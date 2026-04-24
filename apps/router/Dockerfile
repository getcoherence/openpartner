# syntax=docker/dockerfile:1.7
#
# OpenPartner click router image. The hot path — visitors hit
# https://go.<vendor>/r/<linkKey> and this service resolves the link,
# writes a Click, and 302s. Must be fast and thin.
#
# Multi-stage mirrors the API Dockerfile but skips the migration bundle
# since the router only reads/writes; migrations run in the API image.

ARG NODE_VERSION=20-alpine

FROM node:${NODE_VERSION} AS deps
RUN corepack enable && corepack prepare pnpm@9.11.0 --activate
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/router/package.json apps/router/
COPY apps/portal/package.json apps/portal/
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM node:${NODE_VERSION} AS builder
RUN corepack enable && corepack prepare pnpm@9.11.0 --activate
WORKDIR /repo
COPY --from=deps /repo ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @openpartner/db build \
 && pnpm --filter @openpartner/router build \
 && pnpm --filter @openpartner/router --prod deploy /out

FROM node:${NODE_VERSION} AS runner
RUN apk add --no-cache tini
ENV NODE_ENV=production \
    ROUTER_PORT=4701
WORKDIR /app
COPY --from=builder /out/package.json ./package.json
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/dist ./dist

EXPOSE 4701
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.ROUTER_PORT||4701) + '/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "node", "dist/server.js"]
