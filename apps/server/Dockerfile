# syntax=docker/dockerfile:1
# Production image of the orchestrator server (ADR-020). Build from the repository root:
#   docker build -f apps/server/Dockerfile -t ai-orchestrator-server .

FROM node:24-slim AS build
WORKDIR /repo
ENV CI=true NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY . .
RUN npm ci
RUN npm run build --workspace @orch/server
# Install the few dependencies that are not bundled (PGlite) next to the bundle.
RUN cd apps/server/dist && npm install --omit=dev --no-package-lock

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DATA_DIR=/data \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/server/dist ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "main.js"]
