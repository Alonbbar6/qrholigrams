#!/usr/bin/env node
// ============================================================================
// measure-jitter.mjs — run MindAR against a VIDEO and measure the wobble.
//
//   npm run jitter                       # synthetic shaky feed
//   npm run jitter -- --video real.y4m   # footage you recorded yourself
//   npm run jitter -- --miss 25 --mincf 0.0005
//
// WHY THIS EXISTS
// ---------------
// Every tracking change so far has been judged by looking at a phone, which
// is neither repeatable nor comparable. Chrome can be handed a video file as
// its camera (--use-file-for-fake-video-capture), so the same footage can be
// replayed through the real pipeline as many times as needed and the pose it
// produces measured.
//
// The metric is the MEDIAN SECOND DIFFERENCE of the tracked position. First
// difference is velocity — a slow pan is not jitter. Second difference is
// acceleration, which is what shake and noise actually look like. Median
// rather than mean so one dropout does not dominate the number.
//
// LOWER IS BETTER. The number is only meaningful compared against another run
// of the SAME video.
//
// Feed it real footage of your own card, on your own table, in your own bar
// lighting, and every future change becomes a measurement instead of a guess.
// ============================================================================

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { findChrome } from "./lib/usdz.mjs";

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? "1" : argv[++i];
}

const ROOT = process.cwd();
const TABLE = flags.table ?? "1";
const SECONDS = Number(flags.seconds ?? 18);

const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript",
  ".wasm":"application/wasm", ".glb":"model/gltf-binary", ".mind":"application/octet-stream",
  ".css":"text/css", ".png":"image/png", ".json":"application/json" };

function serve(root) {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      try {
        const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
        const file = path.join(root, rel);
        if (!file.startsWith(root)) return res.writeHead(403).end();
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch { res.writeHead(404).end(); }
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });
}

// Build the synthetic feed unless real footage was supplied.
function ensureVideo() {
  if (flags.video) {
    if (!existsSync(flags.video)) throw new Error(`No such video: ${flags.video}`);
    return path.resolve(flags.video);
  }
  const frames = "/tmp/jitter-frames";
  const out = "/tmp/jitter.y4m";
  mkdirSync(frames, { recursive: true });
  console.log("  building synthetic shaky feed…");
  execFileSync("node", ["scripts/make-shaky-video.mjs", `assets/cards/table-${TABLE}-card.png`, frames], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-y", "-framerate", "15", "-i", `${frames}/f%03d.png`, "-pix_fmt", "yuv420p", out], { stdio: "ignore" });
  return out;
}

// Median absolute second difference of the tracked position, in millimetres of
// anchor space. Second difference isolates acceleration, so smooth motion
// scores near zero and only shake and noise register.
function jitter(samples) {
  if (samples.length < 3) return null;
  const d2 = [];
  for (let i = 2; i < samples.length; i++) {
    const a = samples[i - 2], b = samples[i - 1], c = samples[i];
    const dx = c.x - 2 * b.x + a.x, dy = c.y - 2 * b.y + a.y, dz = c.z - 2 * b.z + a.z;
    d2.push(Math.hypot(dx, dy, dz));
  }
  d2.sort((p, q) => p - q);
  const mid = Math.floor(d2.length / 2);
  return { median: d2[mid], p90: d2[Math.floor(d2.length * 0.9)], frames: samples.length };
}

const chromePath = findChrome();
if (!chromePath) { console.error("\nChrome not found.\n"); process.exit(1); }

const video = ensureVideo();
const { server, port } = await serve(ROOT);
const dbg = 9700 + Math.floor(Math.random() * 200);

const params = new URLSearchParams({ table: TABLE, debug: "1" });
for (const k of ["miss", "warmup", "mincf", "beta"]) if (flags[k]) params.set(k, flags[k]);

const chrome = spawn(chromePath, [
  "--headless=new", "--no-sandbox", `--remote-debugging-port=${dbg}`,
  `--user-data-dir=/tmp/jitter-profile-${dbg}`,
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-video-capture=${video}`,
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--window-size=430,932", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find((t) => t.type === "page"); }
    catch { await sleep(250); }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: p })); });
  const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, timeout: 30000 })).result?.result?.value;

  console.log(`  video   : ${video}`);
  console.log(`  params  : ${params.toString()}`);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/?${params}` });
  await sleep(3000);
  // Into card AR: pick the auto mode, then launch.
  await ev(`(()=>{const b=document.getElementById('ar-mode-auto'); if(b) b.click();
              const a=document.getElementById('drink-ar-btn'); if(a) a.click(); return true})()`);
  await sleep(SECONDS * 1000);

  const found = await ev(`Array.isArray(window.__arDebug) ? window.__arDebug.length : -1`);
  const samples = found > 0 ? JSON.parse(await ev(`JSON.stringify(window.__arDebug)`)) : [];
  ws.close();

  if (found < 0) { console.log("\n  ✗ debug recorder never armed — is ?debug=1 reaching ar-experience.js?\n"); }
  else if (samples.length < 3) { console.log(`\n  ✗ card never tracked in this footage (${samples.length} samples).\n`); }
  else {
    const j = jitter(samples);
    console.log(`\n  tracked frames : ${j.frames}`);
    console.log(`  jitter (median): ${(j.median * 1000).toFixed(2)}  ← lower is better`);
    console.log(`  jitter (p90)   : ${(j.p90 * 1000).toFixed(2)}`);
    console.log(`\n  Compare against another run of the SAME video.\n`);
  }
} finally {
  try { chrome.kill(); } catch {}
  server.close();
}
