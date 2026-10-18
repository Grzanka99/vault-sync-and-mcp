# mcp-vault server. Notes live in /vault, the index database in /data.
FROM node:24-slim

WORKDIR /app
RUN npm install -g pnpm@12.14.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/plugin/package.json packages/plugin/
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter @mcp-vault/server...

COPY packages/core packages/core
COPY packages/server packages/server

RUN mkdir -p /vault /data && chown node:node /vault /data
USER node

ENV HOST=0.0.0.0 \
    PORT=8787 \
    MCP_VAULT_DIR=/vault \
    MCP_VAULT_DATA=/data
VOLUME ["/vault", "/data"]
EXPOSE 8787

ENTRYPOINT ["node", "packages/server/src/main.ts"]
CMD ["serve"]
