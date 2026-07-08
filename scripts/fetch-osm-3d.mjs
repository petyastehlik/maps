// Bake OSM-derived 3D data for one area (AREA=<id> env, default halouny):
//   water.bin     — Float32Array flat triangle list [x0,z0, x1,z1, x2,z2, …] (world m)
//   buildings.bin — Float32Array records [cx, cz, halfW, halfD, angleRad, height] × N
//   forest.bin    — Uint8Array 2048×2048 mask (row 0 = north edge, col 0 = west), 255 = forest
//   trails.json   — [{s, imba, name?, points: [[x,z]…]}] from mtb:scale ways
// World frame matches the viewer: origin at map centre, +x east, −z north, metres.
// Each output is skipped if it already exists (delete to refetch). Set OSM_CACHE_DIR
// to cache raw Overpass responses between runs.

import earcut from 'earcut';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveFrame } from './area-frame.mjs';

const { area, toWorld, halfW, halfH, bbox, dataDir } = resolveFrame();
const extentX = halfW * 2, extentZ = halfH * 2;
const [south, west, north, east] = bbox.split(',').map(Number);
mkdirSync(dataDir, { recursive: true });
console.log('overpass bbox:', bbox);

const inside = ([x, z]) => Math.abs(x) <= halfW && Math.abs(z) <= halfH;
const round1 = (v) => Math.round(v * 10) / 10;

// ── overpass (GET — POST 406s from this network) ─────────────────────────
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const cacheDir = process.env.OSM_CACHE_DIR;
if (cacheDir) await mkdir(cacheDir, { recursive: true });

async function overpass(query, label) {
  const cacheFile = cacheDir && path.join(cacheDir, label.replace(/\W+/g, '-') + '.json');
  if (cacheFile && existsSync(cacheFile)) {
    const json = JSON.parse(await readFile(cacheFile, 'utf8'));
    console.log(`${label}: ${json.elements.length} elements (cached)`);
    return json.elements;
  }
  let lastError;
  for (let round = 0; round < 2; round++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      console.log(`querying overpass: ${label} … (${new URL(endpoint).host})`);
      try {
        const res = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
          headers: { 'User-Agent': 'halouny-lidar-map/1.0 (one-off data bake)' },
          signal: AbortSignal.timeout(180_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        console.log(`${label}: ${json.elements.length} elements`);
        if (cacheFile) await writeFile(cacheFile, JSON.stringify(json));
        return json.elements;
      } catch (err) {
        lastError = err;
        console.log(`  ${label} failed on ${new URL(endpoint).host}: ${err.message} — retrying`);
        await new Promise((r) => setTimeout(r, 8000));
      }
    }
  }
  throw new Error(`overpass ${label}: all endpoints failed (${lastError?.message})`);
}

// ── polygon helpers ──────────────────────────────────────────────────────
const nodeKey = (g) => `${g.lon.toFixed(7)}|${g.lat.toFixed(7)}`;

// Stitch way geometries into closed lon/lat rings by matching endpoints.
// Returns rings as open point lists (no repeated last point).
function stitchRings(geometries) {
  const rings = [];
  const open = [];
  let dropped = 0;
  for (const geom of geometries) {
    if (!geom || geom.length < 2) continue;
    const pts = geom.slice();
    if (nodeKey(pts[0]) === nodeKey(pts[pts.length - 1])) {
      if (pts.length >= 4) rings.push(pts.slice(0, -1));
    } else open.push(pts);
  }
  while (open.length) {
    let ring = open.pop();
    let extended = true;
    while (extended && nodeKey(ring[0]) !== nodeKey(ring[ring.length - 1])) {
      extended = false;
      const end = nodeKey(ring[ring.length - 1]);
      for (let i = 0; i < open.length; i++) {
        const seg = open[i];
        if (nodeKey(seg[0]) === end) {
          ring = ring.concat(seg.slice(1)); open.splice(i, 1); extended = true; break;
        }
        if (nodeKey(seg[seg.length - 1]) === end) {
          ring = ring.concat(seg.slice(0, -1).reverse()); open.splice(i, 1); extended = true; break;
        }
      }
    }
    if (nodeKey(ring[0]) === nodeKey(ring[ring.length - 1]) && ring.length >= 4) rings.push(ring.slice(0, -1));
    else dropped++;
  }
  return { rings, dropped };
}

const toWorldRing = (ring) => ring.map((g) => toWorld(g.lon, g.lat));

function ringArea(ring) { // shoelace, absolute, m²
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a / 2);
}

function ringBBox(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}
const bboxHitsSquare = (b) => b.maxX >= -halfW && b.minX <= halfW && b.maxZ >= -halfH && b.minZ <= halfH;

function pointInRing([px, pz], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

// Collect {outer, holes} polygons in world coords from an Overpass element set.
// Relations are stitched from members; ways already used by a relation are skipped.
function collectPolygons(elements) {
  const polygons = [];
  const relMemberIds = new Set();
  let droppedRings = 0, orphanHoles = 0;
  for (const el of elements) {
    if (el.type !== 'relation') continue;
    const wayMembers = (el.members ?? []).filter((m) => m.type === 'way' && m.geometry);
    for (const m of wayMembers) relMemberIds.add(m.ref);
    const outerStitch = stitchRings(wayMembers.filter((m) => m.role !== 'inner').map((m) => m.geometry));
    const innerStitch = stitchRings(wayMembers.filter((m) => m.role === 'inner').map((m) => m.geometry));
    droppedRings += outerStitch.dropped + innerStitch.dropped;
    const outers = outerStitch.rings.map(toWorldRing).filter((r) => bboxHitsSquare(ringBBox(r)));
    const polys = outers.map((outer) => ({ outer, holes: [], area: ringArea(outer) }));
    for (const inner of innerStitch.rings.map(toWorldRing)) {
      let best = null;
      for (const p of polys) {
        if (pointInRing(inner[0], p.outer) && (!best || p.area < best.area)) best = p;
      }
      if (best) best.holes.push(inner);
      else orphanHoles++;
    }
    polygons.push(...polys);
  }
  for (const el of elements) {
    if (el.type !== 'way' || relMemberIds.has(el.id) || !el.geometry) continue;
    if (nodeKey(el.geometry[0]) !== nodeKey(el.geometry[el.geometry.length - 1])) continue;
    if (el.geometry.length < 4) continue;
    const outer = toWorldRing(el.geometry.slice(0, -1));
    if (!bboxHitsSquare(ringBBox(outer))) continue;
    polygons.push({ outer, holes: [], area: ringArea(outer) });
  }
  if (droppedRings) console.log(`  ${droppedRings} unclosable ring(s) dropped`);
  if (orphanHoles) console.log(`  ${orphanHoles} orphan hole(s) dropped`);
  return polygons;
}

// Sutherland–Hodgman clip of a ring against the ±[limX, limZ] rectangle.
function clipRingSquare(ring, limX, limZ) {
  let pts = ring;
  for (const [axis, sign] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
    const lim = axis === 0 ? limX : limZ;
    const bound = sign > 0 ? -lim : lim;
    const keep = (p) => sign > 0 ? p[axis] >= bound : p[axis] <= bound;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ka = keep(a), kb = keep(b);
      if (ka) out.push(a);
      if (ka !== kb) {
        const t = (bound - a[axis]) / (b[axis] - a[axis]);
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    pts = out;
    if (pts.length < 3) return null;
  }
  return pts;
}

// ── water.bin ────────────────────────────────────────────────────────────
const waterPath = path.join(dataDir, 'water.bin');
if (existsSync(waterPath)) {
  console.log('water.bin exists — skipping (delete it to refetch)');
} else {
  await bakeWater();
}

async function bakeWater() {
  const elements = await overpass(`
    [out:json][timeout:180];
    (
      way["natural"="water"](${bbox});
      relation["natural"="water"](${bbox});
      way["waterway"="riverbank"](${bbox});
    );
    out geom;
  `, 'water');

  const polygons = collectPolygons(elements);
  const CLIPX = halfW + 50, CLIPZ = halfH + 50;
  const coords = [];
  const polyAreas = [];
  for (const poly of polygons) {
    const outer = clipRingSquare(poly.outer, CLIPX, CLIPZ);
    if (!outer) continue;
    const holes = poly.holes.map((h) => clipRingSquare(h, CLIPX, CLIPZ)).filter(Boolean);
    const flat = [];
    const holeIdx = [];
    for (const [x, z] of outer) flat.push(x, z);
    for (const h of holes) {
      holeIdx.push(flat.length / 2);
      for (const [x, z] of h) flat.push(x, z);
    }
    const tris = earcut(flat, holeIdx.length ? holeIdx : null);
    let polyArea = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const ax = flat[tris[t] * 2], az = flat[tris[t] * 2 + 1];
      const bx = flat[tris[t + 1] * 2], bz = flat[tris[t + 1] * 2 + 1];
      const cxx = flat[tris[t + 2] * 2], cz = flat[tris[t + 2] * 2 + 1];
      const area = Math.abs((bx - ax) * (cz - az) - (cxx - ax) * (bz - az)) / 2;
      if (area < 0.5) continue; // clip-bridge slivers
      polyArea += area;
      coords.push(round1(ax), round1(az), round1(bx), round1(bz), round1(cxx), round1(cz));
    }
    if (polyArea > 0) polyAreas.push(polyArea);
  }
  const f32 = new Float32Array(coords);
  await writeFile(waterPath, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength));
  const totalKm2 = polyAreas.reduce((s, a) => s + a, 0) / 1e6;
  polyAreas.sort((a, b) => b - a);
  console.log(`wrote water.bin: ${polyAreas.length} polygons, ${coords.length / 6} triangles, ` +
    `${totalKm2.toFixed(2)} km² total`);
  console.log('  largest polygons (km²):', polyAreas.slice(0, 3).map((a) => (a / 1e6).toFixed(3)).join(', '));
}

// ── buildings.bin ────────────────────────────────────────────────────────
const buildingsPath = path.join(dataDir, 'buildings.bin');
if (existsSync(buildingsPath)) {
  console.log('buildings.bin exists — skipping (delete it to refetch)');
} else {
  await bakeBuildings();
}

function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1][0] || p[1] !== arr[i - 1][1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Minimum-area oriented bounding rectangle over the convex hull (per-edge calipers).
function minAreaRect(points) {
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(ang), s = Math.sin(ang);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of hull) {
      const rx = x * c + z * s, rz = -x * s + z * c;
      if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
      if (rz < minZ) minZ = rz; if (rz > maxZ) maxZ = rz;
    }
    const area = (maxX - minX) * (maxZ - minZ);
    if (!best || area < best.area) best = { ang, c, s, minX, maxX, minZ, maxZ, area };
  }
  const mx = (best.minX + best.maxX) / 2, mz = (best.minZ + best.maxZ) / 2;
  let ang = best.ang % Math.PI;
  if (ang > Math.PI / 2) ang -= Math.PI;
  if (ang <= -Math.PI / 2) ang += Math.PI;
  return {
    cx: mx * best.c - mz * best.s,
    cz: mx * best.s + mz * best.c,
    halfW: (best.maxX - best.minX) / 2,
    halfD: (best.maxZ - best.minZ) / 2,
    ang,
  };
}

function buildingHeight(tags = {}) {
  let h = parseFloat(tags.height); // parseFloat drops a trailing ' m'
  if (!Number.isFinite(h)) {
    const levels = parseFloat(tags['building:levels']);
    h = Number.isFinite(levels) ? levels * 3.0 + 1.5 : 6.5;
  }
  return Math.min(40, Math.max(2.5, h));
}

async function bakeBuildings() {
  // Full-bbox building queries time out — fetch as tiles, dedupe by id.
  // An area may narrow the fetch to a corridor (e.g. Garda's lakeshore:
  // suburban Verona would multiply both Overpass load and render cost for
  // rooftops nobody visits on a lake map).
  const bb = area.osmBuildingsBounds ?? { south, west, north, east };
  const N = area.osmBuildingsBounds ? 3 : 2; // corridor still dense → finer tiles
  const dLat = (bb.north - bb.south) / N, dLon = (bb.east - bb.west) / N;
  const byId = new Map();
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const qbbox = `${bb.south + r * dLat},${bb.west + c * dLon},`
        + `${bb.south + (r + 1) * dLat},${bb.west + (c + 1) * dLon}`;
      const elements = await overpass(`
        [out:json][timeout:180];
        way["building"](${qbbox});
        out geom;
      `, `buildings-${r}${c}`);
      for (const el of elements) if (el.type === 'way' && el.geometry) byId.set(el.id, el);
    }
  }
  console.log(`buildings: ${byId.size} unique ways`);

  const records = [];
  const quadCounts = { NW: 0, NE: 0, SW: 0, SE: 0 };
  let heightSum = 0;
  for (const el of byId.values()) {
    if (el.tags?.building === 'no') continue;
    const g = el.geometry;
    if (g.length < 4 || nodeKey(g[0]) !== nodeKey(g[g.length - 1])) continue;
    const rect = minAreaRect(g.slice(0, -1).map((p) => toWorld(p.lon, p.lat)));
    if (!rect) continue;
    if (rect.halfW < 1 || rect.halfD < 1 || rect.halfW > 120 || rect.halfD > 120) continue;
    if (!inside([rect.cx, rect.cz])) continue;
    const h = buildingHeight(el.tags);
    records.push(round1(rect.cx), round1(rect.cz), round1(rect.halfW), round1(rect.halfD), rect.ang, h);
    heightSum += h;
    quadCounts[(rect.cz < 0 ? 'N' : 'S') + (rect.cx < 0 ? 'W' : 'E')]++;
  }
  const f32 = new Float32Array(records);
  await writeFile(buildingsPath, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength));
  const n = records.length / 6;
  console.log(`wrote buildings.bin: ${n} buildings, mean height ${(heightSum / n).toFixed(2)} m`);
  console.log('  by world quadrant:', JSON.stringify(quadCounts));
}

// ── forest.bin ───────────────────────────────────────────────────────────
const forestPath = path.join(dataDir, 'forest.bin');
const GRID = 2048;
if (existsSync(forestPath)) {
  console.log('forest.bin exists — skipping (delete it to refetch)');
} else {
  await bakeForest();
}

// Scanline even-odd fill of one ring group (a relation's rings, or a lone way's
// ring) into the grid. Holes stay clear via parity; groups OR together.
function rasterizeGroup(rings, grid) {
  const edges = [];
  let minRow = Infinity, maxRow = -Infinity;
  const toGrid = ([x, z]) => [(x + halfW) / extentX * GRID, (z + halfH) / extentZ * GRID];
  for (const ring of rings) {
    const g = ring.map(toGrid);
    for (let i = 0, j = g.length - 1; i < g.length; j = i++) {
      const [x1, y1] = g[j], [x2, y2] = g[i];
      if (y1 === y2) continue;
      edges.push([x1, y1, x2, y2]);
      if (Math.min(y1, y2) < minRow) minRow = Math.min(y1, y2);
      if (Math.max(y1, y2) > maxRow) maxRow = Math.max(y1, y2);
    }
  }
  const r0 = Math.max(0, Math.floor(minRow));
  const r1 = Math.min(GRID - 1, Math.ceil(maxRow));
  for (let r = r0; r <= r1; r++) {
    const y = r + 0.5;
    const xs = [];
    for (const [x1, y1, x2, y2] of edges) {
      if ((y1 <= y) !== (y2 <= y)) xs.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const c1 = Math.min(GRID - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let c = c0; c <= c1; c++) grid[r * GRID + c] = 255;
    }
  }
}

async function bakeForest() {
  const elements = await overpass(`
    [out:json][timeout:180];
    (
      way["natural"="wood"](${bbox});
      relation["natural"="wood"](${bbox});
      way["landuse"="forest"](${bbox});
      relation["landuse"="forest"](${bbox});
    );
    out geom;
  `, 'forest');

  const grid = new Uint8Array(GRID * GRID);
  const relMemberIds = new Set();
  let groups = 0;
  for (const el of elements) {
    if (el.type !== 'relation') continue;
    const wayMembers = (el.members ?? []).filter((m) => m.type === 'way' && m.geometry);
    for (const m of wayMembers) relMemberIds.add(m.ref);
    // Outer and inner rings stitched separately, filled together via parity.
    const outers = stitchRings(wayMembers.filter((m) => m.role !== 'inner').map((m) => m.geometry));
    const inners = stitchRings(wayMembers.filter((m) => m.role === 'inner').map((m) => m.geometry));
    const rings = [...outers.rings, ...inners.rings].map(toWorldRing);
    if (rings.length) { rasterizeGroup(rings, grid); groups++; }
  }
  for (const el of elements) {
    if (el.type !== 'way' || relMemberIds.has(el.id) || !el.geometry) continue;
    if (el.geometry.length < 4 || nodeKey(el.geometry[0]) !== nodeKey(el.geometry[el.geometry.length - 1])) continue;
    rasterizeGroup([toWorldRing(el.geometry.slice(0, -1))], grid);
    groups++;
  }
  // carve water out: OSM wood multipolygons sometimes swallow lakes when a
  // multi-way inner ring fails to stitch — no trees may stand on water
  try {
    const wbuf = await readFile(waterPath);
    const w = new Float32Array(wbuf.buffer, wbuf.byteOffset, wbuf.byteLength / 4);
    const gx = (x) => (x + halfW) * GRID / extentX;
    const gz = (z) => (z + halfH) * GRID / extentZ; // row 0 = north (z = −halfH)
    let erased = 0;
    for (let i = 0; i + 5 < w.length; i += 6) {
      const ax = gx(w[i]), az = gz(w[i + 1]);
      const bx = gx(w[i + 2]), bz = gz(w[i + 3]);
      const cx = gx(w[i + 4]), cz = gz(w[i + 5]);
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (d === 0) continue;
      const r0 = Math.max(0, Math.floor(Math.min(az, bz, cz)));
      const r1 = Math.min(GRID - 1, Math.ceil(Math.max(az, bz, cz)));
      const c0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const c1 = Math.min(GRID - 1, Math.ceil(Math.max(ax, bx, cx)));
      for (let r = r0; r <= r1; r++) {
        const py = r + 0.5;
        for (let c = c0; c <= c1; c++) {
          if (!grid[r * GRID + c]) continue;
          const px = c + 0.5;
          const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (py - cz)) / d;
          const l2 = ((cz - az) * (px - cx) + (ax - cx) * (py - cz)) / d;
          if (l1 >= -0.02 && l2 >= -0.02 && 1 - l1 - l2 >= -0.02) {
            grid[r * GRID + c] = 0; erased++;
          }
        }
      }
    }
    console.log(`  carved water out of forest mask: ${erased} cells`);
  } catch { console.log('  no water.bin — forest mask not carved'); }

  await writeFile(forestPath, grid);
  let filled = 0;
  for (const v of grid) if (v) filled++;
  console.log(`wrote forest.bin: ${groups} polygon groups, coverage ${(filled / grid.length * 100).toFixed(1)} %`);
}

// ── trails.json ──────────────────────────────────────────────────────────
const trailsPath = path.join(dataDir, 'trails.json');
if (existsSync(trailsPath)) {
  console.log('trails.json exists — skipping (delete it to refetch)');
} else {
  await bakeTrails();
}

function parseMtbScale(v) {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[sS]/g, '').replace(/[+-]/g, '').trim(), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(6, n)) : null;
}

async function bakeTrails() {
  const elements = await overpass(`
    [out:json][timeout:120];
    way["mtb:scale"](${bbox});
    out geom;
  `, 'mtb trails');

  const trails = [];
  let kept = 0, droppedWays = 0, totalPts = 0;
  const hist = {};
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const tags = el.tags ?? {};
    const scale = parseMtbScale(tags['mtb:scale']);
    // Keep singletrack-ish ways: paths, or anything rated S1+ (drops plain S0 forest tracks).
    if (!(tags.highway === 'path' || (scale !== null && scale >= 1))) { droppedWays++; continue; }
    const s = scale ?? 0;
    const imba = tags['mtb:scale:imba'] !== undefined ? 1 : 0;
    let run = [];
    const runs = [];
    const flush = () => {
      if (run.length >= 2) runs.push(run);
      run = [];
    };
    for (const g of el.geometry) {
      const world = g ? toWorld(g.lon, g.lat) : null;
      if (!world || !inside(world)) { flush(); continue; }
      run.push([round1(world[0]), round1(world[1])]);
    }
    flush();
    if (!runs.length) { droppedWays++; continue; }
    kept++;
    hist[s] = (hist[s] ?? 0) + runs.length;
    for (const points of runs) {
      const entry = { s, imba, points };
      if (tags.name) entry.name = tags.name;
      trails.push(entry);
      totalPts += points.length;
    }
  }
  await writeFile(trailsPath, JSON.stringify(trails));
  console.log(`wrote trails.json: ${kept} ways kept (${trails.length} runs), ${droppedWays} dropped, ${totalPts} points`);
  console.log('  runs by mtb:scale:', JSON.stringify(hist));
}

// ── verify all outputs ───────────────────────────────────────────────────
console.log('\nverifying outputs …');
const assert = (cond, msg) => { if (!cond) throw new Error(`VERIFY FAILED: ${msg}`); };
const LIMX = halfW + 100, LIMZ = halfH + 100;

{
  const buf = await readFile(waterPath);
  assert(buf.byteLength % 24 === 0, `water.bin byteLength ${buf.byteLength} not divisible by 24`);
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  let area = 0;
  for (let i = 0; i < f.length; i += 6) {
    for (let k = 0; k < 6; k++) assert(Number.isFinite(f[i + k]) && Math.abs(f[i + k]) <= (k % 2 === 0 ? LIMX : LIMZ), `water coord ${f[i + k]} at ${i + k}`);
    area += Math.abs((f[i + 2] - f[i]) * (f[i + 5] - f[i + 1]) - (f[i + 4] - f[i]) * (f[i + 3] - f[i + 1])) / 2;
  }
  console.log(`water.bin OK: ${f.length / 6} triangles, ${(area / 1e6).toFixed(2)} km²`);
}
{
  const buf = await readFile(buildingsPath);
  assert(buf.byteLength % 24 === 0, `buildings.bin byteLength ${buf.byteLength} not divisible by 24`);
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  for (let i = 0; i < f.length; i += 6) {
    const [bx, bz, hw, hd, ang, h] = f.subarray(i, i + 6);
    assert(Number.isFinite(bx) && Number.isFinite(bz) && Math.abs(bx) <= halfW && Math.abs(bz) <= halfH, `building centre ${bx},${bz}`);
    assert(hw >= 1 && hw <= 120 && hd >= 1 && hd <= 120, `building half-extents ${hw},${hd}`);
    assert(Number.isFinite(ang) && Math.abs(ang) <= Math.PI / 2 + 1e-6, `building angle ${ang}`);
    assert(h >= 2.5 && h <= 40, `building height ${h}`);
  }
  console.log(`buildings.bin OK: ${f.length / 6} records; samples:`);
  const step = Math.max(6, Math.floor(f.length / 5 / 6) * 6);
  for (let i = 0; i < f.length && i < step * 5; i += step) {
    console.log('  ', Array.from(f.subarray(i, i + 6)).map((v) => v.toFixed(2)).join(', '));
  }
}
{
  const buf = await readFile(forestPath);
  assert(buf.byteLength === GRID * GRID, `forest.bin byteLength ${buf.byteLength} ≠ ${GRID * GRID}`);
  let filled = 0;
  for (const v of buf) { assert(v === 0 || v === 255, `forest value ${v}`); if (v) filled++; }
  console.log(`forest.bin OK: coverage ${(filled / buf.length * 100).toFixed(1)} %`);
}
{
  const trails = JSON.parse(await readFile(trailsPath, 'utf8'));
  assert(Array.isArray(trails) && trails.length > 0, 'trails.json empty');
  for (const t of trails) {
    assert(Number.isInteger(t.s) && t.s >= 0 && t.s <= 6, `trail s ${t.s}`);
    assert(t.imba === 0 || t.imba === 1, `trail imba ${t.imba}`);
    assert(Array.isArray(t.points) && t.points.length >= 2, 'trail with < 2 points');
    for (const [x, z] of t.points) assert(Number.isFinite(x) && Number.isFinite(z) && Math.abs(x) <= halfW && Math.abs(z) <= halfH, `trail point ${x},${z}`);
  }
  console.log(`trails.json OK: ${trails.length} runs; samples:`);
  for (const t of trails.slice(0, 3)) {
    console.log(`   s=${t.s} imba=${t.imba} name=${t.name ?? '—'} points=${t.points.length}`);
  }
}
console.log('all outputs verified');
