#!/usr/bin/env node
// ============================================================================
// build-flight.mjs — combine every drink into one placeable "flight".
//
//   npm run flight
//   -> assets/models/drinks/menu-flight.glb
//
// WHY THIS EXISTS
// ---------------
// Card AR and WebXR keep all six drinks in the scene and swap by visibility,
// because we own that scene. Native AR on iPhone cannot: Quick Look receives
// a FILE, so there is nothing to hide and no API to toggle.
//
// The way to give an iPhone customer more than one drink, without giving up
// the rock-steady tracking, is to put them all in a single file. One tap
// places the whole menu on the table, and they compare by walking around it
// rather than by switching. No toggling needed, because nothing is hidden.
//
// This is only affordable because it merges the LIGHT drinks/ar/ builds:
// roughly 276 k triangles for all six, less than one full-detail model.
// ============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const SRC_DIR = path.join(process.cwd(), "assets", "models", "drinks", "ar");
const OUT = path.join(process.cwd(), "assets", "models", "drinks", "menu-flight.glb");
const TMP = path.join(process.cwd(), "assets", "models", "drinks", ".tmp-flight.glb");

// Gap between glasses, in metres. Wide enough that they read as separate
// drinks on a table rather than a crowded shelf.
const GAP = 0.045;

const { DRINKS } = await import(path.join(process.cwd(), "js", "drinks.js"));
const inputs = DRINKS.map((d) => path.join(SRC_DIR, `${d.id}.glb`)).filter(existsSync);

if (inputs.length < 2) {
  console.error(`\nNeed at least two drinks in ${SRC_DIR}.\nRun: npm run drink -- <raw>.glb <id> --variant ar\n`);
  process.exit(1);
}

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function readGLB(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a .glb`);
  const chunks = {};
  let off = 12;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    chunks[type] = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json: JSON.parse(chunks[JSON_CHUNK].toString("utf8")), bin: chunks[BIN_CHUNK] };
}

function writeGLB(file, json, bin) {
  const pad = (b, fill) => {
    const rem = (4 - (b.length % 4)) % 4;
    return rem ? Buffer.concat([b, Buffer.alloc(rem, fill)]) : b;
  };
  const j = pad(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const b = bin ? pad(bin, 0x00) : null;
  const total = 12 + 8 + j.length + (b ? 8 + b.length : 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(JSON_CHUNK, 4);
  const parts = [head, jh, j];
  if (b) {
    const bh = Buffer.alloc(8); bh.writeUInt32LE(b.length, 0); bh.writeUInt32LE(BIN_CHUNK, 4);
    parts.push(bh, b);
  }
  writeFileSync(file, Buffer.concat(parts, total));
}

// Width of one drink, read from POSITION accessor min/max — no geometry
// decoding needed, which matters because these are Draco-compressed.
function widthOf(file) {
  const { json } = readGLB(file);
  let min = Infinity, max = -Infinity;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const acc = json.accessors?.[prim.attributes?.POSITION];
      if (!acc?.min || !acc?.max) continue;
      min = Math.min(min, acc.min[0]);
      max = Math.max(max, acc.max[0]);
    }
  }
  // Accessor bounds are pre-node-transform; prep-drink wraps roots in a
  // uniform scale node, so fold that in.
  const scale = json.nodes?.find((n) => n.name === "prep-drink-scale")?.scale?.[0] ?? 1;
  return Number.isFinite(min) ? (max - min) * scale : 0.08;
}

// Keyed by drink id, because `merge` orders its scenes alphabetically rather
// than in the order the files were passed — matching by position silently
// pairs each drink with someone else's width.
const widthById = new Map();
console.log("\n  drinks:");
for (const f of inputs) {
  const id = path.basename(f, ".glb");
  const w = widthOf(f);
  widthById.set(id, w);
  console.log(`    ${id.padEnd(20)} ${(w * 100).toFixed(1)} cm wide`);
}

console.log("\n  [1/2] merge");
execFileSync("npx", ["--yes", "@gltf-transform/cli", "merge", ...inputs, TMP], { stdio: "inherit" });

console.log("  [2/2] collapse to one scene and lay out in a row");
const { json, bin } = readGLB(TMP);

// `merge` produces ONE SCENE PER INPUT and leaves the default pointing at the
// first, so a viewer shows a single drink and the other five sit unreferenced
// in the file. Collapse every scene's roots into one, in menu order.
const byId = new Map();
json.scenes.forEach((sc) => {
  for (const n of sc.nodes ?? []) byId.set(sc.name ?? String(n), n);
});

const ordered = DRINKS.map((d) => d.id).filter((id) => byId.has(id));
if (ordered.length !== inputs.length) {
  console.warn(`  ! matched ${ordered.length} of ${inputs.length} drinks by name`);
}

// Total run, so the row straddles the origin and lands centred on wherever
// the customer taps rather than starting there and running off to one side.
const total =
  ordered.reduce((a, id) => a + (widthById.get(id) ?? 0.08), 0) + GAP * (ordered.length - 1);

const roots = [];
let x = -total / 2;
for (const id of ordered) {
  const w = widthById.get(id) ?? 0.08;
  json.nodes.push({
    name: `flight-${id}`,
    translation: [x + w / 2, 0, 0],
    children: [byId.get(id)],
  });
  roots.push(json.nodes.length - 1);
  x += w + GAP;
}

// One scene, every drink, and drop the now-redundant per-input scenes so no
// viewer can pick one of them instead.
json.scenes = [{ name: "menu-flight", nodes: roots }];
json.scene = 0;

writeGLB(OUT, json, bin);
rmSync(TMP, { force: true });

const kb = (f) => (statSync(f).size / 1024).toFixed(0);
console.log(`\n✓ ${path.relative(process.cwd(), OUT)}   ${kb(OUT)} KB`);
console.log(`  ${roots.length} drinks, ${(total * 100).toFixed(0)} cm wide, centred on the origin`);
console.log(`  order: ${ordered.join(" → ")}\n`);
