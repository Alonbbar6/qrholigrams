# Testing and troubleshooting

## In-person test

1. Print `assets/cards/table-N-card.png` at ≥10 cm tall on **matte** card
   (gloss reflects bar lights). A card shown full-screen on a tablet works
   for a quick check.
2. Scan with the phone's native camera app → open in Safari/Chrome, not an
   in-app browser (Instagram/FB/TikTok often block the camera).
3. Tap through the intro, allow camera access (deny → 3D fallback).
4. In 🃏 mode, fill a good part of the frame with the card; the drink locks
   on and the hint text disappears. Covering the card hides it — correct.

## Symptoms

| Symptom | Likely cause | Fix |
|---|---|---|
| Card AR never shows the model | Card small/dim in frame; or `.mind` out of sync with printed card | Closer, more light, `?torch=1`; re-run `npm run table -- N` and reprint |
| Jitter / drift on card | MindAR has no motion sensors or memory; gloss/crumpled card | Matte, flat, light above table; try `?miss=`; recommend 📱 Steady or ✨ Place & swipe |
| Drink huge/tiny in native AR | Model not scaled | Re-run `npm run drink` with correct `--glass` / `--height` |
| Drink floats or sinks into table | Pivot not at base | Re-run `npm run drink` (it centres `--pivot below`) |
| Every drink says "coming soon" | Missing file (id ≠ filename) or a Draco decoder pointing at a CDN | Check `assets/models/drinks/<id>.glb`; confirm local decoder paths |
| Card AR / WebXR shows nothing but browse works | Missing `drinks/ar/<id>.glb` | `npm run drink -- raw.glb <id> --variant ar` |
| Odd materials in iOS Quick Look | On-device USDZ conversion | Ship pre-built USDZ, add id to `USDZ_DRINKS` |
| Old flight after drink update | `menu-flight.glb` not rebuilt | `npm run flight` |
| ✨ Place & swipe greyed out | iPhone Safari has no WebXR | Expected; uses 📱 Steady |
| Camera never opens | Permission denied or not HTTPS | iOS: Settings → Safari → Camera; Android: site settings; use `https://` |
| QR opens wrong table | Old printed card | Regenerate and reprint |
| `.glb`/`.mind` served wrong type | Missing `_headers` on host | Keep `_headers` deployed (Netlify) |
