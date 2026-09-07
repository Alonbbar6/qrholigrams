#!/usr/bin/env node
// ============================================================================
// add-ice.mjs — add a procedural ice sphere to a drink model.
//
//   npm run ice -- --drink old-fashioned
//   npm run ice -- --drink old-fashioned --radius 0.45 --centre 0.58
//
// WHY BUILD IT RATHER THAN GENERATE IT
// ------------------------------------
// The Old Fashioned came back from Meshy as an opaque cylinder with no ice,
// because its source photo was clear spirit over a clear ice sphere in clear
// glass — almost entirely transparent, which is precisely what image-to-3D
// cannot reconstruct. A turntable render confirmed there is no good angle.
//
// Ice is a sphere. That is trivial to generate and impossible to infer, so it
// is built here instead of asked for. Deterministic, so rebuilds match.
//
// The result replaces assets/models/drinks/<id>.glb; re-run prep-drink to
// regenerate the light AR variant and the USDZ from it.
// ============================================================================

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { writeFileSync, existsSync, statSync, copyFileSync } from "node:fs";
import path from "node:path";
import { findChrome } from "./lib/usdz.mjs";

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? "1" : argv[++i];
}
const ROOT = process.cwd();
const DRINK = flags.drink ?? "old-fashioned";
const target = path.join(ROOT, "assets", "models", "drinks", `${DRINK}.glb`);
if (!existsSync(target)) { console.error(`\nNo such model: ${target}\n`); process.exit(1); }

const MIME = { ".html":"text/html", ".js":"text/javascript", ".wasm":"application/wasm",
  ".glb":"model/gltf-binary", ".png":"image/png" };
function serve(root) {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      try {
        const f = path.join(root, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, ""));
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
const dbg = 9880 + Math.floor(Math.random() * 80);
const chrome = spawn(chromePath, ["--headless=new","--no-sandbox",`--remote-debugging-port=${dbg}`,
  `--user-data-dir=/tmp/ice-${dbg}`,"--use-gl=angle","--use-angle=swiftshader",
  "--enable-unsafe-swiftshader","about:blank"], { stdio: "ignore" });
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

  const qs = new URLSearchParams({ src: `/assets/models/drinks/${DRINK}.glb` });
  for (const k of ["radius", "centre", "rough"]) if (flags[k]) qs.set(k, flags[k]);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/scripts/lib/ice-page.html?${qs}` });

  let out = null;
  for (let i = 0; i < 200 && !out; i++) {
    const r = await send("Runtime.evaluate", {
      expression: "window.__ice ? JSON.stringify({ok:window.__ice.ok,error:window.__ice.error}) : null",
      returnByValue: true });
    if (r.result?.result?.value) {
      const st = JSON.parse(r.result.result.value);
      if (!st.ok) throw new Error(st.error);
      const got = await send("Runtime.evaluate", {
        expression: "JSON.stringify({base64:window.__ice.base64,bytes:window.__ice.bytes," +
                    "glass:window.__ice.glass,ice:window.__ice.ice,bounds:window.__ice.bounds})",
        returnByValue: true });
      out = JSON.parse(got.result.result.value);
    } else await sleep(300);
  }
  if (!out) throw new Error("ice build timed out");
  ws.close();

  // Keep the untouched original once, so this is reversible.
  const backup = target.replace(/\.glb$/, ".noice.glb");
  if (!existsSync(backup)) copyFileSync(target, backup);

  writeFileSync(target, Buffer.from(out.base64, "base64"));
  const kb = (f) => (statSync(f).size / 1024).toFixed(0);
  console.log(`\n  glass        : ${(out.glass.w*100).toFixed(1)} x ${(out.glass.h*100).toFixed(1)} cm`);
  console.log(`  ice radius   : ${(out.ice.radius*100).toFixed(1)} cm  at y=${(out.ice.y*100).toFixed(1)} cm`);
  console.log(`  base pivot   : y=${out.bounds.minY.toFixed(4)}  height=${out.bounds.h.toFixed(4)} m`);
  console.log(`  original kept: ${path.relative(ROOT, backup)}`);
  console.log(`\n✓ ${path.relative(ROOT, target)}   ${kb(target)} KB (uncompressed — re-run prep-drink to re-optimise)\n`);
} finally {
  try { chrome.kill(); } catch {}
  server.close();
}
