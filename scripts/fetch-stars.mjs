// Bake a real star catalogue for the night sky: HYG database (Yale BSC +
// Hipparcos merge, public domain) filtered to naked-eye stars.
// Output: public/data/stars.json — [[raDeg, decDeg, mag, colorIndex], ...]

import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const out = path.resolve(import.meta.dirname, '../public/data/stars.json');
if (existsSync(out)) {
  console.log('stars.json exists — delete to refetch');
  process.exit(0);
}

const CANDIDATES = [
  'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv',
  'https://raw.githubusercontent.com/astronexus/HYG-Database/master/hygdata_v3.csv',
  'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/v3/hyg_v37.csv',
];

let csv = null;
for (const url of CANDIDATES) {
  try {
    console.log('trying', url);
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    csv = await res.text();
    console.log(`ok: ${(csv.length / 1e6).toFixed(1)} MB`);
    break;
  } catch (err) {
    console.log('  failed:', err.message);
  }
}
if (!csv) throw new Error('no star catalogue source reachable');

const lines = csv.split('\n');
const unq = (s) => s.replaceAll('"', '');
const header = lines[0].split(',').map(unq);
const col = (name) => header.indexOf(name);
const iRa = col('ra'), iDec = col('dec'), iMag = col('mag'), iCi = col('ci');
if (iRa < 0 || iDec < 0 || iMag < 0) throw new Error(`unexpected header: ${lines[0].slice(0, 120)}`);

const stars = [];
for (let i = 1; i < lines.length; i++) {
  const f = lines[i].split(',').map(unq);
  const mag = parseFloat(f[iMag]);
  if (!Number.isFinite(mag) || mag > 5.0) continue; // naked-eye limit
  const ra = parseFloat(f[iRa]) * 15; // hours → degrees
  const dec = parseFloat(f[iDec]);
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
  if (mag < -20) continue; // the Sun is in HYG — skip it
  const ci = parseFloat(f[iCi]);
  stars.push([+ra.toFixed(3), +dec.toFixed(3), +mag.toFixed(2),
    Number.isFinite(ci) ? +ci.toFixed(2) : 0.5]);
}
stars.sort((a, b) => a[2] - b[2]);
await writeFile(out, JSON.stringify(stars));
console.log(`wrote ${stars.length} stars (brightest: mag ${stars[0]?.[2]}, faintest kept: ${stars[stars.length - 1]?.[2]})`);
