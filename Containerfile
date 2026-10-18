# mcp-vault server image (Podman). Notes live in /vault, the index database in /data.
# Runs as root inside the container: with rootless Podman that is your own user on the host,
# so files in the vault folder stay owned by you.
FROM docker.io/library/node:24-slim

WORKDIR /app
RUN npm install -g pnpm@12.14.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/plugin/package.json packages/plugin/
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter @mcp-vault/server...

COPY packages/core packages/core
COPY packages/server packages/server

ENV HOST=0.0.0.0 \
    PORT=8787 \
    MCP_VAULT_DIR=/vault \
    MCP_VAULT_DATA=/data
VOLUME ["/vault", "/data"]
EXPOSE 8787

ENTRYPOINT ["node", "packages/server/src/main.ts"]
CMD ["serve"]
