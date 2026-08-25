// ============================================================================
// main.js — screen flow, image-tracking AR lifecycle, and fallback handling.
// Plain ES module, no build step required.
// ============================================================================

import confetti from "./vendor/confetti.js";
import { isImageTrackingSupported, startImageTrackingAR, tableId } from "./ar-experience.js";
import { initDrinksMenu } from "./menu.js";

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
revealBtn.addEventListener("click", async () => {
  trackEvent("gift_reveal_tapped", { table: tableId });
  fireConfetti();

  if (!isImageTrackingSupported()) {
    goToFallback();
    return;
  }

  showScreen(arScreen);
  arInstructions.classList.remove("ar-instructions--hidden");
  arContainer.innerHTML = ""; // clear any previous session's video/canvas

  try {
    activeSession = await startImageTrackingAR({
      container: arContainer,
      onTargetFound: () => {
        trackEvent("ar_target_found", { table: tableId });
        arInstructions.classList.add("ar-instructions--hidden");
        fireConfetti({ origin: { y: 0.4 }, particleCount: 90, spread: 100 });
      },
      onTargetLost: () => {
        trackEvent("ar_target_lost", { table: tableId });
        arInstructions.classList.remove("ar-instructions--hidden");
      },
    });
    trackEvent("ar_session_started", { table: tableId });
  } catch (err) {
    // Most commonly: camera permission denied, or no camera available.
    trackEvent("ar_session_failed", { table: tableId, reason: err?.message });
    stopActiveSession();
    goToFallback("We couldn't access your camera — enjoy the 3D preview instead!");
  }
});

backBtn.addEventListener("click", () => {
  stopActiveSession();
  showScreen(introScreen);
});

// ---------------------------------------------------------------------------
// DRINKS MENU
// ---------------------------------------------------------------------------
drinksMenu = initDrinksMenu({
  onExitToIntro: () => showScreen(introScreen),
  trackEvent,
});

function openMenu() {
  // Release the camera first — browsing the menu with a live camera stream
  // running behind it drains battery and, on iOS, can leave the AR session
  // in a state where re-entering it fails.
  stopActiveSession();
  hideMainScreens();
  drinksMenu.openList();
}

function openCarousel() {
  stopActiveSession();
  hideMainScreens();
  drinksMenu.openCarousel(0);
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
