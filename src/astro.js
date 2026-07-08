// Compact positional astronomy for the map's sky: sidereal time, the Moon
// (truncated Meeus lunar theory, ~0.3° — plenty for rendering), and the
// bright planets (JPL approximate Keplerian elements). All angles degrees
// in/out unless noted; observer at the current area's map centre.

let LAT = 49.8878183;
let LON = 14.1978160;

/** Point the sky at another map centre (call before the first setTime). */
export function setObserver(latDeg, lonDeg) { LAT = latDeg; LON = lonDeg; }
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const OBLIQUITY = 23.4393;

export function julianDate(date) {
  return date.getTime() / 86_400_000 + 2440587.5;
}

/** Local mean sidereal time at the map centre, degrees. */
export function siderealTime(jd) {
  const T = (jd - 2451545.0) / 36525;
  let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
    + 0.000387933 * T * T;
  return ((gmst + LON) % 360 + 360) % 360;
}

/** Equatorial (ra, dec) → horizontal {alt, az} (az from north, clockwise). */
export function toHorizontal(raDeg, decDeg, lstDeg) {
  const H = (lstDeg - raDeg) * D2R;
  const dec = decDeg * D2R;
  const lat = LAT * D2R;
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(H);
  const alt = Math.asin(Math.min(1, Math.max(-1, sinAlt)));
  const az = Math.atan2(
    -Math.cos(dec) * Math.sin(H),
    Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(H));
  return { alt: alt * R2D, az: ((az * R2D) % 360 + 360) % 360 };
}

/** Horizontal → world direction (unit): +x east, +y up, −z north. */
export function horizontalToWorld(altDeg, azDeg) {
  const alt = altDeg * D2R, az = azDeg * D2R;
  const c = Math.cos(alt);
  return {
    x: Math.sin(az) * c,
    y: Math.sin(alt),
    z: -Math.cos(az) * c,
  };
}

function eclipticToEquatorial(lonDeg, latDeg) {
  const l = lonDeg * D2R, b = latDeg * D2R, e = OBLIQUITY * D2R;
  const ra = Math.atan2(
    Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(
    Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  return { ra: ((ra * R2D) % 360 + 360) % 360, dec: dec * R2D };
}

/** Sun's geocentric ecliptic longitude, degrees (low precision). */
export function sunEclipticLongitude(jd) {
  const T = (jd - 2451545.0) / 36525;
  const M = (357.52911 + 35999.05029 * T) * D2R;
  const L0 = 280.46646 + 36000.76983 * T;
  const C = (1.914602 - 0.004817 * T) * Math.sin(M)
    + 0.019993 * Math.sin(2 * M);
  return ((L0 + C) % 360 + 360) % 360;
}

/** Moon: equatorial position + illumination. */
export function moonState(jd) {
  const T = (jd - 2451545.0) / 36525;
  const Lp = 218.3164477 + 481267.88123421 * T;   // mean longitude
  const D = (297.8501921 + 445267.1114034 * T) * D2R;  // elongation
  const M = (357.5291092 + 35999.0502909 * T) * D2R;   // sun anomaly
  const Mp = (134.9633964 + 477198.8675055 * T) * D2R; // moon anomaly
  const F = (93.2720950 + 483202.0175233 * T) * D2R;   // arg. latitude

  const lon = Lp
    + 6.288774 * Math.sin(Mp)
    + 1.274027 * Math.sin(2 * D - Mp)
    + 0.658314 * Math.sin(2 * D)
    + 0.213618 * Math.sin(2 * Mp)
    - 0.185116 * Math.sin(M)
    - 0.114332 * Math.sin(2 * F)
    + 0.058793 * Math.sin(2 * D - 2 * Mp)
    + 0.057066 * Math.sin(2 * D - M - Mp)
    + 0.053322 * Math.sin(2 * D + Mp)
    + 0.045758 * Math.sin(2 * D - M);
  const lat = 5.128122 * Math.sin(F)
    + 0.280602 * Math.sin(Mp + F)
    + 0.277693 * Math.sin(Mp - F)
    + 0.173237 * Math.sin(2 * D - F);

  const { ra, dec } = eclipticToEquatorial(lon, lat);
  const sunLon = sunEclipticLongitude(jd);
  // elongation → illuminated fraction; sign of sin(Δλ) says waxing/waning
  const dLon = ((lon - sunLon) % 360 + 360) % 360;
  const elong = Math.acos(Math.min(1, Math.max(-1,
    Math.cos((lon - sunLon) * D2R) * Math.cos(lat * D2R))));
  const fraction = (1 - Math.cos(elong)) / 2;
  return { ra, dec, fraction, waxing: dLon < 180 };
}

// JPL approximate elements (J2000 epoch values + rates per century):
// a (au), e, i, L, longPeri, longNode
const ELEMENTS = {
  earth: [1.00000261, 0.0000056, 0.01671123, -0.0000439, -0.00001531, -0.01294668,
    100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0, 0],
  venus: [0.72333566, 0.0000039, 0.00677672, -0.00004107, 3.39467605, -0.0007889,
    181.9790995, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418],
  mars: [1.52371034, 0.00001847, 0.09339410, 0.00007882, 1.84969142, -0.00813131,
    -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343],
  jupiter: [5.20288700, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714,
    34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106],
  saturn: [9.53667594, -0.00125060, 0.05386179, -0.00050991, 2.48599187, 0.00193609,
    49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794],
};
export const PLANET_STYLE = {
  venus: { mag: -4.2, color: [1.0, 0.98, 0.9] },
  mars: { mag: 0.6, color: [1.0, 0.6, 0.4] },
  jupiter: { mag: -2.2, color: [1.0, 0.94, 0.82] },
  saturn: { mag: 0.8, color: [0.98, 0.92, 0.72] },
};

function heliocentric(name, T) {
  const el = ELEMENTS[name];
  const a = el[0] + el[1] * T;
  const e = el[2] + el[3] * T;
  const i = (el[4] + el[5] * T) * D2R;
  const L = el[6] + el[7] * T;
  const wBar = el[8] + el[9] * T;
  const node = (el[10] + el[11] * T) * D2R;
  const w = (wBar - (el[10] + el[11] * T)) * D2R; // arg of perihelion
  const M = ((L - wBar) % 360 + 360) % 360 * D2R;
  let E = M;
  for (let k = 0; k < 6; k++) E = M + e * Math.sin(E);
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv);
  const r = Math.hypot(xv, yv);
  // ecliptic heliocentric
  const xh = r * (Math.cos(node) * Math.cos(v + w) - Math.sin(node) * Math.sin(v + w) * Math.cos(i));
  const yh = r * (Math.sin(node) * Math.cos(v + w) + Math.cos(node) * Math.sin(v + w) * Math.cos(i));
  const zh = r * (Math.sin(v + w) * Math.sin(i));
  return [xh, yh, zh];
}

/** Geocentric equatorial positions of the bright planets. */
export function planetStates(jd) {
  const T = (jd - 2451545.0) / 36525;
  const earth = heliocentric('earth', T);
  const out = {};
  for (const name of ['venus', 'mars', 'jupiter', 'saturn']) {
    const p = heliocentric(name, T);
    const gx = p[0] - earth[0], gy = p[1] - earth[1], gz = p[2] - earth[2];
    const lon = Math.atan2(gy, gx) * R2D;
    const lat = Math.atan2(gz, Math.hypot(gx, gy)) * R2D;
    out[name] = eclipticToEquatorial(lon, lat);
  }
  return out;
}
