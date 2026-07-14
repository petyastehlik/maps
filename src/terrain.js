// Terrain for the Halouny / Hřebeny DMR 5G model.
// All shaping happens on the GPU. Geometry is layered:
//   base    — one 2048² grid over the full 20 km (9.8 m vertices)
//   detail  — two nested grids (5 m and 2.5 m vertices) that follow the
//             camera focus, drawn with polygon offset over the base
// Heights come from the 6144² heightmap (3.26 m), locally overridden by a
// streamed 2048² detail window composed from native 2 m DMR 5G tiles
// (public/data/h2/, central 12 × 12 km) with a soft blend band at its edge.
// The fragment shader derives per-pixel normals from the same height
// sources, marches sun shadows, drifts cloud shadows, and drapes either the
// orthophoto quadrants (+ hi-res centre tile) or a hypsometric relief.

import * as THREE from 'three';
import { HeightField } from './HeightField.js';
import { dataUrl, area } from './area.js';
import { decodeGrayPNG } from './png16.js';

const MESH_SEGMENTS = 2048;
const SKIRT_DROP = -80; // metres below model base, hides edge gaps
const DETAIL_LEVELS = [
  { extent: 2560, segments: 512, offset: -1 }, // 5 m vertices
  { extent: 1280, segments: 512, offset: -2 }, // 2.5 m vertices
];
const TILE_PX = 1024;
const TILE_M = 2048;
const TILE_GRID = 6;        // 6×6 tiles cover the central 12.3 km
const TILE_HALF_SPAN = (TILE_GRID * TILE_M) / 2;

// Shared by every terrain-anchored layer (water, buildings, trees, lines) so
// their heights always agree with the rendered surface, detail window included.
export const heightChunkGLSL = /* glsl */ `
  uniform sampler2D uHeight;   // 6144² base, metres above minElevation
  uniform sampler2D uHeightD;  // 2048² detail window (2 m grid)
  uniform vec2 uDetailMin;     // world xz of the window's NW corner
  uniform float uDetailSize;   // window extent in metres
  uniform float uDetailOn;
  uniform vec2 uExtent;        // metres east-west, north-south
  uniform float uExag;
  uniform float uHScale;       // metres per stored unit (1 = float metres,
                               // elevation range = normalized 16-bit storage)

  float sampleHeight(vec2 xz) {
    vec2 uvb = vec2(xz.x / uExtent.x + 0.5, 0.5 - xz.y / uExtent.y);
    float h = texture2D(uHeight, uvb).r * uHScale;
    if (uDetailOn > 0.5) {
      vec2 duv = (xz - uDetailMin) / uDetailSize;
      float edge = min(min(duv.x, 1.0 - duv.x), min(duv.y, 1.0 - duv.y));
      float f = smoothstep(0.015, 0.08, edge);
      if (f > 0.0) {
        float hd = texture2D(uHeightD, clamp(duv, 0.0, 1.0)).r * uHScale;
        h = mix(h, hd, f);
      }
    }
    return h;
  }
`;

const vertexShader = /* glsl */ `
  ${heightChunkGLSL}
  uniform float uEdgeMode;     // 0 = base grid (map-edge skirt), 1 = detail grid
  varying vec2 vUv;
  varying float vRelHeight;    // metres above minElevation (pre-exaggeration)
  varying float vSkirt;
  varying vec3 vWorldPos;

  void main() {
    vec3 flat_ = (modelMatrix * vec4(position, 1.0)).xyz;
    vec2 xz = flat_.xz;
    vec2 uvb = vec2(xz.x / uExtent.x + 0.5, 0.5 - xz.y / uExtent.y);
    vUv = uvb;

    if (uEdgeMode > 0.5 &&
        (abs(xz.x) > uExtent.x * 0.5 || abs(xz.y) > uExtent.y * 0.5)) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // detail grid past the map edge
      vSkirt = 0.0; vRelHeight = 0.0; vWorldPos = vec3(0.0);
      return;
    }

    bool border = uvb.x < 0.0003 || uvb.x > 0.9997 || uvb.y < 0.0003 || uvb.y > 0.9997;
    vSkirt = (uEdgeMode < 0.5 && border) ? 1.0 : 0.0;
    float h = sampleHeight(xz);
    vRelHeight = h;
    vec3 p = vec3(xz.x, vSkirt > 0.5 ? ${SKIRT_DROP.toFixed(1)} : h * uExag, xz.y);
    vWorldPos = p;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  ${heightChunkGLSL}
  uniform sampler2D uOrtho00; // west-south
  uniform sampler2D uOrtho10; // east-south
  uniform sampler2D uOrtho01; // west-north
  uniform sampler2D uOrtho11; // east-north
  uniform sampler2D uOrthoC;  // centre 5 × 5 km at double resolution
  uniform float uMode;         // 0 = orthophoto, 1 = hypsometric relief
  uniform float uMinElev;
  uniform float uMaxElev;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform float uAmbientLvl;
  uniform vec3 uFogColor;
  uniform vec3 uCameraPos;
  uniform float uTime;
  uniform float uCloudCover;
  uniform vec2 uCloudDrift;
  uniform sampler2D uWater;    // water polygon mask, blended in place
  uniform sampler2D uRegion;   // region-of-interest fade (1 = clear, 0 = fog)
  uniform float uRegionOn;
  varying vec2 vUv;
  varying float vRelHeight;
  varying float vSkirt;
  varying vec3 vWorldPos;

  vec3 orthoColor(vec2 uv) {
    vec2 luv = fract(uv * 2.0);
    vec3 base;
    if (uv.x < 0.5) {
      base = uv.y < 0.5 ? texture2D(uOrtho00, luv).rgb : texture2D(uOrtho01, luv).rgb;
    } else {
      base = uv.y < 0.5 ? texture2D(uOrtho10, luv).rgb : texture2D(uOrtho11, luv).rgb;
    }
    // centre tile covers the central quarter of the extent; soft 120 m edge
    vec2 cuv = (uv - 0.375) * 4.0;
    vec2 d = min(cuv, 1.0 - cuv);
    float inCentre = smoothstep(0.0, 0.024, min(d.x, d.y));
    base = mix(base, texture2D(uOrthoC, clamp(cuv, 0.0, 1.0)).rgb, inCentre);
    return base;
  }

  vec3 hypsometric(float t) {
    vec3 c0 = vec3(0.24, 0.42, 0.30);  // valley green
    vec3 c1 = vec3(0.47, 0.60, 0.35);  // meadow
    vec3 c2 = vec3(0.76, 0.68, 0.44);  // ochre
    vec3 c3 = vec3(0.62, 0.46, 0.31);  // sienna
    vec3 c4 = vec3(0.93, 0.90, 0.86);  // summit pale
    vec3 c = mix(c0, c1, smoothstep(0.00, 0.30, t));
    c = mix(c, c2, smoothstep(0.30, 0.62, t));
    c = mix(c, c3, smoothstep(0.62, 0.85, t));
    c = mix(c, c4, smoothstep(0.85, 1.00, t));
    return c;
  }

  float contour(float elevation, float interval) {
    float g = elevation / interval;
    float d = abs(fract(g - 0.5) - 0.5) / fwidth(g);
    return 1.0 - smoothstep(0.0, 1.2, d);
  }

  // drifting cloud shadows: two octaves of value noise in world space,
  // wind from the west; multiplies the sun term only
  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
      mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
  }
  float cloudShadow(vec2 uv) {
    vec2 p = uv * uExtent / 2222.0 + uCloudDrift * uTime;
    float n = vnoise(p) * 0.65 + vnoise(p * 2.7 + 13.7) * 0.35;
    return 1.0 - uCloudCover * smoothstep(0.52, 0.78, n);
  }

  // soft terrain-cast shadow: march the base heightmap toward the sun with
  // geometric strides; penumbra widens with occluder distance
  float terrainShadow(vec2 uv, float relHExag, float fragDist) {
    vec2 horiz = vec2(uSunDir.x, uSunDir.z);
    float hl = length(horiz);
    if (hl < 1e-4 || uSunDir.y <= 0.0) return 1.0; // zenith / below horizon
    vec2 stepUv = vec2(horiz.x / hl, -horiz.y / hl) / uExtent; // uv per metre
    float slope = uSunDir.y / hl;                              // rise per metre
    float shade = 1.0;
    float t = 14.0;
    int maxSteps = fragDist < 5000.0 ? 22 : 11; // cheaper far away
    for (int i = 0; i < 22; i++) {
      if (i >= maxSteps) break;
      vec2 suv = uv + stepUv * t;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
      float h = texture2D(uHeight, suv).r * uHScale * uExag;
      float ray = relHExag + 2.0 + slope * t; // small bias against self-shadow acne
      shade = min(shade, clamp((ray - h) / (t * 0.035), 0.0, 1.0));
      t *= 1.32;
    }
    return shade;
  }

  void main() {
    if (vSkirt > 0.02) {
      gl_FragColor = vec4(0.11, 0.095, 0.085, 1.0);
      return;
    }

    // per-pixel normal from central differences on the best height source
    vec2 xz = vWorldPos.xz;
    float delta = 2.6;
    float hL = sampleHeight(xz - vec2(delta, 0.0));
    float hR = sampleHeight(xz + vec2(delta, 0.0));
    float hN = sampleHeight(xz - vec2(0.0, delta)); // −z = north
    float hS = sampleHeight(xz + vec2(0.0, delta));
    vec3 normal = normalize(vec3(
      uExag * (hL - hR),
      2.0 * delta,
      uExag * (hN - hS)
    ));

    float dist0 = distance(vWorldPos, uCameraPos);
    float lambert = max(dot(normal, uSunDir), 0.0);
    if (lambert > 0.001) {
      lambert *= terrainShadow(vUv, vRelHeight * uExag, dist0);
      lambert *= cloudShadow(vUv);
    }
    float ambient = (0.38 + 0.14 * normal.y) * uAmbientLvl;

    vec3 color;
    if (uMode < 0.5) {
      vec3 photo = pow(orthoColor(vUv), vec3(0.92)); // lift shadows slightly
      color = photo * (uAmbient * (ambient + 0.20 * uAmbientLvl) + uSunColor * lambert * 0.62);
    } else {
      float t = vRelHeight / (uMaxElev - uMinElev);
      vec3 tint = hypsometric(t);
      float elevation = vRelHeight + uMinElev;
      float minor = contour(elevation, 20.0) * 0.14;
      float major = contour(elevation, 100.0) * 0.22;
      tint = mix(tint, vec3(0.23, 0.16, 0.10), min(minor + major, 0.34));
      color = tint * (uAmbient * ambient + uSunColor * lambert * 0.85);
    }

    // water, drawn by the terrain itself so it can never gap or z-fight:
    // bright sky reflection with wave sparkle, no view-dependent terms
    float water = smoothstep(0.35, 0.62, texture2D(uWater, vUv).r);
    if (water > 0.003) {
      vec2 wp = vWorldPos.xz;
      float wa = sin(dot(wp, vec2(1.0, 0.3)) * 0.16 + uTime * 1.3);
      float wb = sin(dot(wp, vec2(-0.4, 1.0)) * 0.11 + uTime * 0.8);
      float wc = sin(dot(wp, vec2(0.8, -0.7)) * 0.42 + uTime * 2.1);
      // waves flatten with distance — undersampled sines moiré on a big lake
      float waveAtt = 1.0 - smoothstep(1200.0, 6000.0, dist0);
      vec3 wN = normalize(vec3(
        (wa * 0.045 + wc * 0.025) * waveAtt, 1.0, (wb * 0.05 - wc * 0.02) * waveAtt));
      vec3 deep = vec3(0.04, 0.09, 0.10) * (0.35 + 0.65 * uAmbientLvl);
      vec3 refl = uAmbient * (0.45 + 0.6 * uAmbientLvl);
      vec3 waterCol = mix(deep, refl, 0.55);
      waterCol += uSunColor * pow(max(dot(wN, uSunDir), 0.0), 24.0) * 0.35;
      waterCol *= cloudShadow(vUv); // clouds pass over the river too
      color = mix(color, waterCol, water * 0.9);
    }

    float fog = smoothstep(uFogNear, uFogFar, dist0);
    color = mix(color, uFogColor, fog);

    // region of interest: beyond the border buffer the world sinks into
    // a haze slightly lighter than the distance fog (region.png mask)
    if (uRegionOn > 0.5) {
      float rf = texture2D(uRegion, vUv).r;
      color = mix(uFogColor * 1.28 + vec3(0.045), color, rf);
    }

    gl_FragColor = vec4(color, 1.0);
  }
`;

/** Region-of-interest mask (region.png) → texture; flips uRegionOn. */
async function loadRegionMask(uniforms) {
  if (!area.regionMask) return;
  try {
    const blob = await (await fetch(dataUrl('region.png'))).blob();
    // ImageBitmap ignores THREE's flipY — flip at decode: baked row 0 is
    // north, the shader's v axis points north too
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' });
    const t = new THREE.Texture(bitmap);
    t.flipY = false;
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    uniforms.uRegion.value = t;
    uniforms.uRegionOn.value = 1;
  } catch { /* mask is optional — the map just shows everything */ }
}

// 1×1 zero mask so the terrain renders dry until initWater() swaps it in
function blankWaterMask() {
  const t = new THREE.DataTexture(
    new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

/** Null the CPU copies of a static geometry once the GPU has them.
 *  Bounding volumes are computed first — anything that later asks for a
 *  bounding sphere (frustum culling, raycasts) must never touch the
 *  freed arrays. */
export function freeOnUpload(geometry) {
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  for (const attribute of Object.values(geometry.attributes)) {
    attribute.onUpload(function () { this.array = null; });
  }
  if (geometry.index) geometry.index.onUpload(function () { this.array = null; });
  return geometry;
}

async function readBody(res, onBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onBytes?.(received);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out.buffer;
}

async function fetchWithProgress(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return readBody(res, onBytes);
}

/** Quantized raster as PNG (half the bytes, decodes to the exact same
 *  Uint16 array — lossless grayscale) with the raw .bin as fallback. */
async function fetchHeightRaster(pngFile, binFile, expectPx, onBytes) {
  try {
    const res = await fetch(dataUrl(pngFile));
    if (res.ok && (res.headers.get('content-type') ?? '').includes('png')) {
      const total = Number(res.headers.get('content-length')) || 0;
      const buf = await readBody(res, (b) => onBytes?.(b, total));
      const { data } = await decodeGrayPNG(buf);
      if (data.length === expectPx) return data;
    }
  } catch { /* fall through to .bin */ }
  const buf = await fetchWithProgress(dataUrl(binFile),
    (b) => onBytes?.(b, expectPx * 2));
  return new Uint16Array(buf);
}

/** Streams the 2 m detail window: 2×2 tiles composed around the focus. */
function createDetailStream(uniforms, elevationRange, norm16) {
  const windowPx = TILE_PX * 2;
  const windowData = norm16
    ? new Uint16Array(windowPx * windowPx)
    : new Float32Array(windowPx * windowPx);
  const texture = norm16
    ? new THREE.DataTexture(windowData, windowPx, windowPx, THREE.RedFormat, THREE.UnsignedShortType)
    : new THREE.DataTexture(windowData, windowPx, windowPx, THREE.RedFormat, THREE.FloatType);
  if (norm16) texture.internalFormat = 'R16';
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  uniforms.uHeightD.value = texture;

  const cache = new Map(); // 'tx_tz' → Float32Array | null (missing), LRU order
  const MAX_TILE_CACHE = 12; // ~4 MB each — touring the whole map must not hoard
  let current = '';
  let composing = false;

  async function loadTile(tx, tz) {
    const key = `${tx}_${tz}`;
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key); // refresh recency
      cache.set(key, hit);
      return hit;
    }
    let q = null;
    try {
      const res = await fetch(dataUrl(`h2/tile_${tx}_${tz}.png`));
      if (res.ok && (res.headers.get('content-type') ?? '').includes('png')) {
        const { data: decoded } = await decodeGrayPNG(await res.arrayBuffer());
        if (decoded.length === TILE_PX * TILE_PX) q = decoded;
      }
    } catch { /* png unavailable → try raw */ }
    if (!q) {
      try {
        const res = await fetch(dataUrl(`h2/tile_${tx}_${tz}.bin`));
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (buf.byteLength === TILE_PX * TILE_PX * 2) q = new Uint16Array(buf);
        }
      } catch { /* tile unavailable → no detail here */ }
    }
    let data = null;
    if (q) {
      if (norm16) {
        data = q; // stored quantized — the shader scales by uHScale
      } else {
        data = new Float32Array(q.length);
        for (let i = 0; i < q.length; i++) data[i] = (q[i] / 65535) * elevationRange;
      }
    }
    cache.set(key, data);
    while (cache.size > MAX_TILE_CACHE) {
      cache.delete(cache.keys().next().value); // evict least recently used
    }
    return data;
  }

  async function update(focus) {
    if (composing) return;
    const tx0 = Math.max(0, Math.min(TILE_GRID - 2,
      Math.round((focus.x + TILE_HALF_SPAN) / TILE_M) - 1));
    const tz0 = Math.max(0, Math.min(TILE_GRID - 2,
      Math.round((focus.z + TILE_HALF_SPAN) / TILE_M) - 1));
    const key = `${tx0}_${tz0}`;
    if (key === current) return;
    composing = true;
    try {
      const tiles = await Promise.all([[0, 0], [1, 0], [0, 1], [1, 1]]
        .map(([dx, dz]) => loadTile(tx0 + dx, tz0 + dz)));
      current = key;
      if (tiles.some((t) => !t)) {
        uniforms.uDetailOn.value = 0;
        return;
      }
      for (let dz = 0; dz < 2; dz++) {
        for (let dx = 0; dx < 2; dx++) {
          const t = tiles[dz * 2 + dx];
          for (let r = 0; r < TILE_PX; r++) {
            windowData.set(
              t.subarray(r * TILE_PX, (r + 1) * TILE_PX),
              (dz * TILE_PX + r) * windowPx + dx * TILE_PX);
          }
        }
      }
      texture.needsUpdate = true;
      uniforms.uDetailMin.value.set(
        -TILE_HALF_SPAN + tx0 * TILE_M, -TILE_HALF_SPAN + tz0 * TILE_M);
      uniforms.uDetailSize.value = 2 * TILE_M;
      uniforms.uDetailOn.value = 1;
    } finally {
      composing = false;
    }
  }

  return update;
}

/**
 * Load heightmap + orthophotos, build the layered terrain.
 * @returns {{ mesh, material, heightField, meta, updateDetail }}
 */
export async function loadTerrain(onProgress, caps = {}) {
  const metaRes = await fetch(dataUrl('meta.json'));
  // vite's SPA fallback answers missing files with index.html (HTTP 200)
  if (!metaRes.ok || !(metaRes.headers.get('content-type') ?? '').includes('json')) {
    throw new Error('map data not baked yet');
  }
  const meta = await metaRes.json();

  onProgress?.(0, 0.05);
  const nx = meta.gridSizeX ?? meta.gridSize;
  const nz = meta.gridSizeZ ?? meta.gridSize;
  const quantized = await fetchHeightRaster('heightmap.png', 'heightmap.bin',
    nx * nz, (b, total) => onProgress?.(0,
      0.05 + 0.45 * (b / (total || nx * nz * 2))));

  // Uint16 → metres above min, rows flipped so row 0 = south (v=0)
  const range = meta.maxElevation - meta.minElevation;
  const relHeights = new Float32Array(nx * nz);
  for (let row = 0; row < nz; row++) {
    const src = (nz - 1 - row) * nx;
    const dst = row * nx;
    for (let col = 0; col < nx; col++) {
      relHeights[dst + col] = (quantized[src + col] / 65535) * range;
    }
  }

  // With EXT_texture_norm16 the GPU stores the height raster in its native
  // 16 bits (half the video memory); the shader multiplies by uHScale. The
  // scale moves the ×range multiply from CPU to GPU — worst-case difference
  // ~0.2 µm against the Float32 path, which stays as the exact fallback.
  let heightTexture;
  if (caps.norm16) {
    heightTexture = new THREE.DataTexture(quantized, nx, nz, THREE.RedFormat, THREE.UnsignedShortType);
    heightTexture.internalFormat = 'R16';
    heightTexture.onUpdate = () => { heightTexture.image.data = null; }; // freed after upload
  } else {
    heightTexture = new THREE.DataTexture(relHeights, nx, nz, THREE.RedFormat, THREE.FloatType);
  }
  const hScale = caps.norm16 ? range : 1;
  heightTexture.minFilter = THREE.LinearFilter;
  heightTexture.magFilter = THREE.LinearFilter;
  heightTexture.needsUpdate = true;

  onProgress?.(1, 0.55);
  const loader = new THREE.TextureLoader();
  const orthoTextures = await Promise.all(['00', '10', '01', '11', 'c'].map(async (suffix) => {
    const texture = await loader.loadAsync(dataUrl(`ortho_${suffix}.jpg`));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }));

  onProgress?.(2, 0.9);
  const shared = {
    uHeight: { value: heightTexture },
    uHeightD: { value: null },
    uDetailMin: { value: new THREE.Vector2() },
    uDetailSize: { value: 1 },
    uDetailOn: { value: 0 },
    uOrtho00: { value: orthoTextures[0] },
    uOrtho10: { value: orthoTextures[1] },
    uOrtho01: { value: orthoTextures[2] },
    uOrtho11: { value: orthoTextures[3] },
    uOrthoC: { value: orthoTextures[4] },
    uExag: { value: 1.5 },
    uHScale: { value: hScale },
    uMode: { value: 0 },
    uMinElev: { value: meta.minElevation },
    uMaxElev: { value: meta.maxElevation },
    uExtent: { value: new THREE.Vector2(
      meta.extentMetersX ?? meta.extentMeters, meta.extentMetersZ ?? meta.extentMeters) },
    uFogNear: { value: Math.max(meta.extentMetersX ?? meta.extentMeters,
      meta.extentMetersZ ?? meta.extentMeters) * 0.7 },
    uFogFar: { value: Math.max(meta.extentMetersX ?? meta.extentMeters,
      meta.extentMetersZ ?? meta.extentMeters) * 2.4 },
    uSunDir: { value: new THREE.Vector3(-0.5, 0.72, -0.48).normalize() }, // overwritten per time of day
    uSunColor: { value: new THREE.Color(1.0, 0.96, 0.88) },
    uAmbient: { value: new THREE.Color(0.86, 0.91, 1.0) },
    uAmbientLvl: { value: 1 },
    uFogColor: { value: new THREE.Color('#1d2530') },
    uCameraPos: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uCloudCover: { value: 0.32 },
    uCloudDrift: { value: new THREE.Vector2(0.011, 0.004) },
    uWater: { value: blankWaterMask() },
    uRegion: { value: blankWaterMask() },
    uRegionOn: { value: 0 },
  };

  const makeMaterial = (edgeMode, offset) => new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { ...shared, uEdgeMode: { value: edgeMode } }, // records shared by reference
    polygonOffset: offset !== 0,
    polygonOffsetFactor: offset,
    polygonOffsetUnits: offset * 2,
  });

  const material = makeMaterial(0, 0);
  const ex = meta.extentMetersX ?? meta.extentMeters;
  const ez = meta.extentMetersZ ?? meta.extentMeters;
  const maxExtent = Math.max(ex, ez);
  const baseGeometry = new THREE.PlaneGeometry(ex, ez,
    Math.round(MESH_SEGMENTS * ex / maxExtent), Math.round(MESH_SEGMENTS * ez / maxExtent));
  baseGeometry.deleteAttribute('normal');
  baseGeometry.deleteAttribute('uv'); // shader derives uv from world position
  freeOnUpload(baseGeometry);
  const surface = new THREE.Mesh(baseGeometry, material);
  surface.rotation.x = -Math.PI / 2;
  surface.frustumCulled = false;

  const group = new THREE.Group();
  group.add(surface);

  // nested camera-following detail grids
  const detailMeshes = DETAIL_LEVELS.map((level) => {
    const g = new THREE.PlaneGeometry(level.extent, level.extent, level.segments, level.segments);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    freeOnUpload(g);
    const m = new THREE.Mesh(g, makeMaterial(1, level.offset));
    m.rotation.x = -Math.PI / 2;
    m.frustumCulled = false;
    m.userData.snap = (level.extent / level.segments) * 2;
    group.add(m);
    return m;
  });

  // museum-model pedestal below the skirt
  const pedestal = new THREE.Mesh(
    new THREE.BoxGeometry(ex, 120, ez),
    new THREE.MeshBasicMaterial({ color: '#141110' }),
  );
  pedestal.position.y = SKIRT_DROP - 60;
  group.add(pedestal);

  const streamDetail = createDetailStream(shared, range, !!caps.norm16);
  function updateDetail(focus, cameraPos) {
    // detail grids only earn their vertices up close
    const near = !cameraPos || cameraPos.distanceTo(focus) < 6000;
    for (const m of detailMeshes) {
      m.visible = near;
      const s = m.userData.snap;
      m.position.x = Math.round(focus.x / s) * s;
      m.position.z = Math.round(focus.z / s) * s;
    }
    if (near) streamDetail(focus); // async, self-throttling
  }

  const heightField = new HeightField(relHeights, meta);
  loadRegionMask(material.uniforms); // async — fades in when ready
  return { mesh: group, material, heightField, meta, updateDetail };
}
