// Region-of-interest mask for the Garda map: everything outside the
// Provincia di Trento — the Garda Trentino side of the lake — sinks into
// fog, with full visibility kept for a 3 km buffer beyond the border and a
// smooth fade to nothing by ~6.5 km. The provincial boundary comes from
// OSM (ODbL); the mask is an 8-bit grayscale PNG in the map frame
// (255 = clear, 0 = full fog) sampled by the terrain, building and tree
// shaders and by the label layer. AREA=garda.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { resolveFrame } from './area-frame.mjs';

const { toWorld, halfW, halfH, dataDir, area } = resolveFrame();
if (area.id !== 'garda') throw new Error('run with AREA=garda');

const KEEP_M = 3000;   // fully clear buffer beyond the border
const FADE_M = 3500;   // fog ramp width after the buffer
const W = 512;         // mask texels east-west (~78 m/px)
const H = Math.round(W * (halfH / halfW)); // keep the frame's aspect

// ── boundary from OSM ───────────────────────────────────────────────────
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
async function overpass(query, label) {
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
        return json.elements;
      } catch (err) {
        lastError = err;
        console.log(`  failed on ${new URL(endpoint).host}: ${err.message} — retrying`);
        await new Promise((r) => setTimeout(r, 8000));
      }
    }
  }
  throw new Error(`overpass ${label}: all endpoints failed (${lastError?.message})`);
}

const nodeKey = (g) => `${g.lon.toFixed(7)}|${g.lat.toFixed(7)}`;
function stitchRings(geometries) {
  const rings = [];
  const open = [];
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
    if (nodeKey(ring[0]) === nodeKey(ring[ring.length - 1]) && ring.length >= 4) {
      rings.push(ring.slice(0, -1));
    }
  }
  return rings;
}

const elements = await overpass(
  '[out:json][timeout:120];'
  + 'relation["boundary"="administrative"]["admin_level"="6"]'
  + '["name"="Provincia di Trento"];out body;way(r);out geom;',
  'Provincia di Trento boundary');
const relation = elements.find((e) => e.type === 'relation');
const wayById = new Map(elements.filter((e) => e.type === 'way').map((w) => [w.id, w]));
const outerGeoms = (relation.members ?? [])
  .filter((m) => m.type === 'way' && m.role !== 'inner')
  .map((m) => wayById.get(m.ref)?.geometry)
  .filter(Boolean);
const rings = stitchRings(outerGeoms).map((ring) => ring.map((g) => toWorld(g.lon, g.lat)));
console.log(`${rings.length} ring(s), ${rings.reduce((s, r) => s + r.length, 0)} vertices`);

// ── rasterize: scanline parity fill + distance band to the border ───────
const px2x = (i) => -halfW + ((i + 0.5) / W) * 2 * halfW;
const px2z = (j) => -halfH + ((j + 0.5) / H) * 2 * halfH;

const inside = new Uint8Array(W * H);
for (let j = 0; j < H; j++) {
  const z = px2z(j);
  const xs = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i];
      const [bx, bz] = ring[(i + 1) % ring.length];
      if ((az > z) !== (bz > z)) xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
    }
  }
  xs.sort((a, b) => a - b);
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const i0 = Math.max(0, Math.ceil((xs[k] + halfW) / (2 * halfW) * W - 0.5));
    const i1 = Math.min(W - 1, Math.floor((xs[k + 1] + halfW) / (2 * halfW) * W - 0.5));
    for (let i = i0; i <= i1; i++) inside[j * W + i] = 1;
  }
}
console.log(`inside: ${(100 * inside.reduce((s, v) => s + v, 0) / (W * H)).toFixed(1)} % of frame`);

// boundary segments near the frame, bucketed for the distance queries
const CELL = 1000;
const buckets = new Map();
const margin = KEEP_M + FADE_M + 2 * CELL;
for (const ring of rings) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (Math.max(Math.abs(a[0]), Math.abs(b[0])) > halfW + margin) continue;
    if (Math.max(Math.abs(a[1]), Math.abs(b[1])) > halfH + margin) continue;
    const k = `${Math.floor((a[0] + b[0]) / 2 / CELL)},${Math.floor((a[1] + b[1]) / 2 / CELL)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push([a[0], a[1], b[0], b[1]]);
  }
}

function distToBorder(x, z, limit) {
  const r = Math.ceil(limit / CELL);
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  let best = limit * limit;
  for (let ix = cx - r; ix <= cx + r; ix++) {
    for (let iz = cz - r; iz <= cz + r; iz++) {
      for (const [ax, az, bx, bz] of buckets.get(`${ix},${iz}`) ?? []) {
        const dx = bx - ax, dz = bz - az;
        const t = Math.max(0, Math.min(1,
          ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
        const d2 = (x - (ax + t * dx)) ** 2 + (z - (az + t * dz)) ** 2;
        if (d2 < best) best = d2;
      }
    }
  }
  return Math.sqrt(best);
}

const mask = new Uint8Array(W * H);
const LIMIT = KEEP_M + FADE_M;
for (let j = 0; j < H; j++) {
  for (let i = 0; i < W; i++) {
    const o = j * W + i;
    if (inside[o]) { mask[o] = 255; continue; }
    const d = distToBorder(px2x(i), px2z(j), LIMIT + CELL);
    const t = (d - KEEP_M) / FADE_M; // 0 at buffer edge → 1 at full fog
    const f = t <= 0 ? 1 : t >= 1 ? 0 : (1 - t) * (1 - t) * (3 - 2 * (1 - t)); // smoothstep
    mask[o] = Math.round(255 * Math.max(0, Math.min(1, f)));
  }
}

const out = path.join(dataDir, 'region.png');
await sharp(Buffer.from(mask), { raw: { width: W, height: H, channels: 1 } })
  .png({ compressionLevel: 9 }).toFile(out);
console.log(`wrote ${out} (${W}×${H}, ${(fs.statSync(out).size / 1024).toFixed(0)} kB)`);
