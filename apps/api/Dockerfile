# syntax=docker/dockerfile:1.7
#
# OpenPartner API image.
#
# Multi-stage pnpm workspace build:
#   deps     installs all workspace deps (cached on manifest changes)
#   builder  compiles @openpartner/db + @openpartner/api to dist/
#   runner   minimal alpine + compiled JS + prod node_modules
#
# The runner stage uses pnpm's `deploy` mode to produce a single
# self-contained /app dir with only the API's actual deps (no dev
# packages, no other workspace apps). Size matters — alpine + this
# output lands around ~180 MB.
#
# Entrypoint runs knex migrations before starting the server, so a
# fresh deploy against an empty DB bootstraps on first boot.

ARG NODE_VERSION=20-alpine

# ---------- deps: resolve and fetch every workspace package --------
FROM node:${NODE_VERSION} AS deps
RUN corepack enable && corepack prepare pnpm@9.11.0 --activate
WORKDIR /repo

# Copy only the files pnpm needs to materialize the dependency graph.
# Source changes won't invalidate this layer — only manifests do.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/router/package.json apps/router/
COPY apps/portal/package.json apps/portal/
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- builder: compile TypeScript -----------------------------
FROM node:${NODE_VERSION} AS builder
RUN corepack enable && corepack prepare pnpm@9.11.0 --activate
WORKDIR /repo
COPY --from=deps /repo ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm --filter @openpartner/db build \
 && pnpm --filter @openpartner/api build

# Use pnpm's deploy to carve out a production-only tree for the API.
RUN pnpm --filter @openpartner/api --prod deploy /out \
 # Ship the compiled migration bundle (knexfile.js + migrations/*.js +
 # scripts/migrate.js) so the entrypoint can run migrations without tsx.
 && mkdir -p /out/packages-db \
 && cp -r packages/db/dist-migrate /out/packages-db/dist-migrate

# ---------- runner: minimal ----------------------------------------
FROM node:${NODE_VERSION} AS runner
RUN corepack enable && corepack prepare pnpm@9.11.0 --activate \
 && apk add --no-cache tini
ENV NODE_ENV=production \
    API_PORT=4601 \
    MAIL_TRANSPORT=postmark
WORKDIR /app

# API dist + its workspace deps.
COPY --from=builder /out/package.json ./package.json
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/dist ./dist

# Migrations need the @openpartner/db package + knex bin. We ship it
# alongside so the entrypoint can run them before API boot.
COPY --from=builder /out/packages-db ./packages-db

# Entrypoint runs migrations then execs the API. `exec` matters — we
# want the node process to be PID 1 so signals (SIGTERM from Fly /
# Docker) land on the app directly.
COPY apps/api/docker-entrypoint.sh /usr/local/bin/openpartner-api
RUN chmod +x /usr/local/bin/openpartner-api

EXPOSE 4601
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.API_PORT||4601) + '/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/openpartner-api"]
