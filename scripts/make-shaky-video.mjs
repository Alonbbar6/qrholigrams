#!/usr/bin/env node
// ============================================================================
// make-shaky-video.mjs — DEV/TEST ONLY.
//
// Builds a synthetic "camera feed" of a printed card on a table, with the
// things that actually cause AR jitter in real life:
//   • sub-pixel handheld shake        • slight rotational drift
//   • per-frame sensor noise (grain)  • mild exposure flicker
//
// A static image can't reveal jitter (nothing moves), so this is what makes
// A/B testing the tracking smoothing filter meaningful.
//
//   node scripts/make-shaky-video.mjs assets/cards/table-1-card.png /tmp/shaky
//   ffmpeg -y -framerate 15 -i /tmp/shaky/f%03d.png -pix_fmt yuv420p out.y4m
// ============================================================================

import { createCanvas, loadImage } from "canvas";
import { mkdirSync, writeFileSync } from "node:fs";

const W = 1280;
const H = 720;
const FRAMES = 90;

function solveHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i];
    const [dx, dy] = dst[i];
    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    b.push(dy);
  }
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const h = M.map((row) => row[n]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

const applyH = (H_, x, y) => {
  const d = H_[6] * x + H_[7] * y + H_[8];
  return [(H_[0] * x + H_[1] * y + H_[2]) / d, (H_[3] * x + H_[4] * y + H_[5]) / d];
};

const cardPath = process.argv[2] || "assets/cards/table-1-card.png";
const outDir = process.argv[3] || "/tmp/shaky";
mkdirSync(outDir, { recursive: true });

const card = await loadImage(cardPath);
const srcCanvas = createCanvas(card.width, card.height);
srcCanvas.getContext("2d").drawImage(card, 0, 0);
const srcData = srcCanvas.getContext("2d").getImageData(0, 0, card.width, card.height).data;

const baseQuad = [
  [455, 120],
  [845, 128],
  [880, 640],
  [420, 632],
];

for (let f = 0; f < FRAMES; f++) {
  const t = f / FRAMES;
  // Handheld motion: a slow drift plus a faster small tremor.
  const driftX = Math.sin(t * Math.PI * 2) * 6;
  const driftY = Math.cos(t * Math.PI * 2 * 0.7) * 4;
  const quad = baseQuad.map(([x, y], i) => [
    x + driftX + (Math.random() - 0.5) * 2.4 + Math.sin(t * 40 + i) * 0.8,
    y + driftY + (Math.random() - 0.5) * 2.4 + Math.cos(t * 37 + i) * 0.8,
  ]);

  const Hinv = solveHomography(quad, [
    [0, 0],
    [card.width, 0],
    [card.width, card.height],
    [0, card.height],
  ]);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#6b4a33";
  ctx.fillRect(0, 0, W, H);

  const img = ctx.getImageData(0, 0, W, H);
  const out = img.data;
  const exposure = 0.95 + Math.sin(t * 25) * 0.05; // mild flicker

  const minX = Math.max(0, Math.floor(Math.min(...quad.map((p) => p[0]))));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(...quad.map((p) => p[0]))));
  const minY = Math.max(0, Math.floor(Math.min(...quad.map((p) => p[1]))));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(...quad.map((p) => p[1]))));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const [u, v] = applyH(Hinv, x + 0.5, y + 0.5);
      if (u < 0 || v < 0 || u >= card.width || v >= card.height) continue;
      const si = (Math.floor(v) * card.width + Math.floor(u)) * 4;
      const di = (y * W + x) * 4;
      out[di] = srcData[si] * exposure;
      out[di + 1] = srcData[si + 1] * exposure;
      out[di + 2] = srcData[si + 2] * exposure;
      out[di + 3] = 255;
    }
  }

  // Sensor grain across the whole frame.
  for (let i = 0; i < out.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    out[i] = Math.max(0, Math.min(255, out[i] + n));
    out[i + 1] = Math.max(0, Math.min(255, out[i + 1] + n));
    out[i + 2] = Math.max(0, Math.min(255, out[i + 2] + n));
  }

  ctx.putImageData(img, 0, 0);
  writeFileSync(`${outDir}/f${String(f).padStart(3, "0")}.png`, canvas.toBuffer("image/png"));
}

console.log(`wrote ${FRAMES} frames to ${outDir}`);
