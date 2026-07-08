# Halouny & Garda — 3D LIDAR maps

Three.js viewer of two terrain cuts (Halouny 20 × 20 km, Garda 40 × 61 km)
with a choose-first loading screen: nothing downloads until an area is
picked, then the map loads and enters by itself (last choice remembered in
localStorage; deliberately not part of the URL). All areas share one engine — per-area config lives in
`src/areas.js`, per-area data under `public/data/<area>/`.

**Halouny · Brdy/Hřebeny** (49.8878 N, 14.1978 E — K Vodárně 132), ČÚZK open data:

- **DMR 5G** — LIDAR (airborne laser scanning) terrain model, 2 m grid, EPSG:5514
  — 6144² base heightmap (3.26 m) plus native **2 m tiles streamed** around the
  camera over the central 12 × 12 km, rendered on nested detail grids (down to
  2.5 m vertices)
- **Ortofoto ČR** — aerial imagery draped over the terrain (+ hi-res centre tile)

**Garda — the whole lake** (a 40 × 61 km rectangle around the lake, centre
45.70 N, 10.71 E — from Dro and Arco in the Sarca valley down to Salò,
Sirmione, Desenzano and Peschiera; the full Monte Baldo crest is the eastern
edge; default převýšení 1×), frame EPSG:32632:

- **TINITALY 1.1** — 10 m DEM © INGV, CC BY 4.0
  (doi:10.13127/tinitaly/1.1), four 50 km tiles resampled to a 4096×6144 heightmap
- **Ortofoto AGEA 2012** — Geoportale Nazionale (PCN) WMS, ~50 cm native,
  service declares no access constraints; no 1–2 m detail-tile layer (a
  seamless one across Trentino/Lombardia/Veneto isn't practical — see
  the source-verification brief in the repo history)

Both areas from **OpenStreetMap** — landmark labels, cycling routes, MTB
trails (mtb:scale), water polygons, building footprints, forest cover.

Realism stack: real solar position by time of day (SLUNCE slider, follows the
actual clock until touched) with a shader sky (dusk glow, sun disk),
ray-marched terrain-cast soft shadows, drifting cloud shadows, animated water
on the Berounka and ponds, 37k instanced buildings tinted by the aerial photo
beneath them, and ~50k instanced conifers scattered over the OSM forest mask
around the camera.

The night sky is the real one for the chosen date and time: 1,637 catalogue
stars (HYG, ≤ mag 5) placed by sidereal time, Venus/Mars/Jupiter/Saturn from
Keplerian elements (bright planets pierce the twilight first), a
phase-correct Moon that also takes over as the night key light, and today's
sun path drawn as an arc with hour dots while the SLUNCE slider is used.
Cloud cover and drift follow the live weather at the map centre (Open-Meteo).

## Run

```sh
npm install
npm run dev        # → http://localhost:5173 (default vite port)
```

## Refresh / change the data

Per-area geometry (centre, extent, projection, data dir) lives in
`src/areas.js`; the OSM scripts take `AREA=<id>` (default `halouny`).

```sh
# Halouny (ČÚZK)
node scripts/fetch-data.mjs               # heightmap, meta, ortho_{00,10,01,11,c}.jpg
node scripts/fetch-detail-tiles.mjs       # public/data/halouny/h2/ — native 2 m tiles

# Garda (TINITALY + AGEA) — download + unzip four TINITALY tiles first:
#   https://tinitaly.pi.ingv.it/data_1.1/w50560_s10/w50560_s10.zip  (also w50565,
#   w50060, w50065 — the 50 km tiles covering UTM32 E 600–700k, N 5000–5100k)
TINITALY_DIR=/path/to/tifs node scripts/fetch-data-garda.mjs

# both areas (OSM / Overpass)
AREA=halouny node scripts/fetch-overlays.mjs   # landmarks.json, cycling.json
AREA=halouny node scripts/fetch-osm-3d.mjs     # water, buildings, forest, trails
AREA=garda  node scripts/fetch-overlays.mjs
AREA=garda  node scripts/fetch-osm-3d.mjs

node scripts/fetch-stars.mjs              # shared: public/data/stars.json (HYG ≤ mag 5)
node scripts/convert-data-png.mjs         # heightmaps/masks → lossless PNG (~½ size);
                                          # verifies bit-exact roundtrip, then the
                                          # .bin originals can be deleted
```

Note: `ags.cuzk.gov.cz` responds slowly (~10 s per request) and the public
Overpass servers rate-limit — the scripts retry and resume, just rerun them.
Every output is skipped if it already exists; delete a file to refetch it.

## Controls

- left-drag — pan (grabs the ground) · middle-drag — turn in place (game-style) · wheel — zoom to cursor
- double-click — recenter · arrows/`WASD` — glide · `Q`/`E` — turn in place
- `1` ortofoto · `2` reliéf (hypsometric tint + 20/100 m contours)
- `P` popisky (labels) · `C` cyklotrasy (cycling routes)
- click a label — info card with researched facts + photos (Wikimedia Commons)
- slider — vertical exaggeration (1× = real heights; explained in the help dialog)
- hover — elevation + WGS-84 coordinate probe (CPU ray-march against the height grid)
- `?` button — help dialog with full control reference

The camera is terrain-aware: it can never dive below a hillside, including
ridges between the camera and its focus point.

## How it works

| file | role |
|---|---|
| `scripts/fetch-data.mjs` | fetch GeoTIFF tiles + JPEG quadrants, quantize heights to Uint16 `heightmap.bin` |
| `scripts/fetch-overlays.mjs` | Overpass → `landmarks.json` (place/peak/castle nodes) + `cycling.json` (route ways), projected to the model frame |
| `src/terrain.js` | GPU terrain: vertex displacement + per-pixel normals from the 6144² grid, ortho/hypso fragment shader, skirt + pedestal |
| `src/MapCameraControls.js` | map-grade camera: ground-anchored pan, inertial zoom-to-cursor, orbit, flights, terrain collision |
| `src/labels.js` | typographic landmark layer: importance tiers, distance culling, screen-space declutter, terrain occlusion |
| `src/cycling.js` | cycling routes as line segments displaced by the shared heightmap texture (tracks exaggeration) |
| `src/HeightField.js` | CPU elevation queries: bilinear sampling, ray-march probe, corner-bilinear WGS-84 |
| `src/main.js` | scene, HUD wiring (compass, scale bar, probe readout, layer toggles, help dialog) |
| `public/data/info.json` | per-landmark blurbs + Wikimedia Commons photo URLs shown in the info cards |

Data rasters (heightmaps, detail tiles, forest masks) ship as lossless
grayscale PNG — half the bytes of the raw arrays — and decode in the browser
with a tiny built-in decoder (`src/png16.js`, native DecompressionStream, no
canvas involved so no color management can touch the values; the decoded
arrays are bit-identical to the originals).

Self-contained: fonts (Fraunces, IBM Plex Mono), the star catalogue and all
info-card photos are stored locally. The only runtime request is the live
weather (Open-Meteo, keyless); offline it falls back to baked-in cloud
defaults and everything else works unchanged.

Data: Halouny © ČÚZK — DMR 5G (LLS), Ortofoto ČR · Garda — TINITALY 1.1 DEM
© INGV, CC BY 4.0 (Tarquini S. et al. (2023), doi:10.13127/tinitaly/1.1) and
Ortofoto AGEA 2012 via Geoportale Nazionale (PCN) · © OpenStreetMap
contributors · photos in info cards from Wikimedia Commons (see each file page
for its license) · stars from the HYG database (CC BY-SA 4.0) · weather by
Open-Meteo (CC BY 4.0).
