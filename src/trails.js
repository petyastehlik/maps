// MTB trails („Traily") — OSM ways tagged mtb:scale, draped like the cycling
// routes but coloured by singletrack difficulty (MTB convention:
// S0 green, S1 blue, S2 red, S3+ black). Data is ODbL OpenStreetMap;
// Trailforks' own data is licence-locked to their API (see repo notes).

import * as THREE from 'three';
import { heightChunkGLSL, freeOnUpload } from './terrain.js';
import { fetchAsset } from './area.js';

const LIFT = 8; // just under the cycling routes' 9 m to avoid coplanar flicker

export const TRAIL_COLORS = {
  0: '#6fbf4a', 1: '#4a90d9', 2: '#e05252', 3: '#181818',
};
const colorForScale = (s) => new THREE.Color(TRAIL_COLORS[Math.min(s, 3)]);

const vertexShader = /* glsl */ `
  ${heightChunkGLSL}
  varying vec3 vWorldPos;
  varying vec3 vColor;

  void main() {
    float h = sampleHeight(position.xz);
    vec3 p = vec3(position.x, h * uExag + ${LIFT.toFixed(1)}, position.z);
    vWorldPos = p;
    vColor = color;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uCameraPos;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uAmbientLvl;
  varying vec3 vWorldPos;
  varying vec3 vColor;

  void main() {
    float dist = distance(vWorldPos, uCameraPos);
    // close-range layer: thousands of runs become noise from afar
    float fade = (1.0 - smoothstep(uFogNear * 0.7, uFogFar * 0.7, dist))
      * (1.0 - smoothstep(8000.0, 15000.0, dist));
    // trails are unlit paint — they must not glow in the dark
    gl_FragColor = vec4(vColor, 0.9 * fade * (0.25 + 0.75 * uAmbientLvl));
  }
`;

export async function initTrails(terrainUniforms) {
  const ways = await fetchAsset('trails.json', 'json');

  let segmentCount = 0;
  for (const way of ways) segmentCount += way.points.length - 1;
  const positions = new Float32Array(segmentCount * 2 * 3);
  const colors = new Float32Array(segmentCount * 2 * 3);
  let o = 0;
  for (const way of ways) {
    const c = colorForScale(way.s);
    const pts = way.points;
    for (let i = 0; i < pts.length - 1; i++) {
      for (const pt of [pts[i], pts[i + 1]]) {
        positions[o] = pt[0]; positions[o + 1] = 0; positions[o + 2] = pt[1];
        colors[o] = c.r; colors[o + 1] = c.g; colors[o + 2] = c.b;
        o += 3;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    vertexColors: true,
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
      uFogNear: terrainUniforms.uFogNear,
      uFogFar: terrainUniforms.uFogFar,
      uAmbientLvl: terrainUniforms.uAmbientLvl,
    },
    transparent: true,
    depthWrite: false,
  });

  const lines = new THREE.LineSegments(freeOnUpload(geometry), material);
  lines.frustumCulled = false;
  lines.renderOrder = 3;

  // badge anchors: every trail above ~250 m gets a clickable badge (named
  // ones by name — longest segment wins —, the rest by difficulty); the way
  // geometry rides along for the card's length/climb/profile stats
  const candidates = [];
  for (const way of ways) {
    let len = 0;
    for (let i = 1; i < way.points.length; i++) {
      len += Math.hypot(way.points[i][0] - way.points[i - 1][0],
        way.points[i][1] - way.points[i - 1][1]);
    }
    if (len < 250) continue;
    const mid = way.points[Math.floor(way.points.length / 2)];
    candidates.push({
      name: way.name ?? `S${way.s}`, named: !!way.name, type: 'trail', s: way.s,
      x: mid[0], z: mid[1], way: way.points, len,
    });
  }
  const bestNamed = new Map();
  const trailLabels = [];
  for (const c of candidates) {
    if (!c.named) { trailLabels.push(c); continue; }
    const prev = bestNamed.get(c.name);
    if (!prev || c.len > prev.len) bestNamed.set(c.name, c);
  }
  trailLabels.push(...bestNamed.values());

  return { lines, trailLabels };
}
