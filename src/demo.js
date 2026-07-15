// Guided pitch demo — plays the app like a recorded session: camera
// flights, a simulated cursor that glides and clicks, captions, cards,
// search, dusk, relief and the fog border. Everything runs through the
// SAME APIs the real UI uses (flyToView, previewRoute, the actual DOM
// controls), so the demo is deterministic and always shows the current
// product. ANY real input cancels it instantly and hands control over.
// Start: the ▶ button next to the language pill, or ?demo=1.

import * as THREE from 'three';
import { t } from './i18n.js';

const STOP = Symbol('demo-stopped');

export function initDemo({ controls, labels, mtb, camera, heightField, material }) {
  let running = false;
  let cancelled = false;

  // ── theater props ─────────────────────────────────────────────────────
  const cursor = document.createElement('div');
  cursor.id = 'demo-cursor';
  cursor.hidden = true;
  cursor.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26">
    <path d="M5 2 L19 12.5 L12.3 13.6 L15.4 20.6 L12.6 21.8 L9.6 14.8 L5 19 Z"
      fill="#004f5b" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  document.body.appendChild(cursor);

  const caption = document.createElement('div');
  caption.id = 'demo-caption';
  caption.hidden = true;
  document.body.appendChild(caption);

  const button = document.createElement('button');
  button.id = 'demo-btn';
  button.textContent = '▶';
  button.title = t('Play the demo tour');
  document.body.appendChild(button);
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!running) start();
  });

  let cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  function placeCursor(x, y) {
    cx = x; cy = y;
    cursor.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  const sleep = (ms) => new Promise((resolve, reject) => {
    const id = setTimeout(() => (cancelled ? reject(STOP) : resolve()), ms);
    if (cancelled) { clearTimeout(id); reject(STOP); }
  });

  /** Glide the cursor to a screen point with an eased path. */
  async function moveCursor(x, y, ms = 900) {
    const x0 = cx, y0 = cy;
    const start = performance.now();
    while (true) {
      if (cancelled) throw STOP;
      const f = Math.min(1, (performance.now() - start) / ms);
      const e = f < 0.5 ? 2 * f * f : 1 - ((-2 * f + 2) ** 2) / 2; // easeInOut
      placeCursor(x0 + (x - x0) * e, y0 + (y - y0) * e);
      if (f >= 1) return;
      await sleep(16);
    }
  }

  function clickRipple() {
    const r = document.createElement('i');
    r.className = 'demo-ripple';
    r.style.transform = `translate(${cx}px, ${cy}px)`;
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 700);
  }

  async function say(text, holdMs = 2600) {
    caption.textContent = text;
    caption.hidden = false;
    caption.classList.add('on');
    await sleep(holdMs);
  }
  function hush() {
    caption.classList.remove('on');
  }

  /** World xz → screen px (same projection the labels use). */
  function toScreen(x, z, lift = 10) {
    const y = (heightField.relativeElevationAt(x, z) ?? 0)
      * material.uniforms.uExag.value + lift;
    const v = new THREE.Vector3(x, y, z).project(camera);
    return [(v.x + 1) / 2 * window.innerWidth, (1 - v.y) / 2 * window.innerHeight, v.z];
  }

  async function awaitFlight(maxMs = 12000) {
    const start = performance.now();
    await sleep(350);
    while (controls.flight && performance.now() - start < maxMs) await sleep(120);
    await sleep(250);
  }

  function flyTo(x, z, az, polarDeg, dist, tau = 0.9) {
    controls.flightTau = tau;
    controls.flyToView(x, z, az, THREE.MathUtils.degToRad(polarDeg), dist);
  }

  /** A visible on-screen point of a route, preferring unambiguous spots. */
  function routePoint(uid) {
    const route = mtb.routes.find((r) => (r.uid ?? r.sig) === uid);
    let fallback = null;
    for (const run of route.segs) {
      for (let i = 0; i < run.length; i += 4) {
        const [x, z] = run[i];
        const [sx, sy, depth] = toScreen(x, z);
        if (depth > 1 || sx < 340 || sx > window.innerWidth - 120
          || sy < 120 || sy > window.innerHeight - 160) continue;
        const hit = { sx, sy, route };
        if (mtb.pickAll(x, z, 60).length === 1) return hit;
        fallback ??= hit;
      }
    }
    return fallback;
  }

  const el = (sel) => document.querySelector(sel);
  const centerOf = (node) => {
    const r = node.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };

  async function clickNode(node, ms = 800) {
    const [x, y] = centerOf(node);
    await moveCursor(x, y, ms);
    clickRipple();
    await sleep(120);
    node.click();
  }

  // ── the script ────────────────────────────────────────────────────────
  const sunInput = () => el('#sun');
  let sunBefore = null;

  async function setSun(hours) {
    const input = sunInput();
    input.value = String(hours);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  async function sweepSun(from, to, ms) {
    const steps = Math.max(2, Math.round(ms / 90));
    for (let k = 0; k <= steps; k++) {
      if (cancelled) throw STOP;
      await setSun(from + (to - from) * (k / steps));
      await sleep(ms / steps);
    }
  }

  async function play() {
    // 0 · wait for the intro flight to finish, cursor fades in
    await awaitFlight(16000);
    placeCursor(window.innerWidth * 0.62, window.innerHeight * 0.75);
    cursor.hidden = false;
    await say(t('The official Garda Trentino MTB network — 42 signed routes, 993 km.'), 3000);
    hush();

    // 1 · fly to the Sarca valley, hover 743, card + ITRS tooltip
    flyTo(9481, -161, -0.1, 55, 5600);
    await awaitFlight();
    const spot = routePoint('743') ?? routePoint('731');
    if (spot) {
      await moveCursor(spot.sx, spot.sy, 1100);
      mtb.highlight(spot.route);
      await sleep(500);
      labels.previewRoute(spot.route.uid ?? spot.route.sig);
      await say(t('Hover any route — official stats, photos and the GPX itself.'), 2800);
      labels.selectRoute(spot.route.uid ?? spot.route.sig);
      const disc = el('#lm-popup .itrs svg');
      if (disc) {
        const quad = el('#lm-popup .itrs path[data-tip]');
        await moveCursor(...centerOf(disc), 900);
        quad?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        quad?.dispatchEvent(new PointerEvent('pointermove',
          { bubbles: true, clientX: cx, clientY: cy }));
        await say(t('ITRS — the four ratings straight from the physical trail signs.'), 3000);
        quad?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); // tip off happens on leave
        el('#lm-popup')?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      }
      hush();
      labels.closePopup();
    }

    // 2 · the routes panel: search, preview, fly to a start
    await clickNode(el('#routelist-tab'), 900);
    await sleep(500);
    const search = el('#routelist input');
    await moveCursor(...centerOf(search), 700);
    clickRipple();
    search.focus();
    for (const ch of 'trem') {
      if (cancelled) throw STOP;
      search.value += ch;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(190);
    }
    await say(t('Every route — searchable, sortable, one click from its start.'), 2400);
    const row = [...document.querySelectorAll('#routelist .row')]
      .find((r) => !r.hidden && r.textContent.includes('733'));
    if (row) {
      await moveCursor(...centerOf(row), 800);
      row.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
      await sleep(1100);
      clickRipple();
      row.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      row.click();
    }
    await sleep(400);
    el('#routelist .close')?.click();
    hush();
    await awaitFlight();
    await say(t('Tremalzo — the WWI military road, a cult descent.'), 2600);
    hush();
    labels.closePopup();

    // 3 · real sun: sweep to dusk, stars out, and back
    sunBefore = sunInput().value;
    const sunNode = sunInput();
    await moveCursor(...centerOf(sunNode), 900);
    await sweepSun(parseFloat(sunBefore), 21.4, 3400);
    await say(t('The real sky for any hour — sun, moon and 1,600 stars.'), 3200);
    await sweepSun(21.4, parseFloat(sunBefore), 2400);
    hush();

    // 4 · relief mode
    await clickNode(el('#mode-relief'), 800);
    await say(t('Survey relief with contours, one key away.'), 2600);
    hush();
    await clickNode(el('#mode-ortho'), 700);

    // 5 · the fog border
    flyTo(2706, 9222, 0.15, 62, 13000, 1.0);
    await awaitFlight();
    await say(t('Garda Trentino — and only Garda Trentino. The rest stays in the haze.'), 3200);
    hush();

    // 6 · home
    const home = { x: 7100, z: -700 };
    flyTo(home.x, home.z, -0.05, 56, 21000, 1.0);
    await awaitFlight();
    await say(t('Your turn — grab the map.'), 2600);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────
  function cleanup(userCancelled) {
    cursor.hidden = true;
    caption.classList.remove('on');
    caption.hidden = true;
    button.classList.remove('on');
    labels.closePopup();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    if (document.getElementById('routelist')?.classList.contains('open')) {
      el('#routelist .close')?.click();
    }
    if (userCancelled && sunBefore !== null) {
      sunInput().value = sunBefore;
      sunInput().dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (userCancelled) el('#mode-ortho')?.click();
    sunBefore = null;
    running = false;
    window.__demoDone = true;
  }

  const cancelEvents = ['pointerdown', 'wheel', 'keydown'];
  function onUserInput(e) {
    if (e.target instanceof Node && (e.target === button || button.contains(e.target))) return;
    cancelled = true;
  }

  async function start() {
    if (running) return;
    running = true;
    cancelled = false;
    window.__demoDone = false;
    button.classList.add('on');
    for (const ev of cancelEvents) {
      window.addEventListener(ev, onUserInput, { capture: true, passive: true });
    }
    try {
      await play();
      cleanup(false);
    } catch (err) {
      cleanup(true);
      if (err !== STOP) console.warn('[demo]', err);
    } finally {
      for (const ev of cancelEvents) {
        window.removeEventListener(ev, onUserInput, { capture: true });
      }
    }
  }

  if (new URLSearchParams(window.location.search).get('demo')) start();
  window.__demo = { start };
}
