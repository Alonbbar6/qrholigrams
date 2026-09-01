// ============================================================================
// main.js — screen flow, image-tracking AR lifecycle, and fallback handling.
// Plain ES module, no build step required.
// ============================================================================

import confetti from "./vendor/confetti.js";
import { isImageTrackingSupported, startImageTrackingAR, tableId } from "./ar-experience.js";
import { initDrinksMenu } from "./menu.js";
import { DRINKS } from "./drinks.js";

// ---------------------------------------------------------------------------
// ANALYTICS HOOK
// ---------------------------------------------------------------------------
// A QR code scan itself can't be measured by this page (the scan happens
// in the phone's camera app, before any page ever loads). What you CAN
// measure from here is page views and how far each visitor gets through the
// flow — a solid proxy for "how many people scanned and engaged."
//
// Wire this up to whatever you use, e.g.:
//   - Google Analytics 4:  gtag('event', name, detail)
//   - Plausible:           window.plausible?.(name, { props: detail })
//   - Your own endpoint:   fetch('/api/track', { method: 'POST', body: ... })
//
// BRAND: this is the one function to edit to turn on real analytics.
function trackEvent(name, detail = {}) {
  console.log(`[analytics] ${name}`, detail);
  // Example wiring (uncomment and adapt):
  // window.gtag?.('event', name, detail);
}

trackEvent("page_view", { path: location.pathname, table: tableId });

// ---------------------------------------------------------------------------
// ELEMENT REFS
// ---------------------------------------------------------------------------
const introScreen = document.getElementById("intro");
const arScreen = document.getElementById("ar-screen");
const fallbackScreen = document.getElementById("fallback-screen");

const revealBtn = document.getElementById("reveal-btn");
const backBtn = document.getElementById("back-btn");
const arContainer = document.getElementById("ar-container");
const arInstructions = document.getElementById("ar-instructions");

const confettiCanvas = document.getElementById("confetti-canvas");
const confettiBurst = confetti.create(confettiCanvas, {
  resize: true,
  useWorker: true,
});

// Holds the running MindARThree session so Back can release the camera.
let activeSession = null;

// The drinks menu owns its own two screens (list + detail). main.js only
// needs to be able to close them, so that showing one of ITS screens can't
// leave a menu screen stacked underneath.
let drinksMenu = null;

function showScreen(screen) {
  drinksMenu?.close();
  [introScreen, arScreen, fallbackScreen].forEach((s) => {
    s.classList.toggle("screen--hidden", s !== screen);
  });
}

function hideMainScreens() {
  [introScreen, arScreen, fallbackScreen].forEach((s) =>
    s.classList.add("screen--hidden")
  );
}

function fireConfetti(opts = {}) {
  const colors = ["#ff6fae", "#ffd76f", "#6fe3ff"];
  confettiBurst({
    particleCount: 120,
    spread: 80,
    startVelocity: 45,
    origin: { y: 0.6 },
    colors,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// SCREEN FLOW
// ---------------------------------------------------------------------------
// One card-AR launcher, shared by the gift and by any drink. `modelSrc`
// undefined means the gift (ar-experience.js supplies its own default).
// `label` is only used for analytics and the on-screen prompt.
async function startCardAR({ modelSrc, label, hint } = {}) {
  if (!isImageTrackingSupported()) {
    goToFallback();
    return;
  }

  // Leaving the menu's <model-viewer> holding a decoded model while MindAR
  // spins up a second WebGL context is how phones run out of GPU memory
  // mid-session. The menu drops its model when its screen is hidden.
  drinksMenu?.close();

  showScreen(arScreen);
  arInstructions.textContent = hint ?? "Point your camera at the card on your table 🔍";
  arInstructions.classList.remove("ar-instructions--hidden");
  arContainer.innerHTML = ""; // clear any previous session's video/canvas

  try {
    activeSession = await startImageTrackingAR({
      container: arContainer,
      modelSrc,
      onTargetFound: () => {
        trackEvent("ar_target_found", { table: tableId, subject: label });
        arInstructions.classList.add("ar-instructions--hidden");
        fireConfetti({ origin: { y: 0.4 }, particleCount: 90, spread: 100 });
      },
      onTargetLost: () => {
        trackEvent("ar_target_lost", { table: tableId, subject: label });
        arInstructions.classList.remove("ar-instructions--hidden");
      },
    });
    trackEvent("ar_session_started", { table: tableId, subject: label });
  } catch (err) {
    // Most commonly: camera permission denied, or no camera available.
    trackEvent("ar_session_failed", { table: tableId, subject: label, reason: err?.message });
    stopActiveSession();
    goToFallback("We couldn't access your camera — enjoy the 3D preview instead!");
  }
}

revealBtn.addEventListener("click", () => {
  trackEvent("gift_reveal_tapped", { table: tableId });
  fireConfetti();
  startCardAR({ label: "gift" });
});

// Where ← Back returns to from the card-AR screen: the gift came from the
// intro, a drink came from the carousel.
let arReturnsToCarousel = false;

backBtn.addEventListener("click", () => {
  stopActiveSession();
  if (arReturnsToCarousel) openCarousel(lastCardDrinkIndex);
  else showScreen(introScreen);
});

let lastCardDrinkIndex = 0;

// ---------------------------------------------------------------------------
// DRINKS MENU
// ---------------------------------------------------------------------------
drinksMenu = initDrinksMenu({
  onExitToIntro: () => showScreen(introScreen),
  // "See it on your card" — stand THIS drink on the printed table card,
  // using the same image tracking as the gift.
  onShowDrinkOnCard: (drink, modelSrc) => {
    arReturnsToCarousel = true;
    lastCardDrinkIndex = DRINKS.findIndex((d) => d.id === drink.id);
    startCardAR({
      modelSrc,
      label: drink.id,
      hint: `Point your camera at the card to see the ${drink.name} 🍸`,
    });
  },
  trackEvent,
});

function openMenu() {
  arReturnsToCarousel = false;
  // Release the camera first — browsing the menu with a live camera stream
  // running behind it drains battery and, on iOS, can leave the AR session
  // in a state where re-entering it fails.
  stopActiveSession();
  hideMainScreens();
  drinksMenu.openList();
}

function openCarousel(index = 0) {
  arReturnsToCarousel = false;
  stopActiveSession();
  hideMainScreens();
  drinksMenu.openCarousel(index);
}

document.getElementById("menu-btn").addEventListener("click", openMenu);

// ---------------------------------------------------------------------------
// LANDING SCREEN
// ---------------------------------------------------------------------------
// Scanning a table card lands on the swipeable drinks carousel — that is the
// thing customers came for, and it works in any lighting. The gift reveal is
// still one tap away from the carousel's Menu screen.
//
//   (no param)  -> carousel        the QR-scan default
//   ?menu=1     -> the drinks list
//   ?gift=1     -> straight to the gift intro, skipping the menu
//
// Table cards encode /?table=N, which carries no menu/gift flag, so an
// already-printed card lands on the carousel without being reprinted.
const landing = new URLSearchParams(location.search);
if (landing.get("gift") === "1") {
  showScreen(introScreen);
} else if (landing.get("menu") === "1") {
  openMenu();
} else {
  openCarousel();
}

function stopActiveSession() {
  if (activeSession) {
    try {
      activeSession.stop();
    } catch {
      // session may already be torn down; nothing to do
    }
    activeSession = null;
  }
  arContainer.innerHTML = "";
}

function goToFallback(reason) {
  if (reason) {
    document.getElementById("fallback-reason").textContent = reason;
  }
  showScreen(fallbackScreen);
  trackEvent("fallback_shown", { table: tableId, reason: reason || "unsupported" });
}
