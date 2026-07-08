// Fetch ČÚZK open data for the Halouny / Hřebeny area and bake viewer assets.
//
// Sources (both S-JTSK / Krovak East North, EPSG:5514):
//   DMR 5G  — LIDAR-derived terrain model, 2 m grid, Float32 metres (Bpv)
//             https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer
//   ORTOFOTO — aerial imagery
//             https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO/MapServer
//
// The DEM renderer 500s above ~2560 px per dimension (regardless of the
// advertised 15000×4100 limit), so the 20 × 20 km cut is fetched as a 3×3
// grid of 2048² tiles (merged here) and four ortho quadrants (selected
// per-fragment in the shader).
//
// Output in public/data/:
//   heightmap.bin           Uint16 LE, row-major, row 0 = north
//   meta.json               extent, elevation range, WGS-84 corners
//   ortho_{00,10,01,11}.jpg quadrants, suffix = <xIndex><yIndex>, y 0 = south

import { fromArrayBuffer } from 'geotiff';
import proj4 from 'proj4';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CENTER_LONLAT = [14.1978160, 49.8878183]; // K Vodárně 132, Halouny
const HALF_SIZE_M = 10_000;                     // 20 × 20 km extent
const HEIGHT_PX = 6144;                         // ~3.26 m/px from 2 m source
const ORTHO_TILE_PX = 4096;                     // per quadrant → ~2.44 m/px

proj4.defs('EPSG:5514',
  '+proj=krovak +lat_0=49.5 +lon_0=24.83333333333333 ' +
  '+alpha=30.28813972222222 +k=0.9999 +x_0=0 +y_0=0 ' +
  '+ellps=bessel +towgs84=589,76,480,0,0,0,0 +units=m +no_defs');

const [cx, cy] = proj4('EPSG:4326', 'EPSG:5514', CENTER_LONLAT);
const bbox = [cx - HALF_SIZE_M, cy - HALF_SIZE_M, cx + HALF_SIZE_M, cy + HALF_SIZE_M];
console.log('center S-JTSK:', cx.toFixed(1), cy.toFixed(1));
console.log('bbox:', bbox.map(v => v.toFixed(1)).join(', '));

const outDir = path.resolve(import.meta.dirname, '../public/data');
await mkdir(outDir, { recursive: true });

async function fetchBinary(url, label, timeoutMs = 600_000) {
  console.log(`fetching ${label} …`);
  const t0 = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const ct = res.headers.get('content-type');
  console.log(`${label}: ${(buf.byteLength / 1e6).toFixed(1)} MB, ${ct}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (ct?.includes('json')) throw new Error(`${label} returned JSON error: ${Buffer.from(buf).toString().slice(0, 400)}`);
  return buf;
}

// ── elevation: 3×3 grid of tiles ─────────────────────────────────────────
async function fetchDemTile(tileBbox, widthPx, heightPx, label) {
  const url = 'https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage?' +
    new URLSearchParams({
      bbox: tileBbox.join(','), bboxSR: '5514', imageSR: '5514',
      size: `${widthPx},${heightPx}`,
      format: 'tiff', pixelType: 'F32',
      interpolation: 'RSP_BilinearInterpolation',
      f: 'image',
    });
  const buf = await fetchBinary(url, label);
  const image = await (await fromArrayBuffer(buf)).getImage();
  if (image.getWidth() !== widthPx || image.getHeight() !== heightPx) {
    throw new Error(`${label}: unexpected raster size ${image.getWidth()}×${image.getHeight()}`);
  }
  const [raster] = await image.readRasters();
  return raster; // Float32Array, row 0 = northern edge of the tile
}

const TILES = 3;
const tilePx = HEIGHT_PX / TILES;               // 2048
const tileM = (HALF_SIZE_M * 2) / TILES;        // 6666.67 m
const raster = new Float32Array(HEIGHT_PX * HEIGHT_PX);
for (let ty = 0; ty < TILES; ty++) {            // ty 0 = north row of tiles
  for (let tx = 0; tx < TILES; tx++) {
    const tileBbox = [
      bbox[0] + tx * tileM, bbox[3] - (ty + 1) * tileM,
      bbox[0] + (tx + 1) * tileM, bbox[3] - ty * tileM,
    ];
    const tile = await fetchDemTile(tileBbox, tilePx, tilePx, `DMR 5G tile ${tx},${ty}`);
    for (let row = 0; row < tilePx; row++) {
      raster.set(
        tile.subarray(row * tilePx, (row + 1) * tilePx),
        (ty * tilePx + row) * HEIGHT_PX + tx * tilePx,
      );
    }
  }
}

// stats + nodata guard (area is fully inside CZ, but be safe)
let min = Infinity, max = -Infinity, bad = 0;
for (const v of raster) {
  if (!Number.isFinite(v) || v < -100 || v > 2000) { bad++; continue; }
  if (v < min) min = v;
  if (v > max) max = v;
}
console.log(`elevation: min=${min.toFixed(1)} max=${max.toFixed(1)} m, invalid px=${bad}`);
if (bad > raster.length * 0.01) throw new Error('too many nodata pixels — check bbox');

const q = new Uint16Array(raster.length);
const range = max - min;
for (let i = 0; i < raster.length; i++) {
  const v = raster[i];
  const c = (!Number.isFinite(v) || v < -100 || v > 2000) ? min : v;
  q[i] = Math.round(((c - min) / range) * 65535);
}
await writeFile(path.join(outDir, 'heightmap.bin'), Buffer.from(q.buffer));

const inv = (x, y) => proj4('EPSG:5514', 'EPSG:4326', [x, y]);
await writeFile(path.join(outDir, 'meta.json'), JSON.stringify({
  source: 'ČÚZK DMR 5G (airborne LIDAR), ČÚZK Ortofoto ČR',
  centerLonLat: CENTER_LONLAT,
  centerSJTSK: [cx, cy],
  bboxSJTSK: bbox,
  extentMeters: HALF_SIZE_M * 2,
  gridSize: HEIGHT_PX,
  minElevation: min,
  maxElevation: max,
  cornersLonLat: {
    sw: inv(bbox[0], bbox[1]), se: inv(bbox[2], bbox[1]),
    nw: inv(bbox[0], bbox[3]), ne: inv(bbox[2], bbox[3]),
  },
}, null, 2));
console.log('wrote heightmap.bin + meta.json');

// ── orthophoto: 2×2 quadrants + high-res centre tile ─────────────────────
async function fetchOrtho(oBbox, sizePx, file, label) {
  const url = 'https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO/MapServer/export?' +
    new URLSearchParams({
      bbox: oBbox.join(','), bboxSR: '5514', imageSR: '5514',
      size: `${sizePx},${sizePx}`,
      format: 'jpg', f: 'image',
    });
  const buf = await fetchBinary(url, label);
  await writeFile(path.join(outDir, file), Buffer.from(buf));
}

for (const ix of [0, 1]) {
  for (const iy of [0, 1]) {
    const qBbox = [
      bbox[0] + ix * HALF_SIZE_M, bbox[1] + iy * HALF_SIZE_M,
      bbox[0] + (ix + 1) * HALF_SIZE_M, bbox[1] + (iy + 1) * HALF_SIZE_M,
    ];
    await fetchOrtho(qBbox, ORTHO_TILE_PX, `ortho_${ix}${iy}.jpg`, `ortofoto quadrant ${ix}${iy}`);
  }
}

// centre 5 × 5 km at ~1.2 m/px — the subject of the piece gets extra detail
const CENTER_TILE_M = (HALF_SIZE_M * 2) / 4;
await fetchOrtho(
  [cx - CENTER_TILE_M / 2, cy - CENTER_TILE_M / 2, cx + CENTER_TILE_M / 2, cy + CENTER_TILE_M / 2],
  ORTHO_TILE_PX, 'ortho_c.jpg', 'ortofoto centre tile');
console.log('done');
