// ============================================================================
// webxr-experience.js — the mode that does both.
//
// Card AR (MindAR) can swap drinks in place, because the scene belongs to us,
// but it re-solves the card's pose from camera pixels every frame and wobbles
// in a dim room. Native AR (Quick Look / Scene Viewer) is rock steady, because
// ARKit/ARCore fuse the camera with motion sensors, but it is a FILE HANDOFF:
// the page is backgrounded and there is no live scene to change.
//
// WebXR is the only API that gives both at once. The session runs in OUR
// renderer — so a swipe is just a scene-graph swap, exactly like card AR —
// while the poses come from the platform's own tracker, the same one native AR
// uses. Place once, then change drinks without ever re-placing.
//
// THE CATCH, stated plainly: iPhone Safari does not implement the WebXR Device
// API, and Apple has committed to no timeline. This mode is Android Chrome (and
// other WebXR browsers) only, which is why it is offered as an extra option
// rather than made the default — see menu.js for the fallback chain.
// ============================================================================

import * as THREE from "three";
import { GLTFLoader } from "./vendor/three/loaders/GLTFLoader.js";
import { DRACOLoader } from "./vendor/three/loaders/DRACOLoader.js";

// Reported to the UI so a device that cannot do this never advertises it.
export async function isWebXRSupported() {
  try {
    return Boolean(await navigator.xr?.isSessionSupported?.("immersive-ar"));
  } catch {
    return false;
  }
}

let dracoLoaderPromise = null;
function makeDracoLoader() {
  dracoLoaderPromise ??= Promise.resolve().then(() => {
    const dl = new DRACOLoader();
    // Vendored, like everything else — a bar's guest wifi must not be able to
    // break this. See the CDN warning in README section 2.
    dl.setDecoderPath("js/vendor/draco/");
    return dl;
  });
  return dracoLoaderPromise;
}

// overlayRoot: element shown over the AR view via the dom-overlay feature.
//   That feature is what makes this mode worth building — it lets the drink
//   name, price, dots and swipe handling live in ordinary HTML on top of the
//   camera, which is impossible in a native AR handoff.
// onPlaced / onExit: lifecycle for the caller's UI.
export async function startWebXR({ overlayRoot, modelSrc, onPlaced, onExit }) {
  const session = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["hit-test"],
    // Never REQUIRE dom-overlay: a browser that supports immersive-ar without
    // it would fail the whole session rather than degrade.
    optionalFeatures: ["dom-overlay", "local-floor"],
    domOverlay: { root: overlayRoot },
  });

  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: false,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.xr.enabled = true;
  await renderer.xr.setSession(session);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(); // WebXR drives this itself

  scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4560, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(0.5, 1, 0.6);
  scene.add(key);

  // Reticle: the ring showing where a tap would drop the drink. Rotated flat
  // because RingGeometry is built in the XY plane and hit-test poses are
  // horizontal surfaces.
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.05, 0.06, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xff6fae, transparent: true, opacity: 0.9 })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // The anchor group. Once placed, its matrix never changes again — the
  // platform's tracker moves the CAMERA around it, which is precisely why
  // this does not drift the way marker tracking does.
  const anchorGroup = new THREE.Group();
  anchorGroup.matrixAutoUpdate = false;
  anchorGroup.visible = false;
  scene.add(anchorGroup);

  const loader = new GLTFLoader();
  loader.setDRACOLoader(await makeDracoLoader());

  let currentModel = null;
  let swapToken = 0;
  let placed = false;

  // Every drink lives in the anchor group at once, all hidden but one, so a
  // swipe is a visibility flip rather than a download and decode. Same
  // approach as card AR — see the MODEL CACHE note in ar-experience.js.
  const cache = new Map();

  async function ensureModel(src) {
    if (cache.has(src)) return cache.get(src);
    let gltf;
    try {
      gltf = await loader.loadAsync(arVariantOf(src));
    } catch {
      gltf = await loader.loadAsync(src);
    }
    if (cache.has(src)) return cache.get(src); // a concurrent call won
    // Models are already authored at real-world metres by prep-drink.mjs, and
    // WebXR is metric, so no scaling — a 0.09 m glass is 9 cm on the table.
    const model = gltf.scene;
    model.visible = false;
    anchorGroup.add(model);
    cache.set(src, model);
    return model;
  }

  // Swap the drink without touching the anchor. This is the whole point of
  // the mode: the pose stays exactly where the customer put it.
  async function setModel(src) {
    const token = ++swapToken;
    const model = await ensureModel(src);
    if (token !== swapToken) return; // superseded by a faster swipe
    if (currentModel && currentModel !== model) currentModel.visible = false;
    model.visible = true;
    currentModel = model;
  }

  // Warm the rest of the menu once the customer has placed their first drink.
  async function preload(srcs) {
    for (const src of srcs) {
      try { await ensureModel(src); } catch { /* no model yet for this drink */ }
    }
  }

  await setModel(modelSrc);

  const viewerSpace = await session.requestReferenceSpace("viewer");
  const hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

  session.addEventListener("select", () => {
    // First tap places it. Later taps are ignored: re-placing on every stray
    // tap is how a customer loses the drink they carefully positioned.
    if (placed || !reticle.visible) return;
    anchorGroup.matrix.copy(reticle.matrix);
    anchorGroup.visible = true;
    reticle.visible = false;
    placed = true;
    onPlaced?.();
  });

  session.addEventListener("end", () => {
    renderer.setAnimationLoop(null);
    // Every cached drink, not just the visible one.
    for (const model of cache.values()) disposeTree(model);
    cache.clear();
    renderer.dispose();
    onExit?.();
  });

  renderer.setAnimationLoop((_, frame) => {
    if (!placed && frame) {
      const refSpace = renderer.xr.getReferenceSpace();
      const hits = frame.getHitTestResults(hitTestSource);
      if (hits.length && refSpace) {
        const pose = hits[0].getPose(refSpace);
        if (pose) {
          reticle.visible = true;
          reticle.matrix.fromArray(pose.transform.matrix);
        }
      } else {
        reticle.visible = false;
      }
    }
    renderer.render(scene, camera);
  });

  return {
    setModel,
    preload,
    isPlaced: () => placed,
    end: () => session.end().catch(() => {}),
  };
}

// assets/models/drinks/negroni.glb -> assets/models/drinks/ar/negroni.glb
// The light build again: a WebXR session renders the camera feed, runs the
// platform tracker and draws the drink on one frame budget.
function arVariantOf(src) {
  const i = src.lastIndexOf("/");
  return i === -1 ? src : `${src.slice(0, i)}/ar${src.slice(i)}`;
}

function disposeTree(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap"]) {
        m[k]?.dispose();
      }
      m.dispose();
    }
  });
}
