// Slide-out quick reference of the official MTB network: every signed route
// as a row (number, name, key stats), one click flies the camera to the
// route's STARTING point and opens its card. Rows are ordered by how far
// that start is from Nago–Torbole (the user's base), variants under their
// parent route. Toggled by a slim tab on the right edge; garda only.

import { DIFF_COLORS } from './mtb.js';
import { t, numLocale } from './i18n.js';

// Torbole main square in the garda world frame (10.8773 E, 45.8715 N)
const BASE = [12576, -19346];

/** First point of the GPX inside the frame = where the route starts. */
const startOf = (r) => r.segs[0][0];
const distToBase = (r) => {
  const [x, z] = startOf(r);
  return Math.hypot(x - BASE[0], z - BASE[1]);
};

export function initRouteList({ routes, controls, labels }) {
  const tab = document.createElement('button');
  tab.id = 'routelist-tab';
  tab.textContent = t('ROUTES');
  document.body.appendChild(tab);

  const panel = document.createElement('aside');
  panel.id = 'routelist';
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="searchbox">
      <input type="search" placeholder="${t('search routes…')}" spellcheck="false">
      <button class="clear" hidden aria-label="clear">×</button>
    </div>
    <div class="sort"><span class="label">${t('sort')}</span></div>
    <button class="close">×</button>
    <div class="rows"></div>`;
  document.body.appendChild(panel);

  // default order: mains by how far their start lies from base, variants
  // grouped below their parent; other sort keys go flat over everything
  const mains = routes.filter((r) => !r.variant)
    .sort((a, b) => distToBase(a) - distToBase(b));
  const groups = mains.map((m) => [
    m,
    ...routes.filter((r) => r.variant && r.sig.startsWith(m.sig))
      .sort((a, b) => distToBase(a) - distToBase(b)),
  ]);
  const ordered = groups.flat();

  // fuzzy name search: case- and diacritics-insensitive subsequence match
  const fold = (s) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const fuzzy = (needle, hay) => {
    let i = 0;
    for (const ch of hay) if (ch === needle[i]) i++;
    return i === needle.length;
  };

  // sort modes: start = grouped default; the rest reorder rows flat
  const SORTS = [
    { key: 'start', label: t('start'), title: t('distance of the start from Nago–Torbole') },
    { key: 'km', label: t('length'), title: t('total route length') },
    { key: 'ascent', label: t('climb'), title: t('total ascent') },
    { key: 'difficulty', label: t('difficulty'), title: t('official difficulty (easy → difficult)') },
  ];
  const rowBySig = new Map();
  const sortBar = panel.querySelector('.sort');
  let sortKey = 'start';
  function applySort() {
    const order = sortKey === 'start' ? ordered
      : [...routes].sort((a, b) =>
        (sortKey === 'difficulty'
          ? a.difficulty - b.difficulty || a.km - b.km
          : a[sortKey] - b[sortKey])
        || a.sig.localeCompare(b.sig, 'en', { numeric: true }));
    for (const r of order) rows.appendChild(rowBySig.get(r.sig)); // move = reorder
  }
  for (const s of SORTS) {
    const b = document.createElement('button');
    b.textContent = s.label;
    b.title = s.title;
    if (s.key === sortKey) b.classList.add('on');
    b.addEventListener('click', () => {
      sortKey = s.key;
      for (const other of sortBar.querySelectorAll('button')) {
        other.classList.toggle('on', other === b);
      }
      applySort();
    });
    sortBar.appendChild(b);
  }

  const rows = panel.querySelector('.rows');
  for (const r of ordered) {
    const row = document.createElement('button');
    row.className = 'row' + (r.variant ? ' variant' : '');
    const km = distToBase(r) / 1000;
    row.innerHTML = `
      <b style="background:${DIFF_COLORS[r.difficulty] ?? '#555'}">${r.sig}</b>
      <span>${r.name}</span>
      <small>${r.km.toLocaleString(numLocale)} km</small>
      <small>↑${r.ascent}</small>
      <small class="dist">${km < 1 ? '<1' : Math.round(km)} km</small>`;
    row.title = t('start %s km from Nago–Torbole · length %s km · ↑%s m',
      km < 1 ? '<1' : `~${Math.round(km)}`, r.km.toLocaleString(numLocale), r.ascent);
    row.dataset.hay = fold(`${r.sig} ${r.name}`);
    row.addEventListener('click', () => {
      const [sx, sz] = startOf(r);
      controls.flyToView(sx, sz, controls.getAzimuthalAngle(), 0.95, 3400);
      labels.selectRoute(r.sig);
      if (window.innerWidth < 760) setOpen(false); // phone: panel covers the map
    });
    // hovering a row previews the route: highlight + its card (top-left)
    row.addEventListener('pointerenter', () => labels.previewRoute(r.sig));
    row.addEventListener('pointerleave', () => labels.previewRoute(null));
    rowBySig.set(r.sig, row);
    rows.appendChild(row);
  }

  const search = panel.querySelector('input');
  const clearButton = panel.querySelector('.searchbox .clear');
  search.addEventListener('input', () => {
    const q = fold(search.value.trim());
    clearButton.hidden = search.value === '';
    for (const row of rows.children) {
      row.hidden = q !== '' && !row.dataset.hay.includes(q) && !fuzzy(q, row.dataset.hay);
    }
  });
  clearButton.addEventListener('click', () => {
    search.value = '';
    search.dispatchEvent(new Event('input'));
    search.focus(); // deliberate: the user is clearly mid-search here
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      search.value = '';
      search.dispatchEvent(new Event('input'));
      e.stopPropagation(); // first Esc clears, the next closes the panel
    }
  });

  let open = false;
  function setOpen(v) {
    open = v;
    panel.classList.toggle('open', v);
    tab.classList.toggle('active', v);
    if (!v) labels.previewRoute(null); // no autofocus on open — typing is opt-in
  }
  tab.addEventListener('click', () => setOpen(!open));
  panel.querySelector('.close').addEventListener('click', () => setOpen(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) setOpen(false);
  });
}
