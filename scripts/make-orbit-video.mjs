#!/usr/bin/env node
// ============================================================================
// make-orbit-video.mjs — DEV/TEST ONLY.
//
// A synthetic camera feed that walks a full 360° around the printed card lying
// flat on a table, at a fixed height, looking at it throughout.
//
//   node scripts/make-orbit-video.mjs assets/cards/table-1-card.png /tmp/orbit
//   ffmpeg -y -framerate 15 -i /tmp/orbit/f%03d.png -pix_fmt yuv420p out.y4m
//
// WHY, beyond looking nice
// ------------------------
// make-shaky-video.mjs jiggles the camera in roughly one pose, which measures
// jitter but says nothing about VIEWING ANGLE. Image tracking degrades as the
// card gets more oblique — the card's projected area shrinks, features crowd
// together, and the pose solve gets progressively less constrained.
//
// An orbit sweeps every angle in one clip, so where tracking gives up becomes
// visible rather than guessed at. A customer leaning over their table is doing
// exactly this.
// ============================================================================

import { createCanvas, loadImage } from "canvas";
import { mkdirSync, writeFileSync } from "node:fs";

const W = 1280;
const H = 720;
const FRAMES = Number(process.env.ORBIT_FRAMES ?? 120);

// Camera path, in card-widths. Height and radius set how oblique the view
// gets: lower camera = shallower angle = harder tracking.
const RADIUS = 1.5;
const CAM_HEIGHT = 1.05;
const FOCAL = 900; // pixels; roughly a phone's field of view at this framing

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };

function solveHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i], [dx, dy] = dst[i];
    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]); b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]); b.push(dy);
  }
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
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
const applyH = (Hm, x, y) => {
  const d = Hm[6] * x + Hm[7] * y + Hm[8];
  return [(Hm[0] * x + Hm[1] * y + Hm[2]) / d, (Hm[3] * x + Hm[4] * y + Hm[5]) / d];
};

const cardPath = process.argv[2] || "assets/cards/table-1-card.png";
const outDir = process.argv[3] || "/tmp/orbit";
mkdirSync(outDir, { recursive: true });

const card = await loadImage(cardPath);
const sc = createCanvas(card.width, card.height);
sc.getContext("2d").drawImage(card, 0, 0);
const srcData = sc.getContext("2d").getImageData(0, 0, card.width, card.height).data;

// Card lying flat on y=0, 1 unit wide, aspect from the artwork.
const aspect = card.height / card.width;
const CORNERS = [
  [-0.5, 0, -0.5 * aspect],
  [ 0.5, 0, -0.5 * aspect],
  [ 0.5, 0,  0.5 * aspect],
  [-0.5, 0,  0.5 * aspect],
];

for (let f = 0; f < FRAMES; f++) {
  const t = f / FRAMES;
  const theta = t * Math.PI * 2;

  // Orbit, with a little handheld tremor so it is not unrealistically perfect.
  const cam = [
    Math.cos(theta) * RADIUS + (Math.random() - 0.5) * 0.006,
    CAM_HEIGHT + Math.sin(t * Math.PI * 6) * 0.02,
    Math.sin(theta) * RADIUS + (Math.random() - 0.5) * 0.006,
  ];
  const fwd = norm(sub([0, 0, 0], cam));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);

  const quad = CORNERS.map((P) => {
    const v = sub(P, cam);
    const z = dot(v, fwd);
    return [W / 2 + (FOCAL * dot(v, right)) / z, H / 2 - (FOCAL * dot(v, up)) / z];
  });

  const Hinv = solveHomography(quad, [
    [0, 0], [card.width, 0], [card.width, card.height], [0, card.height],
  ]);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#6b4b32";
  ctx.fillRect(0, 0, W, H);
  const out = ctx.getImageData(0, 0, W, H);

  // Bounding box of the projected card, so only those pixels are sampled.
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));

  // Mild exposure flicker, as a real auto-exposing camera produces.
  const exposure = 1 + Math.sin(t * Math.PI * 8) * 0.03;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const [u, v] = applyH(Hinv, x + 0.5, y + 0.5);
      if (u < 0 || v < 0 || u >= card.width || v >= card.height) continue;
      const si = ((v | 0) * card.width + (u | 0)) * 4;
      const di = (y * W + x) * 4;
      const grain = (Math.random() - 0.5) * 10;
      out.data[di] = Math.max(0, Math.min(255, srcData[si] * exposure + grain));
      out.data[di + 1] = Math.max(0, Math.min(255, srcData[si + 1] * exposure + grain));
      out.data[di + 2] = Math.max(0, Math.min(255, srcData[si + 2] * exposure + grain));
      out.data[di + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  writeFileSync(`${outDir}/f${String(f).padStart(3, "0")}.png`, canvas.toBuffer("image/png"));
}
console.log(`  ${FRAMES} orbit frames -> ${outDir}`);
