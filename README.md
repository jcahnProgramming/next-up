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

## Deploy

Every push to `main` runs `.gitea/workflows/deploy.yml`: fast-forward pull, rebuild, then health checks on
<LAN_IP>:3230 and :3231 (a crash on boot or a stale version fails the deploy). It never writes `.env` and checks
that nothing else did.

## Cloudflare tunnel (Zero Trust dashboard, tunnel "<TUNNEL_NAME>")

Public hostname `nextup.postnerfclarity.com` → service `HTTP` `<LAN_IP>:3230`. Only the web app; the MCP server
(3231) stays on the LAN.

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
