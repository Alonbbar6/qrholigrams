#!/usr/bin/env node
// ============================================================================
// turntable.mjs — render a drink model spinning through a full 360°.
//
//   npm run turntable -- --drink old-fashioned
//   npm run turntable -- --drink negroni --frames 90 --out /tmp/neg360.mp4
//
// Unlike record-ar.mjs this has nothing to do with tracking — no camera, no
// card. It orbits <model-viewer> around the model itself, which is the honest
// way to judge what Meshy actually produced: a still render flatters a model
// by hiding whichever side came out worst.
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
const DRINK = flags.drink ?? "old-fashioned";
const FRAMES = Number(flags.frames ?? 72);
const FPS = Number(flags.fps ?? 15);
const ELEV = flags.elevation ?? "72deg";      // slight downward look, as at a table
const OUT = path.resolve(flags.out ?? `/tmp/${DRINK}-360.mp4`);
const SHOTS = "/tmp/turntable-shots";

const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript",
  ".wasm":"application/wasm", ".glb":"model/gltf-binary", ".png":"image/png", ".css":"text/css" };

const model = `assets/models/drinks/${DRINK}.glb`;
if (!existsSync(path.join(ROOT, model))) {
  console.error(`\nNo such model: ${model}\n`);
  process.exit(1);
}

const page = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#1a1424}
model-viewer{width:100vw;height:100vh;--poster-color:transparent;background:#1a1424}</style>
<script type="module" src="/js/vendor/model-viewer/model-viewer.min.js"></script>
<model-viewer id="mv" loading="eager" environment-image="neutral" exposure="1.15"
  shadow-intensity="1.1" shadow-softness="0.8" interaction-prompt="none"
  camera-orbit="0deg ${ELEV} auto" src="/${model}"></model-viewer>
<script>
customElements.whenDefined('model-viewer').then(()=>{
  customElements.get('model-viewer').dracoDecoderLocation='/js/vendor/draco/';
  const mv=document.getElementById('mv');
  mv.addEventListener('load',()=>{window.__ready=true;});
  window.__setAngle=(deg)=>{ mv.cameraOrbit = deg+'deg ${ELEV} auto'; };
});
</script>`;

function serve(root) {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const url = req.url.split("?")[0];
      if (url === "/__turntable") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(page);
      }
      try {
        const f = path.join(root, decodeURIComponent(url).replace(/^\/+/, ""));
        if (!f.startsWith(root)) return res.writeHead(403).end();
        const b = await readFile(f);
        res.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream" });
        res.end(b);
      } catch { res.writeHead(404).end(); }
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });
}

const chromePath = findChrome();
if (!chromePath) { console.error("\nChrome not found.\n"); process.exit(1); }

const { server, port } = await serve(ROOT);
const dbg = 9850 + Math.floor(Math.random() * 100);
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const chrome = spawn(chromePath, [
  "--headless=new", "--no-sandbox", `--remote-debugging-port=${dbg}`,
  `--user-data-dir=/tmp/turntable-${dbg}`,
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--hide-scrollbars", "--window-size=640,640", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find((t) => t.type === "page"); }
    catch { await sleep(250); }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, timeout: 30000 })).result?.result?.value;

  console.log(`  model : ${model}`);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/__turntable` });

  // Wait for the model, not a fixed delay — Draco decode time varies.
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) { ready = await ev("!!window.__ready"); if (!ready) await sleep(500); }
  if (!ready) throw new Error("model never loaded");
  console.log(`  loaded, rendering ${FRAMES} frames…`);
  await sleep(1500);

  for (let i = 0; i < FRAMES; i++) {
    await ev(`window.__setAngle(${(i * 360) / FRAMES})`);
    await sleep(220); // let the frame settle before capturing
    const s = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(SHOTS, `f${String(i).padStart(3, "0")}.png`), Buffer.from(s.result.data, "base64"));
  }
  ws.close();
} finally {
  try { chrome.kill(); } catch {}
  server.close();
}

execFileSync("ffmpeg", ["-y", "-framerate", String(FPS), "-start_number", "0",
  "-i", path.join(SHOTS, "f%03d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
  "-crf", "24", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-movflags", "+faststart", OUT],
  { stdio: "ignore" });
const gif = OUT.replace(/\.mp4$/, ".gif");
execFileSync("ffmpeg", ["-y", "-framerate", String(FPS), "-start_number", "0",
  "-i", path.join(SHOTS, "f%03d.png"), "-vf", "scale=380:-2,fps=12", "-loop", "0", gif],
  { stdio: "ignore" });

console.log(`\n✓ ${OUT}`);
console.log(`✓ ${gif}\n`);
