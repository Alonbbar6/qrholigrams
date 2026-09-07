// ============================================================================
// usdz.mjs — export a GLB to USDZ via THREE.USDZExporter in headless Chrome.
//
// WHY A BROWSER
// -------------
// USDZExporter turns textures into image files using document.createElement,
// OffscreenCanvas and canvas.toBlob. None of those exist in Node, and shimming
// them faithfully enough to trust the output is more fragile than driving the
// real thing. Chrome is already required to preview any of this, so the build
// leans on it rather than on a DOM emulation.
//
// The GLB is loaded through GLTFLoader + DRACOLoader, so compressed geometry is
// decoded before export — handing a still-compressed scene to the exporter
// produces a valid-looking but empty USDZ.
// ============================================================================

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".json": "application/json",
};

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

// Serve the project root on an ephemeral port. Modules and fetch both need a
// real origin; file:// blocks them.
function serve(root) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
        const file = path.join(root, rel);
        if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function cdp(port) {
  // Chrome needs a moment before its debugging endpoint answers.
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Chrome's debugging port never answered");
}

// glbPath is relative to the project root, e.g. assets/models/drinks/negroni.glb
export async function exportUSDZ({ root, glbPath, timeoutMs = 120000 }) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error("Chrome not found — USDZ export needs it (see scripts/lib/usdz.mjs)");

  const { server, port } = await serve(root);
  const debugPort = 9600 + Math.floor(Math.random() * 300);
  const profile = path.join("/tmp", `usdz-profile-${debugPort}`);
  const chrome = spawn(
    chromePath,
    ["--headless=new", "--no-sandbox", `--remote-debugging-port=${debugPort}`,
     `--user-data-dir=${profile}`, "--use-gl=angle", "--use-angle=swiftshader",
     "--enable-unsafe-swiftshader", "about:blank"],
    { stdio: "ignore" }
  );

  const cleanup = () => { try { chrome.kill(); } catch {} server.close(); };

  try {
    const page = await cdp(debugPort);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) =>
      new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

    const url =
      `http://127.0.0.1:${port}/scripts/lib/usdz-page.html?src=` +
      encodeURIComponent("/" + glbPath.split(path.sep).join("/"));
    await send("Page.navigate", { url });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await send("Runtime.evaluate", {
        expression: "window.__usdz ? JSON.stringify({ok:window.__usdz.ok, error:window.__usdz.error}) : null",
        returnByValue: true,
      });
      const status = r.result?.result?.value;
      if (status) {
        const { ok, error } = JSON.parse(status);
        if (!ok) throw new Error(`USDZ export failed: ${error}`);
        // Pull the payload separately so a large base64 string is fetched once.
        const got = await send("Runtime.evaluate", {
          expression: "JSON.stringify({base64:window.__usdz.base64,bytes:window.__usdz.bytes," +
                      "materials:window.__usdz.materials,size:window.__usdz.size})",
          returnByValue: true,
        });
        ws.close();
        const payload = JSON.parse(got.result.result.value);
        return { ...payload, buffer: Buffer.from(payload.base64, "base64") };
      }
      await new Promise((r2) => setTimeout(r2, 300));
    }
    throw new Error("USDZ export timed out");
  } finally {
    cleanup();
  }
}
