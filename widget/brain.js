/**
 * Behaviour planner for the desktop Miles.
 *
 * Works in window CSS px (y down) on a 2D rig whose proportions are measured
 * from the 3D model, so the 3D IK can reproduce every pose exactly. Big moves
 * are generator "jobs" (`const dt = yield;` per frame); between them he only
 * idles, and the next move waits a random, activity-dependent delay.
 *
 * Surfaces come from each monitor's work area: ceiling = top, ground =
 * bottom, walls = sides. Without roaming, the edge between monitors is a wall.
 */

const v = (x, y) => ({ x, y });
const add = (a, b) => v(a.x + b.x, a.y + b.y);
const sub = (a, b) => v(a.x - b.x, a.y - b.y);
const mul = (a, k) => v(a.x * k, a.y * k);
const len = (a) => Math.hypot(a.x, a.y);
const norm = (a) => { const l = len(a) || 1; return v(a.x / l, a.y / l); };
const dot = (a, b) => a.x * b.x + a.y * b.y;
const rot = (a, t) => v(a.x * Math.cos(t) - a.y * Math.sin(t), a.x * Math.sin(t) + a.y * Math.cos(t));
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const rand = (a, b) => a + Math.random() * (b - a);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerpAngle = (a, b, t) => a + wrap(b - a) * t;

const GRAVITY = 1800;
// Direction into each clingable surface, in three.js axes (y up).
const CLING_NORMAL = { wallL: [-1, 0, 0], wallR: [1, 0, 0], ceiling: [0, 1, 0] };
export const ACTIVITY = { calm: [60, 180], normal: [30, 90], playful: [10, 40] };

function* wait(sec) { let t = 0; while (t < sec) t += yield; }
function* tween(sec, fn) { let t = 0; fn(0); while (t < sec) { t += yield; fn(Math.min(1, t / sec)); } }

export class Brain {
  /**
   * monitors: [{ x, y, w, h, work: { x, y, w, h } }] in window px.
   * proportions: Miles3D.measure() output (meters).
   */
  constructor(monitors, proportions, opts = {}) {
    this.monitors = monitors;
    this.prop = proportions;
    this.opt = { roam: false, activity: "calm", pxPerMeter: 120, ...opts };
    this.netDepth = 70;
    this.time = 0;
    this.job = null;
    this.nextIn = 20;
    this.paused = false;
    this.hold = false;
    this.listeners = { log: () => {} };
    this.fig = {
      x: 0, y: 0, th: Math.PI, surface: "line", phase: 0, moving: false, crouch: 0, look: 0,
      vx: 0, vy: 0, dirX: 1, rope: null, blend: 1, blendFrom: null, shot: null, solved: null, J: null,
      // Facing in three.js axes (y up, z toward the viewer); eased toward targetFwd().
      fwd: { x: 0, y: 0, z: 1 },
      gait: null, // stride parameters of the current walk/crawl (see moveAlong)
    };
    this.drag = { active: false, anchor: v(0, 0), vel: v(0, 0), prevVel: v(0, 0) };
    this.setScale(this.opt.pxPerMeter);
    this.MOVES = this.defineMoves();
  }

  on(name, fn) { this.listeners[name] = fn; }
  log(msg) { this.listeners.log(msg); }

  // ——— Geometry ———
  setScale(pxPerMeter) {
    const k = pxPerMeter;
    const p = this.prop;
    this.opt.pxPerMeter = k;
    this.R = {
      spine: p.spine * k, sh: p.shoulder * k, hip: p.hip * k,
      upper: p.upper * k, fore: p.fore * k, thigh: p.thigh * k, shin: p.shin * k,
      headTop: p.headTop * k,
    };
    // Soft knees when standing, never locked straight.
    this.STAND = (this.R.thigh + this.R.shin) * 0.93;
    this.CROUCH = (this.R.thigh + this.R.shin) * 0.62;
    // Pelvis distance from a wall/ceiling while clinging: close, frog-like.
    this.OFF = (this.R.thigh + this.R.shin) * 0.19;
    this.stride = (this.R.thigh + this.R.shin) * 0.5;
    const f = this.fig;
    if (f.surface === "ground" && !this.job) f.y = this.groundAt(f.x) - this.STAND;
  }

  setMonitors(monitors) {
    this.monitors = monitors;
    const f = this.fig;
    const m = this.monitors[this.monOf(f.x)];
    f.x = clamp(f.x, m.work.x + 80, m.work.x + m.work.w - 80);
    f.y = clamp(f.y, m.work.y + 40, m.work.y + m.work.h - 60);
    if (f.rope && f.surface === "line") this.hangAt(f.x, f.rope.len, f.rope.grip);
  }

  monOf(x) {
    const i = this.monitors.findIndex((m) => x >= m.x && x < m.x + m.w);
    if (i >= 0) return i;
    let best = 0;
    let bd = Infinity;
    this.monitors.forEach((m, k) => {
      const d = Math.abs(x - (m.x + m.w / 2));
      if (d < bd) { bd = d; best = k; }
    });
    return best;
  }
  work(x) { return this.monitors[this.monOf(x)].work; }
  ceilAt(x) { return this.work(x).y; }
  groundAt(x) { const w = this.work(x); return w.y + w.h; }
  anchorY(x) { return this.ceilAt(x) + this.netDepth; }

  walls(x = this.fig.x) {
    if (this.opt.roam) {
      return {
        l: Math.min(...this.monitors.map((m) => m.work.x)),
        r: Math.max(...this.monitors.map((m) => m.work.x + m.work.w)),
      };
    }
    const w = this.work(x);
    return { l: w.x, r: w.x + w.w };
  }

  // ——— Facing ———
  /**
   * Where his chest should point (three.js axes). On walls and the ceiling he
   * faces the surface, seen mostly side-on; on the ground he turns toward
   * where he walks; hanging, he faces the viewer.
   */
  targetFwd() {
    const f = this.fig;
    switch (f.surface) {
      // Three-quarter view: mostly facing the surface, turned toward the viewer.
      case "wallL": return { x: -1, y: 0, z: 0.2 };
      case "wallR": return { x: 1, y: 0, z: 0.2 };
      case "ceiling": return { x: 0, y: 1, z: 0.2 };
      case "ground": {
        const yaw = (f.moving ? 1.15 : 0.55) * (f.dirX || 1);
        return { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
      }
      case "line":
      // A fixed slight turn: following the swing direction made him (and his
      // hands) twist back and forth on every swing.
      case "drag": return { x: 0.25, y: 0, z: 1 };
      default: return { x: 0, y: 0, z: 1 };
    }
  }

  updateFacing(dt) {
    const f = this.fig;
    const t = this.targetFwd();
    const k = Math.min(1, dt * 5);
    f.fwd = { x: lerp(f.fwd.x, t.x, k), y: lerp(f.fwd.y, t.y, k), z: lerp(f.fwd.z, t.z, k) };
  }

  /**
   * Facing made perpendicular to the body axis, plus what the flat rig needs:
   * `lateral` shrinks shoulder/hip width as he turns side-on, `sideZ` says
   * which side is nearer the viewer, `pf` is the facing projected on screen.
   */
  facing() {
    const f = this.fig;
    const up = { x: Math.sin(f.th), y: Math.cos(f.th) };
    const d = f.fwd.x * up.x + f.fwd.y * up.y;
    let fw = { x: f.fwd.x - up.x * d, y: f.fwd.y - up.y * d, z: f.fwd.z };
    const l = Math.hypot(fw.x, fw.y, fw.z);
    fw = l < 1e-3 ? { x: 0, y: 0, z: 1 } : { x: fw.x / l, y: fw.y / l, z: fw.z / l };
    // side = up × fwd: his left-hand side
    const side = { x: up.y * fw.z, y: -up.x * fw.z, z: up.x * fw.y - up.y * fw.x };
    return {
      fwd: fw,
      lateral: Math.max(0.15, Math.hypot(side.x, side.y)),
      sideZ: side.z,
      pf: v(fw.x, -fw.y),
    };
  }

  // ——— Rig ———
  joints() {
    const f = this.fig;
    const R = this.R;
    const F = this.facing();
    const up = v(Math.sin(f.th), -Math.cos(f.th));
    const right = v(Math.cos(f.th), Math.sin(f.th));
    const P = v(f.x, f.y);
    const C = add(P, mul(up, R.spine));
    const sh = R.sh * F.lateral;
    const hip = R.hip * F.lateral;
    return {
      up, right, P, C, F, Hd: add(C, mul(up, R.headTop * 0.7)),
      shL: add(C, mul(right, -sh)), shR: add(C, mul(right, sh)),
      hpL: add(P, mul(right, -hip)), hpR: add(P, mul(right, hip)),
    };
  }

  ik(A, T, l1, l2, prefer) {
    let d = sub(T, A);
    let dist = len(d);
    const max = l1 + l2 - 0.5;
    if (dist > max) { d = mul(norm(d), max); dist = max; }
    dist = Math.max(dist, Math.abs(l1 - l2) + 1);
    const dn = norm(d);
    const a = Math.acos(clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1));
    const m1 = add(A, mul(rot(dn, a), l1));
    const m2 = add(A, mul(rot(dn, -a), l1));
    const M = dot(sub(m1, A), prefer) >= dot(sub(m2, A), prefer) ? m1 : m2;
    return { A, M, E: add(A, mul(dn, dist)) };
  }

  /**
   * Where a limb with nothing to hold goes: hanging with gravity, never fully
   * straight, and shaped by what he is doing.
   */
  freeTarget(k, A, out, reach, J) {
    const f = this.fig;
    const F = J.F;
    const s = f.surface;
    const arm = k[0] === "a";
    let dir;
    let ext = 0.9;
    if (s === "air") {
      dir = add(out, mul(J.up, arm ? 1.2 : -0.2));
    } else if (s === "ground") {
      // Relaxed arms, a touch forward; swing opposite the legs when walking.
      const swing = f.moving ? Math.sin(f.phase * Math.PI * 2) * (k === "aL" ? 0.45 : -0.45) : 0;
      dir = add(add(v(0, 1), mul(out, 0.12 * F.lateral)), mul(F.pf, 0.12 + swing));
      // Asymmetric at rest: one elbow a little more bent than the other.
      ext = f.moving ? 0.86 : k === "aL" ? 0.88 : 0.8;
    } else if (!arm && (s === "line" || s === "drag") && f.rope?.grip === "hand") {
      // Hanging by a hand: legs together, trailing the swing, one knee tucked.
      const r = f.rope;
      const trail = -Math.cos(r.ang) * r.vel * 0.3;
      dir = add(v(trail, 1), mul(out, 0.05));
      ext = k === "lL" ? 0.92 : 0.8;
    } else if (arm && f.rope?.grip === "feet") {
      dir = add(v(0, 1), mul(out, 0.25));
      ext = 0.92;
    } else {
      dir = add(v(0, 0.85), mul(out, 0.4));
    }
    return add(A, mul(norm(dir), reach * ext));
  }

  ropeGrip(r) { return v(r.ax + Math.sin(r.ang) * r.len, r.ay + Math.cos(r.ang) * r.len); }

  poseFromRope(r) {
    const R = this.R;
    const G = this.ropeGrip(r);
    const down = v(Math.sin(r.ang), Math.cos(r.ang));
    if (r.grip === "feet" || r.grip === "tuck") {
      const th = Math.atan2(down.x, -down.y);
      // Upside down. Feet on the line: close to the feet so the knees open
      // into a wide diamond. Tuck: hands on the line with the arms almost
      // straight, so arms and shoulders form a triangle.
      const P = r.grip === "feet"
        ? add(G, mul(down, (R.thigh + R.shin) * 0.42))
        : add(G, mul(down, (R.upper + R.fore) * 0.99 - R.spine));
      return { x: P.x, y: P.y, th };
    }
    const th = Math.atan2(-down.x, down.y);
    const right = v(Math.cos(th), Math.sin(th));
    const sh = R.sh * this.facing().lateral;
    const P = add(add(G, mul(down, (R.upper + R.fore) * 0.88 + R.spine)), mul(right, -sh * 0.7));
    return { x: P.x, y: P.y, th };
  }

  ropePhysics(r, dt, extra = 0) {
    r.vel += (-(GRAVITY / r.len) * Math.sin(r.ang) + extra) * dt;
    r.vel *= Math.pow(0.996, dt * 60);
    r.ang += r.vel * dt;
  }

  surfaceFor(name) {
    const f = this.fig;
    const w = this.walls();
    const up = v(Math.sin(f.th), -Math.cos(f.th));
    switch (name) {
      case "ceiling": return { proj: (p) => v(p.x, this.ceilAt(p.x)), n: v(0, 1), d: up };
      case "wallL": return { proj: (p) => v(w.l, p.y), n: v(1, 0), d: up };
      case "wallR": return { proj: (p) => v(w.r, p.y), n: v(-1, 0), d: up };
      default: return { proj: (p) => v(p.x, this.groundAt(p.x)), n: v(0, -1), d: v(f.dirX || 1, 0) };
    }
  }

  /**
   * Foot/hand targets for a stepping gait. `fig.gait` (set by the move)
   * gives stride length per cycle, lift and the stance share; while a foot
   * is planted it travels back by exactly what the body moves, so it never
   * slides.
   */
  gaitTargets(J, surf, limbs) {
    const g = this.fig.gait || { stride: this.stride, lift: this.stride * 0.35, stance: 0.7 };
    const s = g.stance;
    const half = s / 2;
    const offs = { aL: 0, lR: 0, aR: 0.5, lL: 0.5 };
    // Clinging: compact frog crouch, hands near head level, feet near the hips.
    // Walking: feet straight under the hips.
    const ground = this.fig.surface === "ground";
    const bias = ground ? { aL: 0, aR: 0, lL: 0, lR: 0 } : { aL: this.stride * 0.45, aR: this.stride * 0.45, lL: -this.stride * 0.15, lR: -this.stride * 0.15 };
    const roots = { aL: J.shL, aR: J.shR, lL: J.hpL, lR: J.hpR };
    const out = {};
    for (const k of limbs) {
      let p = (this.fig.phase + offs[k]) % 1;
      if (p < 0) p += 1;
      const rel = p < s ? lerp(half, -half, p / s) : lerp(-half, half, (p - s) / (1 - s));
      const lf = p < s ? 0 : Math.sin((Math.PI * (p - s)) / (1 - s)) * g.lift;
      out[k] = add(add(surf.proj(roots[k]), mul(surf.d, bias[k] + rel * g.stride)), mul(surf.n, lf));
    }
    return out;
  }

  /**
   * Upside-down hang: the line runs on past his feet, and a fist on that
   * shoulder's side can hold it this far below the feet (as high as the arm
   * reaches).
   */
  tailReach(G, J, shoulder) {
    const R = this.R;
    const axis = norm(sub(J.P, G));
    const rel = sub(shoulder, G);
    const along = dot(rel, axis);
    const lateral = Math.abs(rel.x * axis.y - rel.y * axis.x);
    const reach = (R.upper + R.fore) * 0.93;
    return Math.max(R.thigh * 0.3, along - Math.sqrt(Math.max(0, reach * reach - lateral * lateral)));
  }

  /** Place body (rope/drag), then solve all four limbs in 2D. */
  solvePose() {
    const f = this.fig;
    const R = this.R;
    if ((f.surface === "line" || f.surface === "drag") && f.rope) {
      const p = this.poseFromRope(f.rope);
      if (f.blend < 1 && f.blendFrom) {
        const e = ease(f.blend);
        f.x = lerp(f.blendFrom.x, p.x, e);
        f.y = lerp(f.blendFrom.y, p.y, e);
        f.th = lerpAngle(f.blendFrom.th, p.th, e);
      } else {
        f.x = p.x; f.y = p.y; f.th = p.th;
      }
    }
    const J = this.joints();
    const F = J.F;
    const T = { aL: null, aR: null, lL: null, lR: null };
    const s = f.surface;
    const ground = this.groundAt(f.x);
    const onSurface = s === "ceiling" || s === "wallL" || s === "wallR";
    if (onSurface) {
      Object.assign(T, this.gaitTargets(J, this.surfaceFor(s), ["aL", "aR", "lL", "lR"]));
    } else if (s === "ground") {
      if (f.moving) Object.assign(T, this.gaitTargets(J, this.surfaceFor("ground"), ["lL", "lR"]));
      else {
        // Relaxed stance: feet a little apart and staggered along his facing.
        const stagger = mul(F.pf, this.stride * 0.22);
        T.lL = v(J.hpL.x - R.hip * 0.5 * F.lateral + stagger.x, ground);
        T.lR = v(J.hpR.x + R.hip * 0.5 * F.lateral - stagger.x, ground);
      }
      if (f.crouch > 0.5) { T.aL = v(f.x - R.sh * 1.6, ground); T.aR = v(f.x + R.sh * 1.6, ground); }
    } else if ((s === "line" || s === "drag") && f.rope) {
      const G = this.ropeGrip(f.rope);
      if (f.rope.grip === "feet") {
        // Feet pressed together around the line, knees spread wide; both
        // fists on the line just below, one above the other.
        T.lL = add(G, mul(J.right, -R.hip * 0.25));
        T.lR = add(G, mul(J.right, R.hip * 0.25));
        const axis = norm(sub(J.P, G));
        const dR = this.tailReach(G, J, J.shR);
        const dL = Math.max(this.tailReach(G, J, J.shL), dR + R.fore * 0.3);
        T.aR = add(G, mul(axis, dR));
        T.aL = add(G, mul(axis, dL));
      } else if (f.rope.grip === "tuck") {
        // crawl-refs/hanging from top pose.png: both fists together on the
        // line at crotch height, legs free in a wide V, knees out, toes up.
        const toAnchor = v(-Math.sin(f.rope.ang), -Math.cos(f.rope.ang));
        const leg = R.thigh + R.shin;
        // Fists stacked one above the other on the line. Targets are wrists,
        // so shift each down by half a fist to centre the fist on the line.
        const down = v(Math.sin(f.rope.ang), Math.cos(f.rope.ang));
        const fist = this.opt.pxPerMeter * 0.1;
        T.aR = add(G, mul(down, fist * 0.3));
        T.aL = add(G, mul(down, fist * 0.9));
        T.lL = add(add(G, mul(toAnchor, leg * 0.5)), mul(J.right, -leg * 0.18));
        T.lR = add(add(G, mul(toAnchor, leg * 0.5)), mul(J.right, leg * 0.18));
      } else T.aR = G;
    }

    // Which way elbows and knees bend. Clinging: away from the surface, knees
    // drawn up toward his head, elbows slightly back. On the ground: knees
    // forward and elbows back along his facing.
    const surf = onSurface ? this.surfaceFor(s) : null;
    const prefer = (k, out) => {
      if (surf) {
        const along = mul(surf.d, k[0] === "l" ? 0.6 : -0.3);
        return add(add(surf.n, along), mul(out, 0.3 * F.lateral));
      }
      if (s === "ground") return add(mul(out, F.lateral), mul(F.pf, k[0] === "l" ? 1 : -1));
      return add(out, k[0] === "l" ? mul(J.up, -0.1) : v(0, 0));
    };

    const limbs = {
      aL: [J.shL, R.upper, R.fore, mul(J.right, -1)],
      aR: [J.shR, R.upper, R.fore, J.right],
      lL: [J.hpL, R.thigh, R.shin, mul(J.right, -1)],
      lR: [J.hpR, R.thigh, R.shin, J.right],
    };
    f.solved = {};
    for (const [k, [A, l1, l2, out]] of Object.entries(limbs)) {
      const tgt = T[k] || this.freeTarget(k, A, out, l1 + l2, J);
      f.solved[k] = this.ik(A, tgt, l1, l2, prefer(k, out));
    }
    f.J = J;
    const onLine = (s === "line" || s === "drag") && !!f.rope;
    f.grips = { aL: onLine && f.rope.grip !== "hand", aR: onLine };
  }

  /** Rig handed to the 3D model each frame. */
  rig() {
    const f = this.fig;
    const F = f.J.F;
    const s = f.surface;
    const t = this.time;
    // Depth (meters, + toward the viewer) for hand/foot targets (z) and for
    // the elbow/knee bend direction (pz). `near` is +1 for the limb on the
    // viewer's side when he is side-on, 0 when he faces the viewer.
    const depth = (k) => {
      const near = (k === "aR" || k === "lR" ? 1 : -1) * F.sideZ;
      const arm = k[0] === "a";
      if (s === "ground") {
        if (!arm) return { z: near * 0.06, pz: 0.25 };
        const swing = f.moving ? Math.sin(f.phase * Math.PI * 2) * (k === "aL" ? 0.14 : -0.14) * (1 - Math.abs(F.sideZ)) : 0;
        // At rest one hand hangs a little forward of the other.
        const rest = f.moving ? 0 : k === "aL" ? 0.06 : -0.02;
        return { z: 0.05 + swing + rest, pz: -0.22 };
      }
      if (s === "line" || s === "drag") {
        // Fists on the line past his feet sit in front of his body.
        if (f.rope && f.rope.grip !== "hand" && arm) return { z: 0.2, pz: near * 0.2 };
        if (k === "aR") return { z: 0, pz: near * 0.2 };
        return arm ? { z: 0.06, pz: -0.15 } : { z: near * 0.05 + 0.04, pz: 0.25 };
      }
      return arm ? { z: 0, pz: -0.1 } : { z: 0, pz: 0.25 };
    };
    const limbs = {};
    for (const k of Object.keys(f.solved)) limbs[k] = { ...f.solved[k], ...depth(k) };

    // Idle weight shift on the ground.
    const idle = s === "ground" && !f.moving && f.crouch === 0 && !this.job;
    const pelvis = idle ? add(f.J.P, v(Math.sin(t * 0.6) * 2.5 * F.lateral, 0)) : f.J.P;
    // Lean into the walk/run; sway a little when standing. Clinging, tip the
    // upper body slightly away from the surface so the hips press in.
    let lean = s === "ground" && f.moving && f.gait ? f.gait.lean * (f.dirX || 1) : 0;
    if (CLING_NORMAL[s]) {
      const away = this.surfaceFor(s).n;
      const up = v(Math.sin(f.th), -Math.cos(f.th));
      lean = 0.1 * Math.sign(up.x * away.y - up.y * away.x);
    }
    const th = idle ? f.th + Math.sin(t * 0.6) * 0.015 : f.th + lean;

    return {
      pelvis, th, fwd: [F.fwd.x, F.fwd.y, F.fwd.z], look: f.look, limbs,
      // How far to turn his head toward the viewer (1 = straight at you).
      faceCamera: { wallL: 0.85, wallR: 0.85, ceiling: 0.85, ground: f.moving ? 0.25 : 0.55, line: 0.4, drag: 0.6 }[s] ?? 0.3,
      eyes: s === "drag" ? 1.35 : s === "air" ? 1.25 : f.moving ? 0.85 : 1,
      footFlat: s === "ground",
      // Clinging: the 3D rig plans hands/feet itself on the surface plane.
      cling: CLING_NORMAL[s] ? { phase: f.phase, moving: f.moving, off: this.OFF / this.opt.pxPerMeter, normal: CLING_NORMAL[s] } : null,
      curl: { aL: f.crouch > 0.5 ? 0 : 0.3, aR: f.grips.aR ? 1 : f.crouch > 0.5 ? 0 : 0.3 },
    };
  }

  /** Loose box around him: drag hit-test and window-follow bounds. */
  hitRect(pad = 30) {
    const f = this.fig;
    if (!f.solved) return null;
    const pts = [f.J.Hd, f.J.P, f.J.C];
    for (const k in f.solved) pts.push(f.solved[k].M, f.solved[k].E);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const head = this.R.headTop * 0.45;
    return {
      x: Math.min(...xs) - pad - head, y: Math.min(...ys) - pad - head,
      w: Math.max(...xs) - Math.min(...xs) + (pad + head) * 2, h: Math.max(...ys) - Math.min(...ys) + (pad + head) * 2,
    };
  }

  snapshot() { const f = this.fig; return { x: f.x, y: f.y, th: f.th }; }

  // ——— Placement (start / restore / reset) ———
  hangAt(x, length = 200, grip = "feet") {
    const f = this.fig;
    const w = this.walls(x);
    x = clamp(x, w.l + 120, w.r - 120);
    f.rope = { ax: x, ay: this.anchorY(x), len: length, ang: 0.15, vel: 0, grip };
    f.surface = "line";
    f.blend = 1;
    f.fwd = this.targetFwd();
    this.solvePose();
  }

  restore(state) {
    const f = this.fig;
    const m = state && this.monitors[state.monitor];
    if (!m) return false;
    const x = clamp(state.x, m.work.x + 100, m.work.x + m.work.w - 100);
    f.rope = null;
    f.shot = null;
    switch (state.surface) {
      case "line":
        this.hangAt(x, clamp(state.len || 200, 60, m.work.h - 260), state.grip || "feet");
        break;
      case "ceiling":
        f.surface = "ceiling"; f.x = x; f.y = this.ceilAt(x) + this.OFF; f.th = state.th > 0 ? Math.PI / 2 : -Math.PI / 2;
        break;
      case "wallL":
      case "wallR": {
        f.surface = state.surface;
        const w = this.walls(x);
        f.x = state.surface === "wallL" ? w.l + this.OFF : w.r - this.OFF;
        f.y = clamp(state.y, m.work.y + 150, m.work.y + m.work.h - 150);
        f.th = 0;
        break;
      }
      default:
        f.surface = "ground"; f.x = x; f.y = this.groundAt(x) - this.STAND; f.th = 0;
    }
    // Mid-climb with all four planted: an asymmetric climbing pose at rest.
    f.phase = 0.12;
    f.fwd = this.targetFwd();
    this.solvePose();
    return true;
  }

  serialize() {
    const f = this.fig;
    return {
      surface: ["air", "drag"].includes(f.surface) ? "ground" : f.surface,
      monitor: this.monOf(f.x),
      x: f.rope && f.surface === "line" ? f.rope.ax : f.x,
      y: f.y, th: f.th, len: f.rope?.len, grip: f.rope?.grip,
    };
  }

  // ——— Jobs ———
  start(id, reason = "") {
    const m = this.MOVES[id];
    if (!m || !m.from.includes(this.fig.surface)) return false;
    this.job = { id, label: m.label, it: m.make() };
    this.job.it.next();
    this.log(`${m.label}${reason ? " · " + reason : ""}`);
    return true;
  }

  pickMove() {
    const W = {
      line: { climb: 2, lower: 2, swing: 2, swingWall: 2, flip: 1, tuck: 2, cross: 1 },
      ceiling: { ceilCrawl: 3, drop: 3, ceilWall: 2, cross: 1 },
      wallL: { wallCrawl: 3, wallCeil: 2, wallGround: 2, zip: 1 },
      wallR: { wallCrawl: 3, wallCeil: 2, wallGround: 2, zip: 1 },
      ground: { walk: 3, groundWall: 2, zip: 3, crouch: 1, cross: 1 },
    }[this.fig.surface];
    if (!W) return null;
    const w = { ...W };
    if (!this.opt.roam || this.monitors.length < 2) delete w.cross;
    const entries = Object.entries(w);
    let r = Math.random() * entries.reduce((s, [, k]) => s + k, 0);
    for (const [id, k] of entries) if ((r -= k) <= 0) return id;
    return entries[0]?.[0] ?? null;
  }

  scheduleNext() {
    const [a, b] = ACTIVITY[this.opt.activity] || ACTIVITY.calm;
    this.nextIn = rand(a, b);
  }

  defineMoves() {
    const B = this;
    const f = this.fig;
    const randX = () => { const w = B.walls(); return rand(w.l + 150, w.r - 150); };

    /**
     * Travel along a surface, easing in and out of `speed`; the gait phase
     * follows the distance covered so feet never slide. On the ground the
     * pelvis bobs twice per stride, highest as one foot passes the other.
     */
    function* moveAlong(axis, to, speed, gait = null) {
      f.moving = true;
      f.gait = gait;
      const stride = gait?.stride || B.stride;
      const accel = speed * 2.2; // full speed in ~0.45 s
      let vel = 0;
      while (Math.abs(to - f[axis]) > 0.5) {
        const dt = yield;
        const remaining = Math.abs(to - f[axis]);
        vel = Math.min(speed, vel + accel * dt, Math.sqrt(2 * accel * remaining) + 1);
        const step = Math.min(remaining, vel * dt);
        const sgn = Math.sign(to - f[axis]);
        f[axis] += sgn * step;
        const up = v(Math.sin(f.th), -Math.cos(f.th));
        const facing = f.surface === "ground" ? f.dirX || 1 : axis === "x" ? Math.sign(up.x) || 1 : Math.sign(up.y) || 1;
        f.phase += (step / stride) * (facing === sgn ? 1 : -1);
        if (f.surface === "ceiling") f.y = lerp(f.y, B.ceilAt(f.x) + B.OFF, Math.min(1, dt * 6));
        if (f.surface === "ground") {
          const bob = gait ? Math.cos((f.phase - gait.stance / 2) * Math.PI * 4) * gait.bob * (vel / speed) : 0;
          f.y = lerp(f.y, B.groundAt(f.x) - B.STAND * (gait?.height ?? 1) - bob, Math.min(1, dt * 10));
        }
      }
      f.moving = false;
      f.gait = null;
    }

    /** Stroll (or run) on the ground at a human pace with a full stride. */
    function* walkTo(x, run = false) {
      const leg = B.R.thigh + B.R.shin;
      const k = B.opt.pxPerMeter;
      const gait = run
        ? { stride: leg * 2.0, lift: leg * 0.2, stance: 0.45, bob: k * 0.035, height: 0.92, lean: 0.15 }
        : { stride: leg * 1.25, lift: leg * 0.12, stance: 0.62, bob: k * 0.022, height: 0.97, lean: 0.06 };
      f.surface = "ground";
      f.dirX = Math.sign(x - f.x) || 1;
      yield* tween(0.15, (t) => { f.th = lerpAngle(f.th, 0, t); });
      // Give him a moment to turn toward where he's going.
      yield* wait(0.3);
      yield* moveAlong("x", x, (run ? 2.6 : 0.9) * k, gait);
    }

    /** A short stroll of 2–6 body widths, turning back at the walls. */
    const strollX = () => {
      const w = B.walls();
      const dist = rand(2, 6) * B.R.sh * 2.4;
      let dir = Math.random() > 0.5 ? 1 : -1;
      if (f.x + dir * dist > w.r - 120 || f.x + dir * dist < w.l + 120) dir = -dir;
      return clamp(f.x + dir * dist, w.l + 120, w.r - 120);
    };

    function* crawlCeiling(x) {
      f.surface = "ceiling";
      const th = (Math.sign(x - f.x) || 1) > 0 ? Math.PI / 2 : -Math.PI / 2;
      if (Math.abs(wrap(f.th - th)) > 0.1) yield* tween(0.35, (t) => { f.th = lerpAngle(f.th, th, t); });
      yield* moveAlong("x", x, B.stride * 2.6);
    }

    function* crawlWall(y) {
      const th = (Math.sign(y - f.y) || -1) < 0 ? 0 : Math.PI;
      if (Math.abs(wrap(f.th - th)) > 0.1) yield* tween(0.45, (t) => { f.th = lerpAngle(f.th, th, t); });
      yield* moveAlong("y", y, B.stride * 2.4);
    }

    const nearestWall = () => { const w = B.walls(); return f.x - w.l < w.r - f.x ? "wallL" : "wallR"; };
    const wallX = (side) => { const w = B.walls(); return side === "wallL" ? w.l + B.OFF : w.r - B.OFF; };
    const corner = B.stride * 1.5;

    function* hop(from, to, sec, height, endTh = 0) {
      f.surface = "air";
      yield* tween(sec, (t) => {
        const e = ease(t);
        f.x = lerp(from.x, to.x, e);
        f.y = lerp(from.y, to.y, e) - Math.sin(Math.PI * t) * height;
        f.th = lerpAngle(from.th, endTh, e);
      });
    }

    function* land() {
      f.surface = "ground";
      f.th = 0;
      const g = B.groundAt(f.x);
      yield* tween(0.18, (t) => { f.crouch = t; f.y = g - lerp(B.STAND, B.CROUCH, t); });
      yield* wait(0.25);
      yield* tween(0.3, (t) => { f.crouch = 1 - t; f.y = g - lerp(B.CROUCH, B.STAND, t); });
      f.crouch = 0;
    }

    function* ceilingToWall() {
      const side = nearestWall();
      const w = B.walls();
      yield* crawlCeiling(side === "wallL" ? w.l + corner : w.r - corner);
      const from = B.snapshot();
      const to = v(wallX(side), B.ceilAt(f.x) + corner);
      yield* tween(0.7, (t) => {
        const e = ease(t);
        f.x = lerp(from.x, to.x, e); f.y = lerp(from.y, to.y, e); f.th = lerpAngle(from.th, Math.PI, e);
        f.surface = t < 0.5 ? "ceiling" : side;
      });
      f.surface = side;
      yield* crawlWall(rand(B.ceilAt(f.x) + 200, B.groundAt(f.x) - 260));
    }

    function* wallToCeiling() {
      const side = f.surface;
      yield* crawlWall(B.ceilAt(f.x) + corner);
      const from = B.snapshot();
      const w = B.walls();
      const to = v(side === "wallL" ? w.l + corner : w.r - corner, B.ceilAt(f.x) + B.OFF);
      const th = side === "wallL" ? Math.PI / 2 : -Math.PI / 2;
      yield* tween(0.7, (t) => {
        const e = ease(t);
        f.x = lerp(from.x, to.x, e); f.y = lerp(from.y, to.y, e); f.th = lerpAngle(from.th, th, e);
        f.surface = t < 0.5 ? side : "ceiling";
      });
      f.surface = "ceiling";
      yield* crawlCeiling(randX());
    }

    function* wallToGround() {
      const side = f.surface;
      yield* crawlWall(B.groundAt(f.x) - B.STAND * 1.3);
      const from = B.snapshot();
      const w = B.walls();
      const x = side === "wallL" ? w.l + B.stride * 2.4 : w.r - B.stride * 2.4;
      yield* hop(from, v(x, B.groundAt(x) - B.STAND), 0.6, 120);
      yield* land();
    }

    function* groundToWall() {
      const side = nearestWall();
      const w = B.walls();
      yield* walkTo(side === "wallL" ? w.l + B.stride * 5 : w.r - B.stride * 5, true);
      const from = B.snapshot();
      yield* hop(from, v(wallX(side), B.groundAt(f.x) - B.STAND * 3.5), 0.55, 90);
      f.surface = side;
      yield* crawlWall(rand(B.ceilAt(f.x) + 220, B.groundAt(f.x) - 300));
    }

    function* zipUp() {
      const w = B.walls();
      const ax = clamp(f.x + (Math.random() > 0.5 ? 1 : -1) * 140, w.l + 140, w.r - 140);
      const anchor = v(ax, B.anchorY(ax));
      const hand = f.solved ? f.solved.aR.E : v(f.x, f.y);
      yield* tween(0.25, (t) => { f.shot = { from: hand, to: anchor, t }; });
      const from = B.snapshot();
      const L = clamp(f.y - anchor.y, 120, 320);
      f.shot = null;
      f.rope = { ax: anchor.x, ay: anchor.y, len: L, ang: Math.asin(clamp((f.x - anchor.x) / L, -0.9, 0.9)), vel: 0, grip: "hand" };
      f.blendFrom = from;
      f.surface = "line";
      yield* tween(0.7, (t) => { f.blend = t; });
      f.blend = 1;
      f.rope.vel = 0.9 * (Math.sign(f.x - anchor.x) || 1);
      yield* wait(1.5);
    }

    function* dropLine() {
      const from = B.snapshot();
      f.rope = { ax: f.x, ay: B.anchorY(f.x), len: 30, ang: 0, vel: 0.2, grip: Math.random() < 0.4 ? "tuck" : "feet" };
      f.blendFrom = from;
      f.surface = "line";
      yield* tween(0.6, (t) => { f.blend = t; });
      const target = rand(160, Math.max(170, B.groundAt(f.x) - f.rope.ay - B.STAND * 2.6));
      yield* tween(2.2, (t) => { f.rope.len = lerp(30, target, ease(t)); });
    }

    function* climbUp() {
      const r = f.rope;
      const start = r.len;
      yield* tween(1.8, (t) => { r.len = lerp(start, 36, ease(t)); r.vel *= 0.9; });
      const from = B.snapshot();
      const th = Math.random() > 0.5 ? Math.PI / 2 : -Math.PI / 2;
      const to = v(r.ax, B.ceilAt(r.ax) + B.OFF);
      f.rope = null;
      f.surface = "ceiling";
      yield* tween(0.5, (t) => {
        const e = ease(t);
        f.x = lerp(from.x, to.x, e); f.y = lerp(from.y, to.y, e); f.th = lerpAngle(from.th, th, e);
      });
    }

    /** Change how he holds the line (feet / hand / tuck), blending the body over. */
    function* setGrip(grip) {
      if (f.rope.grip === grip) return;
      const from = B.snapshot();
      f.rope.grip = grip;
      f.blendFrom = from;
      f.blend = 0;
      yield* tween(0.8, (t) => { f.blend = t; });
      f.blend = 1;
    }

    function* flipGrip() {
      yield* setGrip(f.rope.grip === "hand" ? "feet" : "hand");
    }

    function* tuckHang() {
      yield* setGrip("tuck");
      yield* wait(rand(2, 4));
    }

    function* lineToGround() {
      if (f.rope.grip === "hand") yield* flipGrip();
      const r = f.rope;
      const start = r.len;
      // How far his body (head down) reaches below the end of the line.
      const below = (r.grip === "feet" ? (B.R.thigh + B.R.shin) * 0.42 : 0) + B.R.spine + B.R.headTop;
      const target = B.groundAt(r.ax) - r.ay - below - 10;
      yield* tween(2.4, (t) => { r.len = lerp(start, Math.max(start, target), ease(t)); r.vel *= 0.97; });
      const from = B.snapshot();
      f.rope = null;
      yield* hop(from, v(from.x, B.groundAt(from.x) - B.STAND), 0.6, 30);
      yield* land();
    }

    function* pump(seconds, dir, amp) {
      const r = f.rope;
      let t = 0;
      while (t < seconds) {
        const dt = yield;
        t += dt;
        if (Math.abs(r.ang) < amp) r.vel += (Math.sign(r.vel) || dir) * 1.5 * dt;
      }
    }

    function* bigSwing() { yield* pump(4, 1, 0.9); yield* wait(2); }

    function* swingToWall() {
      const side = nearestWall();
      const dir = side === "wallL" ? -1 : 1;
      const r = f.rope;
      yield* pump(3, dir, 1.0);
      let waited = 0;
      while (!(Math.sign(r.ang) === dir && Math.abs(r.vel) < 0.25) && waited < 6) waited += yield;
      const from = B.snapshot();
      f.rope = null;
      const y = clamp(f.y, B.ceilAt(f.x) + 180, B.groundAt(f.x) - 260);
      const dist = Math.abs(wallX(side) - f.x);
      yield* hop(from, v(wallX(side), y), clamp(dist / 900, 0.45, 1.3), 60);
      f.surface = side;
      yield* wait(0.4);
    }

    function* webTravel(toX) {
      if (f.surface !== "line") {
        if (f.surface === "ceiling") yield* dropLine();
        else yield* zipUp();
      }
      if (f.rope.grip !== "hand") yield* setGrip("hand");
      let r = f.rope;
      const hops = Math.max(1, Math.ceil(Math.abs(toX - f.x) / 700));
      const startX = B.ropeGrip(r).x;
      for (let i = 1; i <= hops; i++) {
        const G = B.ropeGrip(r);
        const nextX = lerp(startX, toX, i / hops);
        const ax = (G.x + nextX) / 2;
        const ay = Math.min(B.anchorY(ax), B.anchorY(G.x));
        const L = Math.hypot(G.x - ax, G.y - ay);
        const a0 = Math.atan2(G.x - ax, G.y - ay);
        const from = B.snapshot();
        f.rope = r = { ax, ay, len: L, ang: a0, vel: 0, grip: "hand" };
        f.blendFrom = from;
        f.blend = 0;
        yield* tween(0.15, (t) => { f.blend = t; });
        yield* tween(1.1, (t) => { r.ang = lerp(a0, -a0, (1 - Math.cos(Math.PI * t)) / 2); });
      }
      // Re-anchor straight above the landing spot so the leftover swing
      // doesn't carry him back across.
      const G = B.ropeGrip(r);
      const from = B.snapshot();
      const ay = B.anchorY(G.x);
      f.rope = { ax: G.x, ay, len: clamp(G.y - ay, 120, 360), ang: 0, vel: 0.35 * Math.sign(G.x - r.ax), grip: "hand" };
      f.blendFrom = from;
      f.blend = 0;
      yield* tween(0.35, (t) => { f.blend = t; });
      f.blend = 1;
      yield* wait(1);
    }

    function* crossMonitor() {
      const cur = B.monOf(f.x);
      const other = B.monitors[(cur + 1) % B.monitors.length];
      const toX = other.work.x + other.work.w / 2 + rand(-300, 300);
      const roam = B.opt.roam;
      B.opt.roam = true; // the inner edge is passable while he travels
      try { yield* webTravel(toX); } finally { B.opt.roam = roam; }
    }

    function* idleCrouch() {
      const g = B.groundAt(f.x);
      yield* tween(0.3, (t) => { f.crouch = t; f.y = g - lerp(B.STAND, B.CROUCH, t); });
      yield* wait(rand(2, 4));
      yield* tween(0.4, (t) => { f.crouch = 1 - t; f.y = g - lerp(B.CROUCH, B.STAND, t); });
      f.crouch = 0;
    }

    function* settleTo(surface) {
      const from = B.snapshot();
      const w = B.walls();
      let to;
      let th;
      if (surface === "ceiling") { to = v(clamp(f.x, w.l + 80, w.r - 80), B.ceilAt(f.x) + B.OFF); th = f.vx >= 0 ? Math.PI / 2 : -Math.PI / 2; }
      else { to = v(wallX(surface), clamp(f.y, B.ceilAt(f.x) + 120, B.groundAt(f.x) - 200)); th = 0; }
      f.surface = "air";
      yield* tween(0.35, (t) => {
        const e = ease(t);
        f.x = lerp(from.x, to.x, e); f.y = lerp(from.y, to.y, e); f.th = lerpAngle(from.th, th, e);
      });
      f.surface = surface;
    }

    function* fall() {
      f.surface = "air";
      for (;;) {
        const dt = yield;
        f.vy += GRAVITY * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        f.th = lerpAngle(f.th, 0, Math.min(1, dt * 5));
        const w = B.walls();
        if (f.x < w.l + 60) { f.x = w.l + 60; f.vx = Math.abs(f.vx) * 0.3; }
        if (f.x > w.r - 60) { f.x = w.r - 60; f.vx = -Math.abs(f.vx) * 0.3; }
        if (f.y >= B.groundAt(f.x) - B.STAND) { f.y = B.groundAt(f.x) - B.STAND; break; }
      }
      yield* land();
    }

    this._settleTo = settleTo;
    this._fall = fall;

    return {
      walk: { label: "Walk", from: ["ground"], make: () => walkTo(strollX()) },
      crouch: { label: "Crouch", from: ["ground"], make: idleCrouch },
      groundWall: { label: "Leap onto wall", from: ["ground"], make: groundToWall },
      zip: { label: "Web-zip up", from: ["ground", "wallL", "wallR"], make: zipUp },
      wallCrawl: { label: "Crawl on wall", from: ["wallL", "wallR"], make: () => crawlWall(rand(B.ceilAt(f.x) + 150, B.groundAt(f.x) - 200)) },
      wallCeil: { label: "Wall → ceiling", from: ["wallL", "wallR"], make: wallToCeiling },
      wallGround: { label: "Wall → ground", from: ["wallL", "wallR"], make: wallToGround },
      ceilCrawl: { label: "Crawl on ceiling", from: ["ceiling"], make: () => crawlCeiling(randX()) },
      ceilWall: { label: "Ceiling → wall", from: ["ceiling"], make: ceilingToWall },
      drop: { label: "Drop on a line", from: ["ceiling"], make: dropLine },
      climb: { label: "Climb to ceiling", from: ["line"], make: climbUp },
      lower: { label: "Lower to ground", from: ["line"], make: lineToGround },
      swing: { label: "Big swing", from: ["line"], make: bigSwing },
      swingWall: { label: "Swing to wall", from: ["line"], make: swingToWall },
      flip: { label: "Flip grip", from: ["line"], make: flipGrip },
      tuck: { label: "Tuck hang", from: ["line"], make: tuckHang },
      cross: { label: "Go to other monitor", from: ["ground", "wallL", "wallR", "ceiling", "line"], make: crossMonitor },
    };
  }

  // ——— Dragging ———
  beginDrag(p) {
    const b = this.hitRect();
    if (!b || p.x < b.x || p.x > b.x + b.w || p.y < b.y || p.y > b.y + b.h) return false;
    const f = this.fig;
    this.job = null;
    f.shot = null;
    f.moving = false;
    f.crouch = 0;
    const from = this.snapshot();
    f.rope = { ax: p.x, ay: p.y, len: 55, ang: 0, vel: 0, grip: "hand" };
    f.blendFrom = from;
    f.blend = 0;
    f.surface = "drag";
    this.drag = { active: true, anchor: p, vel: v(0, 0), prevVel: v(0, 0) };
    return true;
  }

  moveDrag(p, dt) {
    const d = this.drag;
    const nv = mul(sub(p, d.anchor), 1 / Math.max(dt, 1 / 120));
    d.vel = v(lerp(d.vel.x, nv.x, 0.5), lerp(d.vel.y, nv.y, 0.5));
    const minX = Math.min(...this.monitors.map((m) => m.work.x)) + 60;
    const maxX = Math.max(...this.monitors.map((m) => m.work.x + m.work.w)) - 60;
    d.anchor = v(clamp(p.x, minX, maxX), clamp(p.y, this.ceilAt(p.x), this.groundAt(p.x) - 120));
  }

  endDrag() {
    if (!this.drag.active) return;
    this.drag.active = false;
    const f = this.fig;
    const r = f.rope;
    f.vx = this.drag.vel.x * 0.6 + Math.cos(r.ang) * r.vel * r.len;
    f.vy = this.drag.vel.y * 0.6 - Math.sin(r.ang) * r.vel * r.len;
    f.rope = null;
    const w = this.walls();
    let it;
    let label;
    if (f.y - this.ceilAt(f.x) < 170) { it = this._settleTo("ceiling"); label = "Stick to ceiling"; }
    else if (f.x - w.l < 140) { it = this._settleTo("wallL"); label = "Stick to wall"; }
    else if (w.r - f.x < 140) { it = this._settleTo("wallR"); label = "Stick to wall"; }
    else { it = this._fall(); label = "Fall & land"; }
    this.job = { id: "release", label, it };
    it.next();
    this.log(`Released → ${label}`);
  }

  // ——— Frame ———
  /** Advance; returns true while something is moving (render at full rate). */
  update(dt) {
    const f = this.fig;
    this.time += dt;
    if (this.drag.active && f.rope) {
      const r = f.rope;
      r.ax = this.drag.anchor.x;
      r.ay = this.drag.anchor.y;
      const accX = (this.drag.vel.x - this.drag.prevVel.x) / Math.max(dt, 1e-3);
      this.drag.prevVel = this.drag.vel;
      this.ropePhysics(r, dt, -(clamp(accX, -8000, 8000) / r.len) * Math.cos(r.ang));
      if (f.blend < 1) f.blend = Math.min(1, f.blend + dt / 0.25);
    } else if (f.surface === "line" && f.rope) {
      this.ropePhysics(f.rope, dt, Math.sin(this.time * 0.7) * 0.25 + Math.sin(this.time * 1.9) * 0.1);
    }

    if (this.job) {
      // `hold` lets the host page finish enlarging its window before a move starts.
      if (!this.hold && this.job.it.next(dt).done) { this.job = null; this.scheduleNext(); }
    } else if (!this.drag.active && !this.paused) {
      this.nextIn -= dt;
      if (this.nextIn <= 0) {
        const id = this.pickMove();
        if (id) this.start(id, "auto");
        else this.scheduleNext();
      }
    }

    this.updateFacing(dt);
    f.look = Math.sin(this.time * 0.37) * 0.6 + Math.sin(this.time * 1.3) * 0.2;
    if (!this.job && f.surface === "ground" && f.crouch === 0) f.y = this.groundAt(f.x) - this.STAND + Math.sin(this.time * 2.2) * 1.2;
    this.solvePose();
    // Idle sway on the line is slow enough for the reduced idle frame rate.
    return !!this.job || this.drag.active;
  }
}
