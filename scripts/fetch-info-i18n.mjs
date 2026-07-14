// English / Italian landmark blurbs for the info cards. The Czech texts in
// info.json were researched by hand; rather than machine-translate them,
// every entry that carries a Wikipedia link gets the real article summary
// in both languages: the linked article's langlinks lead to the en/it
// equivalents, whose REST summaries become the card text. Entries without
// a Wikipedia article keep name, photos and links — just no blurb.
// Writes info_en.json and info_it.json next to info.json. AREA=<id> picks
// the area. Existing outputs are updated in place (safe to rerun).

import fs from 'node:fs';
import path from 'node:path';
import { resolveFrame } from './area-frame.mjs';

const { dataDir } = resolveFrame();
const UA = 'halouny-lidar-map/1.0 (one-off data bake; personal project)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === 2) throw err;
      await sleep(4000 * (i + 1));
    }
  }
  return null;
}

/** wiki page title from a wikipedia URL. */
function parseWikiLink(link) {
  const m = /https?:\/\/(\w+)\.wikipedia\.org\/wiki\/([^#?]+)/.exec(link ?? '');
  return m ? { wiki: m[1], title: decodeURIComponent(m[2]).replace(/_/g, ' ') } : null;
}

/** titles of the article in the wanted languages (langlinks + itself). */
async function titlesFor(src, wanted) {
  const out = {};
  if (wanted.includes(src.wiki)) out[src.wiki] = src.title;
  const d = await api(`https://${src.wiki}.wikipedia.org/w/api.php?action=query`
    + `&prop=langlinks&lllimit=500&format=json&formatversion=2`
    + `&titles=${encodeURIComponent(src.title)}&redirects=1`);
  for (const ll of d?.query?.pages?.[0]?.langlinks ?? []) {
    if (wanted.includes(ll.lang)) out[ll.lang] = ll.title;
  }
  return out;
}

/** plain-text summary of an article, sentence-trimmed for the card. */
async function summary(wiki, title) {
  const d = await api(`https://${wiki}.wikipedia.org/api/rest_v1/page/summary/`
    + encodeURIComponent(title.replace(/ /g, '_')));
  let text = d?.extract ?? '';
  if (!text || d?.type === 'disambiguation') return '';
  if (text.length > 420) {
    const cut = text.slice(0, 420);
    text = cut.slice(0, Math.max(cut.lastIndexOf('. '), 200) + 1);
  }
  return text;
}

const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'info.json'), 'utf8'));

// landmarks that entered the frame after info.json was researched (e.g. the
// reframe that brought in Rovereto) have no entry at all — give towns and
// castles a shot at a Wikipedia article by name so their cards aren't empty
try {
  const landmarks = JSON.parse(
    fs.readFileSync(path.join(dataDir, 'landmarks.json'), 'utf8'));
  for (const lm of landmarks) {
    if (!['town', 'city', 'castle'].includes(lm.type)) continue;
    const key = `${lm.type}:${lm.name}`;
    if (info[key]) continue;
    info[key] = { link: `https://it.wikipedia.org/wiki/${encodeURIComponent(lm.name.replace(/ /g, '_'))}` };
  }
} catch { /* landmarks bake not run yet */ }
const out = { en: {}, it: {} };
for (const langFile of ['en', 'it']) {
  const p = path.join(dataDir, `info_${langFile}.json`);
  if (fs.existsSync(p)) out[langFile] = JSON.parse(fs.readFileSync(p, 'utf8'));
}

const keys = Object.keys(info);
let hit = 0, miss = 0, done = 0;
for (const key of keys) {
  done++;
  const entry = info[key];
  if (out.en[key]?.text !== undefined && out.it[key]?.text !== undefined) continue;
  const src = parseWikiLink(entry.link);
  let texts = { en: '', it: '' };
  if (src) {
    try {
      const titles = await titlesFor(src, ['en', 'it']);
      for (const l of ['en', 'it']) {
        if (titles[l]) {
          texts[l] = await summary(l, titles[l]);
          await sleep(700);
        }
      }
    } catch (err) {
      console.warn(`  ${key}: ${err.message}`);
    }
    await sleep(700);
  }
  for (const l of ['en', 'it']) {
    // language-appropriate wiki link when it exists; photos/link ride along
    out[l][key] = { ...entry, text: texts[l] || undefined };
    if (!texts[l]) delete out[l][key].text;
  }
  if (texts.en || texts.it) hit++; else miss++;
  if (done % 50 === 0) {
    console.log(`${done}/${keys.length} · with text ${hit} · without ${miss}`);
    for (const l of ['en', 'it']) {
      fs.writeFileSync(path.join(dataDir, `info_${l}.json`), JSON.stringify(out[l]));
    }
  }
}
for (const l of ['en', 'it']) {
  fs.writeFileSync(path.join(dataDir, `info_${l}.json`), JSON.stringify(out[l]));
}
console.log(`done: ${keys.length} entries · ${hit} with wiki text · ${miss} without`);
