// ============================================================================
// drinks.js — the cocktail menu.
//
// BRAND: this is the ONE file to edit to change what's on the menu. Add,
// remove, or reorder entries and the menu screen rebuilds itself — there is
// no markup to touch.
//
// ---------------------------------------------------------------------------
// GETTING THE MODELS (same pipeline as the gift — see README "Getting your
// model (Meshy → here)")
// ---------------------------------------------------------------------------
//   1. Generate the drink in Meshy, export .glb
//   2. Compress:  npm run compress:glb -- assets/models/drinks/<id>.glb
//   3. Drop it at assets/models/drinks/<id>.glb  (match `id` below)
//
// A drink with no model file still appears on the menu — it renders a
// "photo coming soon" state instead of the 3D viewer. That's deliberate:
// you can write the whole menu now and let it light up drink by drink as
// the art lands. Nothing crashes, nothing 404s into a blank card.
//
// ---------------------------------------------------------------------------
// REAL-WORLD SCALE — the one gotcha that will bite you
// ---------------------------------------------------------------------------
// "View in your space" hands the model to iOS Quick Look / Android Scene
// Viewer, which place it at the size it was authored. Meshy exports are
// almost never to scale, so an unscaled cocktail can arrive the size of a
// bar stool. One command handles this, along with compression and AR pivot:
//
//   npm run drink -- ~/Downloads/negroni_raw.glb negroni --glass rocks
//
// (Note: gltf-transform's `resize` command does NOT do this — it resizes
// TEXTURES, not geometry, and there is no geometry-scale command in its CLI.
// scripts/prep-drink.mjs does the scaling itself.)
//
// Rough real heights to aim for: rocks glass 0.09 m, coupe 0.12 m,
// highball 0.15 m, flute 0.22 m. Check by placing it next to a real glass.
// ============================================================================

// Where the browse screen looks for models. Keeping drinks in their own
// folder keeps them clear of the gift model, which has a different job.
export const DRINK_MODEL_DIR = "assets/models/drinks";

export const DRINKS = [
  {
    id: "old-fashioned",
    name: "Old Fashioned",
    tagline: "Bourbon, demerara, aromatic bitters, orange oil",
    price: "£12",
    // BRAND: shown in the list before the 3D loads, and as the "coming
    // soon" face for drinks with no model yet.
    emoji: "🥃",
    // Tint behind the model in the detail view. Pick something close to the
    // drink's real colour — it does a lot of work selling the preview.
    accent: "#c97b2c",
  },
  {
    id: "espresso-martini",
    name: "Espresso Martini",
    tagline: "Vodka, fresh espresso, coffee liqueur",
    price: "£13",
    emoji: "☕",
    accent: "#4a2c1a",
  },
  {
    id: "negroni",
    name: "Negroni",
    tagline: "Gin, Campari, sweet vermouth, orange",
    price: "£11",
    emoji: "🍊",
    accent: "#c1272d",
  },
  {
    id: "margarita",
    name: "Tommy's Margarita",
    tagline: "Tequila blanco, lime, agave, salt rim",
    price: "£12",
    emoji: "🍋",
    accent: "#b9d14a",
  },
  {
    id: "french-75",
    name: "French 75",
    tagline: "Gin, lemon, sugar, topped with champagne",
    price: "£14",
    emoji: "🥂",
    accent: "#e8d98a",
  },
  {
    id: "alibi-sour",
    name: "The Alibi Sour",
    tagline: "House signature — rye, blackberry, lemon, egg white",
    price: "£13",
    emoji: "🍒",
    accent: "#7b2d5e",
  },

  // ---------------------------------------------------------------------
  // THE FLIGHT — every drink in one placement
  // ---------------------------------------------------------------------
  // Built by `npm run flight`, which merges the light drinks/ar/ builds into
  // a single 73 cm row centred on the origin.
  //
  // It exists because of a hard platform limit: native AR on iOS is a FILE
  // handoff to Quick Look, so a drink cannot be swapped once placed — the
  // page is not running and there is no scene to change. Putting all six in
  // one file sidesteps that entirely. One tap, the whole menu on the table,
  // rock steady, and nothing to switch because nothing is hidden.
  //
  // It rides the ordinary carousel machinery: same screen, same AR button,
  // same modes. Just another entry with a model behind it.
  {
    id: "menu-flight",
    name: "The Whole Menu",
    tagline: "All six, side by side on your table",
    price: "Tasting flight",
    emoji: "🍸",
    accent: "#6fe3ff",
  },
];

// Resolve a drink's model path from its id. Kept as a function rather than a
// field on each entry so adding a drink means adding a name and an id, not
// remembering to hand-write a path that has to match the filename anyway.
export function modelPathFor(drink) {
  return `${DRINK_MODEL_DIR}/${drink.id}.glb`;
}

// Optional per-drink USDZ override for iOS Quick Look. model-viewer will
// generate a USDZ on the fly when this is absent, which is fine for static
// models — supply a hand-authored one only if a drink has an animation or a
// material that survives the auto-conversion badly.
export function iosModelPathFor(drink) {
  return drink.iosModel || null;
}
