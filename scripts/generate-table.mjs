#!/usr/bin/env node
// ============================================================================
// generate-table.mjs — the primary generator for image-tracking AR.
//
// For a given table number, this produces THREE things from one consistent
// source image, in one run:
//   1. assets/cards/table-<N>-card.png   — the printable table-tent artwork
//      (QR code baked into a branded card design)
//   2. assets/targets/table-<N>.mind     — the compiled MindAR "target" file
//      that lets the AR page recognize that exact printed card as a marker
//   3. qr-output/table-<N>-qr.png        — the bare QR code alone, if you
//      want it for anything separate from the printed card
//
// Steps 1 and 2 MUST come from the same image — the .mind file is a compiled
// fingerprint of the card's exact pixels. If you redesign the card, you must
// re-run this script (not just re-generate the QR) so the target stays in
// sync with what's printed.
//
// Usage:
//   npm run table -- 1
//   npm run table -- 1 https://your-real-site.netlify.app
// ============================================================================

import { createCanvas, loadImage } from "canvas";
import QRCode from "qrcode";
import { OfflineCompiler } from "mind-ar/src/image-target/offline-compiler.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// BRAND: update once you're deployed for real, so `npm run table -- N`
// works with no second argument.
const DEFAULT_SITE_URL = "https://qrholigrams-bar-gift.netlify.app";

const tableNumber = process.argv[2];
const siteUrl = (process.argv[3] || DEFAULT_SITE_URL).replace(/\/+$/, "");

if (!tableNumber || !/^[a-zA-Z0-9_-]+$/.test(tableNumber)) {
  console.error(
    `\nUsage: npm run table -- <table-number> [site-url]\n` +
      `Example: npm run table -- 1 https://your-site.netlify.app\n`
  );
  process.exit(1);
}

const tableUrl = `${siteUrl}/?table=${encodeURIComponent(tableNumber)}`;

// ---------------------------------------------------------------------------
// BRAND: card dimensions + palette. 1200x1600 = a 3:4 portrait card, prints
// cleanly at 4"x5.33" @ 300dpi. Keep width/height in sync with CARD_ASPECT
// used later in js/ar-experience.js (it needs the same ratio to size the
// tracked plane correctly).
// ---------------------------------------------------------------------------
const CARD_W = 1200;
const CARD_H = 1600;
const COLORS = {
  bgTop: "#241a33",
  bgBottom: "#14101c",
  accent: "#ff6fae",
  accent2: "#ffd76f",
  accent3: "#6fe3ff",
  text: "#ffffff",
};

async function buildCardImage() {
  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext("2d");

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, 0, CARD_H);
  grad.addColorStop(0, COLORS.bgTop);
  grad.addColorStop(1, COLORS.bgBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // ---- Trackable decorative texture -------------------------------------
  // ⚠️ THIS ARTWORK IS LOAD-BEARING FOR THE AR. MindAR recognizes the card by
  // finding distinctive corner features in it, so the design is tuned for
  // trackability as much as for looks. The rules that matter:
  //
  //   1. HIGH CONTRAST. Feature detectors respond to strong gradients. The
  //      first version of this card drew shapes at 0.12–0.34 alpha and it
  //      yielded only 47 tracking points. Near-opaque shapes yield far more.
  //   2. HARD EDGES. Crisp polygon corners are exactly what the detector
  //      looks for; soft blurry blobs give it almost nothing.
  //   3. MULTIPLE SCALES. Big shapes survive distance and motion blur; small
  //      ones give precision up close. You need both.
  //   4. NON-REPEATING + ASYMMETRIC. Identical repeated shapes produce
  //      ambiguous descriptors that the matcher confuses with each other
  //      (this is exactly why a bare QR code tracks poorly). Vary size,
  //      rotation, colour and shape, and let the layout be lopsided.
  //
  // Seeded per table, so every table's card is also distinct from the others.
  const rand = mulberry32(hashString(`table-${tableNumber}`));
  const palette = [
    COLORS.accent,
    COLORS.accent2,
    COLORS.accent3,
    COLORS.text,
    "#7d5cff",
    "#ff8a4c",
  ];
  const pick = () => palette[Math.floor(rand() * palette.length)];

  // MindAR extracts its tracking features from a heavily DOWNSAMPLED copy of
  // the card (256x341 and 128x171 — roughly 1/5 scale). Two consequences that
  // drive the design below:
  //   • Fine detail is invisible to the tracker. Small confetti looks nice but
  //     contributes essentially nothing; large and mid shapes do the work.
  //   • The white QR panel is drawn on top of this artwork later, so anything
  //     placed under it is wasted. We reject those positions up front, which
  //     concentrates the same shape budget into the area that counts.
  const qrZone = { x0: 230, y0: 320, x1: 970, y1: 1060 };
  const outsideQR = () => {
    for (let tries = 0; tries < 40; tries++) {
      const x = rand() * CARD_W;
      const y = rand() * CARD_H;
      if (x < qrZone.x0 || x > qrZone.x1 || y < qrZone.y0 || y > qrZone.y1) {
        return [x, y];
      }
    }
    return [rand() * CARD_W, rand() * CARD_H];
  };

  // Layer 1 — large irregular shards. These carry tracking at distance and
  // through motion blur, when fine detail has smeared away.
  for (let i = 0; i < 48; i++) {
    const [x, y] = outsideQR();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rand() * Math.PI * 2);
    ctx.globalAlpha = 0.55 + rand() * 0.4;
    ctx.fillStyle = pick();
    drawShard(ctx, 100 + rand() * 200, rand);
    ctx.restore();
  }

  // Layer 2 — mid-scale shapes, the main workhorse for tracking.
  //
  // Placed on a JITTERED GRID rather than at random, and this matters a lot.
  // MindAR enforces a minimum spacing between tracking features (occSize —
  // roughly every 117px of this card), so what it can use is capped by how
  // EVENLY the detail is spread, not by how much of it there is. Pure random
  // placement clumps in some cells and leaves others bare, wasting both. One
  // varied shape per cell covers the grid the extractor is actually sampling.
  const CELL = 104;
  const cols = Math.ceil(CARD_W / CELL);
  const rows = Math.ceil(CARD_H / CELL);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = (cx + 0.15 + rand() * 0.7) * CELL;
      const y = (cy + 0.15 + rand() * 0.7) * CELL;
      // Skip cells under the QR panel — that artwork would be painted over.
      if (x > qrZone.x0 && x < qrZone.x1 && y > qrZone.y0 && y < qrZone.y1) continue;
      if (x > CARD_W || y > CARD_H) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rand() * Math.PI * 2);
      ctx.globalAlpha = 0.7 + rand() * 0.3;
      ctx.fillStyle = pick();
      const size = 46 + rand() * 84;
      const kind = rand();
      if (kind < 0.3) {
        drawShard(ctx, size, rand);
      } else if (kind < 0.55) {
        drawSparkle(ctx, size);
      } else if (kind < 0.78) {
        // thick ring — two strong concentric edges
        ctx.beginPath();
        ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(5, size * 0.26);
        ctx.strokeStyle = ctx.fillStyle;
        ctx.stroke();
      } else {
        // hard-edged triangle
        ctx.beginPath();
        ctx.moveTo(0, -size / 2);
        ctx.lineTo(size / 2, size / 2);
        ctx.lineTo(-size / 2, size / 2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // Layer 3 — small confetti. Purely decorative: too fine for the tracker to
  // see at its working resolution, but it keeps the card from looking sparse.
  for (let i = 0; i < 120; i++) {
    const [x, y] = outsideQR();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rand() * Math.PI * 2);
    ctx.globalAlpha = 0.7 + rand() * 0.3;
    ctx.fillStyle = pick();
    const size = 10 + rand() * 26;
    if (rand() < 0.5) {
      ctx.fillRect(-size / 2, -size / 6, size, size / 3); // dash
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- Asymmetric corner blocks ------------------------------------------
  // Deliberately different in each corner: gives the tracker unambiguous
  // orientation cues so it can't lock on 90° rotated, and adds strong
  // long edges that survive blur.
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(0, 0, 190, 26); // top-left: wide bar
  ctx.fillStyle = COLORS.accent3;
  ctx.fillRect(CARD_W - 26, 0, 26, 150); // top-right: tall bar
  ctx.fillStyle = COLORS.accent2;
  ctx.beginPath(); // bottom-left: triangle
  ctx.moveTo(0, CARD_H);
  ctx.lineTo(120, CARD_H);
  ctx.lineTo(0, CARD_H - 120);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // ---- Decorative border frame -----------------------------------------
  ctx.save();
  ctx.strokeStyle = COLORS.accent2;
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 10;
  roundRectPath(ctx, 28, 28, CARD_W - 56, CARD_H - 56, 28);
  ctx.stroke();
  ctx.restore();

  // ---- Header panel + text ----------------------------------------------
  // The solid panel isn't only cosmetic. Text sitting directly on the busy
  // confetti was unreadable, and the panel's long straight edges are strong,
  // unambiguous tracking features in their own right — so this both fixes
  // legibility and helps the AR.
  ctx.save();
  ctx.fillStyle = "rgba(12, 9, 20, 0.92)";
  roundRectPath(ctx, 70, 74, CARD_W - 140, 200, 24);
  ctx.fill();
  ctx.strokeStyle = COLORS.accent2;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.restore();

  // BRAND: swap in your real bar name / tagline.
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = "center";
  ctx.font = "bold 72px Helvetica";
  ctx.fillText("THE ALIBI BAR", CARD_W / 2, 170);

  ctx.fillStyle = COLORS.accent;
  ctx.font = "bold 44px Helvetica";
  ctx.fillText(`TABLE ${tableNumber}`, CARD_W / 2, 240);

  // ---- QR code on a clean white card (own quiet zone, no texture on it) --
  const qrSize = 620;
  const qrDataUrl = await QRCode.toDataURL(tableUrl, {
    errorCorrectionLevel: "H",
    margin: 2,
    width: qrSize,
    color: { dark: COLORS.bgBottom, light: "#ffffffff" },
  });
  const qrImg = await loadImage(qrDataUrl);

  const panelPad = 40;
  const panelSize = qrSize + panelPad * 2;
  const panelX = (CARD_W - panelSize) / 2;
  const panelY = 340;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 30;
  ctx.fillStyle = "#ffffff";
  roundRectPath(ctx, panelX, panelY, panelSize, panelSize, 32);
  ctx.fill();
  ctx.restore();

  ctx.drawImage(qrImg, panelX + panelPad, panelY + panelPad, qrSize, qrSize);

  // ---- Caption panel + footer --------------------------------------------
  // Same reasoning as the header panel: readable text over busy artwork, plus
  // extra hard edges for the tracker.
  const capY = panelY + panelSize + 26;
  ctx.save();
  ctx.fillStyle = "rgba(12, 9, 20, 0.92)";
  roundRectPath(ctx, 130, capY, CARD_W - 260, 172, 22);
  ctx.fill();
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();

  // Note: emoji glyphs render unreliably across node-canvas builds (missing
  // color font tables show a fallback shape instead) — stick to plain text
  // here. Emoji in index.html is fine since real browsers handle it.
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = "center";
  ctx.font = "bold 46px Helvetica";
  ctx.fillText("Scan for your gift", CARD_W / 2, capY + 68);

  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "26px Helvetica";
  ctx.fillText("Point your camera here once the page loads", CARD_W / 2, capY + 122);

  // Footer strip keeps the URL legible against the confetti.
  ctx.save();
  ctx.fillStyle = "rgba(12, 9, 20, 0.88)";
  roundRectPath(ctx, 230, CARD_H - 96, CARD_W - 460, 54, 16);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "rgba(255,255,255,0.62)";
  ctx.font = "22px Helvetica";
  ctx.fillText(tableUrl.replace(/^https?:\/\//, ""), CARD_W / 2, CARD_H - 60);

  return canvas;
}

// An irregular hard-edged polygon. Randomised vertex radii mean no two are
// alike, which is exactly what the feature matcher wants — repeated identical
// shapes produce ambiguous descriptors.
function drawShard(ctx, size, rand) {
  const points = 5 + Math.floor(rand() * 4);
  ctx.beginPath();
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const r = (size / 2) * (0.45 + rand() * 0.55);
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function drawSparkle(ctx, size) {
  const r = size / 2;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.28, -r * 0.28);
  ctx.lineTo(r, 0);
  ctx.lineTo(r * 0.28, r * 0.28);
  ctx.lineTo(0, r);
  ctx.lineTo(-r * 0.28, r * 0.28);
  ctx.lineTo(-r, 0);
  ctx.lineTo(-r * 0.28, -r * 0.28);
  ctx.closePath();
  ctx.fill();
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Deterministic PRNG so re-running for the same table number without design
// changes reproduces the same decorative layout (easier to diff/debug).
function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
const root = process.cwd();
const cardsDir = path.join(root, "assets", "cards");
const targetsDir = path.join(root, "assets", "targets");
const qrDir = path.join(root, "qr-output");
await mkdir(cardsDir, { recursive: true });
await mkdir(targetsDir, { recursive: true });
await mkdir(qrDir, { recursive: true });

console.log(`\nGenerating table ${tableNumber} → ${tableUrl}\n`);

// 1. Card artwork
const cardCanvas = await buildCardImage();
const cardPath = path.join(cardsDir, `table-${tableNumber}-card.png`);
await writeFile(cardPath, cardCanvas.toBuffer("image/png"));
console.log(`  card:   ${cardPath}`);

// 2. Bare QR (handy for reference; not what gets compiled as the AR target)
const qrOnlyPath = path.join(qrDir, `table-${tableNumber}-qr.png`);
await QRCode.toFile(qrOnlyPath, tableUrl, {
  errorCorrectionLevel: "H",
  margin: 3,
  width: 1200,
});
console.log(`  qr:     ${qrOnlyPath}`);

// 3. Compile the MindAR target from the exact card image just generated
console.log(`  compiling AR target (this scans the card for trackable features)...`);
const cardImageForCompile = await loadImage(cardCanvas.toBuffer("image/png"));
const compiler = new OfflineCompiler();
await compiler.compileImageTargets([cardImageForCompile], (percent) => {
  process.stdout.write(`\r  compiling: ${percent.toFixed(0)}%   `);
});
process.stdout.write("\n");
const targetBuffer = compiler.exportData();
const targetPath = path.join(targetsDir, `table-${tableNumber}.mind`);
await writeFile(targetPath, targetBuffer);
console.log(`  target: ${targetPath}  (${(targetBuffer.length / 1024).toFixed(0)} KB)`);

console.log(
  `\nDone. Print ${path.relative(root, cardPath)} for the table, and the AR page at\n` +
    `${tableUrl}\nwill recognize it automatically once deployed.\n`
);
