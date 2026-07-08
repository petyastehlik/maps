// OSM cycling routes draped on the terrain. The vertex shader samples the
// same heightmap as the terrain (shared uniform records), so the lines hug
// the surface and track vertical exaggeration exactly; depth testing hides
// them behind ridges like any terrain feature.

import * as THREE from 'three';
import { heightChunkGLSL, freeOnUpload } from './terrain.js';
import { dataUrl, fetchAsset } from './area.js';

const LIFT = 9; // metres above bare-earth terrain, keeps lines out of the surface

const vertexShader = /* glsl */ `
  ${heightChunkGLSL}
  varying vec3 vWorldPos;

  void main() {
    float h = sampleHeight(position.xz);
    vec3 p = vec3(position.x, h * uExag + ${LIFT.toFixed(1)}, position.z);
    vWorldPos = p;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCameraPos;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec3 vWorldPos;

  void main() {
    float dist = distance(vWorldPos, uCameraPos);
    // close-range layer: thousands of lines become noise from afar
    float fade = (1.0 - smoothstep(uFogNear, uFogFar, dist))
      * (1.0 - smoothstep(25000.0, 40000.0, dist));
    gl_FragColor = vec4(uColor, 0.85 * fade);
  }
`;

/** Pick spaced-out label anchor points for each named route. */
function routeLabelAnchors(ways) {
  const candidates = new Map(); // route name → [{x, z, len}]
  for (const way of ways) {
    if (!way.name || !/[\w\u00C0-\u017F]/.test(way.name)) continue; // "?" refs etc.
    let len = 0;
    for (let i = 1; i < way.points.length; i++) {
      len += Math.hypot(way.points[i][0] - way.points[i - 1][0],
        way.points[i][1] - way.points[i - 1][1]);
    }
    const mid = way.points[Math.floor(way.points.length / 2)];
    if (!candidates.has(way.name)) candidates.set(way.name, []);
    candidates.get(way.name).push({ x: mid[0], z: mid[1], len });
  }
  const labels = [];
  for (const [name, cands] of candidates) {
    cands.sort((a, b) => b.len - a.len); // prefer long segments, then space out
    const picked = [];
    for (const c of cands) {
      if (picked.length >= 5) break;
      if (picked.every((p) => Math.hypot(p.x - c.x, p.z - c.z) > 2800)) picked.push(c);
    }
    for (const p of picked) {
      labels.push({ name, type: 'route', x: Math.round(p.x), z: Math.round(p.z) });
    }
  }
  return labels;
}

/**
 * @param terrainUniforms uniforms of the terrain ShaderMaterial — uHeight,
 *        uExag, uExtent, uFogNear, uFogFar, uCameraPos are shared by record
 *        so the lines always agree with the surface.
 * @returns {{ lines: THREE.LineSegments, routeLabels: Array }}
 */
export async function initCycling(terrainUniforms) {
  const ways = await fetchAsset('cycling.json', 'json');

  let segmentCount = 0;
  for (const way of ways) segmentCount += way.points.length - 1;
  const positions = new Float32Array(segmentCount * 2 * 3);
  let o = 0;
  for (const way of ways) {
    const pts = way.points;
    for (let i = 0; i < pts.length - 1; i++) {
      positions[o++] = pts[i][0]; positions[o++] = 0; positions[o++] = pts[i][1];
      positions[o++] = pts[i + 1][0]; positions[o++] = 0; positions[o++] = pts[i + 1][1];
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

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
      uFogNear: terrainUniforms.uFogNear,
      uFogFar: terrainUniforms.uFogFar,
      uCameraPos: terrainUniforms.uCameraPos,
      uColor: { value: new THREE.Color('#ffd75e') },
    },
    transparent: true,
    depthWrite: false,
  });

  const lines = new THREE.LineSegments(freeOnUpload(geometry), material);
  lines.frustumCulled = false; // displaced in shader
  lines.renderOrder = 2;
  return { lines, routeLabels: routeLabelAnchors(ways) };
}
