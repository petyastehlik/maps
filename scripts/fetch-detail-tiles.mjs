// Bake native 2 m DMR 5G tiles for the central 12 × 12 km of the map.
// 6×6 tiles, each 1024 px over 2048 m (2 m/px), quantized uint16 against the
// SAME global elevation range as heightmap.bin (meta.json), so the viewer can
// blend them freely. Resumable: existing tiles are skipped.
//
// Output: public/data/h2/tile_<tx>_<tz>.bin  (uint16 LE, row 0 = north)
//         tx 0..5 west→east, tz 0..5 north→south,
//         tile (tx,tz) covers x ∈ [-6144 + 2048·tx, …+2048], same for z.

import { fromArrayBuffer } from 'geotiff';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const TILE_PX = 1024;
const TILE_M = 2048;
const TILES = 6;
const HALF_SPAN = (TILES * TILE_M) / 2; // 6144 m

const dataDir = path.resolve(import.meta.dirname, '../public/data');
const outDir = path.join(dataDir, 'h2');
await mkdir(outDir, { recursive: true });

const meta = JSON.parse(readFileSync(path.join(dataDir, 'meta.json'), 'utf8'));
const [cx, cy] = meta.centerSJTSK;
const { minElevation: gMin, maxElevation: gMax } = meta;
const range = gMax - gMin;

async function fetchTile(tx, tz) {
  const file = path.join(outDir, `tile_${tx}_${tz}.bin`);
  if (existsSync(file)) { console.log(`tile ${tx},${tz} exists — skip`); return; }
  // world x east = S-JTSK x − cx; world z south = −(S-JTSK y − cy)
  const x0 = cx - HALF_SPAN + tx * TILE_M;
  const yTop = cy + HALF_SPAN - tz * TILE_M; // tz 0 = north row
  const bbox = [x0, yTop - TILE_M, x0 + TILE_M, yTop];
  const url = 'https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage?' +
    new URLSearchParams({
      bbox: bbox.join(','), bboxSR: '5514', imageSR: '5514',
      size: `${TILE_PX},${TILE_PX}`,
      format: 'tiff', pixelType: 'F32',
      interpolation: 'RSP_BilinearInterpolation',
      f: 'image',
    });
  for (let attempt = 1; ; attempt++) {
    try {
      const t0 = Date.now();
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const ct = res.headers.get('content-type');
      if (ct?.includes('json')) throw new Error(`server error: ${Buffer.from(buf).toString().slice(0, 200)}`);
      const image = await (await fromArrayBuffer(buf)).getImage();
      if (image.getWidth() !== TILE_PX) throw new Error(`bad size ${image.getWidth()}`);
      const [raster] = await image.readRasters();
      const q = new Uint16Array(TILE_PX * TILE_PX);
      let bad = 0;
      for (let i = 0; i < raster.length; i++) {
        const v = raster[i];
        const c = (!Number.isFinite(v) || v < -100 || v > 2000) ? (bad++, gMin) : v;
        q[i] = Math.max(0, Math.min(65535, Math.round(((c - gMin) / range) * 65535)));
      }
      await writeFile(file, Buffer.from(q.buffer));
      console.log(`tile ${tx},${tz}: ok (${((Date.now() - t0) / 1000).toFixed(1)}s, bad px ${bad})`);
      return;
    } catch (err) {
      if (attempt >= 3) throw new Error(`tile ${tx},${tz}: ${err.message}`);
      console.log(`tile ${tx},${tz} attempt ${attempt} failed (${err.message}) — retrying`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

for (let tz = 0; tz < TILES; tz++) {
  for (let tx = 0; tx < TILES; tx++) {
    await fetchTile(tx, tz);
  }
}
console.log('all detail tiles baked');
