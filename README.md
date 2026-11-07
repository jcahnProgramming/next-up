# Next Up

A no-accounts kanban for planning which game a group plays next: type a code, get a shared board.

**Live:** https://nextup.postnerfclarity.com

Built by Jamie Cahn · https://jamiecahn.com

![A new, empty Next Up board in the dark theme: the Next Up mark and the board's code in the top bar, and three lanes, Up Next, Now Playing and Played](docs/screenshot-board.png)

## What it does

- **Open or create a board with a code.** One box on the front page: type a code and you're on that board, or offered to create it. No sign-up, no login, no email.
- **Three lanes: Up Next, Now Playing, Played.** Add a game as a wide card and drag it between and within lanes, with a mouse, by long-press on a phone, or from the keyboard (Space to lift, arrows to move).
- **Card details for game night.** Each card has a go-live date, a free-text server info box (web addresses become links), and a sign-up list where players add their names.
- **Optional password, chosen once at creation.** With one, someone who has only the code sees a lock screen and nothing else, so server info stays with the people who know the password.
- **Every change is recorded** with who made it (a display name, not an account): adds, edits, moves, deletes and sign-ups, each with enough detail to undo it. The History page that shows and restores them is not built yet.
- **Five themes** (Light, Dark, Legacy, Pastel, Cyberpunk) and a layout that stacks the lanes on a phone.

## Why I built it

My WoW guild, Post Nerf Clarity, needed a simple way to plan our next game. Next Up is a no-accounts kanban for that: type a code to open or create a board, and anyone with the code can edit it. A board can have a password set at creation, and then outsiders with only the code see just a lock screen, so server info stays private.

> TODO (Jamie): your description also says the guild tested Next Up on a real rotation and that it has live sync and
> full history with restore. Live sync, the History page and Restore aren't built yet (see Roadmap), and
> `CHANGELOG.json` reserves 1.0.0 for "used by Post Nerf Clarity for one real game rotation". Add the rotation line
> here if it has happened, and bump the version story to match.

## How it works

**Boards and codes.** A board's code is its key. Codes are 3–32 letters, numbers and hyphens, and capitals don't matter (`PNC-Raids` and `pnc-raids` are the same board). Nothing lists boards: you can only open one whose code you know. Each board has its own address, `/b/<code>`.

**Passwords.** When you create a board you choose, once, whether it has one. A board without a password is open to anyone with the code, for good: a password can't be added later. A board with one shows only a lock screen until the password is entered, and its API answers nothing but "locked". A password can never be removed, and it can't be recovered. Passwords are stored as argon2id hashes, never in plain text. Once you unlock a board, your browser remembers it with a signed, httpOnly cookie until you press the lock on the code chip in the top bar. If the password changes, browsers holding the old one land back on the lock screen.

**History.** Every change is written to an append-only log in the same database transaction as the change itself, labelled with the display name this browser chose (or "Someone"). The name is a label, not a verified identity. Deleted cards and removed players are kept, not erased, so they can be restored. The log is complete today; the page to browse it and the Restore buttons come next.

**Conflicts and offline.** If two people edit the same card, the second save doesn't overwrite the first: it shows the newer version and asks again. If your connection drops, the board says you're offline, shows when it was loaded, and pauses editing until you reconnect. Boards don't update live yet: you see other people's changes when you reload.

**The read-only MCP server.** A second process exposes Next Up to AI tools over the [Model Context Protocol](https://modelcontextprotocol.io) (Streamable HTTP at `POST /mcp`). It opens the database read-only, so SQLite itself refuses writes from it, and it needs a bearer token (`MCP_BEARER_TOKEN`) on every request. It has one tool so far, `get_version`. Keep it on your own network: it is not meant to be public.

**Abuse limits.** With no accounts, limits are per network: 30 unknown codes or board creations per 15 minutes, and 10 wrong passwords per 15 minutes across all boards. IPv6 addresses are grouped by /64. There are also caps of 500 boards, 200 cards per board and 100 players per card. The limits live in memory, so a restart resets them.

**`TRUSTED_PROXIES`.** Behind Cloudflare, every request arrives from your tunnel or proxy, so the app reads the visitor's address from the `CF-Connecting-IP` header to rate-limit each network separately. The internet can't forge that header, because Cloudflare's edge sets it, but a device on your own network talking to the app's port directly could. Set `TRUSTED_PROXIES` to the address (or CIDR range) your proxy connects from, as the container sees it, and the header is honoured only from there; every other connection is limited by its own address. Left unset, the header is honoured from any connection. A malformed value stops the web app from starting, rather than running without the protection you asked for.

## Run it locally

**Prerequisites:** Node.js 22 or newer and npm.

```bash
npm install          # see the note below if this fails on Windows
npm run dev          # web API on 127.0.0.1:3230, MCP on 127.0.0.1:3231, UI on http://localhost:5173
npm test             # the server and client-rule tests (node:test)
npm run build        # checks CHANGELOG.json and the logo library, then builds the client into client/dist
npm start            # serves the built app and API on http://127.0.0.1:3230
npm run start:mcp    # the MCP server on 127.0.0.1:3231
npm run gen-token    # prints an MCP_BEARER_TOKEN=... line to add to .env
```

The database is created on first start at `data/next-up.db`. Settings go in `.env` (copy `.env.example`); the MCP server answers `503` to everything but `/health` until `MCP_BEARER_TOKEN` is set.

**If `npm install` fails building `better-sqlite3`:** npm compiles it from source, which needs Python and a C++ toolchain. Both native dependencies (`better-sqlite3` and `argon2`) ship prebuilt binaries for Windows x64, Apple-silicon macOS and Linux x64/arm64, so on those you can skip the compile step instead:

```bash
npm install --ignore-scripts
```

(Elsewhere, such as an Intel Mac or Windows on ARM, `argon2` has no prebuilt binary: install the build tools and use plain `npm install`.)

## Deploy

Next Up runs in Docker: two containers from one image, the web app (port 3230) and the MCP server (port 3231), sharing one SQLite file in `./data`.

```bash
git clone <repo-url> next-up && cd next-up
cp .env.example .env     # then fill it in (below)
mkdir data               # owned by PUID:PGID (default 1000:1000)
docker compose up -d --build
curl http://<BIND_IP>:3230/health
```

Configure it in `.env`:

| Variable | Required | What it does |
| --- | --- | --- |
| `BIND_IP` | yes | Host address both ports are published on: where your proxy or tunnel reaches the app, or `127.0.0.1` for this machine only. Compose refuses to start without it and never falls back to `0.0.0.0`. |
| `MCP_BEARER_TOKEN` | for MCP | At least 16 characters; `npm run gen-token` makes one. Read at start-up. |
| `PUID`, `PGID` | no | User and group the containers run as (default `1000`). Match the owner of `./data`. |
| `TRUSTED_PROXIES` | no | IPs or CIDRs your proxy connects from; see "How it works". |

Point your reverse proxy or tunnel at port 3230 only. The MCP port should stay on your own network. `/health` on both ports returns `{ status, service, version }` and nothing else.

The repo also has the Gitea Actions workflow that deploys the live site on every push to `main` (`.gitea/workflows/deploy.yml`): it fast-forwards the server's checkout, rebuilds, and fails unless both containers come up healthy, stay up, and report the version in `CHANGELOG.json`. Its host-specific values come from repository variables (`DEPLOY_DIR`, `GITEA_INTERNAL_URL`, `BIND_IP`), so it works for another host by setting those.

## Backups

Everything lives in one SQLite database: `data/next-up.db` (plus `next-up.db-wal` and `next-up.db-shm` while it runs, because it uses write-ahead logging). There is no other state on the server: unlocks and display names live in each visitor's browser.

- **Simplest:** stop the containers (`docker compose stop`), copy the whole `data/` folder, then start them again.
- **Without stopping:** take an online copy with SQLite's backup command, e.g. `sqlite3 data/next-up.db ".backup 'next-up-backup.db'"` (needs the `sqlite3` tool on the host). Copying only `next-up.db` while the app runs can miss recent changes that are still in the `-wal` file.

To restore, stop the containers, put the backup in place as `data/next-up.db` (with no stale `-wal` or `-shm` files beside it), and start them. Keep `data/` on a local disk, not a network share.

## Tech stack

- **Server:** Node.js 22+, Express 5, SQLite through better-sqlite3 13, argon2 (argon2id) for passwords, zod 4 for validation
- **Client:** React 19, React Router 7, Vite 8, plain CSS with design tokens (no UI library, no drag-and-drop library)
- **MCP:** `@modelcontextprotocol/sdk` 1.x, Streamable HTTP, read-only
- **Tests:** Node's built-in test runner (`node:test`) against an in-memory database
- **Deploy:** Docker Compose, Gitea Actions

## Project structure

```
client/          React app: pages, board and cards, themes, settings
server/          Express API, SQLite schema and migrations, rate limits, MCP server
  boards/ cards/ players/   one folder per feature: routes and the events they log
  core/          database, schema, codes, passwords, positions, rate limits
  mcp/           the read-only MCP server and its tools (resolvers/)
  test/          node:test suites
scripts/         dev launcher, changelog and logo checks, token generator
logos/           game logo library (empty so far; adding a logo is a commit)
design/v1/       the UI design: artboards and the stylesheet they use
docs/            README images
.gitea/          deploy workflow
```

## FAQ

**Do I need an account?**
No. There are no accounts, logins or emails. The board code is the key, plus the password if the board has one. Next Up asks for a display name the first time your browser changes something, only so the history can say who did what; "Not now" records your changes as "Someone".

**Who can see my board?**
Anyone who has its code, if it has no password: they can view and edit it. If it has a password, someone with only the code sees a lock screen with the code they typed and nothing else: no name, cards, counts or server info. Boards aren't listed or searchable anywhere.

**What happens if I forget the password?**
It can't be recovered or reset, and a password can never be removed from a board. Browsers that already unlocked the board stay unlocked until someone presses the lock or the password changes. Changing a password (which needs the current one) isn't built yet.

**What happens when I delete a card?**
It leaves the board for everyone, but it is kept in the database and logged, so the coming History page can restore it. Removed players are kept the same way and would return to their old place in the sign-up order.

**Can I delete a board?**
Not yet. The plan is that anyone who can edit a board can retire it, with 24 hours to undo before it and its history are purged and its code is free again. Until then boards are kept indefinitely.

**Does it work on phones?**
Yes. On a phone the three lanes stack top to bottom. Press and hold a card to pick it up, and the page scrolls when you drag near the top or bottom edge. The card's edit sheet also has a Lane option if you'd rather not drag.

**Why does it say "too many tries"?**
Your network went over a limit: 30 unknown codes or new boards, or 10 wrong passwords (across all boards), per 15 minutes. It shows a countdown. Boards your browser has opened before still open by their link.

**Can I self-host it?**
Yes: see [Deploy](#deploy). There's no license file yet, though, so ask before reusing the code.

## Roadmap

From the agreed spec in `CLAUDE.md` and the parts the code already prepares for:

- **History and Restore:** a page listing every change by name and time, with Restore on card edits, deletes, moves and removed players. The log behind it is already recorded.
- **Live sync:** boards updating for everyone viewing, with a clear notice when the connection drops.
- **"This board" in Settings:** change a board's password (current password required) and delete (retire) a board, restorable for 24 hours.
- **More MCP tools:** read-only tools that read boards. No tool reads boards yet.
- **After 1.0:** a public Discord bot: link a board to a channel, post when a game goes live, and sign up from Discord.

## Support

[Buy me a coffee](https://buymeacoffee.com/PathPlays). The same plain link sits in the app's bottom bar; nothing from that site loads in Next Up.

## Built with AI

Built with [Claude Code](https://claude.com/claude-code) from written specs (`CLAUDE.md` and the designs in `design/v1/`).

## License

No license file yet.
