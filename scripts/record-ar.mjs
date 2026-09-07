#!/usr/bin/env node
// ============================================================================
// record-ar.mjs — record the card-AR view against a video, headlessly.
//
//   npm run record-ar
//   npm run record-ar -- --drink negroni --out /tmp/negroni.mp4
//   npm run record-ar -- --video real.y4m --miss 25
//
// Companion to measure-jitter.mjs: that one gives you the NUMBER, this gives
// you the PICTURE. Same fake-camera trick — Chrome takes a video file as its
// webcam, so the real MindAR pipeline runs against identical footage every
// time and any change can be compared frame for frame.
//
// Together they close the loop that was missing: until now every tracking
// change had to be shipped to a phone and judged by eye.
// ============================================================================

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { findChrome } from "./lib/usdz.mjs";

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? "1" : argv[++i];
}

const ROOT = process.cwd();
const TABLE = flags.table ?? "1";
const DRINK = flags.drink ?? null;          // default: whatever the carousel opens on
const OUT = path.resolve(flags.out ?? "/tmp/ar-recording.mp4");
const FRAMES = Number(flags.frames ?? 70);
const SETTLE = Number(flags.settle ?? 14);  // seconds before capture starts
const FPS = Number(flags.fps ?? 10);

const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript",
  ".wasm":"application/wasm", ".glb":"model/gltf-binary", ".mind":"application/octet-stream",
  ".css":"text/css", ".png":"image/png", ".usdz":"model/vnd.usdz+zip" };

function serve(root) {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      try {
        const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
        const f = path.join(root, rel);
        if (!f.startsWith(root)) return res.writeHead(403).end();
        const b = await readFile(f);
        res.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream" });
        res.end(b);
      } catch { res.writeHead(404).end(); }
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });
}

function ensureVideo() {
  if (flags.video) {
    if (!existsSync(flags.video)) throw new Error(`No such video: ${flags.video}`);
    return path.resolve(flags.video);
  }
  const frames = "/tmp/recar-frames", out = "/tmp/recar.y4m";
  mkdirSync(frames, { recursive: true });
  console.log("  building synthetic feed from the current card art…");
  execFileSync("node", ["scripts/make-shaky-video.mjs", `assets/cards/table-${TABLE}-card.png`, frames], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-y", "-framerate", "15", "-i", `${frames}/f%03d.png`, "-pix_fmt", "yuv420p", out], { stdio: "ignore" });
  return out;
}

const chromePath = findChrome();
if (!chromePath) { console.error("\nChrome not found.\n"); process.exit(1); }

const video = ensureVideo();
const { server, port } = await serve(ROOT);
const dbg = 9800 + Math.floor(Math.random() * 150);
const shots = "/tmp/recar-shots";
rmSync(shots, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });

const params = new URLSearchParams({ table: TABLE, debug: "1" });
for (const k of ["miss", "warmup", "mincf", "beta", "torch"]) if (flags[k]) params.set(k, flags[k]);

const chrome = spawn(chromePath, [
  "--headless=new", "--no-sandbox", `--remote-debugging-port=${dbg}`,
  `--user-data-dir=/tmp/recar-profile-${dbg}`,
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
  `--use-file-for-fake-video-capture=${video}`,
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--window-size=430,760", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find((t) => t.type === "page"); }
    catch { await sleep(250); }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, timeout: 30000 })).result?.result?.value;

  console.log(`  video   : ${video}`);
  console.log(`  params  : ${params}`);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/?${params}` });
  await sleep(4000);

  // Pick a drink if one was named, then enter card AR.
  const pick = DRINK
    ? `(()=>{const i=[...document.querySelectorAll('.drink-row-btn')]
         .findIndex(b=>b.textContent.toLowerCase().includes(${JSON.stringify(DRINK.toLowerCase())}));
         return i;})()`
    : "-1";
  await ev(`(()=>{
    const dots=[...document.querySelectorAll('#drink-dots .drink-dot')];
    const i=${pick}; if(i>=0 && dots[i]) dots[i].click();
    const m=document.getElementById('ar-mode-auto'); if(m) m.click();
    const a=document.getElementById('drink-ar-btn'); if(a) a.click();
    return true;})()`);

  console.log(`  settling ${SETTLE}s (camera + model + tracking acquisition)…`);
  await sleep(SETTLE * 1000);
  console.log(`  tracked samples: ${await ev(`(window.__arDebug||[]).length`)}`);

  for (let i = 0; i < FRAMES; i++) {
    const s = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(shots, `f${String(i).padStart(3, "0")}.png`), Buffer.from(s.result.data, "base64"));
    await sleep(160);
  }
  console.log(`  captured ${FRAMES} frames | final samples: ${await ev(`(window.__arDebug||[]).length`)}`);
  ws.close();
} finally {
  try { chrome.kill(); } catch {}
  server.close();
}

// Pad to even dimensions — libx264 rejects odd width/height.
execFileSync("ffmpeg", ["-y", "-framerate", String(FPS), "-start_number", "0",
  "-i", path.join(shots, "f%03d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
  "-crf", "26", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-movflags", "+faststart", OUT],
  { stdio: "ignore" });
const gif = OUT.replace(/\.mp4$/, ".gif");
execFileSync("ffmpeg", ["-y", "-framerate", String(FPS), "-start_number", "0",
  "-i", path.join(shots, "f%03d.png"), "-vf", "scale=360:-2,fps=8", "-loop", "0", gif],
  { stdio: "ignore" });

console.log(`\n✓ ${OUT}`);
console.log(`✓ ${gif}\n`);
