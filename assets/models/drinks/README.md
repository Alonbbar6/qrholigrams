# Drink models

One `.glb` per drink, named to match the `id` in [`js/drinks.js`](../../../js/drinks.js).

    old-fashioned.glb
    espresso-martini.glb
    negroni.glb
    margarita.glb
    french-75.glb
    alibi-sour.glb

A drink with no file here still appears on the menu — it shows a
"3D preview coming soon" card instead of the viewer. Add files as the art lands.

## Pipeline (Meshy → here)

One command does everything — export from Meshy, then:

    npm run drink -- ~/Downloads/negroni_raw.glb negroni --glass rocks

It runs, in this order:

1. **center** `--pivot below` — puts the pivot at the glass's base, which is
   what native AR needs to sit it on a detected floor plane.
2. **optimize** — draco geometry + webp textures.
3. **scale** — to a real-world height in metres.

Order matters: centering must precede compression, or it decodes the Draco
geometry and doesn't re-compress, roughly doubling the file.

`--glass` presets: `rocks` 0.09 · `coupe` 0.12 · `highball` 0.15 ·
`flute` 0.22 · `wine` 0.20 (metres). Or pass `--height 0.11` directly.

> ⚠️ gltf-transform's `resize` command does **not** scale geometry — it
> resizes *textures*. Its CLI has no geometry-scale command at all, which is
> why `prep-drink.mjs` does that step itself.

Check the result:

    npm run validate:glb -- assets/models/drinks/negroni.glb
