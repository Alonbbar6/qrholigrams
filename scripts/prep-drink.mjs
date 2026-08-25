#!/usr/bin/env node
// ============================================================================
// prep-drink.mjs — turn a raw Meshy/Tripo export into a menu-ready drink.
//
// Usage:
//   node scripts/prep-drink.mjs <input.glb> <drink-id> [--height 0.09]
//   npm run drink -- ~/Downloads/negroni_raw.glb negroni --height 0.09
//
// Writes assets/models/drinks/<drink-id>.glb, where <drink-id> must match an
// `id` in js/drinks.js.
//
// It runs three steps:
//
//   1. center     — pivot BELOW the model. Native AR places objects on a
//                   detected floor plane, so the pivot needs to be at the
//                   glass's base or the drink floats / sinks into the table.
//   2. optimize   — draco geometry + webp textures. AI exports routinely land
//                   at 100k+ triangles and 4K PNGs; that's a slow download on
//                   bar wifi and a slow first frame on a mid-range phone.
//   3. scale      — to a real-world height in metres (see below).
//
// ORDER MATTERS: centering must come BEFORE compression. `center` cannot
// operate on Draco-compressed geometry without decoding it first, and it does
// not re-compress afterwards — running it second silently doubled the output
// (105 KB back up to 209 KB) while printing only a passing warning. Draco
// goes last so nothing downstream can undo it.
//
// ---------------------------------------------------------------------------
// WHY STEP 3 IS HERE AND NOT A gltf-transform COMMAND
// ---------------------------------------------------------------------------
// glTF Transform has no geometry-scale command. Its `resize` command is a
// TEXTURE operation ("Resize PNG or JPEG textures", --width/--height) and
// will not touch model dimensions — an easy and expensive thing to get wrong,
// because it fails silently: you get a valid GLB that's still bar-stool sized.
//
// So we do it here. Rather than rewriting every vertex, we wrap the scene's
// root nodes in a single parent node carrying a uniform scale. That's exact,
// instant, touches no binary data, and survives Draco compression (already
// applied by step 2 — rewriting vertices at this point would mean decoding
// and re-encoding the very compression we just did).
//
// WHY IT MATTERS: iOS Quick Look and Android Scene Viewer place a model at
// the size it was authored, in metres. Meshy exports are rarely to scale, so
// an unscaled cocktail arrives the size of furniture.
// ============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from "node:fs";
import path from "node:path";

// Real-world heights in metres. Defaults to a rocks glass — override with
// --height for anything else.
const GLASS_HEIGHTS = {
  rocks: 0.09,
  coupe: 0.12,
  highball: 0.15,
  flute: 0.22,
  wine: 0.2,
};
const DEFAULT_HEIGHT = GLASS_HEIGHTS.rocks;

// ---------------------------------------------------------------------------
// BUDGET — why these defaults, and why optimize's own defaults are not enough
// ---------------------------------------------------------------------------
// A raw Meshy export is built for a desktop viewport, not a phone on bar wifi.
// A real one measured here: 75 MB, 1.99 M triangles, 4× 2048² textures — which
// is ~89 MB of VRAM for a single drink, on a device that has to hold a camera
// stream at the same time.
//
// `gltf-transform optimize` does simplify and compress by default, but its
// defaults are tuned to be lossless-ish and barely touch a model this heavy:
//   --simplify-error 0.0001  is far too tight to remove millions of triangles
//   --texture-size   2048    leaves 2048² maps exactly as they are
// So we pass explicit budgets rather than relying on those defaults.
//
// A drink renders on a phone at a few hundred pixels tall. 1024² textures and
// tens of thousands of triangles are past the point of visible difference —
// the limit that matters is time-to-first-frame, not silhouette accuracy.
const DEFAULT_RATIO = 0.05; // keep 5% of vertices
const DEFAULT_ERROR = 0.01; // allow real simplification (optimize default: 0.0001)
const DEFAULT_TEXTURE_SIZE = 1024;

// ---------------------------------------------------------------------------
// ARGS
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  else positional.push(argv[i]);
}

const [inputPath, drinkId] = positional;
const targetHeight = Number(flags.height ?? GLASS_HEIGHTS[flags.glass] ?? DEFAULT_HEIGHT);
const ratio = Number(flags.ratio ?? DEFAULT_RATIO);
const error = Number(flags.error ?? DEFAULT_ERROR);
const textureSize = Number(flags["texture-size"] ?? DEFAULT_TEXTURE_SIZE);

if (!inputPath || !drinkId) {
  console.error(`
Usage: node scripts/prep-drink.mjs <input.glb> <drink-id> [options]

  <drink-id> must match an id in js/drinks.js.

  --glass <name>       rocks|coupe|highball|flute|wine  (sets height)
  --height <metres>    explicit real-world height, overrides --glass
  --ratio <0-1>        fraction of vertices to keep       (default ${DEFAULT_RATIO})
  --error <number>     simplification error tolerance     (default ${DEFAULT_ERROR})
  --texture-size <px>  max texture dimension              (default ${DEFAULT_TEXTURE_SIZE})

Examples:
  node scripts/prep-drink.mjs ~/Downloads/negroni.glb negroni
  node scripts/prep-drink.mjs ~/Downloads/french75.glb french-75 --glass flute
  node scripts/prep-drink.mjs ~/Downloads/raw.glb negroni --ratio 0.1 --texture-size 2048
`);
  process.exit(1);
}

if (!Number.isFinite(targetHeight) || targetHeight <= 0) {
  console.error(`\n--height must be a positive number of metres, got "${flags.height}"\n`);
  process.exit(1);
}

const outDir = path.join(process.cwd(), "assets", "models", "drinks");
const outPath = path.join(outDir, `${drinkId}.glb`);
const tmpA = path.join(outDir, `.tmp-${drinkId}-centered.glb`);
const tmpB = path.join(outDir, `.tmp-${drinkId}-opt.glb`);

mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// GLB CONTAINER
// ---------------------------------------------------------------------------
// A .glb is: a 12-byte header, then length-prefixed chunks. We only need to
// rewrite the JSON chunk, leaving the binary chunk (geometry, textures)
// untouched and byte-identical.
const JSON_CHUNK = 0x4e4f534a; // 'JSON'
const BIN_CHUNK = 0x004e4942; // 'BIN\0'

function readGLB(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a .glb`);

  const chunks = {};
  let off = 12;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    chunks[type] = buf.subarray(off + 8, off + 8 + len);
    // Chunks are 4-byte aligned; skip any padding before the next header.
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json: JSON.parse(chunks[JSON_CHUNK].toString("utf8")), bin: chunks[BIN_CHUNK] };
}

function writeGLB(file, json, bin) {
  const pad = (b, fill) => {
    const rem = (4 - (b.length % 4)) % 4;
    return rem ? Buffer.concat([b, Buffer.alloc(rem, fill)]) : b;
  };
  // JSON pads with spaces, BIN pads with zeros — per the glTF spec.
  const jsonBuf = pad(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const binBuf = bin ? pad(bin, 0x00) : null;

  const parts = [];
  const total = 12 + 8 + jsonBuf.length + (binBuf ? 8 + binBuf.length : 0);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // magic 'glTF'
  header.writeUInt32LE(2, 4); // version
  header.writeUInt32LE(total, 8);
  parts.push(header);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuf.length, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4);
  parts.push(jsonHeader, jsonBuf);

  if (binBuf) {
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binBuf.length, 0);
    binHeader.writeUInt32LE(BIN_CHUNK, 4);
    parts.push(binHeader, binBuf);
  }
  writeFileSync(file, Buffer.concat(parts, total));
}

// ---------------------------------------------------------------------------
// MATRIX HELPERS (glTF matrices are column-major, 16 floats)
// ---------------------------------------------------------------------------
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

// Compose a node's local matrix. glTF says `matrix` and TRS are mutually
// exclusive, and `matrix` wins where present.
function localMatrix(node) {
  if (node.matrix) return node.matrix;

  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];

  // Quaternion → rotation matrix, scaled per-axis, translation in the last
  // column. This is the standard M = T * R * S expansion.
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function transformPoint(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// ---------------------------------------------------------------------------
// BOUNDS
// ---------------------------------------------------------------------------
// Read the world-space bounding box WITHOUT decoding any geometry: glTF
// requires POSITION accessors to declare min/max, so the eight corners of
// each primitive's local box, pushed through its node's world matrix, give an
// exact bound. This is why the step still works after Draco compression —
// accessor min/max survive it.
function worldBounds(json) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const scene = json.scenes?.[json.scene ?? 0];
  if (!scene) return null;

  const visit = (nodeIndex, parentMatrix) => {
    const node = json.nodes[nodeIndex];
    const world = multiply(parentMatrix, localMatrix(node));

    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives ?? []) {
        const acc = json.accessors?.[prim.attributes?.POSITION];
        if (!acc?.min || !acc?.max) continue;
        // All 8 corners — a rotated box's extent isn't captured by
        // transforming only min and max.
        for (let corner = 0; corner < 8; corner++) {
          const p = transformPoint(world, [
            corner & 1 ? acc.max[0] : acc.min[0],
            corner & 2 ? acc.max[1] : acc.min[1],
            corner & 4 ? acc.max[2] : acc.min[2],
          ]);
          for (let i = 0; i < 3; i++) {
            if (p[i] < min[i]) min[i] = p[i];
            if (p[i] > max[i]) max[i] = p[i];
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };

  for (const root of scene.nodes ?? []) visit(root, IDENTITY);
  return Number.isFinite(min[1]) ? { min, max } : null;
}

// Wrap the scene's roots in one new scaled node. Non-destructive: no vertex
// data is touched, so this is safe on already-compressed geometry.
function applyScale(json, factor) {
  const scene = json.scenes[json.scene ?? 0];
  json.nodes.push({
    name: "prep-drink-scale",
    scale: [factor, factor, factor],
    children: [...scene.nodes],
  });
  scene.nodes = [json.nodes.length - 1];
}

// ---------------------------------------------------------------------------
// RUN
// ---------------------------------------------------------------------------
const gltf = (...args) =>
  execFileSync("npx", ["--yes", "@gltf-transform/cli", ...args], { stdio: "inherit" });

const kb = (f) => (statSync(f).size / 1024).toFixed(0);
const cleanup = () => [tmpA, tmpB].forEach((f) => rmSync(f, { force: true }));

try {
  const beforeKb = kb(inputPath);

  console.log(`\n[1/3] center — pivot below (AR floor placement)`);
  gltf("center", inputPath, tmpA, "--pivot", "below");

  console.log(
    `\n[2/3] optimize — simplify to ${ratio * 100}% verts, ${textureSize}px textures, draco + webp`
  );
  gltf(
    "optimize", tmpA, tmpB,
    "--compress", "draco",
    "--texture-compress", "webp",
    "--texture-size", String(textureSize),
    "--simplify", "true",
    "--simplify-ratio", String(ratio),
    "--simplify-error", String(error)
  );

  console.log(`\n[3/3] scale — to ${targetHeight} m tall`);
  const { json, bin } = readGLB(tmpB);
  const bounds = worldBounds(json);

  if (!bounds) {
    // Better to ship an unscaled model with a loud warning than to guess a
    // factor from nothing and silently produce a wrong size.
    console.warn(
      `  ! Could not read bounds (no POSITION min/max). Wrote the model UNSCALED —\n` +
        `    check its size in AR before putting it on the menu.`
    );
    writeGLB(outPath, json, bin);
  } else {
    const height = bounds.max[1] - bounds.min[1];
    if (height <= 1e-9) throw new Error("model has zero height — is it a flat plane?");

    const factor = targetHeight / height;
    applyScale(json, factor);
    writeGLB(outPath, json, bin);

    console.log(`  authored height : ${height.toFixed(4)} units`);
    console.log(`  scale factor    : ${factor.toFixed(5)}`);
    console.log(`  final height    : ${targetHeight} m`);
  }

  console.log(`\n✓ ${path.relative(process.cwd(), outPath)}   ${beforeKb} KB → ${kb(outPath)} KB`);
  console.log(`  Menu id "${drinkId}" — confirm it matches an entry in js/drinks.js.\n`);
} catch (err) {
  console.error(`\n✗ ${err.message}\n`);
  process.exitCode = 1;
} finally {
  cleanup();
}
