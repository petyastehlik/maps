// Queryable elevation grid built from the DMR 5G heightmap.
// World frame: origin at map centre, +x east, −z north, y up (metres × exaggeration).
// Grid rows are stored south-to-north (row 0 = southern edge).

export class HeightField {
  /**
   * @param {Float32Array} relHeights metres above minElevation, row 0 = south
   * @param {object} meta parsed meta.json
   */
  constructor(relHeights, meta) {
    this.h = relHeights;
    this.nx = meta.gridSizeX ?? meta.gridSize;
    this.nz = meta.gridSizeZ ?? meta.gridSize;
    this.extentX = meta.extentMetersX ?? meta.extentMeters;
    this.extentZ = meta.extentMetersZ ?? meta.extentMeters;
    this.extent = Math.max(this.extentX, this.extentZ); // scalar consumers
    this.minElevation = meta.minElevation;
    this.maxElevation = meta.maxElevation;
    this.corners = meta.cornersLonLat;
  }

  /** Elevation in metres above minElevation at world (x, z); bilinear. */
  relativeElevationAt(x, z) {
    const { nx, nz, extentX, extentZ } = this;
    const u = (x / extentX + 0.5) * (nx - 1);
    const v = (0.5 - z / extentZ) * (nz - 1); // −z is north = high row index
    if (u < 0 || v < 0 || u > nx - 1 || v > nz - 1) return null;
    const x0 = Math.floor(u), y0 = Math.floor(v);
    const x1 = Math.min(x0 + 1, nx - 1), y1 = Math.min(y0 + 1, nz - 1);
    const fx = u - x0, fy = v - y0;
    const a = this.h[y0 * nx + x0], b = this.h[y0 * nx + x1];
    const c = this.h[y1 * nx + x0], d = this.h[y1 * nx + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  /** Absolute elevation (m a.s.l.) at world (x, z), or null outside the map. */
  elevationAt(x, z) {
    const rel = this.relativeElevationAt(x, z);
    return rel === null ? null : rel + this.minElevation;
  }

  /** WGS-84 [lon, lat] at world (x, z) — bilinear across true corner coordinates. */
  lonLatAt(x, z) {
    const u = x / this.extentX + 0.5;
    const v = 0.5 - z / this.extentZ; // v = 0 south … 1 north
    const { sw, se, nw, ne } = this.corners;
    const lerp = (a, b, t) => a + (b - a) * t;
    return [
      lerp(lerp(sw[0], se[0], u), lerp(nw[0], ne[0], u), v),
      lerp(lerp(sw[1], se[1], u), lerp(nw[1], ne[1], u), v),
    ];
  }

  /**
   * March a ray against the exaggerated terrain surface.
   * @returns {{x:number,y:number,z:number}|null} hit point in world space
   */
  probe(origin, dir, exaggeration) {
    const maxT = 40_000;
    let t = 0;
    let prevT = 0;
    let prevDiff = null;
    while (t < maxT) {
      const px = origin.x + dir.x * t;
      const py = origin.y + dir.y * t;
      const pz = origin.z + dir.z * t;
      const rel = this.relativeElevationAt(px, pz);
      if (rel !== null) {
        const surfaceY = rel * exaggeration;
        const diff = py - surfaceY;
        if (diff <= 0) {
          if (prevDiff === null) return null; // started underground
          // bisect between prevT and t for a crisp hit
          let lo = prevT, hi = t;
          for (let i = 0; i < 12; i++) {
            const mid = (lo + hi) / 2;
            const mx = origin.x + dir.x * mid;
            const mz = origin.z + dir.z * mid;
            const mRel = this.relativeElevationAt(mx, mz) ?? 0;
            if (origin.y + dir.y * mid - mRel * exaggeration <= 0) hi = mid;
            else lo = mid;
          }
          const ft = (lo + hi) / 2;
          return { x: origin.x + dir.x * ft, y: origin.y + dir.y * ft, z: origin.z + dir.z * ft };
        }
        prevDiff = diff;
        // step proportional to height above terrain, clamped
        prevT = t;
        t += Math.max(4, Math.min(diff * 0.7, 200));
      } else {
        prevT = t;
        prevDiff = null;
        t += 200;
      }
    }
    return null;
  }
}
