// Convert the heavy data rasters from raw .bin to lossless PNG:
//   heightmap.bin (Uint16)  → heightmap.png  (16-bit grayscale)
//   h2/tile_*.bin (Uint16)  → h2/tile_*.png  (16-bit grayscale)
//   forest.bin    (Uint8)   → forest.png     (8-bit grayscale)
// Every file is decoded back and compared BYTE FOR BYTE before the .bin is
// considered replaceable — the app must see the exact same arrays.
// Run: node scripts/convert-data-png.mjs   (all areas, resume-safe)

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AREAS } from '../src/areas.js';
import { decodeGrayPNG } from '../src/png16.js';
import { encodeGrayPNG } from './png-encode.mjs';

let saved = 0;

function encodeGray(buf, width, height, depth) {
  const data = depth === 16
    ? new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
    : buf;
  return encodeGrayPNG(data, width, height);
}

// verify with the APP'S decoder — proves both the file and the exact
// decode path the browser will execute reproduce the original bytes
async function verifyRoundtrip(png, original, depth) {
  const { data, depth: gotDepth } = await decodeGrayPNG(
    png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
  if (gotDepth !== depth) throw new Error(`roundtrip: depth ${gotDepth} vs ${depth}`);
  const b = depth === 16
    ? new Uint16Array(original.buffer, original.byteOffset, original.byteLength / 2)
    : original;
  if (data.length !== b.length) throw new Error(`roundtrip: length ${data.length} vs ${b.length}`);
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== b[i]) throw new Error(`roundtrip: mismatch at ${i}: ${data[i]} vs ${b[i]}`);
  }
}

async function convert(binPath, width, height, depth) {
  const pngPath = binPath.replace(/\.bin$/, '.png');
  if (existsSync(pngPath)) { console.log(`  ${path.basename(pngPath)} exists — skipping`); return; }
  if (!existsSync(binPath)) { console.log(`  ${path.basename(binPath)} missing — skipping`); return; }
  const bin = new Uint8Array(await readFile(binPath));
  const png = encodeGray(bin, width, height, depth);
  await verifyRoundtrip(png, bin, depth);
  await writeFile(pngPath, png);
  const ratio = png.length / bin.length;
  saved += bin.length - png.length;
  console.log(`  ${path.basename(binPath)} ${(bin.length / 1e6).toFixed(1)} MB → `
    + `${(png.length / 1e6).toFixed(1)} MB (${(ratio * 100).toFixed(0)} %) ✓ bit-exact`);
}

for (const area of Object.values(AREAS)) {
  const dir = path.resolve(import.meta.dirname, '../public', area.dataDir.slice(1));
  if (!existsSync(path.join(dir, 'meta.json'))) continue;
  console.log(`${area.id}:`);
  const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
  const nx = meta.gridSizeX ?? meta.gridSize;
  const nz = meta.gridSizeZ ?? meta.gridSize;
  await convert(path.join(dir, 'heightmap.bin'), nx, nz, 16);
  if (existsSync(path.join(dir, 'forest.bin'))) {
    await convert(path.join(dir, 'forest.bin'), 2048, 2048, 8);
  }
  const h2 = path.join(dir, 'h2');
  if (existsSync(h2)) {
    for (const f of (await readdir(h2)).filter((f) => f.endsWith('.bin')).sort()) {
      await convert(path.join(h2, f), 1024, 1024, 16);
    }
  }
}
console.log(`total saved: ${(saved / 1e6).toFixed(1)} MB`);
