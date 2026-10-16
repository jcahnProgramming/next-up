# Next Up UI system, v1

The finished UI design for Next Up, exported verbatim from the Claude Design canvas on 2026-10-15.

- Canvas: https://claude.ai/artifact/GVhhGKUUKPaCbaySUsvkWU (version `1792120277-560c`)
- Exported: 2026-10-15

**This folder is the source of truth for the UI.** Read the relevant artboards before building any screen. If the
canvas and this folder ever disagree, re-export; never hand-edit the files here. If an artboard disagrees with the
settled decisions below or with `CLAUDE.md`, the decisions win: flag it rather than building it.

## Files

`nu.css` is the stylesheet every artboard uses: the theme tokens for all five themes plus the component classes.
`canvas.json` is the canvas layout (board positions, section titles, order).

The artboards are `.dc.html` files for the Design canvas runtime. They load `./support.js`, which the canvas supplies,
so they don't render on their own: open the canvas link to see them, or read the markup and `nu.css` directly.

| File | What it shows |
| --- | --- |
| `Main.dc.html` | The five themes side by side (text levels, buttons, sync pills, lane, cards, input, swatches), plus spacing, radius, type scale and motion |
| `Tokens.dc.html` | Every theme token's value in all five themes, read live from `nu.css`, plus the shared card and button tokens |
| `Components.dc.html` | Buttons and their states, text fields, themed dropdown, themed date picker, code chip, phone lane header, player chips, live-sync pills, badges, avatars, banners, toast, empty vs error states (two themes, switchable) |
| `Card-Anatomy.dc.html` | Card anatomy at 2×, the 1200 × 300 logo art spec and safe zone, the no-logo card in all five themes, scrim stress test, content rules |
| `Card-States.dc.html` | A card in every state, with and without a logo, in all five themes |
| `Topbar-Options.dc.html` | Top bar A: open board, password board unlocked here (with the lock button), lock screen |
| `Landing-Desktop.dc.html` | Landing / code entry, desktop |
| `Landing-States.dc.html` | Landing in every state |
| `Landing-Phone.dc.html` | Landing on a phone |
| `Board-Desktop.dc.html` | Board on desktop, live, mid-drag |
| `Lock-Screen.dc.html` | Lock screen: entering, wrong password, too many attempts, unlocking |
| `Board-States.dc.html` | Board: empty, loading, error, offline |
| `Board-Phone.dc.html` | Board on a phone: stacked lanes, and moving a card |
| `Board-Phone-States.dc.html` | Board on a phone: states |
| `Detail-Desktop.dc.html` | Card detail panel, desktop |
| `Detail-Edit.dc.html` | Card edit, desktop |
| `Detail-Phone.dc.html` | Card detail and edit on a phone |
| `Logo-Picker.dc.html` | Logo picker (searchable themed dropdown over `logos/`) |
| `Prompts.dc.html` | Display name prompt |
| `History.dc.html` | History and restore (edits, deletes, moves) |
| `Settings.dc.html` | Settings: theme, display name, this board's password |
| `Changelog.dc.html` | What's new |
| `System-States.dc.html` | System states |

The game art on the artboards (`art-*` classes in `nu.css`) is abstract sample gradients for showing contrast. Real
cards use files from `logos/` only; never port the sample art.

## Settled decisions

These were decided alongside the canvas and are mirrored in `CLAUDE.md`.

- **Access.** No user accounts, ever. Board passwords are optional. A board without a password is fully open to
  anyone with the code. A board with a password shows nothing but a lock screen to someone without it: no board name
  beyond the typed code, no cards, counts or logos. There is no view-only mode.
- **Unlocking is remembered per browser.** A lock button on the code chip in the top bar forgets it. The button
  appears only on a password board that was unlocked in this browser.
- **Password changed.** When a board's password changes, browsers holding the old one land on a "the board's
  password changed" lock screen.
- **Changing or removing a password requires the current password.** Setting one on an open board does not.
- **Wrong-password attempts are rate-limited per network,** with one shared counter covering both the lock screen
  and Settings.
- **Settings** holds the theme picker (five themes) and display name (both per browser), and a "This board" section
  that sets, changes or removes the board password. "This board" is a board setting that lives on the Settings page;
  it shows only while on a board you can access and is absent from the landing page.
- **History.** Restore on card edits, deletes and moves. Restoring a move puts the card as close to its old lane and
  position as possible. Password changes are logged but never restorable.
- **Display name** is asked at a browser's first change, never just for viewing. "Not now" logs changes as
  "Someone".
- **Layout.** Top bar option A. On phones (390 px) the three lanes stack vertically. Moving a card on a phone is
  long-press, drag with auto-scroll, drop slot, plus a Lane dropdown in the edit sheet.
- **Cards** are wide pills. Logo art is 1200 × 300 from the repo's `logos/` library only (no uploads, ever). No logo
  means a solid theme-coloured fill from the `--card-fb-*` tokens with the game name as text. Cards are
  keyboard-reachable (`role="button" tabindex="0"`): Enter opens, Space lifts, arrows move.
- **Themes:** Light, Dark, Legacy, Pastel, Cyberpunk. Light and Dark follow the device by default ("Match device").
  Dark is glass. Legacy is flat: no blur or translucency, 1 px borders, small radii, squared buttons; cards stay
  pills.
- **Buttons** never clip or truncate their labels. Sizes come from the `--btn-*` tokens; no inline sizes on buttons;
  touch targets are at least 44 px.
- **Offline:** "Editing paused until we reconnect." with a "Retry" button, wherever editing is paused.
- **`design/v1/` is the source of truth for the UI.** Read it before building any screen.

## Known conflicts on the canvas (the decisions win)

Found when the canvas was exported. The artboards are kept verbatim, so build these the decided way:

- `History.dc.html` marks "removed player" as not restorable. Deletes are restorable, players included.
- `History.dc.html` marks a "restored" entry as not restorable. A restore is an edit; it can be restored like any
  other.
- `Detail-Edit.dc.html`'s server-info hint says "Visible to anyone with the board code." On a password board it
  also takes the password.
- `System-States.dc.html` says Settings has nothing to fetch. "This board" talks to the server and needs working,
  error, offline and rate-limited states (`Settings.dc.html` draws some of them).
- `System-States.dc.html` says offline uses the warning tint; every other board draws it with the error banner.
- `Main.dc.html` gives `control-h-sm` as 32; `nu.css` and `Tokens.dc.html` say 36.
- `Logo-Picker.dc.html` describes the no-logo card as "the game's initials". It shows the game name; the initials
  are only the monogram disc.
