// Trees — instanced crossed-quad conifers scattered over the OSM forest mask
// in 512 m chunks around the camera focus. Placement is a pure hash of the
// world cell, so trees never pop to different spots; chunks rebuild only
// when the focus crosses a chunk boundary. The sprite is drawn on a canvas
// at startup (no asset), lit by the shared sun uniforms.

import * as THREE from 'three';
import { heightChunkGLSL } from './terrain.js';
import { dataUrl, fetchAsset } from './area.js';
import { decodeGrayPNG } from './png16.js';

/** Forest mask as PNG (40× smaller, decodes to the identical bytes) with
 *  the raw .bin as fallback. */
async function loadForestMask() {
  try {
    const res = await fetch(dataUrl('forest.png'));
    if (res.ok && (res.headers.get('content-type') ?? '').includes('png')) {
      const { data } = await decodeGrayPNG(await res.arrayBuffer());
      if (data.length === GRID * GRID) return data;
    }
  } catch { /* fall through */ }
  return new Uint8Array(await fetchAsset('forest.bin'));
}

const CHUNK = 512;            // metres
const RADIUS = 3600;          // visible ring around the camera
const SPACING = 13;           // candidate grid step inside a chunk
const KEEP = 0.75;            // fraction of forest candidates that get a tree
const CAPACITY = 220000;   // worst case: the whole 3.6 km radius is forest
const GRID = 2048;            // forest.bin resolution

const vertexShader = /* glsl */ `
  ${heightChunkGLSL}
  uniform vec3 uCameraPos;
  attribute vec3 aTree;   // x, z, height
  attribute float aTint;
  varying vec2 vUvq;
  varying float vTint;
  varying float vFade;

  void main() {
    float camDist = distance(uCameraPos.xz, aTree.xy);
    if (camDist > ${RADIUS.toFixed(1)}) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      vUvq = vec2(0.0); vTint = 1.0; vFade = 0.0;
      return;
    }
    float ground = sampleHeight(aTree.xy) * uExag;
    float h = aTree.z;
    float w = 0.52 + 0.3 * fract(aTree.z * 7.31); // width variety from height hash
    // fade by shrinking (keeps the material opaque — no transparent pass)
    float grow = 1.0 - smoothstep(${(RADIUS * 0.82).toFixed(1)}, ${RADIUS.toFixed(1)}, camDist);
    vec3 local = position * vec3(h * w, h, h * w) * grow;
    vec3 world = vec3(aTree.x + local.x, ground - 0.4 + local.y, aTree.y + local.z);
    vUvq = uv;
    vTint = aTint;
    vFade = grow;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uSprite;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform float uAmbientLvl;
  uniform vec3 uSunDir;
  varying vec2 vUvq;
  varying float vTint;
  varying float vFade;

  void main() {
    vec4 tex = texture2D(uSprite, vUvq);
    if (tex.a < 0.5 || vFade < 0.03) discard;
    float sun = max(uSunDir.y, 0.0) * 0.55 + 0.25 * max(uSunDir.y, 0.0);
    vec3 color = tex.rgb * vTint *
      (uAmbient * 0.55 * uAmbientLvl + uSunColor * sun);
    gl_FragColor = vec4(color, 1.0);
  }
`;

function drawConiferSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  // trunk
  ctx.fillStyle = '#4a3625';
  ctx.fillRect(60, 104, 8, 24);
  // stacked foliage triangles, darker toward the base
  const layers = [
    [8, 46, '#26401f'], [30, 64, '#2c4a24'], [52, 82, '#33552a'], [74, 104, '#2c4a24'],
  ];
  for (const [top, bottom, fill] of layers) {
    const w = 14 + (bottom / 104) * 44;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(64, top);
    ctx.lineTo(64 - w / 2, bottom);
    ctx.lineTo(64 + w / 2, bottom);
    ctx.closePath();
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipMapLinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

// deterministic per-cell hash → [0, 1)
function hash2(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Downsampled aerial photo as a CPU-side vegetation check: trees are only
 * planted where the pixel actually looks vegetated — keeps them off quarry
 * faces, scree, sand pits and buildings that sit inside OSM forest polygons.
 */
async function loadVegetationSampler(extentX, extentZ) {
  const half = 512; // per quadrant → 1024² whole map (≈ 19.5 m/px at 20 km)
  const size = half * 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // suffix <x><y>, y 0 = south; canvas row 0 = north
  const quads = [['00', 0, half], ['10', half, half], ['01', 0, 0], ['11', half, 0]];
  await Promise.all(quads.map(([suffix, dx, dy]) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, dx, dy, half, half); resolve(); };
    img.onerror = reject;
    img.src = dataUrl(`ortho_${suffix}.jpg`);
  })));
  const data = ctx.getImageData(0, 0, size, size).data;
  return (x, z) => {
    const px = Math.min(size - 1, Math.max(0, Math.floor((x / extentX + 0.5) * size)));
    const py = Math.min(size - 1, Math.max(0, Math.floor((z / extentZ + 0.5) * size)));
    const i = (py * size + px) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = 0.3 * r + 0.55 * g + 0.15 * b;
    // reject what is clearly NOT vegetation: bright rock/sand/concrete,
    // reddish bare ground, bluish roofs/water — dark shadowed forest passes
    return lum < 148 && g >= b - 4 && g >= r - 14;
  };
}

export async function initTrees(terrainUniforms) {
  const { x: extentX, y: extentZ } = terrainUniforms.uExtent.value; // per-area
  const [mask, isVegetated] = await Promise.all([
    loadForestMask(),
    loadVegetationSampler(extentX, extentZ),
  ]);
  const isForest = (x, z) => {
    const col = Math.floor((x / extentX + 0.5) * GRID);
    const row = Math.floor((z / extentZ + 0.5) * GRID);
    if (col < 0 || col >= GRID || row < 0 || row >= GRID) return false;
    return mask[row * GRID + col] > 0;
  };

  // crossed quads, base at y=0, unit height
  const positions = new Float32Array([
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
    0, 0, -0.5, 0, 0, 0.5, 0, 1, 0.5, 0, 1, -0.5,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
  const index = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(index);

  const treeAttr = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
  const tintAttr = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
  treeAttr.setUsage(THREE.DynamicDrawUsage);
  tintAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aTree', treeAttr);
  geometry.setAttribute('aTint', tintAttr);
  geometry.instanceCount = 0;

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uHeight: terrainUniforms.uHeight,
      uHeightD: terrainUniforms.uHeightD,
      uHScale: terrainUniforms.uHScale,
      uDetailMin: terrainUniforms.uDetailMin,
      uDetailSize: terrainUniforms.uDetailSize,
      uDetailOn: terrainUniforms.uDetailOn,
      uExag: terrainUniforms.uExag,
      uExtent: terrainUniforms.uExtent,
      uCameraPos: terrainUniforms.uCameraPos,
      uSunDir: terrainUniforms.uSunDir,
      uSunColor: terrainUniforms.uSunColor,
      uAmbient: terrainUniforms.uAmbient,
      uAmbientLvl: terrainUniforms.uAmbientLvl,
      uSprite: { value: drawConiferSprite() },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  let lastChunkX = Infinity, lastChunkZ = Infinity;

  function rebuild(focusX, focusZ) {
    let n = 0;
    const chunkRange = Math.ceil(RADIUS / CHUNK);
    const cx = Math.round(focusX / CHUNK), cz = Math.round(focusZ / CHUNK);
    for (let dz = -chunkRange; dz <= chunkRange; dz++) {
      for (let dx = -chunkRange; dx <= chunkRange; dx++) {
        const baseX = (cx + dx) * CHUNK, baseZ = (cz + dz) * CHUNK;
        const cells = Math.floor(CHUNK / SPACING);
        for (let iz = 0; iz < cells; iz++) {
          for (let ix = 0; ix < cells; ix++) {
            const gx = Math.round(baseX / SPACING) + ix;
            const gz = Math.round(baseZ / SPACING) + iz;
            const h1 = hash2(gx, gz);
            if (h1 > KEEP) continue;
            const x = baseX + ix * SPACING + (hash2(gx + 7919, gz) - 0.5) * SPACING * 0.9;
            const z = baseZ + iz * SPACING + (hash2(gx, gz + 104729) - 0.5) * SPACING * 0.9;
            if ((x - focusX) ** 2 + (z - focusZ) ** 2 > RADIUS * RADIUS) continue;
            if (!isForest(x, z)) continue;
            if (!isVegetated(x, z)) continue; // no trees on quarry/rock/sand
            if (n >= CAPACITY) break;
            treeAttr.array[n * 3] = x;
            treeAttr.array[n * 3 + 1] = z;
            treeAttr.array[n * 3 + 2] = 13 + hash2(gx + 31, gz + 17) * 9; // 13–22 m
            tintAttr.array[n] = 0.8 + hash2(gx + 3, gz + 11) * 0.45;
            n++;
          }
        }
      }
    }
    geometry.instanceCount = n;
    treeAttr.needsUpdate = true;
    tintAttr.needsUpdate = true;
  }

  /** Call per frame with the CAMERA position (the shader culls by camera
   *  distance — the rebuild centre must be the same reference point). */
  function update(cameraPos) {
    const cxNow = Math.round(cameraPos.x / CHUNK), czNow = Math.round(cameraPos.z / CHUNK);
    if (cxNow === lastChunkX && czNow === lastChunkZ) return;
    lastChunkX = cxNow; lastChunkZ = czNow;
    rebuild(cameraPos.x, cameraPos.z);
  }

  return { mesh, update };
}
