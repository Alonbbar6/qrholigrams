#!/usr/bin/env node
// ============================================================================
// measure-target.mjs — reports how trackable a compiled .mind target is.
//
//   npm run measure -- 1
//
// The number that matters most is TRACKING points: MindAR uses these to follow
// the card frame-to-frame once it's been found, and a low count is what makes
// the model jitter and drift. Matching keypoints (used to first *find* the
// card) are usually plentiful and less of a bottleneck.
//
// Rough guide for total tracking points:
//   < 60    poor    — expect visible wobble and frequent loss
//   60–150  usable  — reasonable in good light
//   > 150   good    — holds steady
// ============================================================================

import { decode } from "@msgpack/msgpack";
import { readFileSync } from "node:fs";
import path from "node:path";

const table = process.argv[2] || "1";
const file = path.join(process.cwd(), "assets", "targets", `table-${table}.mind`);

const data = decode(new Uint8Array(readFileSync(file))).dataList[0];

let matching = 0;
for (const m of data.matchingData) {
  matching += m.maximaPoints.length + m.minimaPoints.length;
}

let tracking = 0;
const perLevel = [];
for (const t of data.trackingData) {
  tracking += t.points.length;
  perLevel.push(`${t.width}x${t.height}: ${t.points.length}`);
}

const verdict =
  tracking > 150 ? "GOOD — should hold steady" :
  tracking >= 60 ? "USABLE — okay in good light" :
  "POOR — expect visible wobble";

console.log(`\nTarget: table-${table}.mind  (${data.targetImage.width}x${data.targetImage.height})`);
console.log(`  matching keypoints : ${matching}  (finding the card)`);
console.log(`  tracking points    : ${tracking}  (following it) — ${perLevel.join(", ")}`);
console.log(`\n  ${verdict}\n`);
