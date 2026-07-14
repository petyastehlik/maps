// Buildings — 37k OSM footprints as oriented boxes, instanced in one draw
// call. Each instance carries (centre, rotation, half-extents, height);
// the vertex shader anchors the base to the heightmap, so buildings ride
// the terrain and the exaggeration slider like everything else. Lit by the
// shared sun/ambient uniforms with warm roofs and per-instance tint
// variation; instances collapse beyond 7 km where they'd be sub-pixel.

import * as THREE from 'three';
import { heightChunkGLSL, freeOnUpload } from './terrain.js';
import { dataUrl, fetchAsset } from './area.js';

const VISIBLE_RANGE = 7000;
const SINK = 1.6; // metres buried below terrain so slope edges don't gap

const vertexShader = /* glsl */ `
  ${heightChunkGLSL}
  uniform sampler2D uOrtho00;
  uniform sampler2D uOrtho10;
  uniform sampler2D uOrtho01;
  uniform sampler2D uOrtho11;
  uniform sampler2D uOrthoC;
  uniform vec3 uCameraPos;
  attribute vec4 aPlace;   // cx, cz, angle, height
  attribute vec2 aSize;    // halfW, halfD
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vOrtho;     // aerial colour at the footprint — ties walls/roof in
  varying float vTint;
  varying float vRoof;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  vec3 orthoAt(vec2 uv) {
    vec2 luv = fract(uv * 2.0);
    vec3 base;
    if (uv.x < 0.5) {
      base = uv.y < 0.5 ? texture2D(uOrtho00, luv).rgb : texture2D(uOrtho01, luv).rgb;
    } else {
      base = uv.y < 0.5 ? texture2D(uOrtho10, luv).rgb : texture2D(uOrtho11, luv).rgb;
    }
    vec2 cuv = (uv - 0.375) * 4.0;
    vec2 d = min(cuv, 1.0 - cuv);
    float inCentre = step(0.0, min(d.x, d.y));
    return mix(base, texture2D(uOrthoC, clamp(cuv, 0.0, 1.0)).rgb, inCentre);
  }

  void main() {
    float c = cos(aPlace.z), s = sin(aPlace.z);
    // y-up unit box (base at y=0): xz is the footprint — right-handed, so
    // triangle winding survives and all faces render outward
    vec2 local = position.xz * aSize * 2.0;
    vec2 world2 = vec2(
      aPlace.x + local.x * c - local.y * s,
      aPlace.y + local.x * s + local.y * c);

    float camDist = distance(uCameraPos.xz, aPlace.xy);
    if (camDist > ${VISIBLE_RANGE.toFixed(1)}) {          // collapse far instances
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      vNormal = vec3(0.0, 1.0, 0.0); vWorldPos = vec3(0.0);
      vOrtho = vec3(0.5); vTint = 1.0; vRoof = 0.0;
      return;
    }

    vec2 uvh = vec2(aPlace.x / uExtent.x + 0.5, 0.5 - aPlace.y / uExtent.y);
    float ground = sampleHeight(aPlace.xy) * uExag;
    vOrtho = orthoAt(uvh);
    float y = ground - ${SINK.toFixed(1)} +
      position.y * (aPlace.w + ${SINK.toFixed(1)});

    vec3 world = vec3(world2.x, y, world2.y);
    vWorldPos = world;
    vec3 n = normal;
    vNormal = normalize(vec3(n.x * c - n.z * s, n.y, n.x * s + n.z * c));
    vRoof = step(0.5, n.y);
    vTint = 0.92 + 0.16 * hash(aPlace.xy);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform float uAmbientLvl;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec3 uCameraPos;
  uniform float uMode;
  uniform vec2 uExtent;
  uniform sampler2D uRegion;
  uniform float uRegionOn;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vOrtho;
  varying float vTint;
  varying float vRoof;

  void main() {
    // same albedo source and lighting formula as the terrain itself, so the
    // boxes sit IN the photo rather than on it: the roof is literally the
    // aerial pixel underneath; walls a darker take on it
    vec3 photo = pow(vOrtho, vec3(0.92));
    vec3 roof = mix(photo, vec3(0.55, 0.36, 0.28), uMode);   // relief: scheme colours
    vec3 wall = mix(photo * 0.72 + vec3(0.05), vec3(0.62, 0.58, 0.52), uMode);
    vec3 albedo = mix(wall, roof, vRoof) * vTint;

    float lambert = max(dot(normalize(vNormal), uSunDir), 0.0);
    float ambient = (0.58 + 0.14 * vNormal.y) * uAmbientLvl;
    vec3 color = albedo * (uAmbient * ambient + uSunColor * lambert * 0.62);

    float dist = distance(vWorldPos, uCameraPos);
    float fog = smoothstep(uFogNear, uFogFar, dist);
    color = mix(color, uFogColor, fog);
    if (uRegionOn > 0.5) {
      // outside the region of interest buildings dissolve into the haze
      vec2 ruv = vec2(vWorldPos.x / uExtent.x + 0.5, 0.5 - vWorldPos.z / uExtent.y);
      float rf = texture2D(uRegion, ruv).r;
      if (rf < 0.32) discard;
      color = mix(uFogColor * 1.28 + vec3(0.045), color, rf);
    }
    gl_FragColor = vec4(color, 1.0); // opaque — buildings are sub-pixel at the range cutoff
  }
`;

export async function initBuildings(terrainUniforms) {
  const buf = await fetchAsset('buildings.bin');
  const records = new Float32Array(buf);
  const count = records.length / 6;

  // y-up unit box with its base at y = 0
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = box.index;
  geometry.setAttribute('position', box.getAttribute('position'));
  geometry.setAttribute('normal', box.getAttribute('normal'));

  const place = new Float32Array(count * 4);
  const size = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const r = records.subarray(i * 6, i * 6 + 6);
    place[i * 4] = r[0];     // cx
    place[i * 4 + 1] = r[1]; // cz
    place[i * 4 + 2] = r[4]; // angle
    place[i * 4 + 3] = r[5]; // height
    size[i * 2] = r[2];      // halfW
    size[i * 2 + 1] = r[3];  // halfD
  }
  geometry.setAttribute('aPlace', new THREE.InstancedBufferAttribute(place, 4));
  geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 2));
  geometry.instanceCount = count;

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
      uOrtho00: terrainUniforms.uOrtho00,
      uOrtho10: terrainUniforms.uOrtho10,
      uOrtho01: terrainUniforms.uOrtho01,
      uOrtho11: terrainUniforms.uOrtho11,
      uOrthoC: terrainUniforms.uOrthoC,
      uExag: terrainUniforms.uExag,
      uExtent: terrainUniforms.uExtent,
      uCameraPos: terrainUniforms.uCameraPos,
      uSunDir: terrainUniforms.uSunDir,
      uSunColor: terrainUniforms.uSunColor,
      uAmbient: terrainUniforms.uAmbient,
      uAmbientLvl: terrainUniforms.uAmbientLvl,
      uFogColor: terrainUniforms.uFogColor,
      uRegion: terrainUniforms.uRegion,
      uRegionOn: terrainUniforms.uRegionOn,
      uFogNear: terrainUniforms.uFogNear,
      uFogFar: terrainUniforms.uFogFar,
      uMode: terrainUniforms.uMode,
    },
  });

  const mesh = new THREE.Mesh(freeOnUpload(geometry), material);
  mesh.frustumCulled = false;
  return mesh;
}
