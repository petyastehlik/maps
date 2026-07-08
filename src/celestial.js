// The real night sky over Halouny: 1,637 catalogue stars (HYG ≤ mag 5),
// the four bright planets, and a phase-correct Moon, all placed by true
// positions for the chosen time and rotating with sidereal time. Plus
// today's sun path arc, shown while the time slider is being used.

import * as THREE from 'three';
import {
  moonState, toHorizontal, horizontalToWorld, planetStates, PLANET_STYLE,
} from './astro.js';
import { solarPosition } from './sun.js';

const RADIUS = 54_000;
const PLANETS = ['venus', 'mars', 'jupiter', 'saturn'];

const starsVertex = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aPierce;
  uniform float uPixelRatio;
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    // bright objects pierce twilight: Venus shows at dusk long before the
    // faint stars — a low exponent lifts them out of a small uOpacity
    vAlpha = pow(uOpacity, mix(1.6, 0.25, aPierce));
    vec4 mv = viewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio;
    gl_Position = projectionMatrix * mv;
  }
`;
const starsFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float alpha = smoothstep(0.5, 0.16, d) * vAlpha;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`;

// how early an object of magnitude `mag` cuts through twilight (0 faint … 1 Venus)
const pierceFor = (mag) => THREE.MathUtils.clamp((1.5 - mag) / 6, 0, 1);

function starColor(ci) {
  // B−V colour index → warm/cool tint
  const t = THREE.MathUtils.clamp((ci + 0.2) / 1.8, 0, 1);
  return [
    0.72 + 0.28 * t,
    0.80 + 0.05 * t,
    1.0 - 0.38 * t,
  ];
}

function drawMoonPhase(canvas, fraction, waxing) {
  const S = canvas.width;
  const r = S * 0.46;
  const cx = S / 2, cy = S / 2;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  // dark disc base
  ctx.fillStyle = 'rgba(70, 74, 86, 0.55)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // lit part: half-disc + terminator half-ellipse
  const lit = '#f2ead8';
  const sign = waxing ? 1 : -1; // waxing: light on the right (NH evening)
  ctx.fillStyle = lit;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, sign < 0);
  const k = 2 * fraction - 1; // −1 new … +1 full; terminator semi-axis
  ctx.ellipse(cx, cy, Math.abs(k * r), r, 0, Math.PI / 2, -Math.PI / 2,
    (k * sign) < 0);
  ctx.fill();
}

export async function initCelestial() {
  const catalogue = await (await fetch('data/stars.json')).json();
  const group = new THREE.Group();

  const starCount = catalogue.length;
  const total = starCount + PLANETS.length;
  const positions = new Float32Array(total * 3);
  const sizes = new Float32Array(total);
  const colors = new Float32Array(total * 3);
  const pierces = new Float32Array(total);
  for (let i = 0; i < starCount; i++) {
    const [, , mag, ci] = catalogue[i];
    sizes[i] = THREE.MathUtils.clamp(6.4 - mag * 1.15, 1.5, 8.5);
    pierces[i] = pierceFor(mag);
    const bright = THREE.MathUtils.clamp(1.25 - mag * 0.19, 0.28, 1.25);
    const c = starColor(ci);
    colors.set([c[0] * bright, c[1] * bright, c[2] * bright], i * 3);
  }
  PLANETS.forEach((name, k) => {
    const i = starCount + k;
    const style = PLANET_STYLE[name];
    sizes[i] = THREE.MathUtils.clamp(6.4 - style.mag * 1.15, 5, 11);
    pierces[i] = pierceFor(style.mag);
    colors.set(style.color, i * 3);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aPierce', new THREE.BufferAttribute(pierces, 1));
  const starsMaterial = new THREE.ShaderMaterial({
    vertexShader: starsVertex,
    fragmentShader: starsFragment,
    uniforms: {
      uOpacity: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    transparent: true,
    depthWrite: false,
  });
  const stars = new THREE.Points(geometry, starsMaterial);
  stars.frustumCulled = false;
  group.add(stars);

  // ── moon sprite with phase texture ───────────────────────────────────────
  const moonCanvas = document.createElement('canvas');
  moonCanvas.width = moonCanvas.height = 128;
  const moonTexture = new THREE.CanvasTexture(moonCanvas);
  moonTexture.colorSpace = THREE.SRGBColorSpace;
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: moonTexture, transparent: true, depthWrite: false, opacity: 1,
  }));
  moon.scale.setScalar(RADIUS * 0.022); // ≈ 1.25° — slightly hero-sized
  group.add(moon);
  let lastPhase = -1;

  // ── sun path arc for today, revealed while the slider is used ───────────
  const arcGroup = new THREE.Group();
  let arcOpacity = 0;
  let arcWanted = 0;
  let arcTimer = 0;
  function buildArc(doy) {
    const pts = [];
    const hourDots = [];
    for (let h = 2; h <= 23; h += 1 / 12) {
      const { elevation, azimuth } = solarPosition(h, doy);
      if (elevation < -0.02) continue;
      const d = horizontalToWorld(elevation * 180 / Math.PI, azimuth * 180 / Math.PI);
      const p = new THREE.Vector3(d.x, d.y, d.z).multiplyScalar(RADIUS * 0.92);
      pts.push(p);
      if (Math.abs(h - Math.round(h)) < 1 / 24) hourDots.push(p);
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({
        color: '#f3ead9', transparent: true, opacity: 0, depthWrite: false,
      }));
    const dots = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(hourDots),
      new THREE.PointsMaterial({
        color: '#ff7a2f', size: 7, sizeAttenuation: false,
        transparent: true, opacity: 0, depthWrite: false,
      }));
    line.frustumCulled = dots.frustumCulled = false;
    arcGroup.add(line, dots);
  }

  group.add(arcGroup);

  function setTime(jd, lst) {
    for (let i = 0; i < starCount; i++) {
      const [ra, dec] = catalogue[i];
      const { alt, az } = toHorizontal(ra, dec, lst);
      const d = horizontalToWorld(alt, az);
      positions[i * 3] = d.x * RADIUS;
      positions[i * 3 + 1] = d.y * RADIUS;
      positions[i * 3 + 2] = d.z * RADIUS;
    }
    const planetEq = planetStates(jd);
    PLANETS.forEach((name, k) => {
      const i = starCount + k;
      const { alt, az } = toHorizontal(planetEq[name].ra, planetEq[name].dec, lst);
      const d = horizontalToWorld(alt, az);
      positions[i * 3] = d.x * RADIUS;
      positions[i * 3 + 1] = d.y * RADIUS;
      positions[i * 3 + 2] = d.z * RADIUS;
    });
    geometry.getAttribute('position').needsUpdate = true;

    const m = moonState(jd);
    const mh = toHorizontal(m.ra, m.dec, lst);
    const md = horizontalToWorld(mh.alt, mh.az);
    moon.position.set(md.x, md.y, md.z).multiplyScalar(RADIUS * 0.96);
    if (Math.abs(m.fraction - lastPhase) > 0.005) {
      lastPhase = m.fraction;
      drawMoonPhase(moonCanvas, m.fraction, m.waxing);
      moonTexture.needsUpdate = true;
    }
    return { moonAltDeg: mh.alt, moonDir: md, moonFraction: m.fraction };
  }

  /** Per-frame: fade stars with night, fade the sun arc in/out. */
  function update(dt, nightFactor, duskFactor) {
    // stars fade in as night falls; moon is visible even at dusk
    starsMaterial.uniforms.uOpacity.value = nightFactor;
    moon.material.opacity = Math.min(1, nightFactor * 2 + duskFactor * 0.5);
    arcTimer = Math.max(0, arcTimer - dt);
    arcWanted = arcTimer > 0 ? 0.85 : 0;
    arcOpacity += (arcWanted - arcOpacity) * Math.min(1, dt * 6);
    for (const child of arcGroup.children) {
      child.material.opacity = arcOpacity * (child.isLine ? 0.55 : 1);
    }
  }

  /** Call when the user touches the time slider — reveals the sun arc. */
  function pokeArc() { arcTimer = 2.6; }

  return { group, setTime, update, pokeArc, buildArc };
}
