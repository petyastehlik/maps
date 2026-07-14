// Per-area configuration — everything that differs between mapped regions.
// Pure data: imported by both the app (browser) and the bake scripts (node),
// so no three.js and no browser globals in here. Adding a third area should
// require nothing but a new entry (plus its baked data under public/data/).

const ALL_AREAS = {
  halouny: {
    id: 'halouny',
    title: 'Halouny',
    lat: 49.8878183,
    lon: 14.1978160,
    halfWidthM: 10_000,   // east-west
    halfHeightM: 10_000,  // north-south
    projDef: '+proj=krovak +lat_0=49.5 +lon_0=24.83333333333333 '
      + '+alpha=30.28813972222222 +k=0.9999 +x_0=0 +y_0=0 '
      + '+ellps=bessel +towgs84=589,76,480,0,0,0,0 +units=m +no_defs', // S-JTSK
    dataDir: '/data/halouny',
    exagDefault: 1.5,
    exagAdjustable: true,

    homeView: { x: 0, z: 0, azimuth: 2.982, polarDeg: 61, distance: 6480 },
    pins: [
      { name: 'Halouny', x: 0, z: 0, color: '#ff7a2f' },
      { name: 'Lhotecká 432', x: 3503, z: 2427, color: '#4da3ff' }, // Mníšek p. B.
    ],
    attributionHtml: 'data © <a href="https://geoportal.cuzk.gov.cz" '
      + 'target="_blank">ČÚZK</a> — DMR 5G (LLS) · Ortofoto ČR · © '
      + '<a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  },
  garda: {
    id: 'garda',
    title: 'Garda',
    lat: 45.70,
    lon: 10.71,
    halfWidthM: 20_000,   // 40 km: Desenzano shore to the Monte Baldo crest
    halfHeightM: 30_500,  // 61 km: Dro (N) to Peschiera (S)
    projDef: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs',
    dataDir: '/data/garda',
    exagDefault: 1,
    exagAdjustable: false, // the real Alps need no help
    // buildings only along the lake corridor — suburban Verona/Rovereto
    // would triple the fetch and render load for nothing lake-related
    osmBuildingsBounds: { south: 45.40, west: 10.45, north: 45.99, east: 10.99 },

    // high over the south basin, the whole lake running north to Riva
    homeView: { x: -3500, z: 2000, azimuth: -0.05, polarDeg: 58, distance: 40000 },
    pins: [],
    // the signed 7xx MTB network (routes.json) replaces the OSM line layers
    mtbRoutes: true,
    attributionHtml: 'elevation © <a href="https://tinitaly.pi.ingv.it" '
      + 'target="_blank">INGV — TINITALY</a> (CC BY 4.0) · Ortofoto AGEA 2012 — PCN · © '
      + '<a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'
      + ' · MTB routes © <a href="https://www.gardatrentino.it/en/outdoor/bike/MTB/MTB-tours" '
      + 'target="_blank">Garda Trentino</a>',
  },
};

// A build can ship a subset of areas (the public Garda-only deployment:
// VITE_AREAS=garda vite build). import.meta.env is undefined under node,
// so the bake scripts always see every area.
const only = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_AREAS)
  ?.split(',').map((s) => s.trim()).filter(Boolean);
export const AREAS = only?.length
  ? Object.fromEntries(Object.entries(ALL_AREAS).filter(([id]) => only.includes(id)))
  : ALL_AREAS;
export const DEFAULT_AREA = AREAS.halouny ? 'halouny' : Object.keys(AREAS)[0];
