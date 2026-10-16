---
name: ar-qr-meshy
description: How to set up and change the QR-code AR experience in this repo (The Alibi Bar cocktails in AR) — generating table cards, QR codes and MindAR .mind targets, configuring the AR modes and tuning knobs, and taking Meshy (or Tripo) 3D exports through the drink-model pipeline into the menu. Use when adding a table, re-generating cards or QR codes, adding/replacing/fixing a drink or gift model, changing the menu, rebranding the card, tuning tracking, or debugging "model doesn't appear / wrong size / jittery / coming soon".
---

# AR + QR + Meshy models — The Alibi Bar

Static site, no build step. A printed table card carries a QR code to
`/?table=N`; the page shows a swipeable 3D cocktail menu and lets the customer
place a drink in AR. Live: https://qrholigrams-bar-gift.netlify.app

```
table card (QR + artwork) → /?table=N → intro → 3D carousel → AR mode:
  ✨ Place & swipe  WebXR in our three.js renderer   (Android Chrome only)
  📱 Steady         iOS Quick Look / Android Scene Viewer (file handoff)
  🃏 Auto on card   MindAR image tracking on the printed card
```

## Where things live

| Path | Role |
|---|---|
| `js/drinks.js` | **The menu.** `DRINKS` array (id, name, tagline, price, emoji, accent) + `USDZ_DRINKS` opt-in set |
| `js/ar-experience.js` | MindAR + three.js card AR; reads `?table=`, loads `assets/targets/table-N.mind`, `TARGET_HEIGHT` (0.55 card-widths), facing (`standGroup.rotation.z`), tuning URL params |
| `js/webxr-experience.js` | Place & swipe (WebXR) |
| `js/menu.js` | Carousel + `<model-viewer>` native-AR handoff |
| `js/main.js` | Screen flow, routes, `trackEvent` analytics |
| `assets/models/drinks/<id>.glb` | Full-detail drink (browse + native AR) |
| `assets/models/drinks/ar/<id>.glb` | Light copy, used by card AR **and** WebXR |
| `assets/models/drinks/<id>.usdz` | Optional pre-built Quick Look file |
| `assets/models/gift-placeholder.glb` | Gift model for `?gift=1` |
| `assets/cards/table-N-card.png` | Printable card |
| `assets/targets/table-N.mind` | Compiled tracking target for that exact card |
| `qr-output/table-N-qr.png` | Bare QR |
| `scripts/` | Generators and measurement tools (below) |

`js/vendor/` holds every library — **nothing may be fetched at runtime**.

## Task: set up a table (QR + card + AR target)

```bash
npm install                     # once (canvas, mind-ar, qrcode)
npm run table -- 5              # uses DEFAULT_SITE_URL in generate-table.mjs
npm run table -- 5 https://other-site.netlify.app
```

Writes all three in sync: `assets/cards/table-5-card.png`,
`assets/targets/table-5.mind`, `qr-output/table-5-qr.png`. The QR encodes
`<site>/?table=5`, and `ar-experience.js` loads `table-5.mind` from that param
— no code change needed to add a table.

Rules:
- The `.mind` file is a fingerprint of the card's exact pixels. **Any card
  change (colour, text, layout, `COLORS`, `CARD_W/H`) → re-run `npm run table`
  for every table and reprint.** Otherwise tracking silently fails.
- Card artwork is load-bearing for tracking; read the comments in
  `buildCardImage()` before altering the texture. Redesigning for "better
  tracking" has been measured not to help (62 → 64 points; fine grain halved
  it). Don't propose it.
- Check trackability: `node scripts/measure-target.mjs 5` (<60 poor,
  60–150 usable, >150 good). Note there is no `npm run measure` script.
- Cards encode `/?table=N` with no mode flag on purpose, so landing behaviour
  can change without reprinting.

Other QR codes (no card/target): `node scripts/generate-qr.js <url>` →
`qr-output/gift-qr.png` + `.svg`. E.g. a bar-counter QR to
`https://qrholigrams-bar-gift.netlify.app/?menu=1`.

Routes: `/?table=N` (intro → AR carousel), `?browse=1` (3D carousel, no
camera), `?menu=1` (drinks list), `?gift=1` (original gift reveal).

## Task: add or replace a drink from Meshy

1. In Meshy, generate the drink and **export `.glb`**. Opaque drinks work;
   clear spirit over clear ice in clear glass does not (image-to-3D can't
   reconstruct transparency) — shoot without the ice and add it with
   `npm run ice` (step 5).
2. Add/confirm the entry in `js/drinks.js`. `id` must equal the filename.
   A drink with no model still renders a "coming soon" card, so the menu can
   be written first.
3. Build the full model (centre pivot → optimize → real-world scale → USDZ):
   ```bash
   npm run drink -- ~/Downloads/negroni_raw.glb negroni --glass rocks
   ```
   `--glass`: `rocks` 0.09 · `coupe` 0.12 · `highball` 0.15 · `flute` 0.22 ·
   `wine` 0.20 m, or `--height 0.11`. Also `--ratio`, `--error`,
   `--texture-size`, `--no-usdz`.
4. Build the light AR variant (required for card AR / WebXR, and the flight):
   ```bash
   npm run drink -- ~/Downloads/negroni_raw.glb negroni --glass rocks --variant ar
   ```
5. Optional ice: `npm run ice -- --drink old-fashioned [--radius 0.45 --centre 0.58]`
   (rewrites `<id>.glb`; re-run step 4 afterwards so ar/ and USDZ match).
6. Rebuild the all-drinks placement whenever any ar/ model changes:
   `npm run flight` → `assets/models/drinks/menu-flight.glb`.
7. Validate: `npm run validate:glb -- assets/models/drinks/negroni.glb`.
8. Optional: add the id to `USDZ_DRINKS` in `js/drinks.js` only after the
   `.usdz` has been eyeballed in Quick Look — it's 5× the GLB's size.
   Otherwise iOS converts the GLB on device.

Why the pipeline is shaped this way (don't "simplify" it):
- **Centre before compressing.** `center` decodes Draco and doesn't
  re-compress; running it after doubles the file.
- **Scale is mandatory.** Native AR places models at authored size; Meshy
  exports arrive bar-stool sized. gltf-transform's `resize` scales
  *textures*, not geometry — `prep-drink.mjs` wraps the roots in a scaled node.
- Raw Meshy exports can be 75 MB / 2 M triangles / 4×2048² textures;
  explicit simplify/texture budgets are passed because optimize's defaults
  barely touch them. Target ~1 MB full, ~0.4 MB ar/.

## Task: replace the gift model (`?gift=1`)

Export `.glb` from Meshy, then:
```bash
npm run compress:textures -- ~/Downloads/your.glb assets/models/gift-placeholder.glb
npm run validate:glb -- assets/models/gift-placeholder.glb
```
Sizing/seating on the card is automatic (`TARGET_HEIGHT`). Baked animation
clips play automatically; otherwise it auto-spins. Keep it under ~2 MB.

## Draco / no-CDN rule

Draco is decoded locally: `DRACOLoader.setDecoderPath("js/vendor/draco/")` in
`ar-experience.js` and `webxr-experience.js`, and
`dracoDecoderLocation = "js/vendor/draco/"` in `menu.js`. Any new loader or
`<model-viewer>` instance must set these too, or it silently reaches
`gstatic.com` — on captive-portal wifi that hangs with no load/error event and
every drink shows "coming soon". (The README's older "don't Draco-compress"
note predates this wiring.)

## AR configuration and tuning

URL params, no deploy needed (read in `js/ar-experience.js`):

| Param | Default | Effect |
|---|---|---|
| `?miss=` | 18 | frames lost before the model hides |
| `?warmup=` | 5 | frames detected before it appears |
| `?mincf=` / `?beta=` | 0.001 / 1000 | One Euro filter (A/B tested, defaults won) |
| `?torch=1` | off | flashlight — biggest single lever in a dark bar |
| `?debug=1` | off | logs camera capabilities and pose samples |

Code-level knobs: `TARGET_HEIGHT` and `standGroup.rotation.z` (size and
facing on card) in `ar-experience.js`; per-table content can branch on
`tableId`.

Measuring instead of eyeballing: `npm run jitter [-- --video real.y4m --miss 25]`
replays footage through real MindAR and reports median second-difference
(lower is better, compare only against the same video). Also
`npm run record-ar`, `npm run turntable` (render a model to check it).

Known dead ends — don't re-suggest: anchoring native AR to the card (Quick
Look ignores USDZ image anchors; Scene Viewer is plane-only), WebXR image
tracking (absent on iOS Safari), 8th Wall (shut down Feb 2026).

## Branding checklist

Colours: `:root` in `css/style.css` **and** `COLORS` in
`scripts/generate-table.mjs`. Copy: `index.html` + header text in
`generate-table.mjs`. Then re-run `npm run table -- N` for every table.

## Run, test, deploy

- Local: `npm run dev` → http://localhost:5000 (camera needs HTTPS on a
  phone; test on device against the deployed URL or an HTTPS tunnel).
- Deploy: `netlify deploy --prod --dir=.` (`_headers` sets `.glb`/`.mind` MIME).
- In-person test and symptom table: see
  [references/troubleshooting.md](references/troubleshooting.md).
