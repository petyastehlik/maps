// UI language: English (default) or Italian. English is the source text —
// the HTML and all JS strings are written in English and the Italian
// dictionary below is keyed by them. Switching writes localStorage and
// reloads, like the area picker, so every layer boots consistently.

const LANGS = ['en', 'it'];
const stored = (() => {
  try { return window.localStorage.getItem('mapa:lang'); } catch { return null; }
})();
export const lang = LANGS.includes(stored) ? stored : 'en';

let enterAfterSwitch = () => null;

export function setLang(next) {
  if (next === lang || !LANGS.includes(next)) return;
  try {
    window.localStorage.setItem('mapa:lang', next);
    // mid-map the reload should come straight back in — same as an area
    // pick; on the untouched veil the choose-first rule stays
    const enter = enterAfterSwitch();
    if (enter) window.sessionStorage.setItem('mapa:enter', enter);
  } catch { /* ok */ }
  window.location.reload();
}

const IT = {
  // controls panel
  'Surface': 'Superficie',
  'Ortho': 'Orto',
  'Relief': 'Rilievo',
  'Heights': 'Altezze',
  'Terrain height multiplier — 1× matches reality': 'Moltiplicatore delle altezze — 1× corrisponde alla realtà',
  'Sun': 'Sole',
  'Time of day — sun position over the map': 'Ora del giorno — posizione del sole sulla mappa',
  'Layers': 'Livelli',
  'Names': 'Nomi',
  'Bike': 'Bici',
  'Trails': 'Sentieri',
  'MTB': 'MTB',
  'Buildings': 'Edifici',
  'Trees': 'Alberi',
  '? Controls & help': '? &nbsp;Comandi e guida',
  'Controls': 'Comandi',
  'Controls.': 'Comandi<span>.</span>',
  'N = north': 'N = nord',
  'rotate left': 'ruota a sinistra',
  'rotate right': 'ruota a destra',

  // help dialog
  'Mouse': 'Mouse',
  'left-button drag': 'trascina col tasto sinistro',
  'pans the map — you grab the terrain and drag it under the cursor': 'sposta la mappa — afferri il terreno e lo trascini sotto il cursore',
  'wheel / pinch': 'rotella / pinch',
  'smooth zoom towards the point under the cursor': 'zoom fluido verso il punto sotto il cursore',
  'middle-button drag': 'trascina col tasto centrale',
  'orbits and tilts the camera around the view centre — from straight down to skyward': 'ruota e inclina la camera attorno al centro della vista — dalla verticale al cielo',
  'double click': 'doppio clic',
  'recentres the view on the clicked spot': 'ricentra la vista sul punto cliccato',
  'click a label or a route': 'clic su un nome o un percorso',
  'card with facts about the place or route': 'scheda con informazioni sul luogo o percorso',
  'hover the terrain': 'passa sul terreno',
  'probe — coordinates and elevation': 'sonda — coordinate e quota',
  'touch (mobile)': 'touch (mobile)',
  '1 finger pan · 2 fingers zoom & tilt · ⟲⟳ buttons rotate': '1 dito sposta · 2 dita zoom e inclinazione · pulsanti ⟲⟳ ruotano',
  'Keyboard': 'Tastiera',
  'arrows': 'frecce',
  'pan the map in view direction': 'spostano la mappa nella direzione della vista',
  'rotate left / right': 'ruota a sinistra / destra',
  'surface: orthophoto / relief with contours': 'superficie: ortofoto / rilievo con isoipse',
  'layers: names / bike routes / trails': 'livelli: nomi / percorsi bici / sentieri',
  'closes a card or this help': 'chiude una scheda o questa guida',
  'The slider multiplies terrain heights. 1× matches the real laser-scanned heights; higher values exaggerate the relief. On Garda the real Alps need no help — the slider is hidden.': 'Il cursore moltiplica le altezze del terreno. <b>1×</b> corrisponde alle quote reali del rilevamento laser; valori più alti esagerano il rilievo. Sul Garda le Alpi vere non ne hanno bisogno — il cursore è nascosto.',
  'Data': 'Dati',
  'Elevation & imagery: ČÚZK DMR 5G + Ortofoto ČR (Halouny) · TINITALY DEM + AGEA orthophoto (Garda) · names and routes © OpenStreetMap contributors · MTB routes © Garda Trentino.': 'Quote e immagini: ČÚZK DMR 5G + Ortofoto ČR (Halouny) · DEM TINITALY + ortofoto AGEA (Garda) · nomi e percorsi © OpenStreetMap · percorsi MTB © Garda Trentino.',

  // loading veil
  'Maps': 'Mappe',
  'choose a map': 'scegli una mappa',
  'preparing…': 'preparazione…',
  'switching to %s…': 'passo a %s…',
  'Loading %s — switching to %s restarts the download.': 'Caricamento di %s — passando a %s il download ricomincia.',
  'loading elevation…': 'carico le quote…',
  'loading imagery…': 'carico le immagini…',
  'building the scene…': 'costruisco la scena…',
  'entering the map…': 'entro nella mappa…',

  // readout / scalebar
  'm a.s.l.': 'm s.l.m.',

  // label chips + cards
  'town': 'città',
  'village': 'paese',
  'hamlet': 'frazione',
  'peak': 'cima',
  'castle': 'castello',
  'landmark': 'monumento',
  'bike route': 'ciclovia',
  'address': 'indirizzo',
  'trail': 'sentiero',
  'peak · %s m a.s.l.': 'cima · %s m s.l.m.',
  'trail · difficulty S%s': 'sentiero · difficoltà S%s',
  'MTB route %s · %s': 'percorso MTB %s · %s',
  'length %s km · climb +%s m · descent −%s m': 'lunghezza %s km · salita +%s m · discesa −%s m',
  'loop': 'anello',
  'partly off the map': 'in parte fuori mappa',
  'official route page →': 'pagina ufficiale del percorso →',
  'this trail on Trailforks →': 'questo sentiero su Trailforks →',
  'more →': 'altro →',
  'photo:': 'foto:',
  'surface per official route data': 'fondo secondo i dati ufficiali del percorso',
  'share of the route on signed singletrack (S0–S5 scale, per OSM); the rest follows roads and gravel': 'quota del percorso su singletrack segnalati (scala S0–S5, da OSM); il resto corre su strade e sterrati',
  'singletrack': 'singletrack',

  // ITRS
  'technique': 'tecnica',
  'fitness': 'fisico',
  'fall risk': 'caduta',
  'remoteness': 'isolamento',
  'technique — the riding skill the route demands': 'tecnica — l’abilità di guida richiesta dal percorso',
  'fitness — length, climb and descent combined': 'fisico — lunghezza, salita e discesa nel complesso',
  'fall risk — how exposed the route is, what a mistake costs': 'caduta — quanto è esposto il percorso, cosa costa un errore',
  'remoteness — phone signal, water and rescue access': 'isolamento — segnale, acqua e accesso dei soccorsi',
  'green · easy': 'verde · facile',
  'blue · moderate': 'blu · medio',
  'red · demanding': 'rosso · impegnativo',
  'black · extreme': 'nero · estremo',
  'ITRS — International Trail Rating System, from the physical route signs; green → blue → red → black': 'ITRS — International Trail Rating System, dalla segnaletica sul percorso; verde → blu → rosso → nero',

  // S-scale tooltips
  'S0 · flowing trail without roots, rocks or steps — anyone can ride it': 'S0 · sentiero scorrevole senza radici, sassi o gradini — alla portata di tutti',
  'S1 · small roots and rocks, occasionally narrow — basic trail technique': 'S1 · piccole radici e sassi, a tratti stretto — tecnica di base',
  'S2 · big roots, steps and switchbacks — confident technique needed': 'S2 · radici grosse, gradini e tornanti — serve tecnica sicura',
  'S3 · blocked, exposed passages and high steps — for experts': 'S3 · passaggi bloccati ed esposti, gradini alti — per esperti',
  'S4 · very steep and heavily blocked — extreme technique': 'S4 · molto ripido e fortemente bloccato — tecnica estrema',
  'S5 · at the edge of rideability — for a handful of the best': 'S5 · al limite della pedalabilità — per pochissimi',

  // official difficulty
  'easy': 'facile',
  'moderate': 'media',
  'difficult': 'difficile',

  // surfaces (official legend)
  'Asphalt': 'Asfalto',
  'Dirt road': 'Sterrata',
  'Forested/wild trail': 'Sentiero nel bosco',
  'Path': 'Sentiero',
  'Road': 'Strada',
  'Gravel': 'Ghiaia',
  'Singletrail': 'Singletrack',

  // route list panel
  'ROUTES': 'PERCORSI',
  'search routes…': 'cerca percorso…',
  'sort': 'ordina',
  'start': 'start',
  'length': 'lunghezza',
  'climb': 'salita',
  'difficulty': 'difficoltà',
  'distance of the start from Nago–Torbole': 'distanza della partenza da Nago–Torbole',
  'total route length': 'lunghezza totale del percorso',
  'total ascent': 'salita totale',
  'official difficulty (easy → difficult)': 'difficoltà ufficiale (facile → difficile)',
  'start %s km from Nago–Torbole · length %s km · ↑%s m': 'partenza a %s km da Nago–Torbole · lunghezza %s km · ↑%s m',

  // pitch demo captions
  'Play the demo tour': 'Guarda il tour dimostrativo',
  'The official Garda Trentino MTB network — 42 signed routes, 993 km.': 'La rete MTB ufficiale del Garda Trentino — 42 percorsi segnalati, 993 km.',
  'Hover any route — official stats, photos and the GPX itself.': 'Passa su un percorso — dati ufficiali, foto e il GPX stesso.',
  'ITRS — the four ratings straight from the physical trail signs.': 'ITRS — le quattro valutazioni direttamente dalla segnaletica sul percorso.',
  'Every route — searchable, sortable, one click from its start.': 'Tutti i percorsi — ricerca, ordinamento, un clic e sei alla partenza.',
  'Tremalzo — the WWI military road, a cult descent.': 'Tremalzo — la strada militare della Grande Guerra, una discesa cult.',
  'The real sky for any hour — sun, moon and 1,600 stars.': 'Il cielo vero a ogni ora — sole, luna e 1.600 stelle.',
  'Survey relief with contours, one key away.': 'Rilievo con isoipse, a un tasto di distanza.',
  'Garda Trentino — and only Garda Trentino. The rest stays in the haze.': 'Garda Trentino — e solo Garda Trentino. Il resto resta nella foschia.',
  'Your turn — grab the map.': 'Tocca a te — prendi la mappa.',
};

/** Translate an English source string; %s slots are filled in order. */
export function t(key, ...args) {
  let out = lang === 'it' ? (IT[key] ?? key) : key;
  for (const a of args) out = out.replace('%s', String(a));
  return out;
}

/** Locale for number formatting. */
export const numLocale = lang === 'it' ? 'it-IT' : 'en-GB';

/** Boot pass: translate all [data-i18n] text and [data-i18n-title] titles
 *  in the static HTML (English source → active language). */
export function translatePage() {
  document.documentElement.lang = lang;
  if (lang === 'en') return;
  const norm = (str) => str.replace(/\s+/g, ' ').trim();
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = norm(el.dataset.i18n || el.textContent);
    if (IT[key]) el.innerHTML = IT[key];
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    const key = norm(el.dataset.i18nTitle || el.title);
    if (IT[key]) el.title = IT[key];
  }
}

/** The EN | IT switcher pill (top right, usable already on the veil).
 *  @param getEnterId returns the area to re-enter after the reload, or
 *         null while the user hasn't picked one yet. */
export function mountSwitcher(getEnterId = () => null) {
  enterAfterSwitch = getEnterId;
  const box = document.createElement('div');
  box.id = 'lang';
  for (const l of LANGS) {
    const b = document.createElement('button');
    b.textContent = l.toUpperCase();
    b.classList.toggle('on', l === lang);
    b.addEventListener('click', () => setLang(l));
    box.appendChild(b);
  }
  document.body.appendChild(box);
}
