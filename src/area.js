// The area chosen for THIS page load: the remembered choice, else the
// default. Deliberately NOT part of the URL — the only way to switch is the
// picker on the loading screen, and switching is a full reload so every
// layer boots against one consistent config.

import { AREAS, DEFAULT_AREA } from './areas.js';

const remembered = window.localStorage.getItem('mapa:area');
const id = AREAS[remembered] ? remembered : DEFAULT_AREA;

export const area = AREAS[id];
// relative to the page URL, so the app works at a domain root AND under a
// subpath like petyastehlik.github.io/maps/
export const dataUrl = (file) => `${area.dataDir.slice(1)}/${file}`;
/** Make a data path from baked JSON (absolute-style '/data/…') page-relative. */
export const assetUrl = (path) => path.replace(/^\//, '');

/** Fetch an area data file; rejects cleanly when it's missing (vite's SPA
 *  fallback answers missing files with index.html, HTTP 200). */
export async function fetchAsset(file, kind = 'buffer') {
  const res = await fetch(dataUrl(file));
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok || ct.includes('text/html')) throw new Error(`${file} není k dispozici`);
  return kind === 'json' ? res.json() : res.arrayBuffer();
}

/** Remember another area and reload into it (loading-screen picker only).
 *  The one-shot session flag lets the reloaded page enter without a second
 *  click — the user just made their choice. */
export function switchArea(toId) {
  if (toId === id || !AREAS[toId]) return;
  try {
    window.localStorage.setItem('mapa:area', toId);
    window.sessionStorage.setItem('mapa:enter', toId);
  } catch { /* ok */ }
  window.location.reload();
}

/** True once per picker-initiated reload: enter the map without waiting. */
export function consumeAutoEnter() {
  try {
    const v = window.sessionStorage.getItem('mapa:enter');
    window.sessionStorage.removeItem('mapa:enter');
    return v === id;
  } catch { return false; }
}
