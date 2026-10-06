/**
 * Desktop widget page: runs inside the transparent overlay window.
 *
 * The host (spidey_host.py) calls `window.spidey.configure()` with the
 * monitor layout, settings and saved state, and receives messages through
 * `window.webkit.messageHandlers.spidey`: the clickable rectangle, the
 * right-click menu request, and periodic state for restore on next boot.
 * Opened in a normal browser it configures itself for the window size.
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Miles3D } from "./miles3d.js";
import { Brain } from "./brain.js";

const SIZES = { small: 95, medium: 120, large: 150 };
// While he rests, the overlay window is a box around what's drawn (Miles +
// his web): the X server and the compositor copy every pixel of a
// transparent window each frame, so smaller is much cheaper. During any move
// or drag it covers the whole layout, so it never shifts mid-motion (a moved
// window shows the old frame at the new place for a moment: a visible jump).
const VIEW_STEP = 64; // window size/position granularity
const VIEW_MARGIN = 40; // room that must stay free inside the window
const VIEW_HEADROOM = 160; // extra room added when fitting
const VIEW_SHRINK_DELAY = 3000; // ms at rest before shrinking around him
const DEBUG = new URLSearchParams(location.search).has("debug");

const hostChannel = window.webkit?.messageHandlers?.spidey;
const post = (msg) => {
  if (hostChannel) hostChannel.postMessage(JSON.stringify(msg));
};

const back = document.getElementById("layer-back");
const front = document.getElementById("layer-front");
const glCanvas = document.getElementById("layer-gl");
const bctx = back.getContext("2d");
const fctx = front.getContext("2d");

const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true, premultipliedAlpha: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(1);

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.3;
scene.add(new THREE.HemisphereLight("#c9d4ff", "#2a1830", 0.9));
const key = new THREE.DirectionalLight("#fff4ea", 2.2);
key.position.set(-1, 2, 3);
scene.add(key);
const rimCyan = new THREE.DirectionalLight("#3de0ff", 2.6);
rimCyan.position.set(2, 1, -2);
scene.add(rimCyan);
const rimMagenta = new THREE.DirectionalLight("#ff2a6d", 1.6);
rimMagenta.position.set(-2, 0.5, -2);
scene.add(rimMagenta);

// Orthographic: 1 world unit = 1 CSS px everywhere on the (wide) overlay,
// so he looks the same at the screen edges as in the middle.
const camera = new THREE.OrthographicCamera(0, 1, 0, -1, -2000, 2000);
camera.position.z = 1000;

let width = 0;
let height = 0;
// Window rectangle inside the full monitor layout (layout px).
const view = { x: 0, y: 0, w: 0, h: 0, pending: null, shrinkSince: 0 };

function applyCamera() {
  camera.left = view.x;
  camera.right = view.x + width;
  camera.top = -view.y;
  camera.bottom = -(view.y + height);
  camera.updateProjectionMatrix();
}

function resize() {
  width = window.innerWidth;
  height = window.innerHeight;
  for (const c of [back, front]) {
    c.width = width;
    c.height = height;
    c.style.width = `${width}px`;
    c.style.height = `${height}px`;
  }
  renderer.setSize(width, height, false);
  glCanvas.style.width = `${width}px`;
  glCanvas.style.height = `${height}px`;
  applyCamera();
}
window.addEventListener("resize", resize);
resize();

// ——— Host bridge ———
let miles = null;
let brain = null;
let config = null;
let systemPaused = false;
let lastHit = "";

function pxPerMeter() {
  return SIZES[config.settings.size] || SIZES.medium;
}

function setup() {
  if (!miles || !config || brain) return;
  brain = new Brain(config.monitors, miles.measure(), {
    roam: !!config.settings.roam,
    activity: config.settings.activity || "calm",
    pxPerMeter: pxPerMeter(),
  });
  brain.paused = !!config.settings.paused;
  brain.on("log", (msg) => post({ type: "log", msg }));
  if (!brain.restore(config.state)) placeDefault();
  brain.scheduleNext();
  brain.nextIn = Math.min(brain.nextIn, 25);
  scene.add(miles.object);
  post({ type: "ready" });
}

function placeDefault() {
  const primary = config.monitors.find((m) => m.primary) || config.monitors[0];
  brain.hangAt(primary.work.x + primary.work.w * 0.7, 200, "feet");
}

window.spidey = {
  configure(cfg) {
    config = cfg;
    // The host resets the window to the full layout on (re)configure.
    view.x = 0;
    view.y = 0;
    view.w = 0;
    view.h = 0;
    view.pending = null;
    applyCamera();
    if (brain) {
      brain.setMonitors(cfg.monitors);
      return;
    }
    setup();
  },
  set(name, value) {
    if (!config) return;
    config.settings[name] = value;
    if (!brain) return;
    if (name === "size") brain.setScale(pxPerMeter());
    if (name === "roam") brain.opt.roam = !!value;
    if (name === "activity") { brain.opt.activity = value; brain.scheduleNext(); }
    if (name === "paused") brain.paused = !!value;
  },
  command(name) {
    if (!brain || brain.drag.active) return;
    if (name === "cross") { brain.job = null; brain.start("cross", "requested"); }
    if (name === "reset") { brain.job = null; placeDefault(); }
  },
  /** Host moved/resized the window to the requested box. */
  viewport(v) {
    view.x = v.x;
    view.y = v.y;
    view.w = v.w;
    view.h = v.h;
    view.pending = null;
    lastHit = "";
    dirty = { full: true };
    applyCamera();
  },
  /** Stop everything (sleep, lock, hidden) and report state for saving. */
  suspend(on) {
    systemPaused = !!on;
    if (brain) post({ type: "state", state: brain.serialize() });
    if (!on) {
      lastTs = performance.now();
      lastHit = ""; // the host cleared the window shape while hidden
    }
  },
};

// ——— Drawing helpers ———
// Rectangles (layout px, [x, y, w, h]) covering the web drawn this frame,
// so the next frame only wipes that area.
let webRects = [];

/** Thin boxes along a polyline of points. */
function stripRects(pts, pad = 6, step = 3) {
  for (let i = 0; i < pts.length - 1; i += step) {
    const a = pts[i];
    const b = pts[Math.min(i + step, pts.length - 1)];
    const x = Math.min(a.x, b.x) - pad;
    const y = Math.min(a.y, b.y) - pad;
    webRects.push([x, y, Math.abs(a.x - b.x) + pad * 2, Math.abs(a.y - b.y) + pad * 2]);
  }
}

// The net is static while he hangs from it: draw it once per anchor.
const netCache = { key: "", canvas: document.createElement("canvas"), x: 0, y: 0 };

function drawNetCached(ax, ay) {
  const edgeY = brain.ceilAt(ax);
  const key = `${Math.round(ax)},${Math.round(ay)},${edgeY}`;
  if (netCache.key !== key) {
    const halfW = Math.ceil(Math.tan(1.18) * (ay - edgeY)) + 30;
    const c = netCache.canvas;
    c.width = halfW * 2;
    c.height = Math.ceil(ay - edgeY) + 30;
    netCache.x = Math.round(ax) - halfW;
    netCache.y = edgeY;
    const ctx = c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, -netCache.x, -netCache.y);
    const hub = { x: ax, y: ay };
    WebLine.drawNet(ctx, { edgeY, rest: hub, hub, spokes: 11, seed: Math.round(ax) % 97 });
    netCache.key = key;
  }
  bctx.drawImage(netCache.canvas, netCache.x, netCache.y);
  webRects.push([netCache.x, netCache.y, netCache.canvas.width, netCache.canvas.height]);
}

function drawWeb(f) {
  const r = f.rope;
  if (!r) return;
  const grip = brain.ropeGrip(r);
  const onNet = f.surface !== "drag" && Math.abs(r.ay - brain.anchorY(r.ax)) < 1;
  const from = { x: r.ax, y: r.ay };
  if (onNet) drawNetCached(r.ax, r.ay);
  const mid = { x: (from.x + grip.x) / 2 + 2, y: (from.y + grip.y) / 2 + Math.min(8, r.len * 0.02) };
  const smp = WebLine.sample([from, mid, grip], 10);
  WebLine.drawCord(bctx, smp, { radius: onNet ? 1.9 : 1.5, fibers: 3, pitch: 9, taperIn: onNet ? 16 : 0, seed: 11 });
  stripRects(smp, 8);
  if (onNet) WebLine.drawHubJunction(bctx, from, smp, 8);
  if (r.grip === "feet") {
    // Web wound around the ankles.
    const span = brain.R.hip * 2 + 8;
    WebLine.drawWrap(fctx, grip, -r.ang, span, "front");
    webRects.push([grip.x - span - 6, grip.y - 12, span * 2 + 12, 24]);
  } else if (r.grip === "hand") {
    // Single fist: a short wrap at the grip reads as holding the line.
    WebLine.drawWrap(fctx, grip, -r.ang, 9, "front");
    webRects.push([grip.x - 15, grip.y - 12, 30, 24]);
  } else {
    // Tuck: both fists on the line; it runs on through them to a short
    // loose end, drawn behind Miles so the fists cover it (not tied).
    const along = { x: Math.sin(r.ang), y: Math.cos(r.ang) };
    const reach = (r.grip === "tuck" ? brain.opt.pxPerMeter * 0.2 : brain.opt.pxPerMeter * 0.1) + 16;
    const end = { x: grip.x + along.x * reach + 3, y: grip.y + along.y * reach };
    const loose = WebLine.sample([grip, { x: (grip.x + end.x) / 2 + 2, y: (grip.y + end.y) / 2 }, end], 6);
    WebLine.drawCord(bctx, loose, { radius: 1.5, fibers: 3, pitch: 9, taperOut: 10, seed: 31, fuzz: 0.3 });
    stripRects(loose, 8);
  }
  if (r.grip === "feet" && f.solved) {
    // Down to the lower of the two fists holding it.
    const dist = (p) => Math.hypot(p.x - grip.x, p.y - grip.y);
    const hand = dist(f.solved.aL.E) > dist(f.solved.aR.E) ? f.solved.aL.E : f.solved.aR.E;
    const sag = { x: (grip.x + hand.x) / 2 + 2, y: (grip.y + hand.y) / 2 + 2 };
    const tail = WebLine.sample([grip, sag, hand], 8);
    WebLine.drawCord(fctx, tail, { radius: 1.5, fibers: 3, pitch: 9, taperOut: 6, seed: 29, fuzz: 0.4 });
    stripRects(tail, 8);
  }
}

function drawShot(f) {
  const s = f.shot;
  if (!s) return;
  const end = { x: s.from.x + (s.to.x - s.from.x) * s.t, y: s.from.y + (s.to.y - s.from.y) * s.t };
  const pts = WebLine.sample([s.from, end], 8);
  WebLine.drawCord(bctx, pts, { radius: 1.4, fibers: 3, pitch: 9, seed: 7, fuzz: 0.3 });
  stripRects(pts, 8);
}

/** Capsules from the posed 3D model → boxes (layout px). */
function milesRects(pad) {
  return miles.outline().map(({ a, b, r }) => {
    const p = r + pad;
    return [Math.min(a.x, b.x) - p, Math.min(a.y, b.y) - p, Math.abs(a.x - b.x) + p * 2, Math.abs(a.y - b.y) + p * 2];
  });
}

let lastHitAt = 0;
// While moving, updating the X input shape every frame costs more than it
// buys; padded boxes cover the 50 ms between updates.
const HIT_INTERVAL = 50;

/** Tell the host which areas take clicks: just his body. */
function reportHit(active) {
  const now = performance.now();
  if (active && now - lastHitAt < HIT_INTERVAL) return;
  lastHitAt = now;
  const rects = milesRects(active ? 12 : 4).map((r) => [Math.floor(r[0] - view.x), Math.floor(r[1] - view.y), Math.ceil(r[2]) + 1, Math.ceil(r[3]) + 1]);
  const key = rects.flat().map((n) => Math.round(n / 3)).join(",");
  if (key === lastHit) return;
  lastHit = key;
  post({ type: "hit", rects });
}

/** Bounding box (layout px) of everything drawn: Miles, line, net, web shot. */
function contentBox(f) {
  const b = brain.hitRect(30);
  let x0 = b.x;
  let y0 = b.y;
  let x1 = b.x + b.w;
  let y1 = b.y + b.h;
  const grow = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  const net = (x, y) => { grow(x - 210, brain.ceilAt(x)); grow(x + 210, y + 20); };
  if (f.rope) {
    grow(f.rope.ax, f.rope.ay);
    if (f.surface !== "drag") net(f.rope.ax, f.rope.ay);
  }
  if (f.shot) net(f.shot.to.x, f.shot.to.y);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Ask the host to move/resize the window when the content no longer fits it well. */
function followViewport(f) {
  if (!hostChannel || !config.size || view.pending) return;
  // Wait until the last resize has actually reached the page.
  if (view.w && (window.innerWidth !== view.w || window.innerHeight !== view.h)) return;
  if (brain.job || brain.drag.active) {
    view.shrinkSince = 0;
    const full = { x: 0, y: 0, w: config.size.w, h: config.size.h };
    if (view.x === 0 && view.y === 0 && width === full.w && height === full.h) return;
    view.pending = full;
    post({ type: "viewport", ...full });
    return;
  }
  const c = contentBox(f);
  const fits = c.x >= view.x + VIEW_MARGIN && c.y >= view.y + VIEW_MARGIN &&
    c.x + c.w <= view.x + width - VIEW_MARGIN && c.y + c.h <= view.y + height - VIEW_MARGIN;
  const snug = (c.w + VIEW_HEADROOM * 2) * (c.h + VIEW_HEADROOM * 2);
  const oversized = width * height > snug * 2.5;
  if (fits && !oversized) { view.shrinkSince = 0; return; }
  if (fits) {
    // Shrink only once he has settled, not between two frames of a move.
    const now = performance.now();
    if (!view.shrinkSince) view.shrinkSince = now;
    if (now - view.shrinkSince < VIEW_SHRINK_DELAY) return;
  }
  view.shrinkSince = 0;
  const pad = VIEW_HEADROOM;
  const down = (n) => Math.floor(n / VIEW_STEP) * VIEW_STEP;
  const up = (n) => Math.ceil(n / VIEW_STEP) * VIEW_STEP;
  const x0 = Math.max(0, down(c.x - pad));
  const y0 = Math.max(0, down(c.y - pad));
  const x1 = Math.min(config.size.w, up(c.x + c.w + pad));
  const y1 = Math.min(config.size.h, up(c.y + c.h + pad));
  const v = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (v.x === view.x && v.y === view.y && v.w === width && v.h === height) return;
  view.pending = v;
  post({ type: "viewport", ...v });
}

// ——— Input (only arrives inside the clickable region) ———
let dragging = false;
let lastMove = 0;
window.addEventListener("pointerdown", (e) => {
  if (!brain || e.button !== 0) return;
  if (brain.beginDrag({ x: e.clientX + view.x, y: e.clientY + view.y })) {
    dragging = true;
    lastMove = performance.now();
    post({ type: "drag", active: true });
  }
});
window.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const now = performance.now();
  brain.moveDrag({ x: e.clientX + view.x, y: e.clientY + view.y }, (now - lastMove) / 1000);
  lastMove = now;
});
const release = () => {
  if (!dragging) return;
  dragging = false;
  brain.endDrag();
  post({ type: "drag", active: false });
};
window.addEventListener("pointerup", release);
window.addEventListener("pointercancel", release);
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  post({ type: "menu" });
});

// ——— Blinking ———
const BLINK_TIME = 0.16;
const blink = { next: 2.5, start: -1 };

/** 0 = open … 1 = shut; a blink every 2.5–6 s, sometimes a double blink. */
function updateBlink(now) {
  if (blink.start < 0 && now >= blink.next) blink.start = now;
  if (blink.start < 0) return 0;
  const t = (now - blink.start) / BLINK_TIME;
  if (t >= 1) {
    blink.start = -1;
    blink.next = now + (Math.random() < 0.2 ? 0.12 : 2.5 + Math.random() * 3.5);
    return 0;
  }
  return Math.sin(t * Math.PI);
}

// ——— Loop ———
// Area (layout px) drawn on the 2D layers last frame; `full` forces a full wipe.
let dirty = { full: true };

function boundsOf(rects, pad) {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y, w, h] of rects) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

let lastTs = performance.now();
let lastRender = 0;
let lastSave = 0;
let frames = 0;
let fpsT = 0;

function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.033, (ts - lastTs) / 1000);
  lastTs = ts;
  if (!brain || systemPaused) return;

  const fullView = view.x === 0 && view.y === 0 && width === config.size?.w && height === config.size?.h;
  brain.hold = !!hostChannel && !!brain.job && !fullView;
  const moving = brain.update(dt);
  const blinkAmount = updateBlink(ts / 1000);
  const active = moving || blinkAmount > 0;
  // Idle (sway, breathing, glances): 30 fps keeps it smooth at half the cost.
  if (!active && ts - lastRender < 32) return;
  lastRender = ts;

  const f = brain.fig;
  followViewport(f);
  // WebKitGTK paints 2D canvases on the CPU: only wipe what was drawn last frame.
  for (const c of [bctx, fctx]) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (!dirty || dirty.full) c.clearRect(0, 0, width, height);
    c.setTransform(1, 0, 0, 1, -view.x, -view.y);
    if (dirty && !dirty.full) c.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
  }
  webRects = [];
  drawWeb(f);
  drawShot(f);
  dirty = boundsOf(webRects, 14);
  const rig = brain.rig();
  miles.applyRig(rig, brain.opt.pxPerMeter);
  miles.setEyes(rig.eyes * (1 - blinkAmount));
  renderer.render(scene, camera);
  reportHit(moving);
  if (DEBUG) {
    fctx.strokeStyle = "rgba(232,163,23,0.9)";
    fctx.lineWidth = 1;
    for (const r of milesRects(4)) fctx.strokeRect(r[0], r[1], r[2], r[3]);
    dirty = { full: true }; // the outlines lie outside the tracked web area
  }

  if (ts - lastSave > 15000) {
    lastSave = ts;
    post({ type: "state", state: brain.serialize() });
  }
  frames++;
  if (ts - fpsT > 5000) {
    post({ type: "stats", fps: Math.round((frames * 1000) / (ts - fpsT)), gl: renderer.getContext().getParameter(renderer.getContext().RENDERER) });
    frames = 0;
    fpsT = ts;
  }
}
requestAnimationFrame(frame);

Miles3D.load().then((m) => {
  miles = m;
  setup();
});

if (DEBUG) window.spideyDebug = { get brain() { return brain; }, get miles() { return miles; }, get config() { return config; } };

// Ask the host for the layout now that window.spidey exists.
post({ type: "hello" });

// Standalone (normal browser, no host): one monitor = the window.
if (!hostChannel) {
  window.spidey.configure({
    monitors: [{ x: 0, y: 0, w: width, h: height, primary: true, work: { x: 0, y: 0, w: width, h: height } }],
    settings: { size: "medium", activity: "calm", roam: false, paused: false },
    state: null,
  });
}
