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
