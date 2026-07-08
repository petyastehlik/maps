// Shader sky: a fullscreen triangle rendered behind the terrain.
// Per-pixel world ray from the camera basis → vertical gradient
// (horizon → zenith), sun disk + warm halo, dusk glow along the sun's
// azimuth, and a hash-based starfield that fades in at night.

import * as THREE from 'three';

const vertexShader = /* glsl */ `
  varying vec2 vNdc;
  void main() {
    vNdc = position.xy;
    gl_Position = vec4(position.xy, 0.999999, 1.0); // behind everything
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uCamRight;
  uniform vec3 uCamUp;
  uniform vec3 uCamFwd;
  uniform float uTanHalfFov;
  uniform float uAspect;
  uniform vec3 uSunDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform float uStars;
  uniform float uDuskGlow;
  varying vec2 vNdc;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 ray = normalize(
      uCamFwd
      + uCamRight * vNdc.x * uTanHalfFov * uAspect
      + uCamUp * vNdc.y * uTanHalfFov);

    float up = clamp(ray.y, -0.05, 1.0);
    vec3 sky = mix(uHorizon, uZenith, pow(clamp(up * 2.2, 0.0, 1.0), 0.55));

    // dusk glow hugging the horizon around the sun's azimuth
    vec3 sunH = normalize(vec3(uSunDir.x, 0.0, uSunDir.z));
    vec3 rayH = normalize(vec3(ray.x, 0.0, ray.z));
    float toward = max(dot(rayH, sunH), 0.0);
    float band = exp(-abs(ray.y) * 9.0);
    sky += vec3(0.95, 0.42, 0.16) * uDuskGlow * pow(toward, 5.0) * band * 0.55;

    // sun disk + halo (only when above the horizon)
    float cosSun = dot(ray, normalize(uSunDir));
    float above = smoothstep(-0.03, 0.02, uSunDir.y);
    sky += uSunColor * pow(max(cosSun, 0.0), 1600.0) * 4.0 * above;
    sky += uSunColor * pow(max(cosSun, 0.0), 24.0) * 0.16 * above;

    // (real catalogue stars are rendered by celestial.js, not here)
    gl_FragColor = vec4(sky, 1.0);
  }
`;

export function createSky() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0, 3, -1, 0, -1, 3, 0, // fullscreen triangle
  ]), 3));
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uCamRight: { value: new THREE.Vector3() },
      uCamUp: { value: new THREE.Vector3() },
      uCamFwd: { value: new THREE.Vector3() },
      uTanHalfFov: { value: 0.5 },
      uAspect: { value: 1.6 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() },
      uStars: { value: 0 },
      uDuskGlow: { value: 0 },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;

  const right = new THREE.Vector3();
  const upv = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  function update(camera, lighting) {
    camera.matrixWorld.extractBasis(right, upv, fwd);
    material.uniforms.uCamRight.value.copy(right);
    material.uniforms.uCamUp.value.copy(upv);
    material.uniforms.uCamFwd.value.copy(fwd).negate(); // camera looks down −z
    material.uniforms.uTanHalfFov.value =
      Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    material.uniforms.uAspect.value = camera.aspect;
    if (lighting) {
      material.uniforms.uSunDir.value.copy(lighting.sunDir);
      material.uniforms.uZenith.value.copy(lighting.zenith);
      material.uniforms.uHorizon.value.copy(lighting.horizon);
      material.uniforms.uSunColor.value.copy(lighting.sunColor);
      material.uniforms.uStars.value = lighting.stars;
      material.uniforms.uDuskGlow.value = lighting.duskGlow;
    }
  }

  return { mesh, update };
}
