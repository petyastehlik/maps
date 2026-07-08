// Landmark labels — quiet typographic layer over the terrain.
// DOM-based (crisp text, real fonts), tiered by importance, distance-culled
// with fade, screen-space decluttered, and terrain-occluded (a label behind
// a ridge hides). Anchors ride the exaggerated terrain like everything else.
// Every label is clickable and opens a small info card (text + photos from
// /data/info.json) that tracks its anchor on screen.

import * as THREE from 'three';
import { dataUrl, assetUrl } from './area.js';

// cull distance = hide beyond this camera-to-anchor distance (metres)
const TIERS = {
  home:    { cull: Infinity, priority: -1 }, // the two address pins
  city:    { cull: Infinity, priority: 0 },
  town:    { cull: Infinity, priority: 1 },
  castle:  { cull: 12_000,   priority: 2 },
  village: { cull: 8_500,    priority: 3 },
  peak:    { cull: 6_000,    priority: 4 },
  hamlet:  { cull: 3_800,    priority: 5 },
  route:   { cull: 5_500,    priority: 6 },
  trail:   { cull: 4_500,    priority: 7 },
};
const FADE_BAND = 0.18;        // fraction of cull distance used for fade-out
const OCCLUSION_HZ = 8;
const LABEL_LIFT = 14;         // metres above terrain, avoids z-fighting feel

const TYPE_CHIP = {
  town: 'město', city: 'město', village: 'obec', hamlet: 'osada',
  peak: 'vrchol', castle: 'památka', route: 'cyklotrasa', home: 'adresa',
  trail: 'trail',
};

/**
 * @param specials extra always-on pin labels: [{name, type:'home', x, z,
 *        lift, accent?}] — accent tints the pill (e.g. the blue address pin)
 * @param routeLabels cycle-route badge anchors from initCycling
 */
export async function initLabels({ camera, heightField, getExag, container, specials = [], routeLabels = [] }) {
  const landmarks = await (await fetch(dataUrl('landmarks.json'))).json();
  let info = {};
  try {
    info = await (await fetch(dataUrl('info.json'))).json();
  } catch { /* info layer is optional */ }

  const root = document.createElement('div');
  root.id = 'labels';
  container.appendChild(root);

  const items = [];
  function addItem(lm) {
    const el = document.createElement('div');
    el.className = `lm lm-${lm.type}`;
    const text = document.createElement('b');
    text.textContent = lm.name;
    if (lm.type === 'peak' && lm.ele) {
      const ele = document.createElement('small');
      ele.textContent = ` ${lm.ele}`;
      text.appendChild(ele);
    }
    if (lm.accent) {
      text.style.borderColor = lm.accent;
      text.style.color = lm.accent;
    }
    if (lm.type === 'trail') el.dataset.s = String(Math.min(lm.s ?? 0, 3));
    const dot = document.createElement('i');
    el.append(dot, text);
    root.appendChild(el);
    const item = {
      lift: LABEL_LIFT, ...lm, el,
      tier: TIERS[lm.type],
      // approx text box for declutter (uppercase mono runs wide)
      w: lm.name.length * 7.5 + 14, h: 16,
      opacity: -1, occluded: false, sx: 0, sy: 0,
    };
    el.addEventListener('click', (e) => { e.stopPropagation(); select(item); });
    items.push(item);
    return item;
  }

  for (const lm of specials) addItem(lm);
  for (const lm of landmarks) {
    if (!TIERS[lm.type]) continue;
    // the centre pin already says Halouny — skip the duplicate OSM node
    if (lm.name === 'Halouny') continue;
    // OSM sometimes has two nodes for one summit — keep the first
    if (items.some((other) => other.name === lm.name && other.type === lm.type
      && Math.hypot(other.x - lm.x, other.z - lm.z) < 600)) continue;
    addItem(lm);
  }
  for (const lm of routeLabels) addItem(lm);

  // ── info card ────────────────────────────────────────────────────────────
  const popup = document.createElement('div');
  popup.id = 'lm-popup';
  popup.hidden = true;
  document.body.appendChild(popup);
  let selected = null;

  function chipFor(item) {
    if (item.type === 'castle') {
      const n = item.name.toLowerCase();
      if (n.includes('zámek') || n.includes('residence')) return 'zámek';
      if (n.includes('tvrz')) return 'tvrz';
      if (n.includes('hrad') || item.name === 'Karlštejn') return 'hrad';
    }
    if (item.type === 'peak' && item.ele) return `vrchol · ${item.ele} m n. m.`;
    if (item.type === 'trail') return `trail · obtížnost S${item.s ?? '?'}`;
    return TYPE_CHIP[item.type] ?? item.type;
  }

  function select(item) {
    if (selected === item) { closePopup(); return; }
    selected = item;
    const data = info[`${item.type}:${item.name}`] ?? info[`home:${item.name}`] ?? {};
    popup.innerHTML = '';

    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.addEventListener('click', closePopup);

    const chip = document.createElement('div');
    chip.className = 'type label';
    chip.textContent = chipFor(item);

    const h = document.createElement('h3');
    h.textContent = item.name;
    popup.append(close, chip, h);

    if (data.text) {
      const p = document.createElement('p');
      p.textContent = data.text;
      popup.appendChild(p);
    }

    // trails: stats + elevation profile computed from the LIDAR heightfield
    if (item.type === 'trail' && item.way) {
      const stats = trailStats(item.way);
      const p = document.createElement('p');
      p.textContent = `délka ${(stats.length / 1000).toFixed(1)} km · `
        + `stoupání +${Math.round(stats.climb)} m · klesání −${Math.round(stats.drop)} m`;
      popup.appendChild(p);
      popup.appendChild(profileSvg(stats.profile));
    }

    const photos = (data.photos ?? []).slice(0, 3);
    if (photos.length) {
      const gallery = document.createElement('div');
      gallery.className = 'gallery';
      const main = document.createElement('img');
      main.className = 'main';
      main.loading = 'lazy';
      main.referrerPolicy = 'no-referrer';
      main.src = assetUrl(photos[0]);
      main.addEventListener('error', () => main.remove());
      gallery.appendChild(main);
      if (photos.length > 1) {
        const thumbs = document.createElement('div');
        thumbs.className = 'thumbs';
        photos.forEach((url, i) => {
          const t = document.createElement('img');
          t.loading = 'lazy';
          t.referrerPolicy = 'no-referrer';
          t.src = assetUrl(url);
          t.className = i === 0 ? 'on' : '';
          t.addEventListener('error', () => t.remove());
          t.addEventListener('click', () => {
            main.src = assetUrl(url);
            for (const s of thumbs.children) s.classList.toggle('on', s === t);
          });
          thumbs.appendChild(t);
        });
        gallery.appendChild(thumbs);
      }
      popup.appendChild(gallery);
    }

    let link = data.link ?? null;
    if (!link && item.type === 'trail') {
      // deep-link the Trailforks map centred on THIS trail (their per-trail
      // pages need the API we can't use — the map at its location is exact)
      const [lon, lat] = heightField.lonLatAt(item.x, item.z);
      link = `https://www.trailforks.com/map/?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&z=15&activitytype=1`;
    }
    if (link) {
      const a = document.createElement('a');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = link.includes('wikipedia') ? 'Wikipedie →'
        : link.includes('trailforks') ? 'tento trail na Trailforks →' : 'více →';
      popup.appendChild(a);
    }
    popup.hidden = false;
    positionPopup();
  }

  /** Length, climb/descent, resampled elevation profile along a polyline. */
  function trailStats(points) {
    const dists = [0];
    for (let i = 1; i < points.length; i++) {
      dists.push(dists[i - 1] + Math.hypot(
        points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    }
    const length = dists[dists.length - 1];
    const SAMPLES = 64;
    const profile = [];
    for (let k = 0; k < SAMPLES; k++) {
      const d = (k / (SAMPLES - 1)) * length;
      let i = 1;
      while (i < dists.length - 1 && dists[i] < d) i++;
      const f = (d - dists[i - 1]) / Math.max(dists[i] - dists[i - 1], 1e-6);
      const x = points[i - 1][0] + (points[i][0] - points[i - 1][0]) * f;
      const z = points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f;
      profile.push(heightField.elevationAt(x, z) ?? 0);
    }
    let climb = 0, drop = 0;
    for (let k = 1; k < SAMPLES; k++) {
      const dh = profile[k] - profile[k - 1];
      if (dh > 0) climb += dh; else drop -= dh;
    }
    return { length, climb, drop, profile };
  }

  function profileSvg(profile) {
    const W = 236, H = 56, PAD = 3;
    const min = Math.min(...profile), max = Math.max(...profile);
    const span = Math.max(max - min, 8);
    const pts = profile.map((e, i) => {
      const x = PAD + (i / (profile.length - 1)) * (W - 2 * PAD);
      const y = H - PAD - ((e - min) / span) * (H - 2 * PAD - 12);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const div = document.createElement('div');
    div.className = 'profile';
    div.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
      `<path d="M${PAD},${H - PAD} L${pts.join(' L')} L${W - PAD},${H - PAD} Z"` +
      ` fill="rgba(255,122,47,0.14)" stroke="none"/>` +
      `<polyline points="${pts.join(' ')}" fill="none"` +
      ` stroke="#ff7a2f" stroke-width="1.4"/>` +
      `<text x="${PAD}" y="9" fill="rgba(243,234,217,0.6)"` +
      ` font-size="8" font-family="IBM Plex Mono">${Math.round(max)} m</text>` +
      `<text x="${W - PAD}" y="9" text-anchor="end" fill="rgba(243,234,217,0.6)"` +
      ` font-size="8" font-family="IBM Plex Mono">min ${Math.round(min)} m</text>` +
      `</svg>`;
    return div;
  }

  function closePopup() {
    selected = null;
    popup.hidden = true;
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopup(); });

  function positionPopup() {
    if (!selected || popup.hidden) return;
    const W = 268;
    const margin = 12;
    let x = selected.sx + 18;
    if (x + W + margin > window.innerWidth) x = selected.sx - W - 18;
    const H = popup.offsetHeight || 200;
    let y = selected.sy - H / 2;
    y = Math.min(Math.max(y, margin), window.innerHeight - H - margin);
    popup.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // ── per-frame update ─────────────────────────────────────────────────────
  const world = new THREE.Vector3();
  const toCamera = new THREE.Vector3();
  let occlusionAt = 0;
  let occlusionIndex = 0;
  let visible = true;
  const hiddenTypes = new Set();

  function setVisible(v) {
    visible = v;
    root.style.display = v ? '' : 'none';
    if (selected) closePopup();
  }

  function setTypeVisible(type, v) {
    if (v) hiddenTypes.delete(type);
    else hiddenTypes.add(type);
    if (!v && selected?.type === type) closePopup();
  }

  function setOpacity(item, value) {
    const wasHidden = item.opacity <= 0.01;
    const nowHidden = value <= 0.01;
    if (Math.abs(value - item.opacity) < 0.02 && wasHidden === nowHidden) return;
    item.opacity = value;
    item.el.style.opacity = value.toFixed(2);
    item.el.style.visibility = nowHidden ? 'hidden' : 'visible';
  }

  function update(nowMs) {
    if (!visible) return;
    const exag = getExag();
    const width = window.innerWidth;
    const height = window.innerHeight;

    // occlusion checks, round-robin a slice per tick to spread the cost;
    // every in-range item is re-checked so hidden labels can come back
    if (nowMs - occlusionAt > 1000 / OCCLUSION_HZ) {
      occlusionAt = nowMs;
      const slice = Math.ceil(items.length / 4);
      for (let k = 0; k < slice; k++) {
        const item = items[(occlusionIndex + k) % items.length];
        const rel = heightField.relativeElevationAt(item.x, item.z) ?? 0;
        world.set(item.x, rel * exag + item.lift, item.z);
        toCamera.subVectors(world, camera.position);
        const dist = toCamera.length();
        if (dist > item.tier.cull) { item.occluded = false; continue; }
        toCamera.divideScalar(dist);
        const hit = heightField.probe(camera.position, toCamera, exag);
        const hitDist = hit
          ? Math.hypot(hit.x - camera.position.x, hit.y - camera.position.y, hit.z - camera.position.z)
          : Infinity;
        item.occluded = hitDist < dist - Math.max(80, dist * 0.02);
      }
      occlusionIndex = (occlusionIndex + slice) % items.length;
    }

    // project + cull
    const shown = [];
    for (const item of items) {
      if (hiddenTypes.has(item.type)) { setOpacity(item, 0); continue; }
      const rel = heightField.relativeElevationAt(item.x, item.z) ?? 0;
      world.set(item.x, rel * exag + item.lift, item.z);
      const dist = camera.position.distanceTo(world);
      const cull = item.tier.cull;
      const fade = cull === Infinity ? 1
        : dist > cull ? 0
        : Math.min(1, (cull - dist) / (cull * FADE_BAND));
      if (fade <= 0 || item.occluded) { setOpacity(item, 0); continue; }

      world.project(camera);
      if (world.z > 1 || world.x < -1.05 || world.x > 1.05 || world.y < -1.05 || world.y > 1.05) {
        setOpacity(item, 0);
        continue;
      }
      item.sx = (world.x + 1) / 2 * width;
      item.sy = (1 - world.y) / 2 * height;
      item.fade = fade;
      item.dist = dist;
      shown.push(item);
    }

    // declutter: priority tiers first, nearer first inside a tier;
    // a label whose spot above the anchor is taken tries below it before hiding
    shown.sort((a, b) => a.tier.priority - b.tier.priority || a.dist - b.dist);
    const claimed = [];
    const free = (r) => !claimed.some((c) =>
      r.x0 < c.x1 && r.x1 > c.x0 && r.y0 < c.y1 && r.y1 > c.y0);
    for (const item of shown) {
      const above = {
        x0: item.sx - item.w / 2, x1: item.sx + item.w / 2,
        y0: item.sy - item.h - 8, y1: item.sy + 4,
      };
      const below = {
        x0: above.x0, x1: above.x1,
        y0: item.sy - 4, y1: item.sy + item.h + 8,
      };
      let flip = false;
      if (free(above)) claimed.push(above);
      else if (item.type !== 'home' && free(below)) { flip = true; claimed.push(below); }
      else { setOpacity(item, 0); continue; }
      item.el.classList.toggle('flip', flip);
      item.el.style.transform = `translate(${item.sx.toFixed(1)}px, ${item.sy.toFixed(1)}px)`;
      setOpacity(item, item.fade);
    }

    positionPopup();
  }

  return { update, setVisible, setTypeVisible, closePopup, count: items.length };
}
