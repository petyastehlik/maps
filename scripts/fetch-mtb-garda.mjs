// Official Garda Trentino MTB routes (the signed 7xx network — 743 & co.)
// baked from the tourist board's own Outdooractive project. The GPX for each
// tour comes from the same download endpoint the official site's "GPX" button
// uses; photos and metadata come from the same API project. Run with
// AREA=garda. Writes:
//   public/data/garda/routes.json       geometry (world frame) + metadata
//   public/data/garda/gpx/<sig>.gpx     the official GPX, served for download
//   public/data/garda/photos/mtb-*.jpg  route photos (attribution in routes.json)
//
// Each route's ITRS rating (the four-quadrant disc on the physical route
// signs — technical/endurance/exposure/rescue, graded verde/blu/rosso/nero)
// ships in the tour gallery as a pictogram named ITRS_<VBRN>{4}; the four
// letters are extracted here and the viewer redraws the disc as crisp SVG.

import fs from 'node:fs';
import path from 'node:path';
import { resolveFrame } from './area-frame.mjs';

const KEY = 'ATLFE9GX-EMWGKQIH-4OSSEBMT'; // public key embedded in gardatrentino.it
const PROJECT = 'api-gardatrentino';
const API = 'https://www.outdooractive.com';

const { toWorld, halfW, halfH, dataDir, area } = resolveFrame();
if (area.id !== 'garda') throw new Error('run with AREA=garda');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, type = 'json', tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return type === 'json' ? await res.json()
        : type === 'text' ? await res.text()
        : Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(1500 * (i + 1));
    }
  }
}


// ── 1 · enumerate the project's tours, keep the signed 7xx MTB network ─────
console.log('listing tours…');
const ids = (await get(`${API}/api/project/${PROJECT}/filter/tour?key=${KEY}`))
  .data.map((d) => d.id);
console.log(`${ids.length} tours in project`);

const tours = [];
const itById = new Map();
for (let i = 0; i < ids.length; i += 25) {
  const batch = ids.slice(i, i + 25).join(',');
  const d = await get(`${API}/api/project/${PROJECT}/oois/${batch}?key=${KEY}&lang=en`);
  tours.push(...(d.tour ?? []));
  await sleep(250);
  const di = await get(`${API}/api/project/${PROJECT}/oois/${batch}?key=${KEY}&lang=it`);
  for (const rec of di.tour ?? []) itById.set(rec.id, rec);
  await sleep(250);
}
console.log(`${tours.length} tour records (+${itById.size} italian)`);

// card blurb: first real paragraph of the official description (the
// signage line dropped), sentence-trimmed to a card-sized length
function blurb(rec) {
  const html = rec?.longText ?? '';
  const paras = html.split(/<p[^>]*>/i).map((p) =>
    p.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\u00a0/g, ' ')
      .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
    .filter((p) => p && !/^Signage/i.test(p) && !/^Segnaletica/i.test(p));
  let text = paras[0] ?? rec?.shortText?.replace(/<[^>]+>/g, ' ').trim() ?? '';
  if (text.length > 300) {
    const cut = text.slice(0, 300);
    text = cut.slice(0, Math.max(cut.lastIndexOf('. '), 180) + 1);
  }
  return text;
}

const inFrame = ([x, z]) => Math.abs(x) < halfW && Math.abs(z) < halfH;

const picked = [];
for (const t of tours) {
  if ((t.category?.name) !== 'Mountainbiking') continue;
  const sig = /Signage:\s*(?:<\/strong>)?\s*(7\d\d[a-z]?)\.?/
    .exec((t.longText ?? '').replace(/ /g, ' '))?.[1];
  if (!sig) continue;
  const pts = (t.geometry ?? '').split(' ').filter((p) => p.includes(','));
  const step = Math.max(1, Math.floor(pts.length / 200));
  let inside = 0, n = 0;
  for (let i = 0; i < pts.length; i += step) {
    const [lon, lat] = pts[i].split(',').map(Number);
    if (inFrame(toWorld(lon, lat))) inside++;
    n++;
  }
  if (inside / n < 0.45) continue; // different valley — not on this map
  picked.push({ t, sig, frameFrac: inside / n });
}
picked.sort((a, b) => a.sig.localeCompare(b.sig, 'en', { numeric: true }));
console.log(`${picked.length} signed 7xx routes in frame:`,
  picked.map((p) => p.sig).join(' '));

// ── 2 · OSM mtb:scale index — share of each route on graded singletrack ────
// trails.json (ODbL OpenStreetMap, baked by fetch-osm-3d.mjs) stays in the
// repo as input for this statistic even though garda no longer draws it.
const trails = JSON.parse(
  fs.readFileSync(path.join(dataDir, 'trails.json'), 'utf8'));
const CELL = 200;
const grid = new Map(); // "cx,cz" → [{x1,z1,x2,z2,s}]
for (const way of trails) {
  const s = Math.min(way.s ?? 0, 5); // S5 bucket swallows the s=6 outliers
  for (let i = 1; i < way.points.length; i++) {
    const seg = {
      x1: way.points[i - 1][0], z1: way.points[i - 1][1],
      x2: way.points[i][0], z2: way.points[i][1], s,
    };
    for (let cx = Math.floor(Math.min(seg.x1, seg.x2) / CELL);
      cx <= Math.floor(Math.max(seg.x1, seg.x2) / CELL); cx++) {
      for (let cz = Math.floor(Math.min(seg.z1, seg.z2) / CELL);
        cz <= Math.floor(Math.max(seg.z1, seg.z2) / CELL); cz++) {
        const k = `${cx},${cz}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(seg);
      }
    }
  }
}

/** mtb:scale grade of the singletrack under a point, or -1 off-trail. */
function gradeAt(px, pz) {
  const R2 = 25 * 25;
  const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
  let best = Infinity, grade = -1;
  for (let ix = cx - 1; ix <= cx + 1; ix++) {
    for (let iz = cz - 1; iz <= cz + 1; iz++) {
      for (const s of grid.get(`${ix},${iz}`) ?? []) {
        const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
        const t = Math.max(0, Math.min(1,
          ((px - s.x1) * dx + (pz - s.z1) * dz) / (dx * dx + dz * dz || 1)));
        const d2 = (px - (s.x1 + t * dx)) ** 2 + (pz - (s.z1 + t * dz)) ** 2;
        if (d2 < R2 && d2 < best) { best = d2; grade = s.s; }
      }
    }
  }
  return grade;
}

// ── 3 · geometry helpers ────────────────────────────────────────────────────
function simplifyDP(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = points[a], [bx, bz] = points[b];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1,
        ((points[i][0] - ax) * dx + (points[i][1] - az) * dz) / len2));
      const d2 = (points[i][0] - (ax + t * dx)) ** 2
        + (points[i][1] - (az + t * dz)) ** 2;
      if (d2 > worst) { worst = d2; at = i; }
    }
    if (worst > tol * tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Straight GL segments sag below convex terrain — cap segment length so the
 *  draped line follows the surface (the height is sampled per vertex). */
function densify(points, maxLen) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / maxLen);
    for (let k = 1; k <= n; k++) {
      out.push([
        Math.round((ax + (bx - ax) * (k / n)) * 10) / 10,
        Math.round((az + (bz - az) * (k / n)) * 10) / 10,
      ]);
    }
  }
  return out;
}

/** world points → in-frame runs (split where the track leaves the map). */
function clipToFrame(points) {
  const segs = [];
  let run = [];
  for (const p of points) {
    if (inFrame(p)) run.push(p);
    else if (run.length) { if (run.length > 1) segs.push(run); run = []; }
  }
  if (run.length > 1) segs.push(run);
  return segs;
}

// ── 4 · bake each route: GPX, geometry, pie, photos ─────────────────────────
const gpxDir = path.join(dataDir, 'gpx');
const photoDir = path.join(dataDir, 'photos');
fs.mkdirSync(gpxDir, { recursive: true });
fs.mkdirSync(photoDir, { recursive: true });

const routes = [];
const usedUids = new Set();
for (const { t, sig, frameFrac } of picked) {
  const variant = /[a-z]$/.test(sig);
  // two official shortcuts share the signage "731a" — keys must not
  let uid = sig;
  while (usedUids.has(uid)) uid += 'x';
  usedUids.add(uid);

  // official GPX — same endpoint as the site's download button
  const gpxPath = path.join(gpxDir, `${uid}.gpx`);
  if (!fs.existsSync(gpxPath)) {
    const gpx = await get(
      `${API}/download.tour.gpx?i=${t.id}&project=${PROJECT}&key=${KEY}`, 'buf');
    fs.writeFileSync(gpxPath, gpx);
    await sleep(300);
  }
  const gpxText = fs.readFileSync(gpxPath, 'utf8');
  const world = [];
  for (const m of gpxText.matchAll(
    /<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/g)) {
    world.push(toWorld(Number(m[2]), Number(m[1])));
  }
  if (world.length < 2) { console.warn(`  ${sig}: empty GPX, skipped`); continue; }

  const segs = clipToFrame(world).map((run) => densify(simplifyDP(run, 4), 60));
  if (!segs.length) { console.warn(`  ${sig}: nothing in frame, skipped`); continue; }

  // metres of the route on S0–S5 graded singletrack, sampled every ~20 m
  const sscale = [0, 0, 0, 0, 0, 0];
  for (let i = 1; i < world.length; i++) {
    const [ax, az] = world[i - 1], [bx, bz] = world[i];
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.round(len / 20));
    for (let k = 0; k < steps; k++) {
      const f = (k + 0.5) / steps;
      const g = gradeAt(ax + (bx - ax) * f, az + (bz - az) * f);
      if (g >= 0) sscale[g] += len / steps;
    }
  }

  // ITRS rating from the signage pictogram's name (4 letters, one per
  // quadrant: technical, endurance, fall exposure, rescue/wilderness)
  const itrs = (t.images?.image ?? [])
    .map((i) => /^ITRS_([VBRN]{4})$/.exec(i.title ?? '')?.[1])
    .find(Boolean) ?? null;

  // photos: primary + a couple more for main routes, attribution kept;
  // pictograms and map sheets are ratings, not photos
  const wanted = [];
  const seen = new Set();
  const addImg = (img) => {
    if (!img?.id || seen.has(img.id)) return;
    if (/^(ITRS_|GT_)/.test(img.title ?? '')) return;
    seen.add(img.id);
    wanted.push(img);
  };
  addImg(t.primaryImage);
  if (!variant) (t.images?.image ?? []).slice(0, 4).forEach(addImg);
  const photos = [];
  for (const img of wanted.slice(0, variant ? 1 : 3)) {
    const file = `mtb-${sig}-${photos.length}.jpg`;
    const dest = path.join(photoDir, file);
    if (!fs.existsSync(dest)) {
      try {
        const buf = await get(
          `https://img.oastatic.com/img2/${img.id}/800x450r/photo.jpg`, 'buf');
        fs.writeFileSync(dest, buf);
        await sleep(250);
      } catch { continue; }
    }
    photos.push({ file: `photos/${file}`, by: img.author ?? img.source ?? '' });
  }

  const surface = (t.wayType?.legend ?? []).map((l) => ({
    name: l.title, m: Math.round(l.length), color: l.color,
  }));

  routes.push({
    sig,
    uid,
    name: t.title,
    variant,
    difficulty: t.rating?.difficulty ?? 2, // official: 1 lehká · 2 střední · 3 těžká
    condition: t.rating?.condition ?? null, // stamina, 1–6
    km: Math.round(t.length / 100) / 10,
    ascent: Math.round(t.elevation?.ascent ?? 0),
    descent: Math.round(t.elevation?.descent ?? 0),
    minAlt: t.elevation?.minAltitude ?? null,
    maxAlt: t.elevation?.maxAltitude ?? null,
    timeMin: t.time?.min ?? null,
    loop: (t.properties?.property ?? []).some((p) => p.tag === 'loopTour'),
    clipped: frameFrac < 0.98,
    text: { en: blurb(t), it: blurb(itById.get(t.id)) },
    itrs,
    sscale: sscale.map((m) => Math.round(m)),
    surface,
    photos,
    link: `https://www.outdooractive.com/r/${t.id}`,
    gpx: `gpx/${uid}.gpx`,
    segs,
  });
  console.log(`  ${sig} ${t.title} — ${segs.length} seg(s), `
    + `ITRS ${itrs ?? '—'}, ${photos.length} photos`);
}

fs.writeFileSync(path.join(dataDir, 'routes.json'), JSON.stringify(routes));
const total = routes.reduce((s, r) => s + r.km, 0);
console.log(`\nwrote routes.json — ${routes.length} routes, ${Math.round(total)} km, `
  + `${(fs.statSync(path.join(dataDir, 'routes.json')).size / 1024).toFixed(0)} kB`);
