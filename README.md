# The Alibi Bar — Cocktails in AR

Scan the QR code on a printed table card and the bar's cocktails appear in 3D,
with prices. Swipe between them, then put one on your table in AR. No app.

```
Printed table card (QR + branded artwork)
   → phone camera scans QR (no app install)
   → swipeable 3D menu: six cocktails, name / tagline / price
   → "Place it on your table"  → native AR, rock steady
     or "Show it on my card"   → auto-anchors to the printed card
```

**Live:** https://qrholigrams-bar-gift.netlify.app

The gift reveal this project started as still exists at `?gift=1` — the same
card-tracking machinery, pointed at a present instead of a drink.

---

## 1. Two AR engines, and why both are here

Neither engine wins outright, so the drink screen offers a toggle and
remembers the choice per device.

| | **Steady** *(default)* | **Auto on card** |
|---|---|---|
| Runs in | iOS Quick Look / Android Scene Viewer | the browser (MindAR + three.js) |
| Anchors to | wherever the customer taps | the printed card, unaided |
| How it tracks | ARKit/ARCore: camera **fused with motion sensors**, plus a map of the room | re-solves the card's pose from camera pixels, every frame, with no memory |
| Stability | **does not move, in any lighting** | drifts and flickers in a dim room |
| Cost | one tap to position it | none |
| Needs | `.glb` (USDZ auto-generated) | `.glb` + a compiled `.mind` target per card |

The middle row is the whole story. ARKit/ARCore carry the pose through a bad
frame using the gyroscope, and remember where the object sits in the room.
MindAR has neither — one blurred or dim frame and there is simply no answer,
so the drink drops out.

### Things already tried, so nobody retries them

- **Redesigning the card for better tracking does not work.** Measured: the
  current card yields 62 tracking points; adding 400 large distinct shapes
  (44% of pixels changed) yielded 64. Adding fine grain *halved* it to 31,
  because MindAR rejects features that resemble their neighbours. Do not
  reprint hoping for stability.
- **Native AR cannot be anchored to the card.** USDZ has an `image` anchor
  type, but AR Quick Look ignores it; Android Scene Viewer is plane-only.
  Neither exposes any API to constrain or report placement.
- **WebXR image tracking** would do both at once, but does not exist on iOS
  Safari, so it would cover only half of customers.
- **8th Wall** is no longer an option: hosted service shut down 28 Feb 2026,
  and the open-source release excludes SLAM — the part that would have helped.

What genuinely helps card tracking: `?torch=1` (biggest single lever in a dark
bar), a larger matte print lying flat, and light above the table.

### On-site tuning knobs

All URL params, so a venue can tune against its own phones without a deploy:

| Param | Default | What it does |
|---|---|---|
| `?miss=` | 18 | frames of lost tracking before the drink hides |
| `?warmup=` | 5 | frames of detection before it appears |
| `?mincf=` `?beta=` | 0.001 / 1000 | One Euro filter (A/B tested; defaults won) |
| `?torch=1` | off | turns the phone flashlight on |
| `?debug=1` | off | logs camera capabilities and pose samples |

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
├── js/vendor/                    Vendored libs (NOTHING is fetched at runtime)
│   ├── confetti.js                 canvas-confetti (MIT)
│   ├── three/                      three.js r152 + GLTFLoader + DRACOLoader
│   ├── model-viewer/               <model-viewer> 3.5.0 (menu + fallback)
│   ├── draco/                      Draco decoder — see the warning below
│   └── mindar/                     MindAR image-tracking build
├── assets/models/gift-placeholder.glb    The 3D gift
├── assets/models/drinks/*.glb            Full detail: 3D browse + native AR
├── assets/models/drinks/ar/*.glb         Light copies: card AR only
├── assets/cards/table-N-card.png         PRINT THESE — table tent artwork
├── assets/targets/table-N.mind           Compiled AR target per card
├── scripts/generate-table.mjs    ★ Main generator: card + QR + AR target
├── scripts/prep-drink.mjs        Raw AI export → menu-ready drink model
├── scripts/generate-qr.js        Bare QR only (legacy/simple case)
├── _headers                      Netlify MIME types for .glb/.mind
└── package.json
```

No build step, no framework, no bundler — plain static files.

> ⚠️ **Vendoring means nothing is fetched at runtime — check that stays true.**
> A vendored library can still reach out on its own: `<model-viewer>` pulls its
> Draco decoder from `gstatic.com` unless `dracoDecoderLocation` is set, and
> three.js needs `DRACOLoader.setDecoderPath()`. Compressing the drink models
> silently reintroduced that CDN dependency once already. The failure is nasty
> — on a captive-portal wifi the request hangs, no `load` or `error` fires, and
> every drink shows "coming soon" while the file itself is perfectly fine.

---

## 2b. The cocktail menu (3D browse + native AR)

Scanning a table card lands on the intro; one tap opens the swipeable menu.
Swipe or use the arrows to move between drinks — each shows its name, tagline
and price, and the dots track position. Then pick an AR mode and place it.

Swiping stays smooth in any lighting because it is only a 3D view; the camera
is not involved until an AR mode is chosen.

### Routes

| URL | Lands on |
|---|---|
| `/?table=N` | intro → AR drink carousel *(what the printed cards encode)* |
| `?browse=1` | the swipeable 3D carousel, no camera |
| `?menu=1` | the drinks list |
| `?gift=1` | the original gift reveal on the card |

The cards encode `/?table=N` with no mode flag, so the landing experience can
be changed without reprinting anything.

### Choosing how AR anchors

Each drink offers a toggle between two genuinely different engines, because
neither is strictly better:

| | ✨ Place & swipe | 📱 Steady | 🃏 Auto on card |
|---|---|---|---|
| Engine | **WebXR** in our own renderer | Quick Look / Scene Viewer | MindAR |
| Anchors to | where you tap | where you tap | the printed card |
| Stability | **steady** (platform tracker) | **steady** (platform tracker) | wobbles in dim rooms |
| Change drink in place? | **yes — swipe, no re-placing** | no, re-place each time | yes |
| Works on | Android Chrome | iOS **and** Android | iOS and Android |

**Place & swipe is the only mode that is both steady and swipeable**, and it
is preferred wherever it exists. The reason it can do both is that the WebXR
session runs inside *our* three.js renderer — so changing drinks is a
scene-graph swap, exactly as in card AR — while the poses come from the same
platform tracker native AR uses.

Native AR cannot do this because it is a **file handoff**, not a live scene:
Safari passes a USDZ to AR Quick Look and Android fires an intent at Scene
Viewer. The page is backgrounded, there is no scene to modify, and neither
viewer reports where the object was placed. Changing the drink means handing
over a different file, which is a new session on a blank slate.

The catch on Place & swipe is coverage: **iPhone Safari does not implement
WebXR** and Apple has committed to no timeline, so iPhones fall back to
Steady. Its segment disables itself rather than disappearing.

The choice is remembered per device in `localStorage`. A mode the device
cannot do disables itself rather than disappearing, so the trade stays
visible.

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
3. **Expect the intro screen** — dark background, floating badge, pulsing
   "Tap to see the drinks" button. (At `?gift=1` the same button reads
   "Tap to see your gift" and runs the original reveal instead.)
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

**Blocking — the menu is live with invented content:**

- [ ] **Real drink names, taglines and prices.** The six currently shipping
      ("The Alibi Sour", £11–£14, and the rest) are placeholders, not your
      menu. One file: [`js/drinks.js`](js/drinks.js).
- [ ] Bar name + copy, brand colours, logo file

**Done:**

- [x] All six drink models (full + light card-AR variants)
- [x] Table cards, QR codes and compiled `.mind` targets for tables 1–4

**Optional:**

- [ ] Re-roll the **Old Fashioned** — the only model that came out badly, an
      opaque cup with no ice. Clear spirit over clear ice is the one thing AI
      3D reliably fails; shooting it *without* the ice sphere should fix it.
      The other five are fine because their drinks are opaque.
- [ ] A `.usdz` per drink for iOS, if the auto-generated one looks off —
      `iosModel` in [`js/drinks.js`](js/drinks.js) picks it up.
- [ ] More tables: `npm run table -- N`
- [ ] Analytics platform to wire `trackEvent` into
