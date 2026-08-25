#!/usr/bin/env node
// ============================================================================
// generate-qr.js — generates the QR code that goes on your table tents.
//
// Usage:
//   node scripts/generate-qr.js https://your-site.netlify.app
//   (or just `npm run qr -- https://your-site.netlify.app`)
//
// Outputs to qr-output/:
//   gift-qr.png  — 1200x1200px, for print / design tools (Canva, Figma, etc.)
//   gift-qr.svg  — vector, scales to any size with no quality loss
// ============================================================================

import QRCode from "qrcode";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// BRAND: set a default here so `npm run qr` works with no arguments once
// you've deployed, or just pass the URL on the command line every time.
const DEFAULT_URL = "https://your-bar-ar-gift.netlify.app";

const url = process.argv[2] || DEFAULT_URL;

if (!url.startsWith("http")) {
  console.error(
    `\n"${url}" doesn't look like a URL. Usage:\n  node scripts/generate-qr.js https://your-site.netlify.app\n`
  );
  process.exit(1);
}

const outDir = path.join(process.cwd(), "qr-output");
await mkdir(outDir, { recursive: true });

// Error correction level 'H' (30% recoverable) gives you room to place a
// logo over the center later without breaking scannability.
const options = {
  errorCorrectionLevel: "H",
  margin: 3, // quiet zone — don't shrink this, scanners rely on it
  color: {
    dark: "#14101c",
    light: "#ffffffff",
  },
};

const pngPath = path.join(outDir, "gift-qr.png");
const svgPath = path.join(outDir, "gift-qr.svg");

await QRCode.toFile(pngPath, url, { ...options, width: 1200 });
const svgString = await QRCode.toString(url, { ...options, type: "svg" });
await writeFile(svgPath, svgString);

console.log(`\nQR code generated for: ${url}`);
console.log(`  ${pngPath}`);
console.log(`  ${svgPath}`);
console.log(
  `\nTest it before printing: scan gift-qr.png with your own phone camera app.\n`
);
