// Bake Garda terrain + orthophoto (sources verified 2026-07-03, see README):
//   heightmap.bin — TINITALY 10 m DEM (INGV, CC BY 4.0), native UTM 32N,
//                   bilinear-resampled to a 4096² grid over the 20×20 km cut
//   ortho_*.jpg   — AGEA 2012 national orthophoto (Geoportale Nazionale WMS,
//                   "Nessuna condizione applicata"), ~50 cm native, fetched as
//                   2048 px tiles (server cap) and stitched with sharp
//   meta.json     — same shape the Halouny bake writes; app reads it as-is
// Run: AREA=garda TINITALY_DIR=<dir with w50560_s10.tif + w50565_s10.tif> \
//        node scripts/fetch-data-garda.mjs
// Outputs are resume-skipped if they already exist (delete to refetch).

import { fromFile } from 'geotiff';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveFrame } from './area-frame.mjs';

process.env.AREA ??= 'garda';
const { area, cx, cy, halfW, halfH, cornersLonLat, dataDir } = resolveFrame();
await mkdir(dataDir, { recursive: true });

const GRIDX = 4096, GRIDZ = 6144;     // heightmap px (~9.8/9.9 m/px, ≈ source native)
const ORTHO_TILE_PX = 4096;           // per quadrant and centre tile (px, square)
const WMS_MAX = 2048;                 // PCN server cap per request
const bboxProj = [cx - halfW, cy - halfH, cx + halfW, cy + halfH]; // UTM 32N, SW-origin

// ── DEM: TINITALY tiles → 4096² Uint16 heightmap ───────────────────────────
const tinitalyDir = process.env.TINITALY_DIR;
const heightPath = path.join(dataDir, 'heightmap.bin');
const metaPath = path.join(dataDir, 'meta.json');

if (existsSync(heightPath) && existsSync(metaPath)) {
  console.log('heightmap.bin + meta.json exist — skipping DEM (delete to rebake)');
} else {
  if (!tinitalyDir) throw new Error('set TINITALY_DIR to the dir holding the unzipped TINITALY tiles');
  await bakeDem();
}

async function loadTile(name) {
  const tif = await fromFile(path.join(tinitalyDir, name));
  const image = await tif.getImage();
  const [ox, oy] = image.getOrigin();          // top-left corner, UTM 32N
  const [rx, ry] = image.getResolution();      // [10, -10]
  const [raster] = await image.readRasters();
  console.log(`${name}: ${image.getWidth()}×${image.getHeight()} px, origin E ${ox} N ${oy}`);
  return { data: raster, w: image.getWidth(), h: image.getHeight(), ox, oy, rx, ry };
}

function sampleTile(t, E, N) {
  const fx = (E - t.ox) / t.rx;
  const fy = (N - t.oy) / t.ry;                // ry negative → rows go south
  if (fx < 0 || fy < 0 || fx > t.w - 1 || fy > t.h - 1) return null;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, t.w - 1), y1 = Math.min(y0 + 1, t.h - 1);
  const ax = fx - x0, ay = fy - y0;
  const v00 = t.data[y0 * t.w + x0], v10 = t.data[y0 * t.w + x1];
  const v01 = t.data[y1 * t.w + x0], v11 = t.data[y1 * t.w + x1];
  if (Math.min(v00, v10, v01, v11) < -100) return null; // nodata
  return (v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay;
}

async function bakeDem() {
  const tiles = [];
  for (const name of ['w50560_s10.tif', 'w50565_s10.tif', 'w50060_s10.tif', 'w50065_s10.tif']) {
    tiles.push(await loadTile(name));
  }
  const stepX = (halfW * 2) / GRIDX;
  const stepZ = (halfH * 2) / GRIDZ;
  const values = new Float32Array(GRIDX * GRIDZ);
  let min = Infinity, max = -Infinity, misses = 0;
  for (let r = 0; r < GRIDZ; r++) {          // row 0 = north edge (like Halouny)
    const N = cy + halfH - (r + 0.5) * stepZ;
    for (let c = 0; c < GRIDX; c++) {
      const E = cx - halfW + (c + 0.5) * stepX;
      let v = null;
      for (const t of tiles) { v = sampleTile(t, E, N); if (v !== null) break; }
      if (v === null) { misses++; v = 65; } // Lake Garda surface ≈ 65 m
      values[r * GRIDX + c] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (r % 512 === 0) console.log(`resample row ${r}/${GRIDZ}`);
  }
  console.log(`elevation ${min.toFixed(1)}–${max.toFixed(1)} m, nodata fills: ${misses}`);
  const q = new Uint16Array(GRIDX * GRIDZ);
  const range = max - min;
  for (let i = 0; i < q.length; i++) q[i] = Math.round(((values[i] - min) / range) * 65535);
  await writeFile(heightPath, Buffer.from(q.buffer));
  await writeFile(metaPath, JSON.stringify({
    source: 'TINITALY 1.1 DEM 10 m © INGV (CC BY 4.0, doi:10.13127/tinitaly/1.1), '
      + 'Ortofoto AGEA 2012 — Geoportale Nazionale (PCN)',
    centerLonLat: [area.lon, area.lat],
    centerProjected: [cx, cy],
    projection: 'EPSG:32632',
    bboxProjected: bboxProj,
    extentMetersX: halfW * 2,
    extentMetersZ: halfH * 2,
    gridSizeX: GRIDX,
    gridSizeZ: GRIDZ,
    minElevation: min,
    maxElevation: max,
    cornersLonLat,
  }, null, 2));
  console.log(`wrote heightmap.bin (${(q.byteLength / 1e6).toFixed(1)} MB) + meta.json`);
}

// ── ortho: AGEA 2012 WMS, tiled at the 2048 px cap and stitched ────────────
const WMS = 'http://wms.pcn.minambiente.it/ogc?map=/ms_ogc/WMS_v1.3/raster/ortofoto_colore_12.map';

async function wmsTile(tileBbox, px, label, attempt = 1) {
  const url = `${WMS}&service=WMS&version=1.3.0&request=GetMap`
    + `&layers=OI.ORTOIMMAGINI.2012.32&styles=&crs=EPSG:32632`
    + `&bbox=${tileBbox.join(',')}&width=${px}&height=${px}&format=image/jpeg`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000 || buf.subarray(0, 40).toString().includes('<?xml')) {
      throw new Error(`server returned ${buf.length} B / xml error`);
    }
    console.log(`  ${label}: ${(buf.length / 1e6).toFixed(2)} MB`);
    return buf;
  } catch (err) {
    if (attempt >= 4) throw err;
    console.log(`  ${label}: ${err.message} — retry ${attempt}`);
    await new Promise((r) => setTimeout(r, 6000 * attempt));
    return wmsTile(tileBbox, px, label, attempt + 1);
  }
}

/** Fetch a rectangle as 2×2 WMS subtiles and stitch to one square JPEG
 *  (pixels may be anisotropic in metres — sampling is normalized). */
async function bakeOrtho(outName, x0, y0, sizeXM, sizeZM) {
  const outPath = path.join(dataDir, outName);
  if (existsSync(outPath)) { console.log(`${outName} exists — skipping`); return; }
  console.log(`${outName} (${sizeXM / 1000}×${sizeZM / 1000} km @ ${ORTHO_TILE_PX} px)…`);
  const subX = sizeXM / 2, subY = sizeZM / 2;
  const composites = [];
  for (let sy = 0; sy < 2; sy++) {          // sy 0 = south
    for (let sx = 0; sx < 2; sx++) {
      const bb = [x0 + sx * subX, y0 + sy * subY, x0 + (sx + 1) * subX, y0 + (sy + 1) * subY];
      const buf = await wmsTile(bb, WMS_MAX, `${outName} ${sx}${sy}`);
      composites.push({ input: buf, left: sx * WMS_MAX, top: (1 - sy) * WMS_MAX });
      await new Promise((r) => setTimeout(r, 1200)); // be polite to PCN
    }
  }
  const jpg = await sharp({ create: {
    width: ORTHO_TILE_PX, height: ORTHO_TILE_PX, channels: 3,
    background: { r: 40, g: 44, b: 48 },
  } }).composite(composites).jpeg({ quality: 87 }).toBuffer();
  await writeFile(outPath, jpg);
  console.log(`wrote ${outName} (${(jpg.length / 1e6).toFixed(1)} MB)`);
}

for (const [ix, iy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
  await bakeOrtho(`ortho_${ix}${iy}.jpg`,
    bboxProj[0] + ix * halfW, bboxProj[1] + iy * halfH, halfW, halfH);
}
await bakeOrtho('ortho_c.jpg', cx - halfW / 4, cy - halfH / 4, halfW / 2, halfH / 2);

console.log('garda bake complete');
