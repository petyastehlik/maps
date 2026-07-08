// Water surfaces (Berounka + ponds). The OSM polygons are rasterized into a
// mask texture once at load; the terrain fragment shader blends the water
// color wherever the mask is set. Because the water is drawn BY the terrain,
// it follows the rendered surface exactly at every LOD — no separate mesh,
// so gaps and z-fighting against the banks are impossible. (DMR 5G LIDAR
// records the water surface itself, so terrain height IS the water level.)

import * as THREE from 'three';
import { dataUrl, fetchAsset } from './area.js';

const MASK_SIZE = 4096; // 4.9 m/px over the 20 km extent

export async function initWater(terrainUniforms) {
  const buf = await fetchAsset('water.bin');
  const flat = new Float32Array(buf); // xz triangle soup in world metres

  const { x: extentX, y: extentZ } = terrainUniforms.uExtent.value;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MASK_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
  ctx.fillStyle = '#fff';

  // world xz → base-uv → pixel; canvas row r holds v = r/size, which is
  // exactly how DataTexture rows map (flipY is a no-op for data textures)
  const px = (x) => (x / extentX + 0.5) * MASK_SIZE;
  const py = (z) => (0.5 - z / extentZ) * MASK_SIZE;
  ctx.beginPath();
  for (let i = 0; i + 5 < flat.length; i += 6) {
    ctx.moveTo(px(flat[i]), py(flat[i + 1]));
    ctx.lineTo(px(flat[i + 2]), py(flat[i + 3]));
    ctx.lineTo(px(flat[i + 4]), py(flat[i + 5]));
    ctx.closePath();
  }
  ctx.fill();

  // keep only one byte per texel on the GPU
  const rgba = ctx.getImageData(0, 0, MASK_SIZE, MASK_SIZE).data;
  const mask = new Uint8Array(MASK_SIZE * MASK_SIZE);
  for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4];
  const texture = new THREE.DataTexture(
    mask, MASK_SIZE, MASK_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  terrainUniforms.uWater.value = texture;
  return { texture };
}
