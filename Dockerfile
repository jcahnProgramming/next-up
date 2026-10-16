# ---------- build: install deps + build the React client ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain for better-sqlite3 in case no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY . .
# The build runs scripts/check-changelog.js first: a malformed CHANGELOG.json fails here.
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---------- runtime: one image, two entrypoints (web + mcp) ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    LISTEN_HOST=0.0.0.0 \
    PORT=3230 \
    MCP_PORT=3231
WORKDIR /app
# CHANGELOG.json is the app version at run time (server/core/version.js). Don't drop it.
COPY --from=build /app/package.json /app/CHANGELOG.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/client/package.json ./client/package.json
COPY --from=build /app/client/dist ./client/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3230 3231
# Default: web app. docker-compose overrides the command for the MCP service.
CMD ["node", "server/index.js"]
