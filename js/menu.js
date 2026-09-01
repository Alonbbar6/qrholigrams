// ============================================================================
// menu.js — the swipeable 3D cocktail browser.
//
// WHY THIS USES A DIFFERENT AR STACK THAN THE GIFT
// ------------------------------------------------
// The gift has to appear locked to the printed card, which only in-browser
// image tracking (MindAR) can do — see README "The AR approach". Drinks have
// no such requirement: the customer just wants the glass on their table. That
// frees us to hand off to the phone's NATIVE AR (iOS Quick Look / Android
// Scene Viewer) via <model-viewer>, which tracks with ARKit/ARCore SLAM
// instead of re-solving a marker pose from camera pixels every frame.
//
// That matters here specifically because this is a BAR. README's own table
// rates native AR "Very robust" in low light against image tracking's "More
// sensitive" — dim rooms are exactly where per-frame image tracking wobbles.
// Swiping stays smooth in any lighting because it's just a 3D view; only the
// "View on your table" step enters AR, and that step is rock steady.
//
// The trade: native AR is a full-screen OS handoff, so a customer cannot
// swipe between drinks while inside it. Swipe here, then AR one drink.
// ============================================================================

import { DRINKS, modelPathFor, iosModelPathFor } from "./drinks.js";

// ---------------------------------------------------------------------------
// DRACO DECODER — must be vendored, same as everything else
// ---------------------------------------------------------------------------
// Drink models are Draco-compressed (scripts/prep-drink.mjs), which cuts a
// 76 MB Meshy export to under 1 MB. The catch: <model-viewer> fetches the
// Draco decoder at RUNTIME, and its built-in default points at
// https://www.gstatic.com/draco/versioned/decoders/1.5.6/.
//
// That would quietly undo the reason model-viewer is vendored at all — on a
// captive-portal guest wifi the decoder request hangs, no `load` or `error`
// event ever fires, and every drink falls through to "3D preview coming soon"
// despite the model being present and fine. Point it at our own copy.
customElements.whenDefined("model-viewer").then(() => {
  const MV = customElements.get("model-viewer");
  if (MV) MV.dracoDecoderLocation = "js/vendor/draco/";
});

// One <model-viewer> instance, reused as the customer swipes. Six live
// viewers would mean six WebGL contexts and six model downloads on a phone;
// browsers cap concurrent contexts and silently drop the oldest, which shows
// up as randomly blank drinks.
let viewer = null;
let listEl = null;
let menuScreen = null;
let drinkScreen = null;
let dotsEl = null;
let currentIndex = 0;
let onExit = null;
let onShowOnCard = null;
let track = () => {};

const currentDrink = () => DRINKS[currentIndex];

// ---------------------------------------------------------------------------
// LIST SCREEN
// ---------------------------------------------------------------------------
function buildList() {
  listEl.innerHTML = "";

  DRINKS.forEach((drink, i) => {
    const li = document.createElement("li");
    li.className = "drink-row";

    const btn = document.createElement("button");
    btn.className = "drink-row-btn";
    btn.type = "button";
    // The whole row is the tap target — a 44px+ hit area matters more than
    // usual here, since people tap this in a dark room, one-handed, holding
    // a drink in the other.
    btn.innerHTML = `
      <span class="drink-row-emoji" aria-hidden="true">${drink.emoji}</span>
      <span class="drink-row-text">
        <span class="drink-row-name">${drink.name}</span>
        <span class="drink-row-tagline">${drink.tagline}</span>
      </span>
      <span class="drink-row-price">${drink.price}</span>
    `;
    btn.addEventListener("click", () => openDrinkAt(i));

    li.appendChild(btn);
    listEl.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// DOTS — position indicator
// ---------------------------------------------------------------------------
// Without this a swipe has no feedback: the drink changes but there's no
// sense of "3 of 6", so people don't discover that swiping keeps going.
function buildDots() {
  dotsEl.innerHTML = "";
  DRINKS.forEach((drink, i) => {
    const dot = document.createElement("button");
    dot.className = "drink-dot";
    dot.type = "button";
    dot.setAttribute("aria-label", `Show ${drink.name}`);
    dot.addEventListener("click", () => openDrinkAt(i));
    dotsEl.appendChild(dot);
  });
}

function syncDots() {
  [...dotsEl.children].forEach((dot, i) => {
    dot.classList.toggle("drink-dot--active", i === currentIndex);
    dot.setAttribute("aria-current", i === currentIndex ? "true" : "false");
  });
}

// ---------------------------------------------------------------------------
// DETAIL SCREEN
// ---------------------------------------------------------------------------
// direction: -1 (came from the right), +1 (from the left), 0 (no animation).
function openDrinkAt(index, direction = 0) {
  // Wrap around, so swiping never dead-ends on the first or last drink.
  currentIndex = (index + DRINKS.length) % DRINKS.length;
  const drink = currentDrink();

  document.getElementById("drink-name").textContent = drink.name;
  document.getElementById("drink-tagline").textContent = drink.tagline;
  document.getElementById("drink-price").textContent = drink.price;

  // Tint the stage with the drink's own colour. Cheap, but it's most of what
  // sells the preview before the model has even downloaded.
  drinkScreen.style.setProperty("--drink-accent", drink.accent);

  // Reset before swapping src — otherwise the previous drink lingers while
  // the new one downloads, which reads as the swipe not having registered.
  setModelState("loading");
  startLoadTimer();
  document.getElementById("drink-ar-btn").hidden = true;
  document.getElementById("drink-card-btn").hidden = true;

  const iosSrc = iosModelPathFor(drink);
  if (iosSrc) viewer.setAttribute("ios-src", iosSrc);
  else viewer.removeAttribute("ios-src"); // model-viewer generates USDZ itself
  viewer.setAttribute("alt", `A 3D model of ${drink.name}`);

  syncDots();
  if (direction) animateIn(direction);

  // Reveal the screen BEFORE assigning src. <model-viewer> gates the final
  // stage of loading on an IntersectionObserver, so a src set while the
  // screen is still `display:none` downloads the file, reaches 88% progress,
  // and then waits forever for a visibility that already happened. The
  // symptom is indistinguishable from a missing model — verified on real
  // hardware, not just headless. `loading="eager"` in index.html covers the
  // same ground; both are here because this failure is silent and expensive.
  showScreen(drinkScreen);
  viewer.setAttribute("src", modelPathFor(drink));
}

// A short slide, purely so the swipe feels like it moved something. Uses a
// class the CSS animates, restarted by forcing a reflow — without that,
// re-adding the same class on consecutive swipes won't replay the animation.
function animateIn(direction) {
  const el = document.querySelector(".drink-inner");
  el.classList.remove("drink-inner--from-left", "drink-inner--from-right");
  void el.offsetWidth;
  el.classList.add(direction > 0 ? "drink-inner--from-right" : "drink-inner--from-left");
}

function next() {
  track("drink_swiped", { to: DRINKS[(currentIndex + 1) % DRINKS.length].id });
  openDrinkAt(currentIndex + 1, 1);
}
function prev() {
  track("drink_swiped", { to: DRINKS[(currentIndex - 1 + DRINKS.length) % DRINKS.length].id });
  openDrinkAt(currentIndex - 1, -1);
}

// Three visual states for the model area: loading, ready, or no-model-yet.
// Driven by a data attribute so all the styling stays in CSS.
function setModelState(state) {
  drinkScreen.dataset.modelState = state;
  if (state === "missing") {
    document.getElementById("drink-missing-emoji").textContent =
      currentDrink()?.emoji ?? "🍸";
  }
}

// STALL timeout on "loading" — deliberately not a total-time deadline.
//
// <model-viewer> only fires load/error once the custom element has upgraded.
// If its script never runs — stalled download, captive portal, an extension
// blocking it — no event ever arrives and the screen sits blank forever with
// no explanation. A bar's guest wifi makes that real, not theoretical.
//
// The subtlety: a fixed deadline punishes big models on slow connections.
// A flat 10s cut off a perfectly healthy 862 KB Draco drink mid-decode and
// showed "coming soon" for a model that was seconds from appearing — the
// worst kind of bug, because it looks like missing art rather than a timer.
//
// So the timer measures SILENCE, not elapsed time: every `progress` event
// restarts it. A slow download keeps ticking along happily; only a genuinely
// dead load — no bytes, no progress, for STALL_TIMEOUT_MS — gives up.
const STALL_TIMEOUT_MS = 12000;
let loadTimer = null;

function startLoadTimer() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    if (drinkScreen.dataset.modelState === "loading") onModelError();
  }, STALL_TIMEOUT_MS);
}

function onModelLoad() {
  clearTimeout(loadTimer);
  setModelState("ready");
  // The AR button only means something where the device can actually enter
  // AR — desktop browsers and older phones can't. model-viewer resolves this
  // asynchronously, so read it after load rather than up front.
  document.getElementById("drink-ar-btn").hidden = !viewer.canActivateAR;
  // The card button needs a camera and WebGL, not native AR — a wider set of
  // devices. It also needs the model to exist, which `ready` just proved.
  document.getElementById("drink-card-btn").hidden = !cardArAvailable();
}

function onModelError() {
  // Usually "this drink has no .glb yet" rather than a fault — drinks.js is
  // written so the menu can be filled in before the art exists.
  clearTimeout(loadTimer);
  setModelState("missing");
  document.getElementById("drink-ar-btn").hidden = true;
  // No model means nothing to stand on the card either.
  document.getElementById("drink-card-btn").hidden = true;
}

// Card AR needs a camera and WebGL. Mirrors isImageTrackingSupported() in
// ar-experience.js rather than importing it, so the menu stays independent
// of the gift's module.
function cardArAvailable() {
  return Boolean(
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.WebGLRenderingContext
  );
}

// ---------------------------------------------------------------------------
// SWIPE
// ---------------------------------------------------------------------------
// Pointer events cover touch, pen and mouse-drag in one path.
//
// Note <model-viewer> deliberately does NOT have camera-controls here. With
// orbit enabled it swallows horizontal drags to spin the model, and swipe
// would only work off-model — a confusing dead zone in the middle of the
// screen. For a menu carousel, swipe is the primary gesture; customers who
// want to inspect a drink from every angle can use "View on your table".
const SWIPE_MIN_PX = 45; // shorter than this is a tap, not a swipe
const SWIPE_MAX_OFF_AXIS = 0.6; // |dy| / |dx| above this is a scroll, not a swipe

function attachSwipe(el) {
  let startX = 0;
  let startY = 0;
  let tracking = false;

  el.addEventListener(
    "pointerdown",
    (e) => {
      tracking = true;
      startX = e.clientX;
      startY = e.clientY;
    },
    { passive: true }
  );

  el.addEventListener(
    "pointerup",
    (e) => {
      if (!tracking) return;
      tracking = false;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) < SWIPE_MIN_PX) return;
      if (Math.abs(dy) / Math.abs(dx) > SWIPE_MAX_OFF_AXIS) return;
      dx < 0 ? next() : prev();
    },
    { passive: true }
  );

  // A pointer leaving the element mid-drag would otherwise leave `tracking`
  // stuck on, so the next unrelated pointerup would count as a swipe.
  el.addEventListener("pointercancel", () => (tracking = false), { passive: true });
  el.addEventListener("pointerleave", () => (tracking = false), { passive: true });
}

// ---------------------------------------------------------------------------
// SCREEN PLUMBING
// ---------------------------------------------------------------------------
function showScreen(screen) {
  [menuScreen, drinkScreen].forEach((s) => {
    s.classList.toggle("screen--hidden", s !== screen);
  });
}

function hideAll() {
  [menuScreen, drinkScreen].forEach((s) => s.classList.add("screen--hidden"));
  // Release the decoded model and its textures. This matters most right
  // before card AR starts: MindAR opens its own WebGL context, and leaving
  // a drink resident in this one is how a mid-range phone runs out of GPU
  // memory partway through a session.
  clearTimeout(loadTimer);
  viewer?.removeAttribute("src");
}

// ---------------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------------
export function initDrinksMenu({ onExitToIntro, onShowDrinkOnCard, trackEvent = () => {} } = {}) {
  onExit = onExitToIntro;
  onShowOnCard = onShowDrinkOnCard;
  track = trackEvent;

  menuScreen = document.getElementById("menu-screen");
  drinkScreen = document.getElementById("drink-screen");
  listEl = document.getElementById("drink-list");
  dotsEl = document.getElementById("drink-dots");
  viewer = document.getElementById("drink-viewer");

  buildList();
  buildDots();

  viewer.addEventListener("load", onModelLoad);
  viewer.addEventListener("error", onModelError);

  // Forward progress means the network and decoder are alive — restart the
  // stall timer so a large model on a slow connection is never cut off.
  viewer.addEventListener("progress", () => {
    if (drinkScreen.dataset.modelState === "loading") startLoadTimer();
  });

  attachSwipe(drinkScreen);
  document.getElementById("drink-prev").addEventListener("click", prev);
  document.getElementById("drink-next").addEventListener("click", next);

  // Arrow keys, so the carousel is usable (and testable) without a touchscreen.
  window.addEventListener("keydown", (e) => {
    if (drinkScreen.classList.contains("screen--hidden")) return;
    if (e.key === "ArrowRight") next();
    if (e.key === "ArrowLeft") prev();
  });

  document.getElementById("drink-ar-btn").addEventListener("click", () => {
    track("drink_ar_opened", { drink: currentDrink()?.id });
    // Must be called from a user gesture — Quick Look and Scene Viewer both
    // refuse to launch otherwise.
    viewer.activateAR();
  });

  document.getElementById("drink-card-btn").addEventListener("click", () => {
    const drink = currentDrink();
    track("drink_card_ar_opened", { drink: drink.id });
    // Hand the model path up to main.js, which owns the MindAR session and
    // the camera lifecycle.
    onShowOnCard?.(drink, modelPathFor(drink));
  });

  document.getElementById("drink-back-btn").addEventListener("click", () => {
    clearTimeout(loadTimer);
    // Drop the model when leaving. Without this the GPU holds the last
    // drink's textures for the life of the page, which adds up over a
    // browsing session on a mid-range phone.
    viewer.removeAttribute("src");
    showScreen(menuScreen);
  });

  document.getElementById("menu-back-btn").addEventListener("click", () => {
    hideAll();
    onExit?.();
  });

  return {
    // The list of all drinks.
    openList() {
      track("menu_opened", {});
      showScreen(menuScreen);
    },
    // Straight into the swipeable carousel — this is what a QR scan lands on.
    openCarousel(index = 0) {
      track("carousel_opened", { drink: DRINKS[index]?.id });
      openDrinkAt(index);
    },
    close: hideAll,
  };
}
