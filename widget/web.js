/**
 * Web line — Verlet rope simulation + twisted-silk renderer.
 *
 * The rope is a chain of particles: index 0 is the hub of an orb-web net
 * (elastic — it gives under load and springs back), the last one carries the
 * body mass. Rendering resamples the chain into a smooth curve and draws it as
 * a lay-twisted silk cord, plus the net, the hub junction, and the wrap where
 * Miles holds on.
 */

const WebLine = (() => {
  const SEGMENTS = 22;
  const SUBSTEPS = 4;
  const ITERATIONS = 14;
  const BODY_MASS = 10;
  // How the net hub responds to the line: constraint share, pull back, max give (px).
  const HUB_WEIGHT = 0.5;
  const NET_SPRING = 0.05;
  const NET_GIVE = 24;

  const SILK = {
    base: "#b4bdca",
    core: "#eef2f7",
    groove: "rgba(62,72,90,0.6)",
    shine: "rgba(255,255,255,0.75)",
    edge: "rgba(48,56,70,0.55)",
    shadow: "rgba(0,0,0,0.3)",
  };

  /** Deterministic noise so fibers/splat keep their shape frame to frame. */
  function hash(n) {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  function create(anchor, length) {
    const segLen = length / SEGMENTS;
    const pts = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const x = anchor.x;
      const y = anchor.y + i * segLen;
      pts.push({ x, y, px: x, py: y });
    }
    return { pts, segLen, pinned: null };
  }

  function end(rope) {
    return rope.pts[rope.pts.length - 1];
  }

  /**
   * Advance the rope by dt seconds.
   * p: { anchor, length, gravity, damping, stiffness (0–1), windX (px/s²) }
   */
  function step(rope, dt, p) {
    rope.segLen = p.length / SEGMENTS;
    const h = dt / SUBSTEPS;
    const damp = Math.pow(p.damping, h * 60);
    const pts = rope.pts;
    const last = pts.length - 1;

    for (let s = 0; s < SUBSTEPS; s++) {
      const hub = pts[0];
      const hvx = (hub.x - hub.px) * 0.8;
      const hvy = (hub.y - hub.py) * 0.8;
      hub.px = hub.x;
      hub.py = hub.y;
      hub.x += hvx + (p.anchor.x - hub.x) * NET_SPRING;
      hub.y += hvy + (p.anchor.y - hub.y) * NET_SPRING;

      for (let i = 1; i <= last; i++) {
        const q = pts[i];
        if (i === last && rope.pinned) {
          q.px = q.x;
          q.py = q.y;
          q.x += (rope.pinned.x - q.x) * 0.5;
          q.y += (rope.pinned.y - q.y) * 0.5;
          continue;
        }
        const vx = (q.x - q.px) * damp;
        const vy = (q.y - q.py) * damp;
        q.px = q.x;
        q.py = q.y;
        // Wind pushes the light rope more than the heavy body at the end.
        const windMul = i === last ? 0.25 : 1;
        q.x += vx + p.windX * windMul * h * h;
        q.y += vy + p.gravity * h * h;
      }

      for (let it = 0; it < ITERATIONS; it++) {
        for (let i = 0; i < last; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const wa = i === 0 ? HUB_WEIGHT : 1;
          const wb = i + 1 === last ? (rope.pinned ? 0 : 1 / BODY_MASS) : 1;
          const wsum = wa + wb;
          if (!wsum) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 0.0001;
          const diff = ((d - rope.segLen) / d) * p.stiffness;
          a.x += dx * diff * (wa / wsum);
          a.y += dy * diff * (wa / wsum);
          b.x -= dx * diff * (wb / wsum);
          b.y -= dy * diff * (wb / wsum);
        }
      }

      const ox = hub.x - p.anchor.x;
      const oy = hub.y - p.anchor.y;
      const off = Math.hypot(ox, oy);
      if (off > NET_GIVE) {
        hub.x = p.anchor.x + (ox / off) * NET_GIVE;
        hub.y = p.anchor.y + (oy / off) * NET_GIVE;
      }
    }
  }

  /** Add a sideways velocity (px/s) to the body end. */
  function impulse(rope, vx) {
    const e = end(rope);
    e.px -= vx / (60 * SUBSTEPS);
  }

  /** Direction (unit vector) from the body end back up the rope. */
  function upDir(rope) {
    const pts = rope.pts;
    const e = pts[pts.length - 1];
    const q = pts[pts.length - 4];
    const dx = q.x - e.x;
    const dy = q.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    return { x: dx / d, y: dy / d };
  }

  /** Catmull-Rom resample → [{x, y, s (arc length), tx, ty, nx, ny}]. */
  function sample(points, perSeg = 6) {
    const out = [];
    const n = points.length;
    for (let i = 0; i < n - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(n - 1, i + 2)];
      for (let k = 0; k < perSeg; k++) {
        const t = k / perSeg;
        const t2 = t * t;
        const t3 = t2 * t;
        out.push({
          x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        });
      }
    }
    out.push({ x: points[n - 1].x, y: points[n - 1].y });

    let s = 0;
    for (let i = 0; i < out.length; i++) {
      const a = out[Math.max(0, i - 1)];
      const b = out[Math.min(out.length - 1, i + 1)];
      if (i > 0) s += Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      out[i].s = s;
      out[i].tx = dx / d;
      out[i].ty = dy / d;
      out[i].nx = -dy / d;
      out[i].ny = dx / d;
    }
    return out;
  }

  function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function outline(ctx, smp, radiusAt, dx = 0, dy = 0) {
    ctx.beginPath();
    for (let i = 0; i < smp.length; i++) {
      const p = smp[i];
      const r = radiusAt(p.s);
      const x = p.x + p.nx * r + dx;
      const y = p.y + p.ny * r + dy;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = smp.length - 1; i >= 0; i--) {
      const p = smp[i];
      const r = radiusAt(p.s);
      ctx.lineTo(p.x - p.nx * r + dx, p.y - p.ny * r + dy);
    }
    ctx.closePath();
  }

  function offsetLine(ctx, smp, offAt) {
    ctx.beginPath();
    for (let i = 0; i < smp.length; i++) {
      const p = smp[i];
      const o = offAt(p.s);
      const x = p.x + p.nx * o;
      const y = p.y + p.ny * o;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  /**
   * Draw a twisted silk cord along resampled points.
   * opts: { radius, fibers, pitch (px per full twist), taperIn, taperOut, seed, fuzz }
   */
  function drawCord(ctx, smp, opts = {}) {
    if (smp.length < 2) return;
    const R = opts.radius || 1.9;
    const total = smp[smp.length - 1].s;
    const taperIn = opts.taperIn || 0;
    const taperOut = opts.taperOut || 0;
    const radiusAt = (s) => {
      let r = R;
      if (taperIn) r *= 0.45 + 0.55 * smoothstep(0, taperIn, s);
      if (taperOut) r *= 0.6 + 0.4 * smoothstep(0, taperOut, total - s);
      return r;
    };

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Soft drop shadow on the desktop behind.
    outline(ctx, smp, (s) => radiusAt(s) + 0.6, 2, 3);
    ctx.fillStyle = SILK.shadow;
    ctx.fill();

    outline(ctx, smp, radiusAt);
    ctx.fillStyle = SILK.base;
    ctx.fill();

    // Bright core where the cord faces the viewer.
    offsetLine(ctx, smp, (s) => -radiusAt(s) * 0.15);
    ctx.strokeStyle = SILK.core;
    ctx.lineWidth = R * 0.95;
    ctx.stroke();

    // Lay twist: each ply's boundary spirals; draw only the front-facing arc,
    // which reads as the diagonal grooves of a laid rope.
    const fibers = opts.fibers || 3;
    const pitch = opts.pitch || 10;
    const k = (Math.PI * 2) / pitch;
    ctx.strokeStyle = SILK.groove;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let f = 0; f < fibers; f++) {
      const phase = (f / fibers) * Math.PI * 2;
      let drawing = false;
      for (let i = 0; i < smp.length; i++) {
        const p = smp[i];
        const th = p.s * k + phase;
        const depth = Math.cos(th);
        const r = radiusAt(p.s);
        const x = p.x + p.nx * Math.sin(th) * r * 0.92;
        const y = p.y + p.ny * Math.sin(th) * r * 0.92;
        if (depth > 0.05) {
          if (!drawing) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          drawing = true;
        } else {
          drawing = false;
        }
      }
    }
    ctx.stroke();

    // Rim darkening on both edges for roundness.
    ctx.strokeStyle = SILK.edge;
    ctx.lineWidth = 0.55;
    offsetLine(ctx, smp, (s) => radiusAt(s) * 0.95);
    ctx.stroke();
    offsetLine(ctx, smp, (s) => -radiusAt(s) * 0.95);
    ctx.stroke();

    // Specular streak on the lit side.
    offsetLine(ctx, smp, (s) => -radiusAt(s) * 0.5);
    ctx.strokeStyle = SILK.shine;
    ctx.lineWidth = 0.45;
    ctx.stroke();

    // Loose fibers fraying off the cord at fixed spots.
    const fuzz = opts.fuzz ?? 1;
    const seed = opts.seed || 1;
    const hairCount = Math.floor((total / 22) * fuzz);
    ctx.strokeStyle = "rgba(225,232,240,0.5)";
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    for (let h = 0; h < hairCount; h++) {
      const s0 = (hash(seed + h * 3.1) * 0.9 + 0.05) * total;
      const i = smp.findIndex((p) => p.s >= s0);
      if (i < 1) continue;
      const p = smp[i];
      const side = hash(seed + h * 7.7) > 0.5 ? 1 : -1;
      const len = 3 + hash(seed + h * 1.3) * 7;
      const lean = 0.25 + hash(seed + h * 5.9) * 0.5;
      const bx = p.x + p.nx * radiusAt(p.s) * side;
      const by = p.y + p.ny * radiusAt(p.s) * side;
      const ex = bx + (p.tx * (1 - lean) + p.nx * side * lean) * len;
      const ey = by + (p.ty * (1 - lean) + p.ny * side * lean) * len;
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(bx + p.tx * len * 0.6, by + p.ty * len * 0.6, ex, ey);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Orb-web net glued to the edge, fanning up from the hub the line hangs on.
   * net: { edgeY, rest (hub rest point), hub (current, displaced by the line), spokes, seed }
   * Threads are laid between points on the radials, so when the line drags
   * the hub the whole net stretches with it.
   */
  function drawNet(ctx, net) {
    const { edgeY, rest, hub, spokes } = net;
    const seed = net.seed || 7;
    const depth = rest.y - edgeY;
    const spread = 1.18;

    const radials = [];
    for (let i = 0; i < spokes; i++) {
      const t = spokes === 1 ? 0.5 : i / (spokes - 1);
      const a = -spread + 2 * spread * t + (hash(seed + i * 1.7) - 0.5) * 0.06;
      const frame = { x: rest.x + Math.tan(a) * depth, y: edgeY };
      const len = Math.hypot(frame.x - hub.x, frame.y - hub.y);
      radials.push({ frame, len, a });
    }

    // Point at fraction t along radial i, with a little gravity droop.
    const at = (i, t) => {
      const r = radials[i];
      const droop = Math.sin(Math.PI * t) * r.len * 0.025;
      return {
        x: hub.x + (r.frame.x - hub.x) * t,
        y: hub.y + (r.frame.y - hub.y) * t + droop,
      };
    };

    // Silk catches the light depending on its direction — gives the shimmer.
    const shine = (a, b) => {
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      return 0.45 + 0.5 * Math.abs(Math.cos(ang - 0.6));
    };

    const threads = [];
    const beads = [];

    // Radials, forking into two attachment threads just before the edge.
    radials.forEach((r, i) => {
      const fork = at(i, 0.88);
      threads.push({ a: hub, b: fork, w: 1.1, sag: 0 });
      const span = 3 + hash(seed + i * 4.3) * 5;
      threads.push({ a: fork, b: { x: r.frame.x - span, y: edgeY }, w: 0.8, sag: 0 });
      threads.push({ a: fork, b: { x: r.frame.x + span, y: edgeY }, w: 0.8, sag: 0 });
    });

    // Top frame thread just under the edge, sagging between attachments.
    for (let i = 0; i < spokes - 1; i++) {
      threads.push({ a: at(i, 0.95), b: at(i + 1, 0.95), w: 0.9, sag: 1.4 });
    }

    // Hub: tight irregular spiral holding the radials together.
    for (let k = 0; k < 4; k++) {
      const t = 0.035 + k * 0.022;
      for (let i = 0; i < spokes - 1; i++) {
        threads.push({ a: at(i, t), b: at(i + 1, t + 0.004), w: 0.55, sag: 0.3 });
      }
    }

    // Capture spiral beyond the free zone: drooping garlands with glue beads.
    const rings = Math.round(9 + depth / 12);
    for (let k = 0; k < rings; k++) {
      const t = 0.2 + (0.66 * k) / (rings - 1);
      for (let i = 0; i < spokes - 1; i++) {
        // a few broken segments, like a real, used web
        if (hash(seed + k * 31.7 + i * 3.3) < 0.05) continue;
        const ta = t + (hash(seed + k * 5.1 + i) - 0.5) * 0.015;
        const tb = t + 0.66 / (rings - 1) / spokes + (hash(seed + k * 9.4 + i) - 0.5) * 0.015;
        const a = at(i, ta);
        const b = at(i + 1, tb);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        threads.push({ a, b, w: 0.7, sag: 0.8 + len * 0.05 });
        const n = Math.floor(len / 7);
        for (let q = 1; q < n; q++) {
          const u = q / n;
          beads.push({
            x: a.x + (b.x - a.x) * u,
            y: a.y + (b.y - a.y) * u + (0.8 + len * 0.05) * 2 * u * (1 - u),
          });
        }
      }
    }

    // A couple of snapped capture threads dangling loose.
    for (let k = 0; k < 3; k++) {
      const i = Math.floor(hash(seed + k * 13.3) * (spokes - 1));
      const p = at(i, 0.35 + hash(seed + k * 2.2) * 0.45);
      const l = 10 + hash(seed + k * 6.6) * 14;
      threads.push({ a: p, b: { x: p.x + 3 + k, y: p.y + l }, w: 0.5, sag: -2 });
    }

    ctx.save();
    ctx.lineCap = "round";

    const curve = (th, dx, dy) => {
      const mx = (th.a.x + th.b.x) / 2;
      const my = (th.a.y + th.b.y) / 2 + th.sag;
      ctx.moveTo(th.a.x + dx, th.a.y + dy);
      ctx.quadraticCurveTo(mx + dx, my + dy, th.b.x + dx, th.b.y + dy);
    };

    // Soft shadow on the desktop behind the net.
    ctx.beginPath();
    for (const th of threads) curve(th, 1.4, 2.2);
    ctx.strokeStyle = "rgba(0,0,0,0.28)";
    ctx.lineWidth = 1;
    ctx.stroke();

    for (const th of threads) {
      ctx.beginPath();
      curve(th, 0, 0);
      ctx.strokeStyle = `rgba(232,238,246,${0.42 + 0.48 * shine(th.a, th.b) * (th.w > 0.75 ? 1 : 0.8)})`;
      ctx.lineWidth = th.w;
      ctx.stroke();
    }

    ctx.beginPath();
    for (const b of beads) {
      ctx.moveTo(b.x + 0.55, b.y);
      ctx.arc(b.x, b.y, 0.55, 0, Math.PI * 2);
    }
    ctx.fillStyle = "rgba(245,248,252,0.7)";
    ctx.fill();

    // Glue pads where the forks meet the edge.
    ctx.fillStyle = "rgba(236,241,247,0.75)";
    radials.forEach((r, i) => {
      const span = 3 + hash(seed + i * 4.3) * 5;
      for (const x of [r.frame.x - span, r.frame.x + span]) {
        ctx.beginPath();
        ctx.ellipse(x, edgeY + 0.6, 1.8, 1, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // Dense silk mat at the hub.
    const mat = ctx.createRadialGradient(hub.x, hub.y, 0.5, hub.x, hub.y, 9);
    mat.addColorStop(0, "rgba(244,247,251,0.95)");
    mat.addColorStop(0.5, "rgba(226,233,242,0.55)");
    mat.addColorStop(1, "rgba(226,233,242,0)");
    ctx.fillStyle = mat;
    ctx.beginPath();
    ctx.arc(hub.x, hub.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Fibers from the hub mat gathering into the start of the cord. */
  function drawHubJunction(ctx, hub, smp, count, seed = 5) {
    const merge = smp.find((p) => p.s >= 20) || smp[smp.length - 1];
    const mid = smp.find((p) => p.s >= 8) || merge;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const a = Math.PI * (0.15 + (0.7 * i) / Math.max(1, count - 1));
      const r = 3 + hash(seed + i * 2.9) * 4;
      const sx = hub.x - Math.cos(a) * r;
      const sy = hub.y + Math.sin(a) * r * 0.6;
      const j = (hash(seed + i * 7.1) - 0.5) * 1.4;
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(mid.x + mid.nx * j * 2, mid.y + mid.ny * j * 2, merge.x + merge.nx * j * 0.5, merge.y + merge.ny * j * 0.5);
    }
    ctx.strokeStyle = "rgba(232,238,246,0.7)";
    ctx.lineWidth = 0.6;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Silk wrapped around the grip (hand or ankles).
   * at: center, angle: rotation so local −y points up the rope, width: wrap span.
   * part: "back" draws hidden halves (before the body), "front" the visible ones.
   */
  function drawWrap(ctx, at, angle, width, part) {
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(angle);
    ctx.lineCap = "round";
    const loops = 4;
    for (let k = 0; k < loops; k++) {
      const y = -3 + k * 2.1;
      const rx = width / 2 + (k % 2) * 0.8;
      const tilt = (k % 2 ? 1 : -1) * 0.12;
      ctx.beginPath();
      if (part === "back") ctx.ellipse(0, y, rx, 1.7, tilt, Math.PI, Math.PI * 2);
      else ctx.ellipse(0, y, rx, 1.7, tilt, 0, Math.PI);
      ctx.strokeStyle = part === "back" ? "rgba(150,160,175,0.6)" : SILK.core;
      ctx.lineWidth = 1.25;
      ctx.stroke();
      if (part !== "back") {
        ctx.strokeStyle = SILK.groove;
        ctx.lineWidth = 0.4;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  return { create, step, impulse, end, upDir, sample, drawCord, drawNet, drawHubJunction, drawWrap, SEGMENTS };
})();
