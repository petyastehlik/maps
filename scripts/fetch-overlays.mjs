// Fetch OpenStreetMap overlays for one area (AREA=<id> env, default halouny):
//   landmarks.json — settlements, named peaks, castles  → [{name, type, x, z, ele?}]
//   cycling.json   — bicycle route ways                 → [{id, name, points: [[x,z]…]}]
// World frame matches the viewer: origin at map centre, +x east, −z north, metres.

import { writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveFrame } from './area-frame.mjs';

const { toWorld, halfW, halfH, bbox, dataDir } = resolveFrame();
mkdirSync(dataDir, { recursive: true });
console.log('overpass bbox:', bbox);

const inside = ([x, z]) => Math.abs(x) <= halfW && Math.abs(z) <= halfH;

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
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'halouny-lidar-map/1.0 (one-off data bake)',
          },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(180_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        console.log(`${label}: ${json.elements.length} elements`);
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

// ── landmarks ────────────────────────────────────────────────────────────
const landmarksPath = path.join(dataDir, 'landmarks.json');
if (existsSync(landmarksPath)) {
  console.log('landmarks.json exists — skipping (delete it to refetch)');
} else {
  await fetchLandmarks();
}

async function fetchLandmarks() {
const landmarkElements = await overpass(`
  [out:json][timeout:90];
  (
    node["place"~"^(city|town|village|hamlet)$"](${bbox});
    node["natural"="peak"]["name"](${bbox});
    nwr["historic"="castle"]["name"]["castle_type"!="manor"](${bbox});
  );
  out center;
`, 'landmarks');

const landmarks = [];
for (const el of landmarkElements) {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const name = el.tags?.name;
  if (lat === undefined || !name) continue;
  const [x, z] = toWorld(lon, lat);
  if (!inside([x, z])) continue;
  const type = el.tags.historic === 'castle' ? 'castle'
    : el.tags.natural === 'peak' ? 'peak'
    : el.tags.place; // city | town | village | hamlet
  const entry = { name, type, x: Math.round(x), z: Math.round(z) };
  const ele = parseFloat(el.tags.ele);
  if (type === 'peak' && Number.isFinite(ele)) entry.ele = Math.round(ele);
  landmarks.push(entry);
}
// stable order: important first (helps debugging, not rendering)
const typeRank = { city: 0, town: 1, castle: 2, village: 3, peak: 4, hamlet: 5 };
landmarks.sort((a, b) => typeRank[a.type] - typeRank[b.type] || a.name.localeCompare(b.name, 'cs'));
await writeFile(path.join(dataDir, 'landmarks.json'), JSON.stringify(landmarks, null, 1));
console.log(`wrote landmarks.json (${landmarks.length}):`,
  landmarks.slice(0, 12).map(l => `${l.name}/${l.type}`).join(', '), '…');
}

// ── cycling routes ───────────────────────────────────────────────────────
const cyclingPath = path.join(dataDir, 'cycling.json');
if (existsSync(cyclingPath)) {
  console.log('cycling.json exists — skipping (delete it to refetch)');
} else {
  await fetchCycling();
}

async function fetchCycling() {
const routeElements = await overpass(`
  [out:json][timeout:150];
  relation["route"="bicycle"](${bbox});
  out geom(${bbox});
`, 'cycling routes');

// `out geom(bbox)` emits null for nodes outside the bbox, and the lon/lat bbox
// is wider than the rotated S-JTSK square — split ways into contiguous runs of
// points that are inside the model, one polyline per run.
const seenWays = new Set();
const ways = [];
for (const rel of routeElements) {
  const routeName = rel.tags?.ref || rel.tags?.name || '';
  for (const member of rel.members ?? []) {
    if (member.type !== 'way' || !member.geometry || seenWays.has(member.ref)) continue;
    seenWays.add(member.ref);
    let run = [];
    const flush = () => {
      if (run.length >= 2) ways.push({ id: member.ref, name: routeName, points: run });
      run = [];
    };
    for (const g of member.geometry) {
      const world = g ? toWorld(g.lon, g.lat) : null;
      if (!world || !inside(world)) { flush(); continue; }
      run.push([Math.round(world[0] * 10) / 10, Math.round(world[1] * 10) / 10]);
    }
    flush();
  }
}
await writeFile(cyclingPath, JSON.stringify(ways));
const totalPts = ways.reduce((s, w) => s + w.points.length, 0);
console.log(`wrote cycling.json: ${ways.length} ways, ${totalPts} points`);
}
