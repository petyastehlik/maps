// Shared frame resolver for the bake scripts. AREA=<id> env picks the area
// (default halouny). The local frame — projection, centre, half-extents — is
// fully determined by src/areas.js, and the DEM bake writes the same values
// into meta.json, so every layer agrees with the rendered terrain. Frames
// are rectangles (width may differ from height); Halouny happens to be square.

import proj4 from 'proj4';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS, DEFAULT_AREA } from '../src/areas.js';

export function resolveFrame() {
  const id = process.env.AREA ?? DEFAULT_AREA;
  const area = AREAS[id];
  if (!area) {
    throw new Error(`unknown AREA "${id}" — known: ${Object.keys(AREAS).join(', ')}`);
  }
  proj4.defs('LOCAL', area.projDef);
  const [cx, cy] = proj4('EPSG:4326', 'LOCAL', [area.lon, area.lat]);
  const halfW = area.halfWidthM;
  const halfH = area.halfHeightM;

  /** lon/lat → viewer world frame [x east, z south-positive], metres. */
  const toWorld = (lon, lat) => {
    const [x, y] = proj4('EPSG:4326', 'LOCAL', [lon, lat]);
    return [x - cx, -(y - cy)];
  };
  /** offsets east/north from centre (metres) → [lon, lat]. */
  const toLonLat = (east, north) => proj4('LOCAL', 'EPSG:4326', [cx + east, cy + north]);

  const cornersLonLat = {
    sw: toLonLat(-halfW, -halfH), se: toLonLat(halfW, -halfH),
    nw: toLonLat(-halfW, halfH), ne: toLonLat(halfW, halfH),
  };
  const cs = Object.values(cornersLonLat);
  const bbox = [
    Math.min(...cs.map((c) => c[1])), Math.min(...cs.map((c) => c[0])),
    Math.max(...cs.map((c) => c[1])), Math.max(...cs.map((c) => c[0])),
  ].join(','); // south,west,north,east — Overpass order

  const dataDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '../public', area.dataDir.slice(1));

  console.log(`area: ${area.id} · centre ${area.lat} N ${area.lon} E · `
    + `${halfW * 2 / 1000}×${halfH * 2 / 1000} km`);
  return { area, cx, cy, halfW, halfH, toWorld, toLonLat, cornersLonLat, bbox, dataDir };
}
