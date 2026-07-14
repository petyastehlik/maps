// Official Garda Trentino MTB network (the signed 7xx routes, baked from the
// tourist board's own GPX — scripts/fetch-mtb-garda.mjs). Draped on the
// terrain like the other line layers and coloured by the official tour
// difficulty: lehká modrá · střední červená · těžká černá. Each route gets
// numbered badges along the line; clicking one opens the rich route card
// (description, difficulty pie, surface split, profile, photos) in labels.js.

import * as THREE from 'three';
import { heightChunkGLSL } from './terrain.js';
import { fetchAsset } from './area.js';

const LIFT = 9;

// pills/cards keep the difficulty colours; the LINES are all one loud red —
// seeing the routes is the whole point of the map
export const DIFF_COLORS = { 1: '#1774d6', 2: '#d92537', 3: '#0c0c0c' };
const LINE_COLOR = '#e8232f';
export const DIFF_NAMES = { 1: 'easy', 2: 'moderate', 3: 'difficult' };

// Difficult tours are near-black — invisible over dark forest ortho without
// a light casing. Each segment is drawn three times: two paper-tone copies
// offset ±~1.3 px perpendicular in screen space (aSide ±1, world offset
// scales with camera distance via uPxK), then the coloured core on top.
const vertexShader = /* glsl */ `
  ${heightChunkGLSL}
  uniform float uPxK;
  uniform vec3 uCameraPos;
  attribute vec2 aPerp;
  attribute float aSide;
  varying vec3 vWorldPos;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float h = sampleHeight(position.xz);
    vec3 p = vec3(position.x, h * uExag + ${LIFT.toFixed(1)}, position.z);
    float dist = distance(p, uCameraPos);
    p.xz += aPerp * (aSide * dist * uPxK);
    vWorldPos = p;
    vColor = color;
    vAlpha = abs(aSide) > 0.7 ? 0.5 : 1.0; // casing quieter than the cores
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uCameraPos;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uAmbientLvl;
  uniform float uDim; // the rest of the network steps back while one glows
  varying vec3 vWorldPos;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float dist = distance(vWorldPos, uCameraPos);
    float fade = (1.0 - smoothstep(uFogNear, uFogFar, dist))
      * (1.0 - smoothstep(25000.0, 40000.0, dist));
    // painted waymarks, not neon — dim with the ambient light
    gl_FragColor = vec4(vColor, 0.9 * vAlpha * fade * (0.3 + 0.7 * uAmbientLvl) * uDim);
  }
`;

// the highlighted route redraws as a fat accent band ON TOP of everything —
// recolouring the base buffer can't win where several routes share a road
const overlayVertexShader = /* glsl */ `
  ${heightChunkGLSL}
  uniform float uPxK;
  uniform vec3 uCameraPos;
  attribute vec2 aPerp;
  attribute float aSide;
  varying vec3 vWorldPos;
  varying float vSide;

  void main() {
    float h = sampleHeight(position.xz);
    vec3 p = vec3(position.x, h * uExag + ${(LIFT + 1).toFixed(1)}, position.z);
    float dist = distance(p, uCameraPos);
    p.xz += aPerp * (aSide * dist * uPxK);
    vWorldPos = p;
    vSide = aSide;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const overlayFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCameraPos;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec3 vWorldPos;
  varying float vSide;

  void main() {
    float dist = distance(vWorldPos, uCameraPos);
    float fade = 1.0 - smoothstep(uFogNear * 1.4, uFogFar * 1.4, dist);
    // white casing under a signal-red core — visible on any terrain
    vec3 color = mix(uColor, vec3(1.0), step(0.5, abs(vSide)));
    gl_FragColor = vec4(color, 0.95 * fade);
  }
`;

/** Badge anchors for the whole network at once. Two passes: first every
 *  route claims ONE well-spread primary anchor (these outrank everything in
 *  the declutterer — each route always has a number on screen), then the
 *  long routes fill in extras every ~6 km, kept away from other badges so
 *  neighbours like 734 and 738 don't drop each other. */
function placeBadges(routes) {
  const placed = [];
  const byRoute = new Map();
  const order = [...routes].sort((a, b) => b.km - a.km);
  const candidatesFor = (route) => {
    const out = [];
    for (const run of [...route.segs].sort((a, b) => b.length - a.length)) {
      const step = Math.max(1, Math.floor(run.length / 32));
      for (let i = 0; i < run.length; i += step) {
        out.push({ x: run[i][0], z: run[i][1] });
      }
    }
    return out;
  };
  // pass 1 — primaries, starting from each route's longest-run midpoint
  for (const route of order) {
    const cands = candidatesFor(route);
    const mid = Math.floor(cands.length / 2);
    const ordered = cands.map((_, k) => cands[(mid + k) % cands.length]);
    let pick = null;
    for (const minOther of [2400, 1400, 700, 0]) {
      pick = ordered.find((c) =>
        placed.every((a) => Math.hypot(a.x - c.x, a.z - c.z) > minOther));
      if (pick) break;
    }
    placed.push(pick);
    byRoute.set(route, [pick]);
  }
  // pass 2 — extras roughly every 6 km of route length
  for (const route of order) {
    const want = Math.max(1, Math.min(6, Math.round(route.km / 6)));
    const mine = byRoute.get(route);
    for (const minOther of [1600, 900, 400]) {
      for (const c of candidatesFor(route)) {
        if (mine.length >= want) break;
        if (!mine.every((a) => Math.hypot(a.x - c.x, a.z - c.z) > 3200)) continue;
        if (!placed.every((a) => Math.hypot(a.x - c.x, a.z - c.z) > minOther)) continue;
        mine.push(c);
        placed.push(c);
      }
      if (mine.length >= want) break;
    }
  }
  return byRoute;
}

export async function initMtb(terrainUniforms) {
  const routes = await fetchAsset('routes.json', 'json');

  let segmentCount = 0;
  for (const r of routes) {
    for (const run of r.segs) segmentCount += run.length - 1;
  }
  // 4 copies per segment: white casing at ±1, twin core strands at ±0.35
  // (a ~2 px stroke) — casing first, cores last so they win the blend
  const verts = segmentCount * 2 * 4;
  const positions = new Float32Array(verts * 3);
  const colors = new Float32Array(verts * 3);
  const perp = new Float32Array(verts * 2);
  const side = new Float32Array(verts);
  const casing = new THREE.Color('#efe6d2');
  // picking grid: route segments in world xz, hover/click hit-testing
  const CELL = 250;
  const pickGrid = new Map(); // "cx,cz" → [{ax,az,bx,bz,r}]
  let oCase = 0; // casing verts fill the front of the buffers…
  let oCore = segmentCount * 2 * 2; // …core verts the back half
  const c = new THREE.Color(LINE_COLOR);
  for (const r of routes) {
    for (const run of r.segs) {
      for (let i = 0; i < run.length - 1; i++) {
        const [ax, az] = run[i], [bx, bz] = run[i + 1];
        const len = Math.hypot(bx - ax, bz - az) || 1;
        const px = -(bz - az) / len, pz = (bx - ax) / len;
        for (const s of [-1, 1]) {
          for (const [x, z] of [[ax, az], [bx, bz]]) {
            positions[oCase * 3] = x; positions[oCase * 3 + 2] = z;
            colors[oCase * 3] = casing.r; colors[oCase * 3 + 1] = casing.g;
            colors[oCase * 3 + 2] = casing.b;
            perp[oCase * 2] = px; perp[oCase * 2 + 1] = pz;
            side[oCase] = s;
            oCase++;
          }
        }
        for (const s of [-0.35, 0.35]) {
          for (const [x, z] of [[ax, az], [bx, bz]]) {
            positions[oCore * 3] = x; positions[oCore * 3 + 2] = z;
            colors[oCore * 3] = c.r; colors[oCore * 3 + 1] = c.g;
            colors[oCore * 3 + 2] = c.b;
            perp[oCore * 2] = px; perp[oCore * 2 + 1] = pz;
            side[oCore] = s;
            oCore++;
          }
        }
        const k = `${Math.floor((ax + bx) / 2 / CELL)},${Math.floor((az + bz) / 2 / CELL)}`;
        if (!pickGrid.has(k)) pickGrid.set(k, []);
        pickGrid.get(k).push({ ax, az, bx, bz, r });
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aPerp', new THREE.BufferAttribute(perp, 2));
  geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    vertexColors: true,
    uniforms: {
      uHeight: terrainUniforms.uHeight,
      uHeightD: terrainUniforms.uHeightD,
      uHScale: terrainUniforms.uHScale,
      uDetailMin: terrainUniforms.uDetailMin,
      uDetailSize: terrainUniforms.uDetailSize,
      uDetailOn: terrainUniforms.uDetailOn,
      uExag: terrainUniforms.uExag,
      uExtent: terrainUniforms.uExtent,
      uCameraPos: terrainUniforms.uCameraPos,
      uFogNear: terrainUniforms.uFogNear,
      uFogFar: terrainUniforms.uFogFar,
      uAmbientLvl: terrainUniforms.uAmbientLvl,
      uPxK: { value: 0 },
      uDim: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
  });

  // the highlight overlay: one preallocated buffer big enough for the
  // longest route, redrawn fat (±1.4 px sides + core) in the accent colour
  let maxRouteSegs = 0;
  for (const r of routes) {
    let n = 0;
    for (const run of r.segs) n += run.length - 1;
    maxRouteSegs = Math.max(maxRouteSegs, n);
  }
  const oPos = new Float32Array(maxRouteSegs * 3 * 2 * 3);
  const oPerp = new Float32Array(maxRouteSegs * 3 * 2 * 2);
  const oSide = new Float32Array(maxRouteSegs * 3 * 2);
  const overlayGeometry = new THREE.BufferGeometry();
  overlayGeometry.setAttribute('position', new THREE.BufferAttribute(oPos, 3));
  overlayGeometry.setAttribute('aPerp', new THREE.BufferAttribute(oPerp, 2));
  overlayGeometry.setAttribute('aSide', new THREE.BufferAttribute(oSide, 1));
  overlayGeometry.setDrawRange(0, 0);
  const overlayMaterial = new THREE.ShaderMaterial({
    vertexShader: overlayVertexShader,
    fragmentShader: overlayFragmentShader,
    uniforms: {
      uHeight: terrainUniforms.uHeight,
      uHeightD: terrainUniforms.uHeightD,
      uHScale: terrainUniforms.uHScale,
      uDetailMin: terrainUniforms.uDetailMin,
      uDetailSize: terrainUniforms.uDetailSize,
      uDetailOn: terrainUniforms.uDetailOn,
      uExag: terrainUniforms.uExag,
      uExtent: terrainUniforms.uExtent,
      uCameraPos: terrainUniforms.uCameraPos,
      uFogNear: terrainUniforms.uFogNear,
      uFogFar: terrainUniforms.uFogFar,
      uPxK: { value: 0 },
      uColor: { value: new THREE.Color('#ffd200') }, // brand yellow — pops on the dimmed red net
    },
    transparent: true,
    depthWrite: false,
  });

  // casing offset ≈ 1.3 px on screen regardless of zoom (fov 55° camera)
  const pxK = (px) =>
    px * 2 * Math.tan(THREE.MathUtils.degToRad(55 / 2)) / window.innerHeight;
  const setPxK = () => {
    material.uniforms.uPxK.value = pxK(1.7);
    overlayMaterial.uniforms.uPxK.value = pxK(1.4);
  };
  setPxK();
  window.addEventListener('resize', setPxK);

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  for (const attribute of Object.values(geometry.attributes)) {
    attribute.onUpload(function () { this.array = null; });
  }
  const base = new THREE.LineSegments(geometry, material);
  base.frustumCulled = false;
  base.renderOrder = 2;
  const overlay = new THREE.LineSegments(overlayGeometry, overlayMaterial);
  overlay.frustumCulled = false;
  overlay.renderOrder = 4; // above every other line layer
  overlay.visible = false;
  const lines = new THREE.Group();
  lines.add(base, overlay);

  // badges: variants sit closer to the ground truth of a click than long
  // tours, so main routes declutter first (labels.js sorts by priority+dist)
  const routeLabels = [];
  const anchorsByRoute = placeBadges(routes);
  for (const r of routes) {
    const way = r.segs.reduce((a, b) => (b.length > a.length ? b : a));
    (anchorsByRoute.get(r) ?? []).forEach((a, i) => {
      routeLabels.push({
        name: r.sig, type: 'route', x: a.x, z: a.z,
        d: r.difficulty, route: r, way,
        primary: i === 0, // one pill per route outranks extras of the others
      });
    });
  }
  /** Every route within `radius` metres of a ground point, nearest first. */
  function pickAll(x, z, radius) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const best = new Map(); // route → d²
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        for (const s of pickGrid.get(`${ix},${iz}`) ?? []) {
          const dx = s.bx - s.ax, dz = s.bz - s.az;
          const t = Math.max(0, Math.min(1,
            ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz || 1)));
          const d2 = (x - (s.ax + t * dx)) ** 2 + (z - (s.az + t * dz)) ** 2;
          if (d2 <= radius * radius && d2 < (best.get(s.r) ?? Infinity)) {
            best.set(s.r, d2);
          }
        }
      }
    }
    return [...best.entries()].sort((a, b) => a[1] - b[1]).map(([r]) => r);
  }

  /** Nearest route within `radius` metres of a ground point, or null. */
  const pick = (x, z, radius) => pickAll(x, z, radius)[0] ?? null;

  /** Redraw one route as the fat accent overlay and dim the rest of the
   *  network under it (null restores the quiet base state). */
  let highlighted = null;
  function highlight(route) {
    if (route === highlighted) return;
    highlighted = route;
    material.uniforms.uDim.value = route ? 0.25 : 1;
    if (!route) { overlay.visible = false; return; }
    let o = 0;
    const put = (x, z, px, pz, s) => {
      oPos[o * 3] = x; oPos[o * 3 + 1] = 0; oPos[o * 3 + 2] = z;
      oPerp[o * 2] = px; oPerp[o * 2 + 1] = pz;
      oSide[o] = s;
      o++;
    };
    for (const run of route.segs) {
      for (let i = 0; i < run.length - 1; i++) {
        const [ax, az] = run[i], [bx, bz] = run[i + 1];
        const len = Math.hypot(bx - ax, bz - az) || 1;
        const px = -(bz - az) / len, pz = (bx - ax) / len;
        for (const s of [-1, 0, 1]) {
          put(ax, az, px, pz, s);
          put(bx, bz, px, pz, s);
        }
      }
    }
    overlayGeometry.setDrawRange(0, o);
    for (const attribute of Object.values(overlayGeometry.attributes)) {
      attribute.needsUpdate = true;
    }
    overlayGeometry.computeBoundingSphere();
    overlay.visible = true;
  }

  return { lines, routeLabels, routes, pick, pickAll, highlight };
}
