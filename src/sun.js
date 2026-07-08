// Solar position + a small lighting model for the map's time-of-day.
// Standard declination/hour-angle astronomy (±0.5° — plenty for lighting),
// evaluated for the map centre. One function returns everything the terrain
// shader and the sky need, so they can never disagree.

import * as THREE from 'three';

let LAT = THREE.MathUtils.degToRad(49.8878183);
let LON_DEG = 14.1978160;

/** Point the solar model at another map centre (same CET/CEST timezone). */
export function setSunObserver(latDeg, lonDeg) {
  LAT = THREE.MathUtils.degToRad(latDeg);
  LON_DEG = lonDeg;
}

/** Solar elevation + azimuth (radians; azimuth from north, clockwise)
 *  for local wall-clock `hours` (CEST) on day-of-year `doy`. */
export function solarPosition(hours, doy) {
  const decl = THREE.MathUtils.degToRad(23.44) *
    Math.sin((2 * Math.PI / 365) * (doy - 81));
  const solarTime = hours - 2 + LON_DEG / 15; // CEST → UTC → local solar
  const hourAngle = THREE.MathUtils.degToRad(15 * (solarTime - 12));
  const sinEl = Math.sin(LAT) * Math.sin(decl) +
    Math.cos(LAT) * Math.cos(decl) * Math.cos(hourAngle);
  const elevation = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1));
  const cosAz = (Math.sin(decl) - sinEl * Math.sin(LAT)) /
    (Math.cos(elevation) * Math.cos(LAT));
  let azimuth = Math.acos(THREE.MathUtils.clamp(cosAz, -1, 1));
  if (hourAngle > 0) azimuth = 2 * Math.PI - azimuth;
  return { elevation, azimuth };
}

const mix = (a, b, t) => a.clone().lerp(b, THREE.MathUtils.clamp(t, 0, 1));
const C = (hex) => new THREE.Color(hex);

// key colours along the day cycle
const SUN_NOON = C('#fff4e0');
const SUN_LOW = C('#ff8b3d');
const AMBIENT_DAY = C('#dbe6f4');
const AMBIENT_DUSK = C('#8b90b8');
const AMBIENT_NIGHT = C('#1c2438');
const ZENITH_DAY = C('#3f6ba8');
const ZENITH_DUSK = C('#252a52');
const ZENITH_NIGHT = C('#05070e');
const HORIZON_DAY = C('#b8cfe0');
const HORIZON_DUSK = C('#e8763a');
const HORIZON_NIGHT = C('#0d1220');

/**
 * Lighting state for local time `hours` (0–24, CEST) — world-space sun
 * direction (toward the sun; may point below horizon at night), light
 * colours, sky gradient colours, star visibility.
 * @param moon optional real moon: { up, dir: THREE.Vector3, fraction } —
 *             night light follows the actual moon and its phase.
 */
export function lightingForTime(hours, doy = 172, moon = null) {
  const { elevation, azimuth } = solarPosition(hours, doy);
  const el = elevation;

  // sun direction in world frame: +x east, −z north, +y up
  const cosEl = Math.cos(el);
  const sunDir = new THREE.Vector3(
    Math.sin(azimuth) * cosEl, Math.sin(el), -Math.cos(azimuth) * cosEl);

  const elDeg = THREE.MathUtils.radToDeg(el);
  // wide twilight ramps — civil twilight (0…−6°) is still bright to the eye;
  // full darkness only arrives near nautical twilight's end (~−12°)
  const day = THREE.MathUtils.smoothstep(elDeg, -10, 2);
  const dusk = 1 - Math.abs(THREE.MathUtils.smoothstep(elDeg, -12, 12) - 0.5) * 2;
  const night = 1 - THREE.MathUtils.smoothstep(elDeg, -16, -6);

  const sunStrength = THREE.MathUtils.smoothstep(elDeg, -1.5, 5);
  const warm = 1 - THREE.MathUtils.smoothstep(elDeg, 2, 35);
  // low sun hits surfaces at grazing angles (small lambert) — compensate so
  // golden-hour light reads warm and strong instead of merely dark
  let sunColor = mix(SUN_NOON, SUN_LOW, warm)
    .multiplyScalar(sunStrength * (1 + 0.9 * warm * sunStrength));

  // deep night: hand the key light to the moon — CROSSFADED (an instant
  // switch pops on water); the real moon direction and phase when known,
  // faint zenith starlight when the moon is down
  const moonBlend = 1 - THREE.MathUtils.smoothstep(elDeg, -8, -3.5);
  let nightDir, nightColor;
  if (moon?.up) {
    nightDir = moon.dir.clone().normalize();
    nightColor = C('#3d5273').multiplyScalar(0.25 + 0.65 * (moon.fraction ?? 0.5));
  } else {
    nightDir = new THREE.Vector3(-0.15, 0.92, 0.36).normalize();
    nightColor = C('#26303f').multiplyScalar(0.28);
  }
  const lightDir = sunDir.clone().lerp(nightDir, moonBlend).normalize();
  sunColor.lerp(nightColor, moonBlend);

  const ambient = mix(mix(AMBIENT_NIGHT, AMBIENT_DUSK, dusk), AMBIENT_DAY, day);
  const zenith = mix(mix(ZENITH_NIGHT, ZENITH_DUSK, dusk), ZENITH_DAY, day);
  const horizon = mix(mix(HORIZON_NIGHT, ZENITH_DUSK.clone().lerp(HORIZON_DUSK, 0.6), dusk),
    HORIZON_DAY, day);
  // fog reads as the far horizon — keep it a touch darker than the sky line
  const fog = horizon.clone().multiplyScalar(0.55 + 0.35 * day);

  return {
    sunDir, lightDir, sunColor, ambient, zenith, horizon, fog,
    ambientLevel: 0.22 + 0.78 * day,
    stars: night,
    duskGlow: dusk * (1 - day),
    elevationDeg: elDeg,
  };
}
