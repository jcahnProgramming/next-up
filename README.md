# Next Up

Game-planning kanban for Post Nerf Clarity, at https://nextup.postnerfclarity.com. No accounts: a board's code opens
it. See `CLAUDE.md` for the rules and `CHANGELOG.json` for what exists.

## Local development

```bash
npm install
npm run dev          # web on 127.0.0.1:3230, MCP on 127.0.0.1:3231, Vite on http://localhost:5173
npm test
npm run build        # checks CHANGELOG.json, then builds the client
```

The MCP server needs `MCP_BEARER_TOKEN` in `.env` (`npm run gen-token` prints a line to add).

`docker compose up` only works on <HOST>: the ports bind to <LAN_IP>.

## First-time setup on <HOST> (once, by hand)

The deploy workflow refuses to run until these exist:

```bash
cd <APPDATA_DIR>
git clone <gitea clone url> next-up      # must be on main
cd next-up
mkdir data
touch .env                               # then add MCP_BEARER_TOKEN=..., PUID=99, PGID=100
chown -R 99:100 data
```

The nightly backups go to the array, in a share that must exist first (Unraid: Shares → Add Share, name `backups`,
primary storage Array, SMB export No; skip if you already have one):

```bash
mkdir -p <BACKUP_DIR>
chown 99:100 <BACKUP_DIR>   # the PUID:PGID in .env
chmod 750 <BACKUP_DIR>
```

The deploy refuses to run without it (it checks before stopping anything).

## Backups

Nightly at 04:00 UTC to `<BACKUP_DIR>/next-up-YYYY-MM-DD.db`, 30 days kept, each one checked with
`integrity_check`. Failures show in `docker logs next-up` as `[backup] FAILED`. `RESTORE.md` says how to restore one and
how to take one by hand.

## Deploy

Every push to `main` runs `.gitea/workflows/deploy.yml`: fast-forward pull, rebuild, then health checks on
<LAN_IP>:3230 and :3231 (a crash on boot or a stale version fails the deploy). It never writes `.env` and checks
that nothing else did.

## Cloudflare tunnel (Zero Trust dashboard, tunnel "<TUNNEL_NAME>")

Public hostname `nextup.postnerfclarity.com` → service `HTTP` `<LAN_IP>:3230`. Only the web app; the MCP server
(3231) stays on the LAN.

### Rate limits behind the tunnel (`TRUSTED_PROXIES`)

Rate limits count per visitor network, which behind the tunnel is the `CF-Connecting-IP` header. Until
`TRUSTED_PROXIES` is set, the header is believed from any connection, so a device on the LAN can send its own to port
3230 and dodge the limits. To close that, tell the app where cloudflared's connections come from:

1. Open any board through the tunnel (any browser, `https://nextup.postnerfclarity.com/b/<a code>`), then on <HOST>:
   `docker logs next-up 2>&1 | grep CF-Connecting-IP`. The app logs each address the header arrives from, once:
   `CF-Connecting-IP arrived on a connection from 172.18.0.1: honoured (TRUSTED_PROXIES not set)`.
2. From a LAN machine: `curl -s -H 'CF-Connecting-IP: 203.0.113.9' http://<LAN_IP>:3230/api/boards/zz-spoof-check`
   (a lookup: only board requests consult the limits, so only they log it), then the same
   `grep` again. Its line names the LAN machine's own address (`<LAN_RANGE>`).
3. If the two addresses differ, add the tunnel's to `.env`: a Docker bridge address (172.16–31.x.x) as
   `TRUSTED_PROXIES=172.16.0.0/12` (Docker can renumber its networks; no LAN address is in that range), or
   `<LAN_IP>` as itself. Then `docker compose up -d next-up` (a plain `restart` doesn't re-read `.env`).
   If they're the same, stop: this way can't tell them apart, and the tunnel needs to reach the container another
   way.
4. Check: the start-up log says `CF-Connecting-IP honoured only from TRUSTED_PROXIES`, the LAN `curl` now logs
   `IGNORED`, and this, from a LAN machine, ends in `429` (that machine's address is then limited for unknown codes
   for 15 minutes; boards it has opened before still open):
   `for i in $(seq 1 31); do curl -s -o /dev/null -w "%{http_code} " -H "CF-Connecting-IP: 203.0.113.$i" http://<LAN_IP>:3230/api/boards/zz-spoof-$i; done`
5. Open a board through the tunnel again: it must work, and the log must not say `IGNORED` for the tunnel's
   address. If it does, every visitor would share one limit: fix `TRUSTED_PROXIES` at once.

## Connecting Claude Code to the MCP server (at home)

The MCP server is read-only and only on the LAN: `http://<LAN_IP>:3231/mcp`, with the bearer token from `.env` on
<HOST>. Read the token on <HOST> (it's never printed by the app):

```bash
grep '^MCP_BEARER_TOKEN=' <DEPLOY_DIR>/.env | cut -d= -f2-
```

Then on the Mac, for every project (`--scope user`; leave it out to add it to the current project only):

```bash
claude mcp add --transport http --scope user next-up http://<LAN_IP>:3231/mcp \
  --header "Authorization: Bearer <the token>"
claude mcp list          # next-up: ✔ Connected
```

`claude mcp add` saves without checking the token; a wrong one shows as "Failed to connect" in `claude mcp list` or
`/mcp`. Tools: `get_version`, `get_board`, `get_card`, `get_history`. Boards with a password always answer only
"locked".
