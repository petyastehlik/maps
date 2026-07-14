// Map-grade camera controller for the terrain viewer.
//
// Interaction scheme (first-class map product, not an orbit demo):
//   left-drag    — grab the ground and pan (the point under the cursor stays
//                  under the cursor), with a gentle glide on release
//   middle-drag  — orbit around the focus point (the terrain at screen
//                  centre): the pivot stays FIXED, the camera glides on a
//                  sphere around it — subtle moves around a landmark
//   wheel/pinch  — inertial dolly toward the ground point under the cursor
//   double-click — fly the focus point to the clicked terrain
//   arrows/WASD  — glide across the map in view-relative directions
//   Q / E        — orbit left / right (combines with WASD, e.g. W+Q)
//
// Pointer input is only *recorded* in event handlers and applied once per
// frame in update() — high-polling mice would otherwise apply the same
// correction several times per frame and judder. All motion goes through
// goal → current exponential smoothing (frame-rate independent), so every
// gesture eases in and out. The camera is clamped so it can never dip below
// the exaggerated terrain, including ridges between camera and focus point.

import * as THREE from 'three';

const MIN_DISTANCE = 250;
const MIN_POLAR = THREE.MathUtils.degToRad(0.5); // from vertical: top-down
const MAX_POLAR = THREE.MathUtils.degToRad(170); // past POS_MAX: sky gaze
// the camera POSITION never dips below this angle — tilting further keeps it
// in place and pitches the view up instead, so you can look at the sky
const POS_MAX_POLAR = THREE.MathUtils.degToRad(82);
const UP = new THREE.Vector3(0, 1, 0);
const ROTATE_SPEED = 0.0045;   // rad per px
const TILT_SPEED = 0.0034;     // rad per px
const WHEEL_SPEED = 0.0014;    // exp factor per wheel px
const KEY_PAN_RATE = 0.85;     // fraction of view distance per second
const KEY_TURN_RATE = 1.05;    // rad per second (Q/E) — subtle orbit
const PAN_THROW = 0.13;        // seconds of release velocity added as glide

const KEY_ACTIONS = {
  ArrowUp: 'fwd', KeyW: 'fwd',
  ArrowDown: 'back', KeyS: 'back',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  KeyQ: 'turnLeft', KeyE: 'turnRight',
};

const damp = (tau, dt) => 1 - Math.exp(-dt / tau);

export class MapCameraControls {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} domElement
   * @param {import('./HeightField.js').HeightField} heightField
   * @param {() => number} getExag current vertical exaggeration
   */
  constructor(camera, domElement, heightField, getExag) {
    this.camera = camera;
    this.dom = domElement;
    this.field = heightField;
    this.getExag = getExag;
    this.halfX = heightField.extentX / 2;
    this.halfZ = heightField.extentZ / 2;
    this.maxDistance = heightField.extent * 1.1; // whole map fits in view

    this.cur = { target: new THREE.Vector3(), azimuth: 0, polar: 1, distance: 6500 };
    this.goal = { target: new THREE.Vector3(), azimuth: 0, polar: 1, distance: 6500 };
    this.flight = false;        // double-click / reset glide → slower target tau
    this.flightTau = 0.35;      // glide time constant; the intro flight slows it
    this.lift = 0;              // terrain-collision lift, smoothed separately

    this.drag = null;           // { mode: 'pan'|'rotate', ... }
    this.keys = new Set();
    this.touchPts = new Map();  // pointerId → {x, y} for active touches
    this.gesture = null;        // two-finger pinch/twist/tilt state

    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();

    const dom = domElement;
    dom.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    dom.addEventListener('pointermove', (e) => this.onPointerMove(e));
    dom.addEventListener('pointerup', (e) => this.onPointerUp(e));
    dom.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    dom.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    dom.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Current focus point (used by the HUD scale bar). */
  get target() { return this.cur.target; }

  /** True once every input and glide has come to rest — the render loop
   *  drops to an idle frame rate while this holds. */
  isSettled() {
    return !this.drag && !this.gesture && this.keys.size === 0 && !this.flight
      && Math.abs(this.goal.distance - this.cur.distance) < 0.5
      && Math.abs(this.goal.azimuth - this.cur.azimuth) < 1e-4
      && Math.abs(this.goal.polar - this.cur.polar) < 1e-4
      && this.goal.target.distanceToSquared(this.cur.target) < 0.25;
  }

  getAzimuthalAngle() { return this.cur.azimuth; }

  groundY(x, z) {
    const rel = this.field.relativeElevationAt(x, z);
    return (rel ?? 0) * this.getExag();
  }

  /** Jump instantly (initial placement). */
  setView(targetX, targetZ, azimuth, polar, distance) {
    for (const s of [this.cur, this.goal]) {
      s.target.set(targetX, this.groundY(targetX, targetZ), targetZ);
      this.clampTargetBounds(s.target);
      s.azimuth = azimuth;
      s.polar = polar;
      s.distance = distance;
    }
    this.update(0.016);
  }

  /** Glide back to a view (R / reset button). */
  flyToView(targetX, targetZ, azimuth, polar, distance) {
    this.goal.target.x = targetX;
    this.goal.target.z = targetZ;
    this.clampTargetBounds(this.goal.target);
    // unwind azimuth so the glide takes the short way round
    const twoPi = Math.PI * 2;
    let az = azimuth;
    while (az - this.cur.azimuth > Math.PI) az -= twoPi;
    while (az - this.cur.azimuth < -Math.PI) az += twoPi;
    this.goal.azimuth = az;
    this.goal.polar = polar;
    this.goal.distance = distance;
    this.flight = true;
  }

  // ── pointer helpers ──────────────────────────────────────────────────────

  rayAt(clientX, clientY) {
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.ray;
  }

  /** Terrain point under a screen position; falls back to the focus plane. */
  groundPointAt(clientX, clientY) {
    const ray = this.rayAt(clientX, clientY);
    const hit = this.field.probe(ray.origin, ray.direction, this.getExag());
    if (hit) return new THREE.Vector3(hit.x, hit.y, hit.z);
    return this.planePointAt(ray, this.cur.target.y);
  }

  /** Intersection of a ray with the horizontal plane y = planeY, clamped. */
  planePointAt(ray, planeY) {
    const dy = ray.direction.y;
    const t = (planeY - ray.origin.y) / (dy === 0 ? -1e-9 : dy);
    if (t <= 0) return null;
    const maxT = this.field.extent * 2.5;
    return ray.origin.clone().addScaledVector(ray.direction, Math.min(t, maxT));
  }

  clampTargetBounds(v) {
    v.x = THREE.MathUtils.clamp(v.x, -this.halfX, this.halfX);
    v.z = THREE.MathUtils.clamp(v.z, -this.halfZ, this.halfZ);
  }

  // ── event handlers ───────────────────────────────────────────────────────

  /** Two-finger gesture: pinch = zoom, vertical drag = tilt. Rotation is
   *  deliberately NOT a gesture — finger-angle noise during a pinch made
   *  the map spin; the on-screen ⟲⟳ buttons rotate instead. */
  beginGesture() {
    this.flightTau = 0.35;
    this.drag = null; // the one-finger pan yields to the gesture
    const [a, b] = [...this.touchPts.values()];
    this.gesture = {
      startDist: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)),
      startMidY: (a.y + b.y) / 2,
      distance: this.goal.distance,
      polar: this.goal.polar,
    };
    this.flight = false;
  }

  applyGesture() {
    const [a, b] = [...this.touchPts.values()];
    const g = this.gesture;
    const dist = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
    this.goal.distance = THREE.MathUtils.clamp(
      g.distance * g.startDist / dist, MIN_DISTANCE, this.maxDistance);
    this.goal.polar = THREE.MathUtils.clamp(
      g.polar - ((a.y + b.y) / 2 - g.startMidY) * TILT_SPEED, MIN_POLAR, MAX_POLAR);
  }

  onPointerDown(e) {
    if (e.pointerType === 'touch') {
      this.touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { this.dom.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      if (this.touchPts.size === 2) { this.beginGesture(); return; }
      if (this.touchPts.size > 2) { this.gesture = null; return; }
      // single finger falls through to the regular pan below
    }
    if (this.drag) return;
    if (e.button === 0) {
      const anchor = this.groundPointAt(e.clientX, e.clientY);
      if (!anchor) return;
      this.drag = {
        mode: 'pan', pointerId: e.pointerId, anchor,
        startTime: performance.now(), samples: [],
      };
    } else if (e.button === 1) {
      e.preventDefault(); // no browser autoscroll
      this.drag = {
        mode: 'rotate', pointerId: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        startAzimuth: this.goal.azimuth, startPolar: this.goal.polar,
      };
    } else {
      return;
    }
    this.drag.clientX = e.clientX;
    this.drag.clientY = e.clientY;
    this.flight = false;
    try { this.dom.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  }

  onPointerMove(e) {
    if (this.touchPts.has(e.pointerId)) {
      this.touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // gesture goals derive absolutely from the start state, so applying
      // per event is idempotent (unlike the pan anchor correction)
      if (this.gesture && this.touchPts.size === 2) this.applyGesture();
    }
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    // record only — the drag is applied once per frame in update()
    this.drag.clientX = e.clientX;
    this.drag.clientY = e.clientY;
  }

  onPointerUp(e) {
    if (this.touchPts.delete(e.pointerId)) {
      if (this.touchPts.size < 2) this.gesture = null;
      if (this.touchPts.size === 1 && !this.drag) {
        // dropping from two fingers to one: the survivor pans afresh
        const [p] = this.touchPts.values();
        const anchor = this.groundPointAt(p.x, p.y);
        if (anchor) {
          this.drag = {
            mode: 'pan', pointerId: [...this.touchPts.keys()][0], anchor,
            startTime: performance.now(), samples: [],
            clientX: p.x, clientY: p.y,
          };
        }
      }
    }
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    if (this.drag.mode === 'pan') {
      // release glide from the last ~150 ms of motion; real flicks qualify,
      // micro-jerks and synthetic bursts don't
      const now = performance.now();
      const s = this.drag.samples[0];
      const windowS = s ? (now - s.t) / 1000 : 0;
      if (now - this.drag.startTime > 120 && windowS > 0.03) {
        const throwVec = new THREE.Vector3(
          (this.cur.target.x - s.x) / windowS, 0, (this.cur.target.z - s.z) / windowS)
          .multiplyScalar(PAN_THROW);
        const maxThrow = this.cur.distance * 0.25;
        if (throwVec.length() > maxThrow) throwVec.setLength(maxThrow);
        this.goal.target.add(throwVec);
        this.clampTargetBounds(this.goal.target);
      }
    }
    try { this.dom.releasePointerCapture(e.pointerId); } catch { /* synthetic */ }
    this.drag = null;
  }

  onWheel(e) {
    e.preventDefault();
    const scale = Math.exp(e.deltaY * (e.ctrlKey ? 4 : 1) * WHEEL_SPEED);
    const prev = this.goal.distance;
    this.goal.distance = THREE.MathUtils.clamp(prev * scale, MIN_DISTANCE, this.maxDistance);
    const applied = this.goal.distance / prev;
    if (applied === 1) return;

    // dolly toward the cursor: keep the ground point under it fixed
    const anchor = this.groundPointAt(e.clientX, e.clientY);
    if (anchor) {
      this.goal.target.x = anchor.x + (this.goal.target.x - anchor.x) * applied;
      this.goal.target.z = anchor.z + (this.goal.target.z - anchor.z) * applied;
      this.clampTargetBounds(this.goal.target);
    }
    this.flight = false;
  }

  onDoubleClick(e) {
    const point = this.groundPointAt(e.clientX, e.clientY);
    if (!point) return;
    this.goal.target.x = point.x;
    this.goal.target.z = point.z;
    this.clampTargetBounds(this.goal.target);
    this.flight = true;
  }

  onKey(e, down) {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // keep browser shortcuts
    const action = KEY_ACTIONS[e.code];
    if (!action) return;
    if (e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    if (down) this.keys.add(action);
    else this.keys.delete(action);
  }

  // ── per-frame update ─────────────────────────────────────────────────────

  update(dt) {
    const { cur, goal } = this;

    // apply the active drag once per frame (see header comment)
    if (this.drag?.mode === 'pan') {
      const ray = this.rayAt(this.drag.clientX, this.drag.clientY);
      const hit = this.planePointAt(ray, this.drag.anchor.y);
      if (hit) {
        const offset = new THREE.Vector3().subVectors(this.drag.anchor, hit);
        offset.y = 0;
        const maxStep = this.field.extent; // reject wild horizon-grazing jumps
        if (offset.lengthSq() <= maxStep * maxStep) {
          this.cur.target.add(offset);
          this.goal.target.add(offset);
          this.clampTargetBounds(this.cur.target);
          this.clampTargetBounds(this.goal.target);
          const now = performance.now();
          this.drag.samples.push({ t: now, x: this.cur.target.x, z: this.cur.target.z });
          while (this.drag.samples.length && now - this.drag.samples[0].t > 160) {
            this.drag.samples.shift();
          }
        }
      }
    } else if (this.drag?.mode === 'rotate') {
      // orbit: the focus point stays put, only the view angles move —
      // the camera glides on a fixed sphere around what you look at
      const dx = this.drag.clientX - this.drag.startX;
      const dy = this.drag.clientY - this.drag.startY;
      goal.azimuth = this.drag.startAzimuth - dx * ROTATE_SPEED;
      goal.polar = THREE.MathUtils.clamp(
        this.drag.startPolar - dy * TILT_SPEED, MIN_POLAR, MAX_POLAR);
    }

    // keyboard: Q/E orbit, WASD glides — they combine (W+Q = advance while turning)
    const turn = this.keys.size
      ? (this.keys.has('turnLeft') ? 1 : 0) - (this.keys.has('turnRight') ? 1 : 0)
      : 0;
    if (turn !== 0 && this.drag?.mode !== 'rotate') {
      goal.azimuth += turn * KEY_TURN_RATE * dt;
    }
    if (this.keys.size) {
      const step = goal.distance * KEY_PAN_RATE * dt;
      const sinA = Math.sin(cur.azimuth), cosA = Math.cos(cur.azimuth);
      const fwd = { x: -sinA, z: -cosA };    // away from the camera
      const right = { x: cosA, z: -sinA };   // screen-right
      let mx = 0, mz = 0;
      if (this.keys.has('fwd')) { mx += fwd.x; mz += fwd.z; }
      if (this.keys.has('back')) { mx -= fwd.x; mz -= fwd.z; }
      if (this.keys.has('right')) { mx += right.x; mz += right.z; }
      if (this.keys.has('left')) { mx -= right.x; mz -= right.z; }
      if (mx !== 0 || mz !== 0) {
        goal.target.x += mx * step;
        goal.target.z += mz * step;
        this.clampTargetBounds(goal.target);
      }
      this.flight = false;
    }

    // the focus point rides on the terrain — frozen during a pan drag so the
    // camera glides level instead of bobbing over every bump under the cursor
    if (this.drag?.mode !== 'pan') {
      goal.target.y = this.groundY(goal.target.x, goal.target.z);
    }

    // goal → current smoothing
    const rotTau = this.drag?.mode === 'rotate' ? 0.09 : 0.16;
    const targetTau = this.flight ? this.flightTau : 0.11;
    cur.azimuth += (goal.azimuth - cur.azimuth) * damp(rotTau, dt);
    cur.polar += (goal.polar - cur.polar) * damp(rotTau, dt);
    cur.distance += (goal.distance - cur.distance) * damp(this.flight ? this.flightTau : 0.12, dt);
    if (!this.drag || this.drag.mode !== 'pan') {
      cur.target.x += (goal.target.x - cur.target.x) * damp(targetTau, dt);
      cur.target.z += (goal.target.z - cur.target.z) * damp(targetTau, dt);
    }
    cur.target.y += (goal.target.y - cur.target.y) * damp(0.45, dt);
    if (this.flight && cur.target.distanceTo(goal.target) < 6
        && Math.abs(cur.distance - goal.distance) < goal.distance * 0.01
        && Math.abs(cur.azimuth - goal.azimuth) < 0.01) {
      // land exactly — the asymptote would otherwise creep for seconds
      cur.target.copy(goal.target);
      cur.distance = goal.distance;
      cur.azimuth = goal.azimuth;
      cur.polar = goal.polar;
      this.flight = false;
      this.flightTau = 0.35;
    }

    // spherical placement — position angle saturates at POS_MAX_POLAR; any
    // remaining polar becomes an upward view pitch applied after lookAt
    const posPolar = Math.min(cur.polar, POS_MAX_POLAR);
    const sinP = Math.sin(posPolar);
    const pos = new THREE.Vector3(
      cur.target.x + cur.distance * sinP * Math.sin(cur.azimuth),
      cur.target.y + cur.distance * Math.cos(posPolar),
      cur.target.z + cur.distance * sinP * Math.cos(cur.azimuth),
    );

    // terrain collision: camera itself plus ridge samples toward the focus
    const clearance = 24 + cur.distance * 0.012;
    let neededLift = this.groundY(pos.x, pos.z) + clearance - pos.y;
    for (const f of [0.12, 0.25, 0.45]) {
      const sx = pos.x + (cur.target.x - pos.x) * f;
      const sy = pos.y + (cur.target.y - pos.y) * f;
      const sz = pos.z + (cur.target.z - pos.z) * f;
      const need = (this.groundY(sx, sz) + clearance * (1 - f) - sy) / (1 - f);
      if (need > neededLift) neededLift = need;
    }
    neededLift = Math.max(0, neededLift);
    // rise quickly (clearance margins cover the brief lag), relax down gently —
    // both smoothed so gliding over rough terrain never judders the camera
    this.lift += (neededLift - this.lift) * damp(neededLift > this.lift ? 0.05 : 0.5, dt);
    pos.y += this.lift;

    this.camera.position.copy(pos);
    const lookPitch = Math.max(0, cur.polar - POS_MAX_POLAR);
    if (lookPitch > 1e-4) {
      // ground-level sky gaze: rotate the view up around the screen-right axis
      const dir = new THREE.Vector3().subVectors(cur.target, pos).normalize();
      const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
      dir.applyAxisAngle(right, lookPitch);
      this.camera.lookAt(pos.clone().addScaledVector(dir, cur.distance));
    } else {
      this.camera.lookAt(cur.target);
    }
  }
}
