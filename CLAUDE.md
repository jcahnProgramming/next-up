# Next Up

A game-planning kanban for the WoW guild Post Nerf Clarity, at https://nextup.postnerfclarity.com. Built for Path and
the guild. Stack, structure and deploy are copied from `D:\Dev\home-dashboard`; when in doubt, do it the way it does.

**Hard boundary: PUBLIC on the internet** through the Cloudflare tunnel "<TUNNEL_NAME>". **No user accounts, ever**: no
login, no sign-up, no user table, no email, no OAuth. The board code is the access key.

---

## What Next Up will be (the agreed spec; only the skeleton exists in 0.1.0)

- The front page has one box: type a code to open that board, or create it if it doesn't exist.
- A board has three lanes: **Up Next**, **Now Playing**, **Played**. Cards drag between and within lanes.
- A card is a wide, short rounded pill with a game logo from `logos/` as its background. Clicking it opens a panel
  with a go-live date, a free-form server info field, and a player sign-up list (+ Add Player).
- **Optional per-board password**: viewing stays open to anyone with the code; editing (sign-ups included) needs the
  password.
- **Every change is logged** against the per-browser display name and can be restored.
- Boards update live for everyone viewing.
- Read-only MCP server. Apple glass styling with five themes.

Never build a stub that pretends part of this works. Until a piece ships, its page says "coming soon" plainly.

## Access model and abuse limits

- **The board code is the only key.** Anyone with it can view the board. Treat codes as secrets in logs: never log a
  code that was tried, right or wrong.
- **Wrong-code attempts are rate-limited per IP.** Behind the tunnel the client's address is Cloudflare's
  `CF-Connecting-IP` header; requests that didn't come through the tunnel (the LAN port) don't have a trustworthy one,
  so never trust that header from anywhere but the tunnel, and never rate-limit everyone as one IP by accident.
- **The total number of boards is capped** (a server-side constant). Creating past the cap is refused with a plain
  message, never a silent failure. The cap is how a public, account-free app stays bounded.
- **Board passwords** guard editing only. Store them hashed (a slow KDF), never in plain text, never in logs, never
  returned by any API or MCP tool, never in the change history.
- **The display name is per browser** (localStorage) and is a label, not an identity: anyone can type any name. The
  history says "changed by <name>", never implies it was verified.
- The only per-browser settings are the theme and the display name.

## Images

- **No user-uploaded images, ever.** No upload endpoint of any kind, no image URLs typed by users, no fetching images
  from the internet. Card images come only from `logos/` in this repo (see `logos/README.md` for the convention).
  Adding a logo is a commit.

## Data rules

- **Retention is forever.** Boards and their full change history are kept indefinitely. No exceptions yet. Any
  exception must name its reason here.
- Deleting a board, card or player is a logged change that can be restored, never a hard delete.
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
- The only secret so far is `MCP_BEARER_TOKEN` (min 16 chars, `npm run gen-token` prints one). It is read at start-up:
  restart `next-up-mcp` after changing it. Without one the MCP server answers 503 to everything but `/health`.
- Never log or return a token, a board password or its hash, including inside error messages.

## MCP

- Read-only, in its own container and port, bearer token on every request (`server/mcp/app.js`), Streamable HTTP at
  `POST /mcp` (stateless).
- **Tools are declared as resolvers** in `server/mcp/resolvers/` and listed in `resolvers/index.js`
  (`{ name, title, description, input, resolve(args, ctx) }`). The MCP layer registers whatever is listed; never edit
  `mcp/server.js` or `mcp/app.js` to add a tool. Every tool is registered with `readOnlyHint`.
- The MCP process opens the database `query_only`: SQLite itself refuses writes from it.
- Keep tool names stable: a rename breaks every connected client.
- **What MCP can never return**: board passwords or their hashes, the token, anything that grants editing.
- Tools so far: `get_version`.

## Honesty rules

- **Never invent or mock data**, including during development: no placeholder boards, sample cards or fake players.
  An honest empty state beats a plausible fake.
- **Suggest, never assert.** Anything uncertain routes through the user, shows its evidence, and remembers rejections.
- "Nothing here" and "no coverage here" must look different.
- Stale data shows its age. If live sync drops, say so; never show a board as live when it isn't.

## Design

Apple styling: glass, translucency, restraint, content-forward. Five themes: Light, Dark, Legacy, Pastel, Cyberpunk
(`client/src/theme/tokens.css`, copied from home-dashboard). The theme boot script in `client/index.html` applies the
stored theme (`nu.theme` in localStorage) before first paint; unset, it follows the device's light/dark mode. No
navigation menu: a top bar with the name and a settings button, a bottom bar with the version.

- **No native `<select>`** (nor `<datalist>` or native date/time/colour pickers): their popups ignore the theme
  (home-dashboard: dark themes showed light text on a light popup). Build one themed dropdown and use it everywhere;
  the go-live date gets a themed date picker, not `<input type="date">`.

## Bugs that cost us (in home-dashboard): don't reintroduce

- **Interactive elements inside a card must sit above the card's full-size click target.** In home-dashboard a
  button stacked under the card's link opened the link instead (reproduced with real input). Anything clickable on a
  card sits above its click layer, and is tested with real input.
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
