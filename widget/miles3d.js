/**
 * Miles 3D — loads the rigged glTF model and poses it procedurally.
 *
 * The behaviour planner (brain.js) hands over a 2D screen-space rig each
 * frame; applyRig() turns it into a 3D pose. Limbs are placed with two-bone
 * IK (target + pole), so poses don't depend on the rig's bone-axis
 * conventions.
 *
 * Model: "Miles from Spider-Man: Across The Spider Verse" by CVRxEarth,
 * CC-BY-4.0 — https://sketchfab.com/3d-models/miles-from-spider-man-across-the-spider-verse-6585b5cd701d4b11a66618e20b7c8df7
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MODEL_URL = new URL("../model/miles_from_spider-man_across_the_spider_verse.glb", import.meta.url).href;
// The file holds four copies side by side; this one is masked, in a clean A-pose.
const VARIANT = "root002_451";

const BONE_NAMES = {
  root: "rootx",
  spine1: "spine_01x",
  spine2: "spine_02x",
  spine3: "spine_03x",
  neck: "neckx",
  head: "headx",
  upperArmL: "arm_stretchl",
  forearmL: "forearm_stretchl",
  handL: "handl",
  upperArmR: "arm_stretchr",
  forearmR: "forearm_stretchr",
  handR: "handr",
  thighL: "thigh_stretchl",
  shinL: "leg_stretchl",
  footL: "footl",
  toesL: "toes_01l",
  thighR: "thigh_stretchr",
  shinR: "leg_stretchr",
  footR: "footr",
  toesR: "toes_01r",
};

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

/** Rotate a bone by a world-space rotation, keeping its parent untouched. */
function rotateBoneWorld(bone, qWorld) {
  bone.getWorldQuaternion(_q1);
  _q1.premultiply(qWorld);
  bone.parent.getWorldQuaternion(_q2).invert();
  bone.quaternion.copy(_q2.multiply(_q1));
  bone.updateMatrixWorld(true);
}

/** Swing a bone so the vector bone→child points along `dirWorld`. */
function aimBone(bone, child, dirWorld) {
  const from = child.getWorldPosition(_v1).sub(bone.getWorldPosition(_v2)).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(from, _v3.copy(dirWorld).normalize());
  rotateBoneWorld(bone, q);
}

/** Analytic two-bone IK in world space; pole picks the elbow/knee side. */
function solveTwoBone(upper, lower, end, target, pole) {
  const a = upper.getWorldPosition(new THREE.Vector3());
  const b = lower.getWorldPosition(new THREE.Vector3());
  const c = end.getWorldPosition(new THREE.Vector3());
  const l1 = a.distanceTo(b);
  const l2 = b.distanceTo(c);
  const toT = target.clone().sub(a);
  const d = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const dir = toT.normalize();
  const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const bend = pole.clone().sub(a);
  bend.sub(dir.clone().multiplyScalar(bend.dot(dir)));
  if (bend.lengthSq() < 1e-8) bend.set(0, 0, 1);
  bend.normalize();
  const elbow = a.clone().add(dir.clone().multiplyScalar(l1 * cosA)).add(bend.multiplyScalar(l1 * sinA));
  aimBone(upper, lower, elbow.clone().sub(a));
  const reach = a.clone().add(dir.multiplyScalar(d));
  aimBone(lower, end, reach.sub(lower.getWorldPosition(new THREE.Vector3())));
}

/**
 * The GLB lost the model's expression shape keys, so build one: a morph that
 * squashes each lens onto its horizontal centre line (Spider-Verse lenses
 * "blink" by narrowing). Negative influence widens them.
 */
function addLensCloseMorph(mesh) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  geo.computeBoundingBox();
  const midX = (geo.boundingBox.min.x + geo.boundingBox.max.x) / 2;
  const span = [
    [Infinity, -Infinity],
    [Infinity, -Infinity],
  ];
  for (let i = 0; i < pos.count; i++) {
    const s = pos.getX(i) < midX ? 0 : 1;
    span[s][0] = Math.min(span[s][0], pos.getY(i));
    span[s][1] = Math.max(span[s][1], pos.getY(i));
  }
  const centre = span.map(([lo, hi]) => (lo + hi) / 2);
  const delta = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = centre[pos.getX(i) < midX ? 0 : 1];
    const y = pos.getY(i);
    delta[i * 3 + 1] = c + (y - c) * 0.06 - y;
  }
  geo.morphAttributes.position = [new THREE.Float32BufferAttribute(delta, 3)];
  geo.morphTargetsRelative = true;
  mesh.updateMorphTargets();
  mesh.morphTargetInfluences[0] = 0;
}

export class Miles3D {
  /** Loads the model; resolves with a ready instance. */
  static async load() {
    const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
    return new Miles3D(gltf);
  }

  constructor(gltf) {
    // object (scale: px per meter) → model (rotated body) → gltf scene
    this.object = new THREE.Group();
    this.model = new THREE.Group();
    this.object.add(this.model);

    const scene = gltf.scene;
    let variant = null;
    scene.traverse((o) => {
      if (o.name === VARIANT) variant = o;
    });
    // Drop the other three copies so they cost nothing to render.
    for (const sibling of [...variant.parent.children]) {
      if (sibling !== variant) sibling.removeFromParent();
    }
    this.model.add(scene);

    scene.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      // Sketchfab's conversion exported metalness 1 / roughness 1, which renders
      // the suit as a black mirror; restore a glossy fabric.
      const m = o.material;
      m.metalness = 0;
      m.roughness = m.name === "E_Y_E_S" ? 0.12 : 0.5;
      if (m.name === "E_Y_E_S") {
        m.emissive = new THREE.Color("#ffffff");
        m.emissiveIntensity = 0.35;
        this.eyes = o;
      }
    });
    if (this.eyes) addLensCloseMorph(this.eyes);

    this.bones = {};
    this.rest = new Map();
    variant.traverse((o) => {
      if (!o.isBone) return;
      this.rest.set(o, o.quaternion.clone());
      const base = o.name.replace(/_\d+$/, "");
      for (const [key, name] of Object.entries(BONE_NAMES)) {
        if (name === base) this.bones[key] = o;
      }
      const f = base.match(/^(index|middle|ring|pinky|thumb)(\d)(_base)?([lr])$/);
      if (f) {
        const side = f[4].toUpperCase();
        (this.fingerBones ??= { L: [], R: [] })[side].push({ bone: o, finger: f[1], seg: +f[2], base: !!f[3] });
      }
    });
    this.object.updateMatrixWorld(true);
  }

  resetPose() {
    for (const [bone, q] of this.rest) bone.quaternion.copy(q);
    this.model.quaternion.identity();
    this.model.position.set(0, 0, 0);
    this.object.updateMatrixWorld(true);
  }

  bonePos(name) {
    return this.bones[name].getWorldPosition(new THREE.Vector3());
  }

  /** Close the hand into a fist around the web (amount 0–1). */
  curlFingers(side, amount) {
    if (!this.fingerBones || amount <= 0) return;
    const hand = this.bones[`hand${side}`];
    const handQ = hand.getWorldQuaternion(new THREE.Quaternion());
    // Curl axis runs across the palm (bone X); sign differs per side.
    const across = new THREE.Vector3(1, 0, 0).applyQuaternion(handQ);
    const sign = side === "L" ? 1 : -1;
    const ordered = [...this.fingerBones[side]].sort((p, q) => p.seg - q.seg || (p.base ? -1 : 1));
    for (const f of ordered) {
      if (f.base) continue;
      const ang = f.finger === "thumb" ? amount * 0.45 : amount * (f.seg === 1 ? 1.25 : 1.35);
      rotateBoneWorld(f.bone, new THREE.Quaternion().setFromAxisAngle(across, sign * ang));
    }
  }

  /**
   * Rest-pose proportions in meters, for 2D planners that must match the
   * model's reach exactly.
   */
  measure() {
    this.resetPose();
    const d = (a, b) => this.bonePos(a).distanceTo(this.bonePos(b));
    const pelvis = this.bonePos("root");
    const shoulderL = this.bonePos("upperArmL");
    const shoulderR = this.bonePos("upperArmR");
    const box = new THREE.Box3().setFromObject(this.model);
    return {
      spine: (shoulderL.y + shoulderR.y) / 2 - pelvis.y,
      shoulder: shoulderL.distanceTo(shoulderR) / 2,
      hip: this.bonePos("thighL").distanceTo(this.bonePos("thighR")) / 2,
      upper: d("upperArmL", "forearmL"),
      fore: d("forearmL", "handL"),
      thigh: d("thighL", "shinL"),
      shin: d("shinL", "footL"),
      headTop: box.max.y - (shoulderL.y + shoulderR.y) / 2,
    };
  }

  /**
   * Pose from a 2D screen-space rig (CSS px, y down), as produced by the
   * behaviour planner. Screen-left limbs (2D "L") drive his right side.
   * rig: {
   *   pelvis, th (up angle), fwd: [x, y, z] chest direction (three.js axes) or yaw,
   *   look, faceCamera (0–1 head turn toward the viewer), footFlat,
   *   limbs: { aL|aR|lL|lR: { M, E, z?, pz? } }, curl: { aL, aR }
   * }
   * z / pz (meters) push a hand/foot target and its elbow/knee bend toward
   * the viewer, giving the flat 2D plan its depth.
   */
  applyRig(rig, pxPerMeter) {
    this.resetPose();
    this.object.position.set(0, 0, 0);
    this.object.rotation.set(0, 0, 0);
    this.object.scale.setScalar(pxPerMeter);
    const toW = (p, z = 0) => new THREE.Vector3(p.x, -p.y, z);

    const up = new THREE.Vector3(Math.sin(rig.th), Math.cos(rig.th), 0);
    const fwd = rig.fwd ? new THREE.Vector3(...rig.fwd) : new THREE.Vector3(0, 0, 1).applyAxisAngle(up, rig.yaw || 0);
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize();
    const side = new THREE.Vector3().crossVectors(up, fwd);
    this.model.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, up, fwd));
    this.object.updateMatrixWorld(true);
    const delta = toW(rig.pelvis).sub(this.bonePos("root")).divideScalar(pxPerMeter);
    this.model.position.add(delta);
    this.object.updateMatrixWorld(true);

    // Turn the head toward the viewer (plus idle glances), split over neck and head.
    const b = this.bones;
    const toCam = Math.atan2(new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 0, 1)).dot(up), fwd.z);
    const turn = THREE.MathUtils.clamp(toCam * (rig.faceCamera ?? 0), -1.2, 1.2) + (rig.look || 0) * 0.35;
    rotateBoneWorld(b.neck, new THREE.Quaternion().setFromAxisAngle(up, turn * 0.35));
    rotateBoneWorld(b.head, new THREE.Quaternion().setFromAxisAngle(up, turn * 0.65));

    if (rig.cling) {
      this.clingLimbs(rig.cling, up, side, pxPerMeter);
    } else {
      const map = { aL: ["upperArmR", "forearmR", "handR"], aR: ["upperArmL", "forearmL", "handL"], lL: ["thighR", "shinR", "footR"], lR: ["thighL", "shinL", "footL"] };
      for (const [k, [u, l, e]] of Object.entries(map)) {
        const limb = rig.limbs[k];
        const z = (limb.z || 0) * pxPerMeter;
        const pz = (limb.pz ?? 0.12) * pxPerMeter;
        solveTwoBone(b[u], b[l], b[e], toW(limb.E, z), toW(limb.M, z + pz));
      }
    }

    // Standing: feet flat, toes along his facing. Elsewhere: toes continue the shin.
    const flatFwd = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (flatFwd.lengthSq() < 1e-6) flatFwd.set(0, 0, 1);
    flatFwd.normalize().add(new THREE.Vector3(0, -0.15, 0));
    // (Clinging feet are oriented in clingLimbs.)
    for (const s of rig.cling ? [] : ["L", "R"]) {
      const shinDir = this.bonePos(`foot${s}`).sub(this.bonePos(`shin${s}`)).normalize();
      const toe = rig.footFlat ? flatFwd : shinDir.multiplyScalar(0.6).add(fwd.clone().multiplyScalar(0.8));
      aimBone(b[`foot${s}`], b[`toes${s}`], toe);
    }
    this.curlFingers("R", rig.curl?.aL ?? 0.25);
    this.curlFingers("L", rig.curl?.aR ?? 0.25);
    this.object.updateMatrixWorld(true);
  }

  /**
   * Clinging to a wall/ceiling, climbing like a ladder (see crawl-refs/):
   * one arm reaching high while the other hand is planted near the chest,
   * one knee drawn up toward the chest while the other leg extends down.
   * A planted hand/foot stays put while the body moves past it, then lifts
   * and reaches ahead; diagonal pairs (left hand + right foot) move together.
   * Limbs are planned in his own body space, so left stays left and nothing
   * tangles, and pinned to the surface plane.
   * cling: { phase (gait cycles), moving, off (pelvis-to-surface, m), normal: [x, y, z] into the surface }
   */
  clingLimbs(cling, up, side, s) {
    const b = this.bones;
    const n = new THREE.Vector3(...cling.normal).normalize();
    const pelvis = this.bonePos("root");
    const onSurface = (p) => p.addScaledVector(n, cling.off * s - p.clone().sub(pelvis).dot(n));
    const STEP = 0.42; // m a planted hand/foot travels along the body per cycle
    const STANCE = 0.75; // share of the cycle a limb stays planted
    const LIFT = 0.08; // m off the surface while a limb reaches ahead
    // Wrists/ankles sit this far off the surface so palms and soles lie flat on it.
    const WRIST_OFF = 0.035;
    const ANKLE_OFF = 0.07;
    const gait = (offset) => {
      let p = (cling.phase + offset) % 1;
      if (p < 0) p += 1;
      if (p < STANCE) return { rel: THREE.MathUtils.lerp(0.5, -0.5, p / STANCE), lift: 0 };
      const t = (p - STANCE) / (1 - STANCE);
      // At rest nothing hangs mid-air: a limb between steps stays on the surface.
      return { rel: THREE.MathUtils.lerp(-0.5, 0.5, t), lift: cling.moving ? Math.sin(Math.PI * t) * LIFT : 0 };
    };
    const limbs = [
      ["upperArmL", "forearmL", "handL", 1, true, 0],
      ["upperArmR", "forearmR", "handR", -1, true, 0.5],
      ["thighL", "shinL", "footL", 1, false, 0.5],
      ["thighR", "shinR", "footR", -1, false, 0],
    ];
    for (const [u, l, e, sgn, arm, offset] of limbs) {
      const root = this.bonePos(u);
      const g = gait(offset);
      // Hands range from chest height to a near-full reach above the head;
      // feet from just below the hip (knee up) to a long step down.
      const target = arm
        ? root.clone().addScaledVector(up, (0.22 + g.rel * STEP) * s).addScaledVector(side, sgn * 0.1 * s)
        : root.clone().addScaledVector(up, (-0.3 + g.rel * STEP) * s).addScaledVector(side, sgn * 0.14 * s);
      onSurface(target).addScaledVector(n, -(g.lift + (arm ? WRIST_OFF : ANKLE_OFF)) * s);
      // Elbows out from the surface and down; knees out, up toward the chest.
      const pole = arm
        ? root.clone().addScaledVector(n, -0.35 * s).addScaledVector(up, -0.15 * s).addScaledVector(side, sgn * 0.2 * s)
        : root.clone().addScaledVector(n, -0.35 * s).addScaledVector(up, 0.45 * s).addScaledVector(side, sgn * 0.2 * s);
      solveTwoBone(b[u], b[l], b[e], target, pole);
      // Palms and soles flat on the surface, fingers/toes pointing along it
      // toward his head and a little outward.
      const along = up.clone().addScaledVector(side, sgn * (arm ? 0.3 : 0.4)).addScaledVector(n, 0.15);
      if (arm) {
        const knuckles = this.fingerBones?.[sgn > 0 ? "L" : "R"].find((f) => f.finger === "middle" && f.base);
        if (knuckles) aimBone(b[e], knuckles.bone, along);
      } else {
        aimBone(b[e], b[sgn > 0 ? "toesL" : "toesR"], along);
      }
    }
  }

  /** Lens opening: 1 normal, 0 shut, >1 wide (surprised). */
  setEyes(open) {
    if (this.eyes) this.eyes.morphTargetInfluences[0] = THREE.MathUtils.clamp(1 - open, -0.6, 1);
  }

  /**
   * His silhouette as capsules in screen px (after applyRig): the overlay
   * takes clicks only inside these, so the desktop stays usable around him.
   */
  outline() {
    const s = this.object.scale.x;
    const P = (v3) => ({ x: v3.x, y: -v3.y });
    const at = (name) => P(this.bonePos(name));
    // The head bone's axis isn't aligned with the skull; use the body's up.
    const bodyUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.model.getWorldQuaternion(new THREE.Quaternion()));
    const headTop = this.bonePos("head").addScaledVector(bodyUp, 0.17 * s);
    const tip = (from, to, k) => {
      const a = this.bonePos(from);
      const b = this.bonePos(to);
      return P(b.add(b.clone().sub(a).multiplyScalar(k)));
    };
    const segs = [
      ["root", "spine3", 0.17],
      ["spine3", "neck", 0.13],
    ].map(([a, b, r]) => ({ a: at(a), b: at(b), r: r * s }));
    segs.push({ a: at("neck"), b: P(headTop), r: 0.13 * s });
    for (const side of ["L", "R"]) {
      segs.push(
        { a: at(`upperArm${side}`), b: at(`forearm${side}`), r: 0.07 * s },
        { a: at(`forearm${side}`), b: at(`hand${side}`), r: 0.06 * s },
        { a: at(`hand${side}`), b: tip(`forearm${side}`, `hand${side}`, 0.75), r: 0.07 * s },
        { a: at(`thigh${side}`), b: at(`shin${side}`), r: 0.1 * s },
        { a: at(`shin${side}`), b: at(`foot${side}`), r: 0.08 * s },
        { a: at(`foot${side}`), b: tip(`foot${side}`, `toes${side}`, 0.6), r: 0.07 * s },
      );
    }
    return segs;
  }
}
