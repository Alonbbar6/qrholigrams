# Table Gift AR — Image-Tracking Web AR for a Bar

Scan the QR code on a printed table card → tap once → point the camera back at
that same card → an animated 3D gift appears **locked to the card**, staying
attached to the artwork as you move your phone around it.

```
Printed table card (QR + branded artwork)
   → phone camera scans QR (no app)
   → branded intro screen, "Tap to see your gift"
   → camera opens, recognizes THE CARD ITSELF as an AR marker
   → gift renders locked to the card, tracking as you move
```

**Live:** https://qrholigrams-bar-gift.netlify.app

---

## 1. The AR approach (and why it changed)

There are two very different ways to do web AR, and this project uses the
second one:

| | Native AR (`<model-viewer>`) | **Image tracking (MindAR)** ← *this project* |
|---|---|---|
| How it anchors | Scans the *floor/table surface*, you tap to drop the model | Continuously recognizes **the printed card** and locks the model to it |
| Feels like | Model sits on the table where you tapped | Model is *part of the card* — move the card, it follows |
| Runs in | Native OS viewer (iOS Quick Look / Android Scene Viewer) | Entirely in the browser (three.js + WebGL + camera) |
| Needs | `.glb` + `.usdz` | `.glb` + a compiled `.mind` target per card |
| Low light | Very robust | **More sensitive** — needs decent light + a detailed card |

We switched to image tracking because "make it look like part of the card"
is not something native Quick Look / Scene Viewer can do — they anchor to
surfaces, not to artwork.

**The tradeoff to know:** image tracking is more finicky in dim bar lighting
than native surface AR. The card design compensates by packing lots of
visual detail (scattered shapes, border, text) across the whole card —
a bare QR on a blank background tracks poorly. Don't strip that texture out.

---

## 2. Project structure

```
.
├── index.html                    Single page: intro, AR camera view, fallback
├── css/style.css                 All styling + brand colors (edit vars at top)
├── js/main.js                    Screen flow, AR lifecycle, analytics hooks
├── js/ar-experience.js           MindAR + three.js setup, model load, animation
├── js/drinks.js                  ★ THE MENU — edit this to change drinks
├── js/menu.js                    Cocktail browser + native-AR handoff
├── js/vendor/                    Vendored libs (no CDN at runtime)
│   ├── confetti.js                 canvas-confetti (MIT)
│   ├── three/                      three.js r152 + GLTFLoader + CSS3DRenderer
│   ├── model-viewer/               <model-viewer> 3.5.0 (fallback + menu)
│   └── mindar/                     MindAR image-tracking build
├── assets/models/gift-placeholder.glb    The 3D gift
├── assets/models/drinks/*.glb            One per drink id (see js/drinks.js)
├── assets/cards/table-N-card.png         PRINT THESE — table tent artwork
├── assets/targets/table-N.mind           Compiled AR target per card
├── scripts/generate-table.mjs    ★ Main generator: card + QR + AR target
├── scripts/prep-drink.mjs        Raw AI export → menu-ready drink model
├── scripts/generate-qr.js        Bare QR only (legacy/simple case)
├── _headers                      Netlify MIME types for .glb/.mind
└── package.json
```

No build step, no framework, no bundler — plain static files.

---

## 2b. The cocktail menu (3D browse + native AR)

Tapping **"Browse the bar menu"** on the intro screen opens a list of drinks.
Tapping a drink shows it in 3D, and **"View on your table"** places it in the
room at real size.

**This uses a different AR stack than the gift, on purpose.** The gift must
lock to the printed card, which only in-browser image tracking can do. Drinks
don't — so they hand off to **iOS Quick Look / Android Scene Viewer**, which
track with ARKit/ARCore SLAM instead of re-solving a marker pose from camera
pixels every frame. Per the table in section 1, that's *"Very robust"* in low
light where image tracking is *"More sensitive"* — which matters a lot in a
bar. The menu does not wobble in a dim room; the gift still can.

### Editing the menu

Everything lives in [`js/drinks.js`](js/drinks.js) — name, tagline, price,
emoji, accent colour. Add an entry and the screen rebuilds itself. No markup
to touch.

### Adding a drink model

Export from Meshy/Tripo, then one command turns it into a menu-ready drink:

```bash
npm run drink -- ~/Downloads/negroni_raw.glb negroni --glass rocks
```

That writes `assets/models/drinks/negroni.glb`, where the id must match an
entry in [`js/drinks.js`](js/drinks.js). A drink with no file still shows on
the menu with a "3D preview coming soon" card, so you can write the full menu
before any art exists.

The script runs three steps, **in this order**:

1. `center --pivot below` — pivot at the glass's base, so native AR sits it on
   the floor plane instead of half-sunk into the table.
2. `optimize` — draco geometry + webp textures.
3. scale to a real-world height in metres.

Centering has to come *before* compression: it decodes Draco geometry and
doesn't re-compress, which roughly doubles the output if run afterwards.

⚠️ **Scale matters.** Native AR places a model at its authored size, and
Meshy exports rarely are — an unscaled cocktail arrives the size of a bar
stool. `--glass` presets: `rocks` 0.09 · `coupe` 0.12 · `highball` 0.15 ·
`flute` 0.22 · `wine` 0.20 m, or pass `--height 0.11`.

> Note: gltf-transform's `resize` command does **not** do this — it resizes
> *textures*. Its CLI has no geometry-scale command, so `prep-drink.mjs`
> performs that step itself by wrapping the scene roots in a scaled node.

### Menu-only QR

`?menu=1` deep-links straight to the menu, skipping the gift flow. Useful for
a QR at the bar counter where there's no table card:

```bash
node scripts/generate-qr.js "https://qrholigrams-bar-gift.netlify.app/?menu=1"
```

---

## 3. Generating a table card

**One command produces all three things a table needs, kept in sync:**

```bash
npm run table -- 1        # table 1
npm run table -- 2        # table 2, etc.
```

That writes:
1. `assets/cards/table-1-card.png` — **the printable artwork** (QR baked in)
2. `assets/targets/table-1.mind` — the compiled AR target for that exact card
3. `qr-output/table-1-qr.png` — the bare QR alone, if you want it separately

> ⚠️ **Critical:** the `.mind` target is a compiled fingerprint of the card's
> exact pixels. If you change the card design *at all* (colors, bar name,
> layout), you **must re-run `npm run table`** for every table — otherwise the
> printed card and the AR target no longer match, and tracking silently fails.

Each table gets its own URL (`/?table=N`) and its own target file, so you can
later give different tables different gifts by branching on `tableId` in
`js/ar-experience.js`.

---

## 4. Testing the QR codes in person

1. **Print the cards** — `assets/cards/table-N-card.png`. Print at
   **at least 10cm (4") tall**; bigger tracks better. Matte cardstock beats
   glossy (glossy reflects bar lights and breaks tracking).
   *For a quick test right now, displaying the card full-screen on a second
   monitor / tablet also works — but printed is the real test.*
2. **Scan the QR** with your phone's **native camera app**. A banner appears →
   tap it to open the page in Safari (iPhone) or Chrome (Android).
3. **Expect the intro screen** — dark background, floating gift emoji,
   pulsing "Tap to see your gift" button.
4. **Tap the button.** Confetti fires, then the browser asks for **camera
   permission — tap Allow**. (Denying it drops you to the 3D fallback view.)
5. **Point the camera at the same printed card.** Hold it so the whole card
   fills a good part of the frame.
6. **The gift appears locked to the card**, with a confetti burst. Move your
   phone around — it should stay attached to the card and shift perspective
   with it. The on-screen hint text disappears once tracking locks on.
7. **Move the card away / cover it** — the model disappears and the hint text
   returns. That's correct behavior.

**Common failure points:**

| Symptom | Cause | Fix |
|---|---|---|
| Model never appears, hint text stays | Card too small in frame, or too dim | Move closer, add light, print bigger |
| Tracking is jittery / model drifts | Glossy paper reflecting light, or a crumpled card | Matte paper, flat surface, avoid direct glare |
| Camera never opens | Permission denied | iPhone: Settings → Safari → Camera → Allow. Android: Chrome → site settings → Camera |
| Works on Android, not iPhone | iOS requires HTTPS + a user tap before camera | Both are already handled — make sure you're on the `https://` URL, not an IP |
| Scanned QR opens the wrong table | Printed an old card after a redesign | Re-run `npm run table -- N` and reprint |
| Camera opens but page is black | WebGL blocked (rare, old device / in-app browser) | Open in real Safari/Chrome, not an in-app webview (Instagram/FB browsers) |

> **In-app browsers** (opening the link from inside Instagram, Facebook,
> TikTok) often block camera access. If a customer scans from within one of
> those, they'll hit the fallback screen. Native camera app → real browser is
> the reliable path.

---

## 5. Deploying

Already linked to Netlify. To push changes:

```bash
netlify deploy --prod --dir=.
```

Free tier, HTTPS included (required — camera access won't work over HTTP).

---

## 6. Swapping in your own branding

- [ ] **Colors** — `:root` variables at the top of `css/style.css`, *and* the
      `COLORS` object in `scripts/generate-table.mjs` (the card uses its own
      copy since it renders server-side).
- [ ] **Bar name / copy** — `index.html` (`<title>`, `.brand-name`,
      `.intro-title`, `.intro-subtitle`) and the header text in
      `scripts/generate-table.mjs`.
- [ ] **Logo** — add to `assets/images/`, replace the `🎁` `.logo-badge` in
      `index.html` with an `<img>`.
- [ ] **Your 3D model** — replace `assets/models/gift-placeholder.glb`.
      **Sizing and seating are automatic**: `js/ar-experience.js` measures the
      model, scales it to `TARGET_HEIGHT` (expressed in card-widths, default
      0.55), centers it, and drops its base onto the card surface. So a model
      of any native size drops in correctly. Tune `TARGET_HEIGHT` if you want
      it bigger/smaller, and `standGroup.rotation.z` for which way it faces.
- [ ] **Re-run `npm run table -- N` for every table** after any card change.

### Getting your model (Meshy → here)

Export **`.glb`** from Meshy. Then optimize before committing:

```bash
npm run compress:textures -- assets/models/your.glb assets/models/gift-placeholder.glb
npm run validate:glb -- assets/models/gift-placeholder.glb
```

Notes:
- **Don't Draco-compress** for this project — the vendored `GLTFLoader` has no
  Draco decoder wired up, so a Draco file will fail to load. WebP texture
  compression alone got the placeholder from 2.87 MB → 266 KB.
- Target **under ~2 MB**; bar wifi is usually mediocre.
- If your model has a **baked animation clip**, it plays automatically. If it
  doesn't, the code falls back to a gentle auto-spin so it still feels alive.

---

## 7. Analytics

`trackEvent(name, detail)` in `js/main.js` — currently `console.log`s.
Events already wired: `page_view`, `gift_reveal_tapped`, `ar_session_started`,
`ar_target_found`, `ar_target_lost`, `ar_session_failed`, `fallback_shown` —
all tagged with the table number, so you can see which tables get used.

A QR *scan* can't be measured directly (it happens in the camera app before
the page loads); `page_view` per table is the closest proxy.

---

## 8. What you still need to provide

- [ ] Bar name + copy, brand colors, logo file
- [ ] Your Meshy `.glb` gift model
- [ ] How many tables (then run `npm run table -- N` for each)
- [ ] (Optional) analytics platform to wire `trackEvent` into
