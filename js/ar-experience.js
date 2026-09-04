// ============================================================================
// ar-experience.js — image-tracking AR: the gift appears locked to the
// printed table card (not just placed on the table), using MindAR's image
// tracking running entirely in-browser (no native Quick Look/Scene Viewer
// handoff — that's what makes locking to the *card itself* possible).
//
// Requires an import map in index.html mapping the bare specifier "three" to
// the vendored js/vendor/three/three.module.min.js — see index.html <head>.
// ============================================================================

import * as THREE from "three";
import { GLTFLoader } from "./vendor/three/loaders/GLTFLoader.js";
import { MindARThree } from "./vendor/mindar/mindar-image-three.prod.js";

// Which table's card to track. QR codes encode ?table=<n>; each table has
// its own compiled target file (see scripts/generate-table.mjs).
const params = new URLSearchParams(location.search);
export const tableId = params.get("table") || "1";
const TARGET_SRC = `assets/targets/table-${tableId}.mind`;

// The gift is the default, but the same card can host any model — the drinks
// menu passes a cocktail here so it stands on the customer's table card.
// See startImageTrackingAR({ modelSrc }).
const DEFAULT_MODEL_SRC = "assets/models/gift-placeholder.glb";

// BRAND: idle turntable spin for models that have no baked animation.
// Off — the gift stands still on the card. Models WITH a baked animation
// clip always play it regardless of this setting.
const AUTO_SPIN = false;

// ---------------------------------------------------------------------------
// TRACKING SMOOTHING (One Euro filter)
// ---------------------------------------------------------------------------
// MindAR re-solves the card's pose from scratch every frame, so camera noise
// shows up directly as jitter. These damp it. The trade-off is the classic
// one: more smoothing = steadier model but it lags behind fast movement.
//
//   filterMinCF — lower = more smoothing when the phone is fairly still.
//   filterBeta  — higher = less lag during fast movement.
//
// These are MindAR's defaults, and they are here deliberately rather than by
// omission. We A/B tested alternatives against a synthetic noisy/shaky camera
// feed (scripts/make-shaky-video.mjs), measuring the median second-difference
// of the tracked pose over 2 runs each:
//
//   mincf=0.001   beta=1000  (default)  jitter 16.4   ← best
//   mincf=0.0001  beta=500              jitter 20.7   +26%
//   mincf=0.00001 beta=200              jitter 20.3   +24%
//   mincf=0.001   beta=100              jitter 23.1   +41%
//
// Turning smoothing UP made things worse, not better: over-damping makes the
// filter lag the real motion and then overshoot correcting, which reads as
// more jitter, not less. Don't "improve" these without re-measuring.
//
// Both can still be overridden from the URL for on-site tuning on real
// hardware, where camera noise differs from the synthetic feed:
//   ?mincf=0.0005&beta=800
const FILTER_MIN_CF = Number(params.get("mincf")) || 0.001;
const FILTER_BETA = Number(params.get("beta")) || 1000;

// ---------------------------------------------------------------------------
// TRACKING TOLERANCES — how many consecutive frames before showing / hiding
// ---------------------------------------------------------------------------
// MindAR's defaults are warmupTolerance 5 and missTolerance 5. The miss value
// is the problem in a bar: five missed frames is roughly 165 ms at 30 fps, so
// the moment detection stutters — a hand crossing the card, a dim table, a
// glare highlight — the drink vanishes and snaps back. That pop-in/pop-out
// reads as "glitchy" far more than smooth wobble does.
//
// Raising it makes the drink ride through brief dropouts. The cost is that a
// card genuinely leaving frame takes longer to clear, which matters much less
// than flicker while someone is looking at their table.
//
// Warmup stays low so the drink still appears promptly on first sight.
// Both overridable on real hardware:  ?warmup=5&miss=20
const WARMUP_TOLERANCE = Number(params.get("warmup")) || 5;
const MISS_TOLERANCE = Number(params.get("miss")) || 18;

// ?torch=1 — see tuneCameraTrack below.
const TORCH = params.get("torch") === "1";

// Set ?debug=1 on the URL to record per-frame tracked positions into
// window.__arDebug — used by the jitter test, and handy for diagnosing a
// card that tracks badly in a real venue.
const DEBUG = params.get("debug") === "1";

// Built lazily so the 300 KB decoder is only fetched when a Draco-compressed
// model is actually shown on the card.
let dracoLoaderPromise = null;
function makeDracoLoader() {
  dracoLoaderPromise ??= import("./vendor/three/loaders/DRACOLoader.js").then((m) => {
    const dl = new m.DRACOLoader();
    dl.setDecoderPath("js/vendor/draco/");
    return dl;
  });
  return dracoLoaderPromise;
}

// assets/models/drinks/negroni.glb -> assets/models/drinks/ar/negroni.glb
function arVariantOf(src) {
  const i = src.lastIndexOf("/");
  return i === -1 ? src : `${src.slice(0, i)}/ar${src.slice(i)}`;
}

// ---------------------------------------------------------------------------
// CAMERA TUNING — the constraints MindAR does not ask for
// ---------------------------------------------------------------------------
// MindAR requests only deviceId, facingMode, width and height. Everything else
// is left on automatic, and two of those automatics actively fight tracking:
//
//   Autofocus hunting — the lens searches, frames go soft, feature detection
//   finds nothing in the blurred frames, and the drink drops out. This is a
//   large part of what reads as "glitching" on a table where the phone is
//   moving slightly.
//
//   Auto-exposure — brightness drifts frame to frame, so the same card's
//   features have different contrast each time it is matched.
//
// Where the browser allows it, pinning these makes tracking measurably
// steadier. Support is the catch: Chrome on Android implements most of these
// MediaTrack constraints; iOS Safari implements almost none, and silently
// ignores what it does not support. So this is a best-effort improvement for
// Android and a no-op on iPhone — it cannot make anything worse.
//
// ?torch=1 turns the flashlight on, which in a dim bar is worth more than any
// software tuning: it is the single biggest tracking lever available, because
// it fixes the input rather than the processing. Off by default — a phone
// unexpectedly lighting up is startling, so it stays opt-in.
async function tuneCameraTrack(video) {
  const track = video?.srcObject?.getVideoTracks?.()[0];
  if (!track?.getCapabilities) return null;

  let caps = {};
  try {
    caps = track.getCapabilities() || {};
  } catch {
    return null; // Safari throws rather than returning an empty set
  }

  const advanced = [];
  if (caps.focusMode?.includes("continuous")) advanced.push({ focusMode: "continuous" });
  if (caps.exposureMode?.includes("continuous")) advanced.push({ exposureMode: "continuous" });
  if (caps.whiteBalanceMode?.includes("continuous"))
    advanced.push({ whiteBalanceMode: "continuous" });
  if (TORCH && caps.torch) advanced.push({ torch: true });

  if (advanced.length) {
    try {
      await track.applyConstraints({ advanced });
    } catch {
      // A browser may advertise a capability and still refuse it. Tracking
      // works without this, so a failure here is not worth surfacing.
    }
  }

  // Reported so a venue can see what its actual phones support — with
  // ?debug=1 this is the fastest way to tell whether tuning did anything.
  const applied = {
    supported: Object.keys(caps).filter((k) =>
      ["focusMode", "exposureMode", "whiteBalanceMode", "torch"].includes(k)
    ),
    applied: advanced,
    resolution: `${track.getSettings?.().width ?? "?"}x${track.getSettings?.().height ?? "?"}`,
  };
  if (DEBUG) console.log("[ar] camera", applied);
  return applied;
}

export function isImageTrackingSupported() {
  return Boolean(
    navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia &&
      window.WebGLRenderingContext
  );
}

// container: DOM element MindAR will fill with <video> + render <canvas>.
// modelSrc:  .glb to stand on the card — defaults to the gift.
// onTargetFound / onTargetLost: called as the card enters/leaves view.
// Returns the running MindARThree instance (call .stop() to release the camera).
export async function startImageTrackingAR({
  container,
  modelSrc = DEFAULT_MODEL_SRC,
  onTargetFound,
  onTargetLost,
}) {
  if (DEBUG) window.__arDebug = [];

  const mindarThree = new MindARThree({
    container,
    imageTargetSrc: TARGET_SRC,
    uiLoading: "yes",
    uiScanning: "yes",
    uiError: "no", // we handle failures ourselves and fall back to the 3D preview screen
    filterMinCF: FILTER_MIN_CF,
    filterBeta: FILTER_BETA,
    warmupTolerance: WARMUP_TOLERANCE,
    missTolerance: MISS_TOLERANCE,
  });

  const { renderer, scene, camera } = mindarThree;

  // BRAND: lighting affects how your real model looks once swapped in —
  // tune intensities/positions here, not in the model itself.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4560, 1.4));
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
  keyLight.position.set(0.5, 1, 0.6);
  scene.add(keyLight);

  const anchor = mindarThree.addAnchor(0);

  const loader = new GLTFLoader();
  // Drink models are Draco-compressed by scripts/prep-drink.mjs, so the
  // loader needs a Draco decoder. Vendored, not the CDN default — a bar's
  // guest wifi must not be able to break this. GLTFLoader only reaches for
  // the decoder when a file actually uses the extension, so the uncompressed
  // gift model costs nothing here.
  loader.setDRACOLoader(await makeDracoLoader());

  // ---- Stand the model UP on the card ------------------------------------
  // MindAR's anchor space treats the card as the XY plane, with +Z pointing
  // straight OUT of the printed surface. glTF models are authored Y-up, so
  // dropping one in unrotated lays it flat *in* the card's plane (it looks
  // like it's lying face-down on the card). Rotating +90° about X maps the
  // model's Y-up onto the card's +Z, so it stands perpendicular — upright
  // when the card is flat on a table.
  const standGroup = new THREE.Group(); // spins the model about the card's normal
  anchor.group.add(standGroup);

  // BRAND: which way the model faces, as a spin around the card's normal.
  // 180° makes it face the bottom edge of the card — i.e. toward whoever is
  // reading it. Change to 0 to face the top edge.
  standGroup.rotation.z = Math.PI;

  // BRAND: size on the card. The card is 1 unit WIDE in anchor space, so this
  // is expressed in card-widths — any model drops in sensibly without
  // re-tuning numbers.
  const TARGET_HEIGHT = 0.55;

  let mixer = null;
  let currentModel = null;
  let swapToken = 0;

  // ---------------------------------------------------------------------
  // MODEL CACHE — every drink resident, one visible
  // ---------------------------------------------------------------------
  // Swapping used to mean download, Draco-decode, fit, then dispose the old
  // one. That is a visible hitch on every swipe and it re-decodes the same
  // drink each time a customer swipes back past it.
  //
  // Instead each drink is fitted once and kept in the scene graph with
  // .visible = false. A swipe becomes two boolean flips, which is instant and
  // allocates nothing.
  //
  // The cost is GPU memory, which is exactly why card AR uses the light
  // drinks/ar/ builds: six of those is roughly 276 k triangles and ~4.8 MP of
  // texture in total, less than ONE full-detail model would have been.
  const cache = new Map();

  // Swap the model standing on the card WITHOUT tearing down the MindAR
  // session. Restarting would drop the camera stream and re-run tracking
  // acquisition — on a phone that's a visible stall and, on iOS, sometimes a
  // permission re-prompt. Keeping one session alive is what makes swiping
  // between drinks in AR feel instant.
  // Load, fit and park a drink in the scene graph, hidden. Returns the cached
  // object on any later call, so this is cheap to call speculatively.
  async function ensureModel(src) {
    if (cache.has(src)) return cache.get(src);

    // Prefer the lighter card-AR build. MindAR is decoding a camera feed and
    // re-solving the card's pose every frame, so renderer time is taken
    // directly out of tracking; the full model costs ~3x the triangles and
    // ~4x the texture memory for detail invisible at a few centimetres.
    // Falls back to the full model if no AR variant has been generated.
    let gltf;
    try {
      gltf = await loader.loadAsync(arVariantOf(src));
    } catch {
      gltf = await loader.loadAsync(src);
    }

    // A concurrent call for the same src may have finished first.
    if (cache.has(src)) return cache.get(src);

    const model = gltf.scene;
    model.rotation.x = Math.PI / 2;

    // ---- Auto-fit: size + seat it on the card ----------------------------
    // MEASURE BEFORE PARENTING. Box3.setFromObject returns WORLD-space bounds,
    // so measuring after standGroup.add() folds in every ancestor transform —
    // standGroup's 180° spin and, far worse, anchor.group's live tracking
    // matrix. At first load that is harmless because MindAR has not started
    // and the anchor is still identity; on a swipe mid-session it is not.
    // `fitted.min.z` becomes a camera-relative depth, and subtracting it
    // throws the drink off the card by whatever the pose happened to be at
    // the instant the swipe landed — a different wrong answer every time.
    //
    // While the model is detached its world matrix IS its local matrix, so
    // these numbers are stable, repeatable, and in the space the offsets
    // below are actually applied in.
    model.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    // After the X rotation the model's height runs along Z. Guard against a
    // zero/degenerate axis so a malformed model can't produce Infinity.
    if (size.z > 1e-6) model.scale.setScalar(TARGET_HEIGHT / size.z);

    // Re-measure post-scale, then centre it on the card and drop its base to
    // z=0 so it stands ON the surface rather than floating or sunk into it.
    model.updateMatrixWorld(true);
    const fitted = new THREE.Box3().setFromObject(model);
    const c = fitted.getCenter(new THREE.Vector3());
    model.position.x -= c.x;
    model.position.y -= c.y;
    model.position.z -= fitted.min.z;

    // Only now does it join the tracked graph — hidden until selected.
    model.visible = false;
    standGroup.add(model);

    const entry = { model, animations: gltf.animations ?? [] };
    cache.set(src, entry);
    return entry;
  }

  // Show one drink and hide the rest. Instant once cached.
  async function setModel(src) {
    // Guard against a customer swiping faster than the models load: only the
    // most recent request may install itself.
    const token = ++swapToken;
    const entry = await ensureModel(src);
    if (token !== swapToken) return; // superseded by a later swipe

    if (currentModel && currentModel !== entry.model) {
      // Stop any running clip before hiding, so an animation cannot keep
      // burning frame time on a drink nobody can see.
      mixer?.stopAllAction();
      currentModel.visible = false;
    }
    mixer = null;

    entry.model.visible = true;
    currentModel = entry.model;

    if (entry.animations.length) {
      mixer = new THREE.AnimationMixer(entry.model);
      mixer.clipAction(entry.animations[0]).play();
    }
  }

  // Warm the cache in the background so later swipes are instant. Sequential
  // and deliberately after the first drink is already on screen: a bar's wifi
  // should spend its first bytes on what the customer is looking at, not on
  // five drinks they have not swiped to yet.
  async function preload(srcs) {
    for (const src of srcs) {
      try {
        await ensureModel(src);
      } catch {
        // A drink with no model yet simply stays uncached; setModel will
        // surface the failure if the customer actually swipes to it.
      }
    }
  }

  await setModel(modelSrc);

  let targetVisible = false;
  anchor.onTargetFound = () => {
    targetVisible = true;
    onTargetFound?.();
  };
  anchor.onTargetLost = () => {
    targetVisible = false;
    onTargetLost?.();
  };

  await mindarThree.start();

  // Only possible once the stream exists.
  await tuneCameraTrack(mindarThree.video);

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();
    if (mixer) mixer.update(delta);
    // BRAND: set AUTO_SPIN to true to make a model with no baked animation
    // slowly turn on the spot. Off by default — a still model reads as
    // deliberately placed rather than "a demo that spins".
    // Note this spins about the CARD'S normal (standGroup's Z), not the
    // model's own Y — the model is rotated 90° to stand up, so spinning its
    // local Y would tumble it end-over-end instead of turning in place.
    if (AUTO_SPIN && !mixer) standGroup.rotation.z += delta * 0.6;

    // Debug sampling: record the tracked pose so jitter can be measured.
    // Only active with ?debug=1 — no cost for real customers.
    if (DEBUG && anchor.group.visible) {
      const m = anchor.group.matrixWorld.elements;
      window.__arDebug.push({ x: m[12], y: m[13], z: m[14] });
    }

    renderer.render(scene, camera);
  });

  // Expose setModel so the caller can swipe between drinks without the
  // camera ever stopping. stop() is forwarded rather than inherited so the
  // caller keeps the same {stop} shape it already used for the gift.
  return {
    stop: () => mindarThree.stop(),
    setModel,
    preload,
  };
}
