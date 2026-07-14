// Halouny · Brdy/Hřebeny — 3D LIDAR terrain viewer.
// Scene bootstrap, camera + map controls, HUD wiring (mode toggle,
// exaggeration, compass, scale bar, elevation probe).

import * as THREE from 'three';
import { MapCameraControls } from './MapCameraControls.js';
import { loadTerrain } from './terrain.js';
import { initLabels } from './labels.js';
import { initCycling } from './cycling.js';
import { initTrails } from './trails.js';
import { initMtb } from './mtb.js';
import { initRouteList } from './routelist.js';
import { initWater } from './water.js';
import { initBuildings } from './buildings.js';
import { initTrees } from './trees.js';
import { lightingForTime, setSunObserver } from './sun.js';
import { createSky } from './sky.js';
import { initCelestial } from './celestial.js';
import { initWeather } from './weather.js';
import { julianDate, siderealTime, setObserver } from './astro.js';
import { area, switchArea, consumeAutoEnter } from './area.js';
import { t, translatePage, mountSwitcher } from './i18n.js';
import { AREAS } from './areas.js';

let resumeSun = null; // set when recovering from a lost WebGL context
const app = document.getElementById('app');
const veil = document.getElementById('veil');
const veilBar = document.getElementById('veil-bar');
const veilStatus = document.getElementById('veil-status');

// ── area: titles, pickers, observer position ───────────────────────────────
// Choose-first loading: NOTHING downloads until an area is explicitly
// picked, so there is no half-loaded map to lose by picking the other one.
// After the pick the map loads and enters by itself — one tap total.
// (A reload arriving from a pick or a lost context carries the mapa:enter
// flag and starts loading straight away.)
translatePage();
mountSwitcher(() => (loadingStarted ? area.id : null));
document.title = `${area.title} · 3D LIDAR map`;
document.getElementById('sun-row').title = t('Time of day — sun position over the map');
document.getElementById('attribution').innerHTML = area.attributionHtml;

const veilTitle = document.getElementById('veil-title');
const veilHint = document.getElementById('veil-hint');
const veilProgress = document.querySelector('#veil .progress');
const autoEnter = consumeAutoEnter();
function enterMap() { veil.classList.add('done'); }

const areaButtons = new Map();
const veilAreas = document.getElementById('veil-areas');
let loadingStarted = false;
let resolveChoice;
const choiceMade = new Promise((resolve) => { resolveChoice = resolve; });

function showLoadingState() {
  loadingStarted = true;
  veilTitle.innerHTML = `${area.title}<span>.</span>`;
  veilProgress.hidden = false;
  veilStatus.textContent = t('preparing…');
  for (const [id, button] of areaButtons) {
    button.classList.toggle('active', id === area.id);
    button.classList.toggle('dim', id !== area.id);
    button.classList.remove('last');
  }
  const other = Object.values(AREAS).find((a) => a.id !== area.id);
  if (other) veilHint.textContent =
    t('Loading %s — switching to %s restarts the download.', area.title, other.title);
  resolveChoice();
}

for (const a of Object.values(AREAS)) {
  const button = document.createElement('button');
  button.textContent = a.title;
  button.classList.toggle('last', a.id === area.id); // remembered, not implied
  button.addEventListener('click', () => {
    if (a.id === area.id) {
      if (!loadingStarted) showLoadingState();
      return;
    }
    // switching areas needs a reload (one config per page load) — say so,
    // then come back already loading the chosen map
    veilTitle.innerHTML = `${a.title}<span>.</span>`;
    veilHint.textContent = '';
    veilStatus.textContent = t('switching to %s…', a.title);
    switchArea(a.id);
  });
  veilAreas.appendChild(button);
  areaButtons.set(a.id, button);
}

if (autoEnter) {
  showLoadingState(); // the pick already happened before the reload
} else {
  veilTitle.innerHTML = `${t('Maps')}<span>.</span>`;
  veilProgress.hidden = true;
  veilStatus.textContent = t('choose a map');
}

setObserver(area.lat, area.lon);
setSunObserver(area.lat, area.lon);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 10, 80_000);

// R16-normalized height textures would halve their video memory, but
// three.js has no way to express the EXT_texture_norm16 internal format
// (verified broken in r185) — the Float32 path stays.
const norm16 = false;

// Static geometry keeps no CPU copies, so a lost WebGL context (GPU reset,
// mobile tab eviction) can't be re-uploaded in place — save the exact view
// and reload instead; the map comes back where the user left it.
renderer.domElement.addEventListener('webglcontextlost', () => {
  try {
    const c = window.__map.controls.cur;
    sessionStorage.setItem('mapa:resume', JSON.stringify({
      x: c.target.x, z: c.target.z, azimuth: c.azimuth,
      polar: c.polar, distance: c.distance,
      sun: document.getElementById('sun').value,
      enter: area.id,
    }));
    sessionStorage.setItem('mapa:enter', area.id);
  } catch { /* reload cold */ }
  window.location.reload();
});

await choiceMade; // nothing downloads before the user picks a map

const LOAD_STEPS = ['loading elevation…', 'loading imagery…', 'building the scene…'];
let terrain;
try {
  terrain = await loadTerrain((step, fraction) => {
    veilStatus.textContent = t(LOAD_STEPS[step] ?? LOAD_STEPS[0]);
    veilBar.style.width = `${Math.round(fraction * 100)}%`;
  }, { norm16 });
} catch (err) {
  // keep the veil (and its area picker) alive so the user can switch back
  veilStatus.textContent = `${area.title}: ${err.message}`;
  throw err;
}
const { mesh, material, heightField, updateDetail } = terrain;
material.uniforms.uExag.value = area.exagDefault;
scene.add(mesh);

const controls = new MapCameraControls(
  camera, renderer.domElement, heightField, () => material.uniforms.uExag.value);

const home = area.homeView;
controls.setView(home.x, home.z, home.azimuth,
  THREE.MathUtils.degToRad(home.polarDeg), home.distance);
// returning from a lost-context reload: restore the exact previous view
try {
  const resume = JSON.parse(sessionStorage.getItem('mapa:resume') ?? 'null');
  sessionStorage.removeItem('mapa:resume');
  if (resume && resume.enter === area.id) {
    controls.setView(resume.x, resume.z, resume.azimuth, resume.polar, resume.distance);
    resumeSun = resume.sun;
  }
} catch { /* cold start */ }

// ── address pins (per-area config) ─────────────────────────────────────────
const markers = area.pins.map((spec) => {
  const group = new THREE.Group();
  const pin = new THREE.Mesh(
    new THREE.CylinderGeometry(3.5, 3.5, 220, 8),
    new THREE.MeshBasicMaterial({ color: spec.color }),
  );
  pin.position.y = 110;
  group.add(pin);
  group.position.set(spec.x, 0, spec.z);
  scene.add(group);
  return { group, rel: heightField.relativeElevationAt(spec.x, spec.z) };
});

function updateMarkerHeight() {
  for (const m of markers) m.group.position.y = m.rel * material.uniforms.uExag.value;
}
updateMarkerHeight();

// ── overlay layers: cycling, trails, water + landmark labels ───────────────
// optional layers degrade to inert stubs when an area lacks their data
const optional = (promise, stub, name) => promise.catch((err) => {
  console.warn(`[vrstva] ${name}: ${err.message}`);
  return typeof stub === 'function' ? stub() : stub;
});
const emptyGroup = () => new THREE.Group();
// areas with the official signed MTB network (routes.json) swap the two OSM
// line layers for it — one layer, one toggle, the standard difficulty colours
const lineStub = () => ({ lines: emptyGroup(), routeLabels: [], trailLabels: [] });
const [cycling, trails, mtb, water, buildings, trees] = await Promise.all([
  area.mtbRoutes ? lineStub()
    : optional(initCycling(material.uniforms), lineStub, 'cyklo'),
  area.mtbRoutes ? lineStub()
    : optional(initTrails(material.uniforms), lineStub, 'traily'),
  area.mtbRoutes ? optional(initMtb(material.uniforms), lineStub, 'mtb') : lineStub(),
  optional(initWater(material.uniforms), // paints into the terrain shader's mask
    () => ({ texture: null }), 'voda'),
  optional(initBuildings(material.uniforms), emptyGroup, 'budovy'),
  optional(initTrees(material.uniforms),
    () => ({ mesh: emptyGroup(), update() {} }), 'stromy'),
]);
scene.add(cycling.lines, trails.lines, mtb.lines, buildings, trees.mesh);

// while a route card is open its route stays highlighted, whatever opened
// it; dismissing a PINNED card lets the highlight linger (the card often
// gets closed exactly to unblock the view of the route) until another
// route takes over, the map is clicked empty, or Escape
let activeRoute = null;
let hoveredRoute = null;
let lingerRoute = null;
const applyHighlight = () => mtb.highlight?.(hoveredRoute ?? activeRoute ?? lingerRoute);

const labels = await initLabels({
  camera, heightField,
  getExag: () => material.uniforms.uExag.value,
  container: app,
  routeLabels: [...cycling.routeLabels, ...trails.trailLabels, ...mtb.routeLabels],
  onRouteSelect: (route, wasPreview) => {
    if (route) {
      activeRoute = route;
      lingerRoute = null;
    } else {
      if (!wasPreview && activeRoute) lingerRoute = activeRoute;
      activeRoute = null;
    }
    applyHighlight();
  },
});

// clicking into the map closes an open info card
renderer.domElement.addEventListener('pointerdown', () => labels.closePopup());

function wireLayerToggle(id, apply) {
  const button = document.getElementById(id);
  let on = true;
  button.addEventListener('click', () => {
    on = !on;
    button.classList.toggle('active', on);
    apply(on);
  });
}
wireLayerToggle('layer-labels', (on) => labels.setVisible(on));
wireLayerToggle('layer-cycling', (on) => {
  cycling.lines.visible = on;
  mtb.lines.visible = on;
  labels.setTypeVisible('route', on);
});
wireLayerToggle('layer-trails', (on) => {
  trails.lines.visible = on;
  labels.setTypeVisible('trail', on);
});
if (area.mtbRoutes) {
  // one MTB layer instead of cyklo + traily, plus the route-list panel
  document.getElementById('layer-cycling').textContent = 'MTB';
  document.getElementById('layer-trails').hidden = true;
  if (mtb.routes?.length) initRouteList({ routes: mtb.routes, controls, labels });
}

// the route lines themselves are hover- and clickable: the cursor's terrain
// point (CPU ray-march) is matched against the route segments, the whole
// route lights up in the accent colour, a click opens its card at the
// cursor; a card opened this way closes again once the pointer leaves the
// route (hovering the card itself keeps it open — it's outside the canvas)
if (area.mtbRoutes && mtb.pick) {
  const canvas = renderer.domElement;
  const pickRadius = (worldPoint) => {
    const dist = camera.position.distanceTo(worldPoint);
    // ~9 px grab zone, never under 25 m
    return Math.max(25, dist * 9 * 2 * Math.tan(THREE.MathUtils.degToRad(55 / 2))
      / window.innerHeight);
  };
  const routeAt = (clientX, clientY) => {
    if (!mtb.lines.visible) return null;
    const g = controls.groundPointAt(clientX, clientY);
    return g ? mtb.pick(g.x, g.z, pickRadius(g)) : null;
  };
  let lastMove = 0;
  let trailing = 0;
  let downAt = null;

  // several routes often share a road — a click there opens a small
  // chooser at the cursor; hovering its rows previews each candidate
  const chooser = document.createElement('div');
  chooser.id = 'route-chooser';
  chooser.hidden = true;
  document.body.appendChild(chooser);
  const closeChooser = () => {
    chooser.hidden = true;
    applyHighlight();
  };
  function openChooser(hits, x, y) {
    chooser.innerHTML = '';
    for (const r of hits) {
      const row = document.createElement('button');
      row.innerHTML = `<b data-d="${r.difficulty}">${r.sig}</b><span>${r.name}</span>`;
      row.addEventListener('pointerenter', () => mtb.highlight(r));
      row.addEventListener('click', () => {
        closeChooser();
        labels.selectRouteAt(r.uid ?? r.sig, x, y);
      });
      chooser.appendChild(row);
    }
    chooser.hidden = false;
    const W = chooser.offsetWidth || 200;
    const H = chooser.offsetHeight || 120;
    chooser.style.transform = `translate(${Math.min(x + 12, window.innerWidth - W - 8)}px, `
      + `${Math.min(Math.max(y - H / 2, 8), window.innerHeight - H - 8)}px)`;
  }
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeChooser();
    lingerRoute = null;
    applyHighlight();
  });

  // the highlight answers instantly (it's the aiming feedback), but the
  // card waits for a settled hover — sweeping the cursor across a zoomed-out
  // map otherwise strobes cards on every route it crosses
  const CARD_DWELL_MS = 400;
  let cardTimer = 0;
  const processMove = (x, y) => {
    const hit = routeAt(x, y);
    if (hit === hoveredRoute) return;
    hoveredRoute = hit;
    applyHighlight();
    canvas.style.cursor = hoveredRoute ? 'pointer' : '';
    clearTimeout(cardTimer);
    if (hoveredRoute) {
      const sig = hoveredRoute.uid ?? hoveredRoute.sig;
      cardTimer = setTimeout(() => labels.previewRoute(sig, x, y), CARD_DWELL_MS);
    } else {
      labels.previewRoute(null);
    }
  };
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) return; // not mid-drag
    clearTimeout(trailing);
    if (performance.now() - lastMove >= 33) {
      lastMove = performance.now();
      processMove(e.clientX, e.clientY);
    } else {
      // the throttle must not swallow the LAST move before the mouse rests
      trailing = setTimeout(() => processMove(e.clientX, e.clientY), 40);
    }
  });
  canvas.addEventListener('pointerdown', (e) => {
    downAt = [e.clientX, e.clientY];
    closeChooser();
  });
  canvas.addEventListener('click', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    const g = mtb.lines.visible && controls.groundPointAt(e.clientX, e.clientY);
    const hits = g ? mtb.pickAll(g.x, g.z, pickRadius(g)) : [];
    if (!hits.length) {
      lingerRoute = null; // clicking empty ground ends a lingering highlight
      applyHighlight();
      return;
    }
    clearTimeout(cardTimer);
    if (hits.length === 1) {
      labels.selectRouteAt(hits[0].uid ?? hits[0].sig, e.clientX, e.clientY); // pins
    } else {
      openChooser(hits, e.clientX, e.clientY);
    }
  });
}
wireLayerToggle('layer-buildings', (on) => { buildings.visible = on; });
wireLayerToggle('layer-trees', (on) => { trees.mesh.visible = on; });

// mobile: the controls panel folds behind a toggle button
document.getElementById('panel-toggle').addEventListener('click', () => {
  document.getElementById('controls').classList.toggle('open');
});

// mobile: hold-to-rotate buttons drive the same smooth path as Q/E
for (const [id, action] of [['rot-left', 'turnLeft'], ['rot-right', 'turnRight']]) {
  const button = document.getElementById(id);
  const start = (e) => { e.preventDefault(); controls.keys.add(action); };
  const stop = () => controls.keys.delete(action);
  button.addEventListener('pointerdown', start);
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    button.addEventListener(ev, stop);
  }
  button.addEventListener('contextmenu', (e) => e.preventDefault()); // no long-press menu
}

// ── help dialog ─────────────────────────────────────────────────────────────
const help = document.getElementById('help');
document.getElementById('help-open').addEventListener('click', () => { help.hidden = false; });
document.getElementById('help-close').addEventListener('click', () => { help.hidden = true; });
help.addEventListener('click', (e) => { if (e.target === help) help.hidden = true; });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') help.hidden = true; });

// ── HUD: mode toggle + exaggeration + reset ────────────────────────────────
const modeButtons = {
  0: document.getElementById('mode-ortho'),
  1: document.getElementById('mode-relief'),
};
function setMode(mode) {
  material.uniforms.uMode.value = mode;
  modeButtons[0].classList.toggle('active', mode === 0);
  modeButtons[1].classList.toggle('active', mode === 1);
}
modeButtons[0].addEventListener('click', () => setMode(0));
modeButtons[1].addEventListener('click', () => setMode(1));

const exagInput = document.getElementById('exag');
const exagValue = document.getElementById('exag-value');
exagInput.value = String(area.exagDefault);
exagValue.textContent = `${area.exagDefault}×`;
if (!area.exagAdjustable) exagInput.closest('.row').hidden = true;
exagInput.addEventListener('input', () => {
  const value = parseFloat(exagInput.value);
  material.uniforms.uExag.value = value;
  exagValue.textContent = `${value.toFixed(2).replace(/0$/, '')}×`;
  updateMarkerHeight();
});

// ── sun, sky, real astronomy, live weather ─────────────────────────────────
const sky = createSky();
scene.add(sky.mesh);
const bootDate = new Date();
const dayOfYear = Math.floor((bootDate - new Date(bootDate.getFullYear(), 0, 0)) / 86_400_000);
const celestial = await initCelestial();
scene.add(celestial.group);
celestial.buildArc(dayOfYear);
initWeather(material.uniforms, area.lat, area.lon);
let lighting = lightingForTime(13, dayOfYear);

function applyTime(hours) {
  // real date at the chosen local wall-clock time → moon, planets, stars
  const date = new Date(bootDate);
  date.setHours(0, 0, 0, 0);
  const jd = julianDate(new Date(date.getTime() + hours * 3_600_000));
  const astro = celestial.setTime(jd, siderealTime(jd));
  lighting = lightingForTime(hours, dayOfYear, {
    up: astro.moonAltDeg > 4,
    dir: new THREE.Vector3(astro.moonDir.x, astro.moonDir.y, astro.moonDir.z),
    fraction: astro.moonFraction,
  });
  material.uniforms.uSunDir.value.copy(lighting.lightDir);
  material.uniforms.uSunColor.value.copy(lighting.sunColor);
  material.uniforms.uAmbient.value.copy(lighting.ambient);
  material.uniforms.uAmbientLvl.value = lighting.ambientLevel;
  material.uniforms.uFogColor.value.copy(lighting.fog);
}

const sunInput = document.getElementById('sun');
const sunValue = document.getElementById('sun-value');
function formatTime(hours) {
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}
sunInput.addEventListener('input', () => {
  const hours = parseFloat(sunInput.value);
  sunValue.textContent = formatTime(hours);
  applyTime(hours);
  celestial.pokeArc(); // reveal today's sun path while scrubbing
});
// always start at noon — the map should never load into the dark
// (unless we're recovering the exact state from a lost-context reload)
const startHours = resumeSun !== null ? parseFloat(resumeSun) : 12;
sunInput.value = String(startHours);
sunValue.textContent = formatTime(startHours);
applyTime(startHours);

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement) return; // typing a search, not a hotkey
  if (e.key === '1') setMode(0);
  if (e.key === '2') setMode(1);
  if (e.key === 'p' || e.key === 'P') document.getElementById('layer-labels').click();
  if (e.key === 'c' || e.key === 'C') document.getElementById('layer-cycling').click();
  if (e.key === 't' || e.key === 'T') document.getElementById('layer-trails').click();
});

// ── HUD: elevation probe under the cursor ──────────────────────────────────
const readout = document.getElementById('readout');
const readoutCoords = readout.querySelector('.coords');
const readoutElev = readout.querySelector('.elev');
const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
let probePending = false;

renderer.domElement.addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  probePending = true;
});

function runProbe() {
  probePending = false;
  raycaster.setFromCamera(pointer, camera);
  const hit = heightField.probe(
    raycaster.ray.origin, raycaster.ray.direction, material.uniforms.uExag.value);
  if (!hit) {
    readout.classList.remove('visible');
    return;
  }
  const elevation = heightField.elevationAt(hit.x, hit.z);
  const [lon, lat] = heightField.lonLatAt(hit.x, hit.z);
  readoutCoords.textContent = `${lat.toFixed(4)}° N ${lon.toFixed(4)}° E`;
  readoutElev.textContent = `▲ ${Math.round(elevation)} ${t('m a.s.l.')}`;
  readout.classList.add('visible');
}

// ── HUD: compass + scale bar ───────────────────────────────────────────────
const compassNeedle = document.getElementById('compass-needle');
const scalebarLabel = document.getElementById('scalebar-label');
const scalebarBar = document.getElementById('scalebar-bar');
const NICE_LENGTHS = [100, 200, 500, 1000, 2000, 5000, 10000];

function updateHud() {
  compassNeedle.style.transform = `rotate(${controls.getAzimuthalAngle()}rad)`;

  const distance = camera.position.distanceTo(controls.target);
  const pxPerMeter = window.innerHeight /
    (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  let length = NICE_LENGTHS[0];
  for (const candidate of NICE_LENGTHS) {
    if (candidate * pxPerMeter <= 240) length = candidate;
  }
  scalebarBar.style.width = `${Math.round(length * pxPerMeter)}px`;
  scalebarLabel.textContent = length >= 1000 ? `${length / 1000} km` : `${length} m`;
}

// ── loop ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// idle frame governor: full display rate while interacting or gliding,
// ~30 fps once everything has been still for a moment. Animations are
// clock-based, so they stay continuous — only their tick rate drops.
// This is what keeps the fans quiet: at rest the scene was redrawing
// 7M+ triangles with a per-pixel shadow march at 120 Hz for nothing.
const IDLE_AFTER_MS = 3000;
const IDLE_FRAME_MS = 33;
let lastActivity = performance.now();
const wake = () => { lastActivity = performance.now(); };
for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart', 'input']) {
  window.addEventListener(ev, wake, { passive: true, capture: true });
}

let lastFrameTime = performance.now();
let lastRenderTime = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const idle = now - lastActivity > IDLE_AFTER_MS && controls.isSettled();
  if (idle && now - lastRenderTime < IDLE_FRAME_MS) return;
  lastRenderTime = now;
  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;
  controls.update(dt);
  material.uniforms.uTime.value = now / 1000;
  // refresh camera matrices so labels/probe project with THIS frame's pose —
  // stale matrices lag one frame and make labels wobble during rotation
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  material.uniforms.uCameraPos.value.copy(camera.position);
  if (probePending) runProbe();
  updateHud();
  labels.update(now);
  sky.update(camera, lighting);
  celestial.update(dt, lighting.stars, lighting.duskGlow);
  trees.update(camera.position);
  updateDetail(controls.target, camera.position);
  renderer.render(scene, camera);
});

// hooks for scripted dogfooding (harmless in production)
window.__map = { camera, controls, heightField, material, labels, trees, buildings, water, mtb, renderer, THREE };

veilBar.style.width = '100%';
enterMap(); // the pick already happened — no second tap needed
