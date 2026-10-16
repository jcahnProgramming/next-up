# Game logo library

Every game logo a card can use lives in this folder, committed to the repo. This is the only source of card
images: Next Up never accepts an uploaded image, and never fetches one from the internet.

## Convention

- **One file per game**, named after the game in lowercase kebab-case: `world-of-warcraft.webp`,
  `final-fantasy-xiv.webp`, `helldivers-2.webp`. Letters `a-z`, digits and single hyphens only. The file name
  (without the extension) is the logo's id, so **never rename a file once a board uses it**; add a new one.
- **Format:** WebP (preferred) or PNG. No SVG (it can carry script), no JPEG transparency hacks, no animation.
- **Size:** 1200 × 300 px (4:1), the shape of a wide, short pill card. At most 200 KB.
- **Composition:** the card is a rounded pill, so the corners are cut away, and it gets narrower on a phone, which
  crops the sides. Keep the logo itself inside the **middle 60% of the width** and the middle 80% of the height.
  Fill the rest with background from the art, not a flat colour.
- **No text overlays or darkening baked in.** The card puts the game's name and a scrim over the image itself, the
  same in every theme.
- Only use art you're allowed to use for a private guild tool (official press kits, fan kits).

## Display names

Each file declares one logo. Its display name (shown in the logo dropdown, and filled in as the card's title when
someone picks it for an untitled card) is the file name title-cased: `v-rising.webp` is **V Rising**,
`helldivers-2.webp` is **Helldivers 2**.

When title-casing gets it wrong, add the right name to `names.json` in this folder:

```json
{
  "final-fantasy-xiv": "Final Fantasy XIV",
  "sons-of-the-forest": "Sons of the Forest"
}
```

Keys are file names without the extension; names are 1 to 60 characters. A key with no matching image is an error,
so remove its entry when you remove a file.

## Checked at build time

`npm run build` runs `scripts/check-logos.js`, and the client build checks again, so a bad file fails the build (and
the deploy) with a message naming the file and what's wrong: the wrong size or format, an animation, a name that
breaks the convention, over 200 KB, a file whose contents don't match its extension, two formats of one game, or a
stray `names.json` entry. Run `node scripts/check-logos.js` to check before committing.

If a logo a card uses is ever removed, that card quietly shows the no-logo card instead of a broken image.
