# Next Up

A game-planning kanban for the WoW guild Post Nerf Clarity, at https://nextup.postnerfclarity.com. Built for Path and
the guild. Stack, structure and deploy are copied from `D:\Dev\home-dashboard`; when in doubt, do it the way it does.

**Hard boundary: PUBLIC on the internet** through the Cloudflare tunnel "<TUNNEL_NAME>". **No user accounts, ever**: no
login, no sign-up, no user table, no email, no OAuth. The board code is the access key, plus the board's password if
it has one.

---

## What Next Up will be (the agreed spec; 0.5.0 has boards, access, lanes, cards and drag and drop; not card details, history or live sync yet)

- The front page has one box: type a code to open that board, or create it if it doesn't exist.
- A board has three lanes: **Up Next**, **Now Playing**, **Played**. Cards drag between and within lanes.
- A card is a wide, short rounded pill with a game logo from `logos/` as its background (a solid theme-coloured fill
  with the game name when it has no logo). Clicking it opens a panel with a go-live date, a free-form server info
  field, and a player sign-up list (+ Add Player).
- **Optional per-board password, chosen at creation only.** Without one, the board is fully open to anyone with the
  code, for life. With one, someone without the password sees only a lock screen; it can be changed later but never
  removed. There is no view-only mode (see "Access model").
- **Boards can be retired** (deleted) by anyone who can edit them; restorable for 24 hours, then purged.
- **Every change is logged** against the per-browser display name. Card edits, deletes and moves can be restored;
  password changes are logged but never restorable.
- Boards update live for everyone viewing.
- A Settings page: theme, display name, and "This board" (change password, delete board).
- Read-only MCP server. Apple glass styling with five themes.

**The UI is designed in `design/v1/`** (exported from the Claude Design canvas; see its `README.md`). It is the
source of truth for every screen: read the relevant artboards before building one.

Never build a stub that pretends part of this works. Until a piece ships, its page says "coming soon" plainly.

## Access model and abuse limits

- **The board code is the key; a password, if set, is a second one.** Treat codes as secrets in logs: never log a
  code that was tried, right or wrong.
- **Board passwords are optional.** A board without a password is fully open to anyone with the code: viewing and
  editing, sign-ups included.
- **A board with a password shows nothing but a lock screen** to someone without it: no board name beyond the code
  they typed, no cards, counts or logos, and no API response that leaks them. **There is no view-only mode.**
- **Unlocking is remembered per browser.** A lock button on the code chip in the top bar forgets it; it appears only
  on a password board unlocked in this browser. When a board's password changes, browsers holding the old one land on
  a "the board's password changed" lock screen, not a generic error.
- **A password can only be set when the board is created.** An open board can never gain one later. A password
  board's password can be **changed** (current password required) but **never removed**: a locked board stays locked
  for life. The database enforces all three (triggers in `server/core/schema.js`), not just the app.
- **Rate limits are per network** (per client IP; IPv6 per /64), in memory (`server/core/rateLimit.js`): a restart
  forgets them. Behind the tunnel the client's address is Cloudflare's `CF-Connecting-IP` header
  (`server/core/network.js`); never rate-limit everyone as one IP by accident (every tunnel request shares
  cloudflared's socket address). Requests without the header (the LAN port, dev) are keyed by their socket address.
  The header can't be forged from the internet (Cloudflare's edge sets it), but a LAN device talking to port 3230
  directly can send its own. Setting `TRUSTED_PROXIES` in `.env` (cloudflared's address as the container sees it)
  makes the app honour the header only from there; until it is set, the header is honoured from any connection.
  - Unknown codes: **30 per network per 15 minutes**. Every creation attempt counts too (otherwise "that code is
    taken" would be an unlimited oracle). While a network is limited, every lookup answers "too many tries" except
    for boards this browser has opened before (it holds their access cookie): "locked" would still say "exists".
  - Wrong passwords: **10 per network per 15 minutes**, **one shared counter** (`limits.passwords`, one per app)
    covering every board, the lock screen and Settings' current-password checks: failing in one place counts against
    the other. Each attempt claims its slot before hashing (so parallel guesses can't slip past) and only a right
    password gives its own slot back; success never resets the count.
- **The total number of boards is capped** at `MAX_BOARDS` = 500 (`server/boards/routes.js`), checked again inside
  the creating transaction. Creating past the cap is refused with a plain message ("Next Up is full"), never a silent
  failure; a free code's lookup already says so. The cap is how a public, account-free app stays bounded.
- **Board passwords** are stored as argon2id hashes (64 MiB, 3 passes, 1 lane; `server/core/passwords.js`), never
  in plain text, never in logs, never returned by any API or MCP tool. Codes are 3–32 letters (a–z), numbers and
  hyphens, case-insensitive, stored lower case (`server/core/codes.js`, shared with the client); passwords 8–128
  characters. The change history records that a board was created with or without a password and when the password
  changed, never the password or its hash, and those entries are never restorable.
- **Access is an httpOnly cookie per board** (`nu_access`, `Path=/api/boards/<code>`, SameSite=Strict, Secure over
  HTTPS; `server/boards/grants.js`), HMAC-signed with `server_secrets.access_grant_key` and carrying the board id and
  password version. A version older than the board's is "the board's password changed". Page script never sees it;
  the lock button asks the server to clear it.
- **Every board route lives under `/api/boards/:code`** and, except `lock` and `unlock`, is registered after
  `requireAccess` in `server/boards/routes.js`, so it is protected by construction. A password board without access
  answers only `{ status: 'locked', code }` (plus `reason: 'password_changed'`), to every method and every path.
- **The display name is per browser** (localStorage) and is a label, not an identity: anyone can type any name. The
  history says "changed by <name>", never implies it was verified. It is asked for at a browser's first change, never
  just for viewing; "Not now" logs that browser's changes as "Someone". Creating a board counts as a change. Every
  change awaits `useAskName()` (`client/src/prefs/NamePrompt.jsx`) first. One key, `nu.displayName`, holds all three
  states: absent (never asked), `""` (answered "Not now", or cleared in Settings: never asked again), or the name.
- The only per-browser settings are the theme and the display name. (Which password boards this browser has unlocked
  is per-browser state, not a setting.)

## Settings page

- **Theme picker** (the five themes, with Light/Dark following the device by default as "Match device") and
  **display name**. Both are per browser.
- **"This board"**: **change password** (password boards only; current password required, and the check shares the
  wrong-password counter) and **delete board**. There is no "set" or "remove": a password is chosen only at creation
  and can never be removed. It is a board setting that lives on the Settings page; it shows only while on a board you
  can access, and is absent when Settings is opened from the landing page. (Not built yet.)

## Images

- **No user-uploaded images, ever.** No upload endpoint of any kind, no image URLs typed by users, no fetching images
  from the internet. Card images come only from `logos/` in this repo (see `logos/README.md` for the convention).
  Adding a logo is a commit.
- Logo art is 1200 × 300 (spec and safe zone in `design/v1/Card-Anatomy.dc.html`). A card with no logo is a solid
  theme-coloured fill from the `--card-fb-*` tokens with the game name as text.
- **The library is built, not fetched.** Each file declares one logo (its id is the file name); display names are the
  title-cased file name unless `logos/names.json` says otherwise. `scripts/logos.js` reads and checks every file; it
  runs as `scripts/check-logos.js` in `npm run build` and again inside the client build (the `virtual:nu-logos`
  plugin in `client/vite.config.js`), so a bad file fails the build and the deploy. Cards store only the id; a card
  whose id isn't in the library (or whose image fails to load) shows the no-logo card. The server checks a logo id's
  shape only (it never sees `logos/`).

## Data rules

- **Retention is forever.** Boards and their full change history are kept indefinitely. Any exception must name its
  reason here. The one exception:
  - **Retired boards.** Anyone with edit access can delete ("retire") a board. It is soft-deleted (`deleted_at`) and
    restorable for 24 hours; after that the board and its whole history are purged and its code becomes free. Reason:
    with a 500-board cap and no accounts, a dead board would otherwise hold its code and a slot forever. (Not built
    yet; the schema already lets only a retired board, or its events, be deleted.)
- Deleting a card or player is a logged change that can be restored, never a hard delete. Cards are tombstoned
  (`cards.deleted_at`); the database refuses deleting a card row unless its board is retired.
- **Cards** (`server/cards/routes.js`, rules shared with the client in `server/core/cardRules.js`): title 1–60
  characters, an optional logo id, one of three lanes. At most `MAX_CARDS` = 200 live cards per board, checked inside
  the creating transaction, refused with a plain message. Edits and deletes carry the card's `version`; a stale one
  gets 409 `{ code: 'conflict', card }` with the latest, never a silent overwrite.
- **Moves** (`POST /api/boards/:code/cards/:id/move` `{ lane, index, afterId? }`): `index` counts the lane's other
  cards; `afterId` (the card just above the gap, null for the top) wins when it is still in that lane. Moves carry no
  version: if two people move one card at once the later write wins and both are logged (each mover's screen corrects
  on its next load). A move still bumps the version, so an edit sheet opened before it gets the conflict. Dropping a
  card where it is writes and logs nothing. Every change of lane or order is `card.moved`, the edit sheet's Lane
  dropdown included; an edit that renames and moves at once logs `card.edited` (lane unchanged) then `card.moved`.
- **Order within a lane is a fractional key** (`server/core/positions.js`): placing a card writes only that card.
  Keys are capped at 64 characters; a placement that would pass the cap rebalances that one lane first (378
  consecutive moves into the same gap before that can happen); the answer then says `rebalanced: true` and the
  client reloads the board. A new card goes to the bottom of its lane.
- **The change log is `events`** (`server/core/events.js`): append-only (the database refuses updates, and deletes
  except when purging a retired board), indexed on `(board_id, created_at)`. Event types **declare themselves** with
  `declareEventType({ type, restorable, payload: zod object })` next to the feature that writes them
  (`server/boards/events.js`); `appendEvent` refuses undeclared types and any payload field not in the schema. Write
  the event in the same transaction as the change. Each payload holds enough to undo it without reading anything
  else. Types so far: `board.created` `{ hasPassword }`; `card.created` `{ cardId, card }`, `card.edited`
  `{ cardId, before, after }` (restorable), `card.deleted` `{ cardId, card }` (restorable), where a card state is
  `{ title, logo, lane, position, index }`; `card.moved` `{ cardId, before, after }` (restorable), where each is only
  the place `{ lane, position, index }` (`server/cards/events.js`).
- History offers Restore on card edits, deletes and moves. Restoring a move puts the card as close to its old lane
  and position as the board now allows. Password changes are logged but never restorable.
- Every time-series table has a composite index on `(parent_id, timestamp)`.
- Every query takes limit/cursor. No unbounded selects, ever.
- One SQLite file (`data/next-up.db`), shared by the web and MCP containers. On <HOST> it lives in
  `<DEPLOY_DIR>/data`, never `<USER_SHARE>/...`.
- Migrations live in `server/core/schema.js` (`{ id, up(db) }`). Never edit or reorder one that has shipped.

## Hosting and networking

- <HOST> (Unraid), deploy folder `<DEPLOY_DIR>`. Two containers from one image: `next-up` (web, port
  **3230**) and `next-up-mcp` (MCP, port **3231**).
- **Host ports bind to `<LAN_IP>` only, never `0.0.0.0`** (`server/test/compose-guard.test.js` fails otherwise).
  Inside the containers the processes listen on `LISTEN_HOST=0.0.0.0`, the container's own interfaces; locally they
  default to `127.0.0.1`.
- **Only the web app is in the tunnel**: `nextup.postnerfclarity.com` → `http://<LAN_IP>:3230`. The MCP server is
  LAN-only; never add it to the tunnel.
- The tunnel's ingress is managed in the Cloudflare Zero Trust dashboard by the owner. Never change tunnel config,
  the cloudflared container, Gitea or its runners from this repo.
- `/health` (both containers) returns `{ status, service, version }` and nothing else: it is public.

## Deploy

Push to `main` → `.gitea/workflows/deploy.yml`: fast-forward the host checkout, `docker compose up -d --build`, then
probe both ports on <LAN_IP> until healthy (~90 s), fail on any restart in the following 15 s (a crash on boot fails
the deploy), and fail unless both report the version in the pulled `CHANGELOG.json`. It fingerprints `.env` before
and after and fails if it changed.

## Credentials

- **The app never writes `.env`** (the deploy fingerprints it). Everything in it is added by hand.
- The only secret in `.env` is `MCP_BEARER_TOKEN` (min 16 chars, `npm run gen-token` prints one). It is read at start-up:
  restart `next-up-mcp` after changing it. Without one the MCP server answers 503 to everything but `/health`.
- The key that signs access cookies is generated by a migration into `server_secrets` (in the database, not
  `.env`). Nothing may read it except `server/boards/grants.js`.
- `TRUSTED_PROXIES` (optional, not a secret) is read at start-up; a malformed value stops the web app from booting.
- Never log or return a token, a board password or its hash, an access cookie or the signing key, including inside
  error messages.

## MCP

- Read-only, in its own container and port, bearer token on every request (`server/mcp/app.js`), Streamable HTTP at
  `POST /mcp` (stateless).
- **Tools are declared as resolvers** in `server/mcp/resolvers/` and listed in `resolvers/index.js`
  (`{ name, title, description, input, resolve(args, ctx) }`). The MCP layer registers whatever is listed; never edit
  `mcp/server.js` or `mcp/app.js` to add a tool. Every tool is registered with `readOnlyHint`.
- The MCP process opens the database `query_only`: SQLite itself refuses writes from it.
- Keep tool names stable: a rename breaks every connected client.
- **What MCP can never return**: board passwords or their hashes, the token, the access-grant key, anything that
  unlocks a password board or grants editing. No tool reads boards yet.
- Tools so far: `get_version`.

## Honesty rules

- **Never invent or mock data**, including during development: no placeholder boards, sample cards or fake players.
  An honest empty state beats a plausible fake.
- **Suggest, never assert.** Anything uncertain routes through the user, shows its evidence, and remembers rejections.
- "Nothing here" and "no coverage here" must look different.
- Stale data shows its age. If live sync drops, say so; never show a board as live when it isn't.
- Wherever editing is paused because we're offline, say "Editing paused until we reconnect." with a "Retry" button.

## Design

**`design/v1/` is the source of truth for the UI.** Read the relevant artboards and `design/v1/nu.css` before
building any screen; where an artboard contradicts this file, this file wins and the conflict gets raised.

Apple styling: glass, translucency, restraint, content-forward. No navigation menu: a top bar with the name and a
settings button, a bottom bar with the version.

- **The coffee bar** (`client/src/chrome/AppShell.jsx`) is a thin bar pinned to the bottom of the viewport on every
  page, separate from the version link: one plain link to https://buymeacoffee.com/PathPlays (new tab,
  `rel="noopener noreferrer"`) with an inline stroke icon. **Never** a script, widget, pixel, third-party logo or
  analytics. It sits below dialogs, sheets and toasts; the page clears it with `--coffee-bar-h` of bottom padding
  (so the version link sits just above it), toasts and the drag hint sit above it, and drag auto-scroll measures from
  its top edge. It takes no pointer events during a drag.

- **Themes:** Light, Dark, Legacy, Pastel, Cyberpunk. The theme boot script in `client/index.html` applies the stored
  theme (`nu.theme` in localStorage) before first paint; unset, Light/Dark follow the device ("Match device"). Dark
  is glass. **Legacy is flat**: no blur or translucency, 1 px borders, small radii, squared buttons; cards stay
  pills. The app still ships the home-dashboard tokens (`client/src/theme/tokens.css`) until the UI is converted to
  `design/v1/nu.css`.
- **Top bar option A**, with the board's code chip. On a password board unlocked in this browser, the chip carries the
  lock button that forgets the unlock.
- **Phones (390 px):** the three lanes stack vertically. Moving a card is long-press, drag with auto-scroll near the
  edges, a drop slot, plus a Lane dropdown in the edit sheet.
- **Cards** are wide pills (`design/v1/Card-Anatomy.dc.html`, `Card-States.dc.html`), keyboard-reachable
  (`role="button" tabindex="0"`): Enter opens, Space lifts, arrows move.
- **Moving cards** is `client/src/cards/useCardDrag.js`: native pointer events and keys, no library. Mouse drags
  start after 5 px; touch lifts after a 350 ms hold that moves under 8 px (sooner movement is a scroll). During a drag
  nothing re-orders: neighbours slide by `--shift` pitches, the slot sits at `--at`, the dragged `<li>` follows by
  an inline transform, and the real order changes on drop (see "Bugs that cost us"). Every step is announced in a
  live region ("Lifted Valheim. Up Next, position 2 of 5."). A drop shows at once and is put back if the server
  refuses; it asks for the display name first like any change.
- **Buttons never clip or truncate their labels.** Sizes come from the `--btn-*` tokens, never inline sizes on a
  button; touch targets are at least 44 px.
- **No native `<select>`** (nor `<datalist>` or native date/time/colour pickers): their popups ignore the theme
  (home-dashboard: dark themes showed light text on a light popup). The one themed dropdown is
  `client/src/chrome/Dropdown.jsx` (the logo dropdown, `client/src/cards/LogoPicker.jsx`, is its searchable cousin); use it everywhere;
  the go-live date gets a themed date picker, not `<input type="date">`.

## Bugs that cost us (in home-dashboard): don't reintroduce

- **Interactive elements inside a card must sit above the card's full-size click target.** In home-dashboard a
  button stacked under the card's link opened the link instead (reproduced with real input). Anything clickable on a
  card sits above its click layer, and is tested with real input.
- **Write `-webkit-backdrop-filter` before `backdrop-filter`.** The production CSS minifier keeps only the last of the
  pair when they share a value; written standard-first, the build shipped only the prefixed one, which Chrome and
  Edge ignore, and every glass surface lost its blur on the live site (0.2.0–0.3.0) while `npm run dev` looked fine.
  `server/test/client-css.test.js` enforces the order. Check glass in a production build, not only in dev.
- **Effect cleanup:** arrow-function effects use block bodies, never concise bodies. A concise body returns its
  value, which React calls as cleanup.
- **A drag must not move the node that holds the pointer.** Re-ordering the DOM mid-drag (React moving a keyed node)
  makes the browser release pointer capture, and a drag whose end listeners lived on that node wedged the app. Keep
  the dragged node's identity stable for the whole drag: derive the visual order from state and change the real
  order only on drop. **End-of-drag listeners live on window/document**, and a drag ends, cleaned up, on release,
  pointercancel, lostpointercapture, blur, a hidden page, the context menu, Escape, an exception, or a watchdog.
- **A container's own hostname wins over Docker DNS.** Never give a container a hostname that matches a name
  something else proxies to.
- **Back off per service, not per host.** Only sustained success resets.
- **A page reached from the bottom bar opened scrolled to the bottom.** New pages open at the top with focus on the
  heading; Back returns to where you were (`client/src/chrome/scrollMemory.js`, copied over for this reason).

## Testing

- `npm test` (node:test, `server/test/`). `npm run build` runs `scripts/check-changelog.js` first.
- API tests use `startApp()` from `server/test/helpers.js`: an in-memory database, its own limits and a clock the
  test moves (`clock.advance(ms)`), and `ip` per request as CF-Connecting-IP. Never point a test at `data/`.
- Test the empty state with a fresh browser profile and an empty database.
- Verify a fix's test catches the bug by running it against unfixed code.
- Drag tests use real input (DevTools protocol) or a lost-capture simulation: events dispatched from page script never
  engage real pointer capture, so they hide drag bugs.
- Visual pass in at least two themes, plus phone width (390 px), with no horizontal scroll.

## Changelog

`CHANGELOG.json` at the repo root is the single source of version truth: the server (`server/core/version.js`), the
client's bottom bar and What's new page (`client/src/release.js`), `/health` and MCP all read it.
`scripts/check-changelog.js` runs before the build, so a malformed entry fails the build and the deploy.

```json
{ "version": "0.x.y", "date": "YYYY-MM-DD", "title": "…",
  "sections": { "New": […], "Improved": […], "Fixed": […] } }
```

Newest first. Omit sections that don't apply (`Removed` is also allowed).

- **PATCH** (0.x.1) for fixes, small additions and refinements. The default.
- **MINOR** (0.x.0) for a genuinely new capability.
- **1.0.0 is reserved** for: the full agreed spec working live and used by Post Nerf Clarity for one real game
  rotation. Don't approach it.

Write entries for someone reading them in six months: what changed from a user's point of view, not which files moved.
