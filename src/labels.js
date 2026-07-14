// Landmark labels — quiet typographic layer over the terrain.
// DOM-based (crisp text, real fonts), tiered by importance, distance-culled
// with fade, screen-space decluttered, and terrain-occluded (a label behind
// a ridge hides). Anchors ride the exaggerated terrain like everything else.
// Every label is clickable and opens a small info card (text + photos from
// /data/info.json) that tracks its anchor on screen.

import * as THREE from 'three';
import { dataUrl, assetUrl, area } from './area.js';
import { DIFF_NAMES } from './mtb.js';
import { TRAIL_COLORS } from './trails.js';
import { t, lang, numLocale } from './i18n.js';

// the standard singletrail scale, for the card's share-of-trail chips
const S_SCALE = [
  { color: TRAIL_COLORS[0], tip: 'S0 · flowing trail without roots, rocks or steps — anyone can ride it' },
  { color: TRAIL_COLORS[1], tip: 'S1 · small roots and rocks, occasionally narrow — basic trail technique' },
  { color: TRAIL_COLORS[2], tip: 'S2 · big roots, steps and switchbacks — confident technique needed' },
  { color: TRAIL_COLORS[3], tip: 'S3 · blocked, exposed passages and high steps — for experts' },
  { color: '#181818', tip: 'S4 · very steep and heavily blocked — extreme technique' },
  { color: '#181818', tip: 'S5 · at the edge of rideability — for a handful of the best' },
];

// ITRS — the four-quadrant rating disc from the physical route signs.
// Grades verde/blu/rosso/nero, one quadrant per aspect; the baked `itrs`
// string holds the four letters in this order.
const ITRS_COLORS = { V: '#6ea832', B: '#0e7dad', R: '#d63c2b', N: '#141414' };
const ITRS_GRADES = {
  V: 'green · easy', B: 'blue · moderate',
  R: 'red · demanding', N: 'black · extreme',
};
// letter order in the baked string; qx/qy place the quadrant like the sign
// (technika TL, fyzička TR, následky pádu BR, odlehlost BL)
const ITRS_DIMS = [
  { key: 'technique', qx: -1, qy: -1,
    tip: 'technique — the riding skill the route demands' },
  { key: 'fitness', qx: 1, qy: -1,
    tip: 'fitness — length, climb and descent combined' },
  { key: 'fall risk', qx: 1, qy: 1,
    tip: 'fall risk — how exposed the route is, what a mistake costs' },
  { key: 'remoteness', qx: -1, qy: 1,
    tip: 'remoteness — phone signal, water and rescue access' },
];

// cull distance = hide beyond this camera-to-anchor distance (metres)
const TIERS = {
  home:    { cull: Infinity, priority: -1 }, // the two address pins
  city:    { cull: Infinity, priority: 0 },
  town:    { cull: Infinity, priority: 1 },
  castle:  { cull: 12_000,   priority: 2 },
  village: { cull: 8_500,    priority: 3 },
  peak:    { cull: 6_000,    priority: 4 },
  hamlet:  { cull: 3_800,    priority: 5 },
  route:   { cull: Infinity, priority: 1.5, farDim: { beyond: 9_000, to: 0.55 } },
  trail:   { cull: 4_500,    priority: 7 },
};
const FADE_BAND = 0.18;        // fraction of cull distance used for fade-out
const OCCLUSION_HZ = 8;
const LABEL_LIFT = 14;         // metres above terrain, avoids z-fighting feel

const TYPE_CHIP = {
  town: 'town', city: 'town', village: 'village', hamlet: 'hamlet',
  peak: 'peak', castle: 'landmark', route: 'bike route', home: 'address',
  trail: 'trail',
};

/**
 * @param specials extra always-on pin labels: [{name, type:'home', x, z,
 *        lift, accent?}] — accent tints the pill (e.g. the blue address pin)
 * @param routeLabels cycle-route badge anchors from initCycling
 */
/** Sampler for the region-of-interest mask: (x, z) → 0..1, or null. */
async function loadRegionSampler() {
  if (!area.regionMask) return null;
  try {
    const blob = await (await fetch(dataUrl('region.png'))).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return (x, z, halfW, halfH) => {
      const i = Math.round((x / (2 * halfW) + 0.5) * (width - 1));
      const j = Math.round((z / (2 * halfH) + 0.5) * (height - 1));
      if (i < 0 || i >= width || j < 0 || j >= height) return 0;
      return data[(j * width + i) * 4] / 255;
    };
  } catch { return null; }
}

export async function initLabels({ camera, heightField, getExag, container, specials = [], routeLabels = [], onRouteSelect = null }) {
  const landmarks = await (await fetch(dataUrl('landmarks.json'))).json();
  const regionAt = await loadRegionSampler();
  const halfW = area.halfWidthM, halfH = area.halfHeightM;
  const inRegion = (lm) => !regionAt || regionAt(lm.x, lm.z, halfW, halfH) >= 0.45;
  let info = {};
  try {
    const res = await fetch(dataUrl(`info_${lang}.json`));
    if (res.ok && !(res.headers.get('content-type') ?? '').includes('html')) {
      info = await res.json();
    } else {
      info = await (await fetch(dataUrl('info.json'))).json();
    }
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
    if (lm.type === 'route' && lm.d) el.dataset.d = String(lm.d);
    const dot = document.createElement('i');
    el.append(dot, text);
    root.appendChild(el);
    const item = {
      lift: LABEL_LIFT, ...lm, el,
      tier: TIERS[lm.type],
      // approx text box for declutter (uppercase mono runs wide; route
      // pills are bigger type with padding and casing)
      w: lm.type === 'route' ? lm.name.length * 8.5 + 22 : lm.name.length * 7.5 + 14,
      h: lm.type === 'route' ? 24 : 16,
      opacity: -1, occluded: false, sx: 0, sy: 0,
    };
    el.addEventListener('click', (e) => { e.stopPropagation(); select(item); });
    items.push(item);
    return item;
  }

  for (const lm of specials) addItem(lm);
  for (const lm of landmarks) {
    if (!TIERS[lm.type]) continue;
    if (!inRegion(lm)) continue; // fogged-out places don't advertise
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
      if (/zámek|residence|castello|castel\b|rocca/.test(n)) return t('castle');
      if (/hrad|forte?\b/.test(n) || item.name === 'Karlštejn') return t('castle');
    }
    if (item.type === 'peak' && item.ele) return t('peak · %s m a.s.l.', item.ele);
    if (item.type === 'trail') return t('trail · difficulty S%s', item.s ?? '?');
    if (item.type === 'route' && item.route) {
      return t('MTB route %s · %s', item.route.sig,
        t(DIFF_NAMES[item.route.difficulty] ?? ''));
    }
    return t(TYPE_CHIP[item.type] ?? item.type);
  }

  // a hover-preview card looks identical but yields to clicks and closes
  // itself when the hover ends; clicking the same route just pins it
  let previewing = false;

  function select(item) {
    if (selected === item) {
      if (previewing) { previewing = false; return; } // pin the preview
      closePopup();
      return;
    }
    previewing = false;
    showCard(item);
  }

  function showCard(item) {
    selected = item;
    const route = item.type === 'route' ? item.route : null;
    onRouteSelect?.(route);
    const data = route
      ? { text: route.text?.[lang] ?? route.text?.en ?? '', photos: route.photos.map((p) => dataUrl(p.file)), link: route.link }
      : info[`${item.type}:${item.name}`] ?? info[`home:${item.name}`] ?? {};
    popup.innerHTML = '';

    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.addEventListener('click', closePopup);

    const chip = document.createElement('div');
    chip.className = 'type label';
    chip.textContent = chipFor(item);

    const h = document.createElement('h3');
    h.textContent = route ? route.name : item.name;
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
      p.textContent = t('length %s km · climb +%s m · descent −%s m',
        (stats.length / 1000).toLocaleString(numLocale, { maximumFractionDigits: 1 }),
        Math.round(stats.climb), Math.round(stats.drop));
      popup.appendChild(p);
      popup.appendChild(profileSvg(stats.profile));
    }

    // official MTB routes: stats, difficulty pie, surface split, profile
    if (route) {
      const p = document.createElement('p');
      p.className = 'route-stats';
      const half = route.timeMin % 60 === 30 ? '½' : '';
      p.textContent = [
        `${route.km.toLocaleString(numLocale)} km`,
        `↑ ${route.ascent} m`, `↓ ${route.descent} m`,
        route.timeMin ? `~${Math.floor(route.timeMin / 60)}${half} h` : null,
        route.loop ? t('loop') : null,
        route.clipped ? t('partly off the map') : null,
      ].filter(Boolean).join(' · ');
      popup.appendChild(p);
      if (route.itrs) popup.appendChild(itrsDisc(route.itrs));
      if (route.surface?.length) popup.appendChild(surfaceBar(route.surface));
      const sRow = sscaleRow(route);
      if (sRow) popup.appendChild(sRow);
      if (item.way) popup.appendChild(profileSvg(trailStats(item.way).profile));
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
      a.textContent = link.includes('wikipedia') ? 'Wikipedia →'
        : link.includes('trailforks') ? t('this trail on Trailforks →')
        : route ? t('official route page →') : t('more →');
      popup.appendChild(a);
    }
    if (route?.gpx) {
      const a = document.createElement('a');
      a.href = dataUrl(route.gpx);
      a.download = `${route.sig}-${route.name.replace(/\s+/g, '-')}.gpx`;
      a.textContent = 'GPX ↓';
      a.className = 'gpx';
      popup.appendChild(a);
    }
    if (route?.photos?.[0]?.by) {
      const credit = document.createElement('small');
      credit.className = 'credit';
      credit.textContent = `${t('photo:')} ${route.photos[0].by}`;
      popup.appendChild(credit);
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
      ` fill="rgba(0,79,91,0.10)" stroke="none"/>` +
      `<polyline points="${pts.join(' ')}" fill="none"` +
      ` stroke="#004f5b" stroke-width="1.4"/>` +
      `<text x="${PAD}" y="9" fill="rgba(0,79,91,0.65)"` +
      ` font-size="8" font-family="IBM Plex Mono">${Math.round(max)} m</text>` +
      `<text x="${W - PAD}" y="9" text-anchor="end" fill="rgba(0,79,91,0.65)"` +
      ` font-size="8" font-family="IBM Plex Mono">min ${Math.round(min)} m</text>` +
      `</svg>`;
    return div;
  }

  /** The ITRS disc from the physical route signs, redrawn as SVG: four
   *  quadrants (technika / fyzička / následky pádu / odlehlost), each
   *  coloured by its official grade, tooltips explaining every aspect. */
  function itrsDisc(itrs) {
    const wrap = document.createElement('div');
    wrap.className = 'itrs';
    const C = 33, R = 30, G = 1.6; // centre, radius, half-gap of the cross
    // white icons, one per quadrant (cx/cy = quadrant centre)
    const icons = {
      'technique': (x, y) => `<path d="M${x},${y - 6.5} L${x + 7},${y + 5.5} L${x - 7},${y + 5.5} Z" fill="#f4f1e8"/>`,
      'fitness': (x, y) => `<path d="M${x},${y + 6.5} C${x - 9},${y} ${x - 8},${y - 7.5} ${x - 3.5},${y - 6.5} C${x - 1.5},${y - 6} ${x},${y - 4} ${x},${y - 3} C${x},${y - 4} ${x + 1.5},${y - 6} ${x + 3.5},${y - 6.5} C${x + 8},${y - 7.5} ${x + 9},${y} ${x},${y + 6.5} Z" fill="#f4f1e8"/>`,
      'fall risk': (x, y) => `<path d="M${x - 7},${y + 6} v-9 h3.5 v3 h3 v3 h3 v3 Z" fill="#f4f1e8"/>`
        + `<rect x="${x + 4}" y="${y - 6.5}" width="2.6" height="8" fill="#f4f1e8"/>`
        + `<rect x="${x + 4}" y="${y + 3.5}" width="2.6" height="2.6" fill="#f4f1e8"/>`,
      'remoteness': (x, y) => `<path d="M${x - 6.5},${y - 2} q6,-6 12,0 l-2.5,2.7 q-3.5,-3 -7,0 Z" fill="#f4f1e8" transform="rotate(-40 ${x} ${y})"/>`
        + `<path d="M${x + 1.5},${y - 6.5} h3 v2.5 h2.5 v3 h-2.5 v2.5 h-3 v-2.5 h-2.5 v-3 h2.5 Z" fill="#f4f1e8"/>`,
    };
    let svg = `<svg viewBox="0 0 66 66" width="62" height="62">`;
    ITRS_DIMS.forEach((d, i) => {
      const grade = itrs[i];
      const x0 = C + d.qx * G, y0 = C + d.qy * G;
      // quadrant: two straight edges along the cross gap + the outer arc
      const ax = x0, ay = y0 + d.qy * (R - G);
      const bx = x0 + d.qx * (R - G), by = y0;
      const sweep = (d.qx === d.qy) ? 0 : 1;
      svg += `<path d="M${x0},${y0} L${ax},${ay} A${R},${R} 0 0 ${sweep} ${bx},${by} Z"`
        + ` fill="${ITRS_COLORS[grade] ?? '#555'}"`
        + ` data-tip="${t(d.tip)} — ${t(ITRS_GRADES[grade]) ?? '?'}"/>`;
      svg += icons[d.key](C + d.qx * (R * 0.52), C + d.qy * (R * 0.52));
    });
    svg += `<circle cx="${C}" cy="${C}" r="${R + 0.8}" fill="none"`
      + ` stroke="rgba(244,241,232,0.55)" stroke-width="1.2"/></svg>`;
    const legend = ITRS_DIMS.map((d, i) =>
      `<span data-tip="${t(d.tip)} — ${t(ITRS_GRADES[itrs[i]]) ?? '?'}">`
      + `<i style="background:${ITRS_COLORS[itrs[i]] ?? '#555'}"></i>${t(d.key)}</span>`).join('');
    wrap.innerHTML = `${svg}<div class="itrs-legend" `
      + `data-tip="${t('ITRS — International Trail Rating System, from the physical route signs; green → blue → red → black')}">${legend}</div>`;
    return wrap;
  }

  /** Share of the route on graded singletrack (OSM mtb:scale), as chips —
   *  "S1 13 %" etc.; grades the route never touches stay silent. */
  function sscaleRow(route) {
    const total = (route.km || 0) * 1000;
    if (!route.sscale || !total) return null;
    const parts = route.sscale
      .map((m, i) => ({ m, i }))
      .filter((p) => p.m >= 100);
    if (!parts.length) return null;
    const row = document.createElement('div');
    row.className = 'sscale';
    row.innerHTML = parts.map(({ m, i }) => {
      const pct = Math.round((m / total) * 100);
      return `<span data-tip="${t(S_SCALE[i].tip)} — ${(m / 1000).toLocaleString(numLocale, { maximumFractionDigits: 1 })} km">`
        + `<i style="background:${S_SCALE[i].color}"></i>S${i} ${pct < 1 ? '<1' : pct} %</span>`;
    }).join('')
      + `<span class="cap" data-tip="${t('share of the route on signed singletrack (S0–S5 scale, per OSM); the rest follows roads and gravel')}">${t('singletrack')}</span>`;
    return row;
  }

  /** Official surface split as a thin stacked bar (from the tour data). */
  function surfaceBar(surface) {
    const total = surface.reduce((a, s) => a + s.m, 0) || 1;
    const bar = document.createElement('div');
    bar.className = 'surface';
    bar.innerHTML = surface.map((s) =>
      `<i style="width:${(s.m / total * 100).toFixed(1)}%;background:${s.color}"`
      + ` data-tip="${t(s.name)} — ${(s.m / 1000).toLocaleString(numLocale, { maximumFractionDigits: 1 })} km"></i>`).join('');
    const cap = document.createElement('small');
    cap.textContent = t('surface per official route data');
    const wrap = document.createElement('div');
    wrap.className = 'surface-wrap';
    wrap.append(bar, cap);
    return wrap;
  }

  // one shared tooltip for [data-tip] elements inside the card
  const tip = document.createElement('div');
  tip.id = 'lm-tip';
  tip.hidden = true;
  document.body.appendChild(tip);
  popup.addEventListener('pointerover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
  });
  popup.addEventListener('pointermove', (e) => {
    if (tip.hidden) return;
    const W = tip.offsetWidth || 200;
    const x = Math.min(e.clientX + 14, window.innerWidth - W - 8);
    const y = Math.max(e.clientY - tip.offsetHeight - 10, 8);
    tip.style.transform = `translate(${x}px, ${y}px)`;
  });
  popup.addEventListener('pointerleave', () => { tip.hidden = true; });

  function closePopup() {
    const wasPreview = previewing;
    selected = null;
    previewing = false;
    popup.hidden = true;
    tip.hidden = true;
    onRouteSelect?.(null, wasPreview);
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopup(); });

  function positionPopup() {
    if (!selected || popup.hidden) return;
    // route cards live in the top-left corner: anchored cards kept covering
    // the very route they highlight (and a card drifting under the cursor
    // fired pointerleave loops — the TRASY hover flicker)
    if (selected.type === 'route') {
      popup.style.transform = 'translate(12px, 12px)';
      return;
    }
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
      let fade = cull === Infinity ? 1
        : dist > cull ? 0
        : Math.min(1, (cull - dist) / (cull * FADE_BAND));
      const farDim = item.tier.farDim;
      if (farDim && dist > farDim.beyond) fade = Math.min(fade, farDim.to);
      if (item.occluded) {
        // route badges dim behind terrain instead of vanishing — they are
        // the only always-on handle on a route; everything else hides
        if (item.type === 'route') fade = Math.max(0.35, fade * 0.5);
        else fade = 0;
      }
      if (fade <= 0) { setOpacity(item, 0); continue; }

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
      // far-faded route pills pack tighter — at whole-map zoom the network
      // stays labelled instead of decluttering itself away
      const w = item.type === 'route' && item.fade < 0.7 ? item.w * 0.55 : item.w;
      const above = {
        x0: item.sx - w / 2, x1: item.sx + w / 2,
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

  /** Open the card of an official MTB route (route-list panel rows).
   *  Always pins — the row may already be showing this card as a preview. */
  function selectRoute(sig) {
    const item = items.find((i) => i.type === 'route' && i.route?.sig === sig);
    if (!item) return;
    if (selected !== item) showCard(item);
    previewing = false;
  }

  /** Open a route card anchored at a screen point (clicks on the line
   *  itself — the badge may be culled, so the click position anchors it). */
  function selectRouteAt(sig, sx, sy) {
    const item = items.find((i) => i.type === 'route' && i.route?.sig === sig);
    if (!item) return;
    if (selected !== item) showCard(item);
    previewing = false; // clicks pin
    if (sx !== undefined) { item.sx = sx; item.sy = sy; }
    positionPopup();
  }

  /** Hover-preview a route card (null ends the preview). A card the user
   *  clicked open (sticky) is never replaced or closed by previews. */
  function previewRoute(sig, sx, sy) {
    if (!sig) {
      if (previewing) closePopup();
      return;
    }
    if (selected && !previewing) return; // sticky card wins
    const item = items.find((i) => i.type === 'route' && i.route?.sig === sig);
    if (!item) return;
    if (selected !== item) showCard(item);
    previewing = true;
    if (sx !== undefined) { item.sx = sx; item.sy = sy; }
    positionPopup();
  }

  return {
    update, setVisible, setTypeVisible, closePopup,
    selectRoute, selectRouteAt, previewRoute,
    count: items.length,
  };
}
