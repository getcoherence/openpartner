# syntax=docker/dockerfile:1.7
#
# OpenPartner portal image.
#
# Stage 1 builds the Vite SPA. Stage 2 serves it with nginx:alpine and
# proxies /api/* to whatever service we point API_UPSTREAM at. Defaults
# suit docker-compose (service name "api"); override for Fly /
# standalone deploys.

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
# Portal's types depend on @openpartner/db types being compiled first.
RUN pnpm --filter @openpartner/db build \
 && pnpm --filter @openpartner/portal build

FROM nginx:1.27-alpine AS runner
RUN apk add --no-cache tini \
 && rm /etc/nginx/conf.d/default.conf \
 # Make every path nginx writes to owned by the unprivileged `nginx`
 # user that already exists in the image. Required because we drop
 # privileges via USER below, and nginx writes pid/cache/logs at boot.
 # Listening on 8080 (>1024) means we don't need CAP_NET_BIND_SERVICE.
 && chown -R nginx:nginx /var/cache/nginx /var/log/nginx /etc/nginx/conf.d /usr/share/nginx/html \
 && touch /var/run/nginx.pid \
 && chown nginx:nginx /var/run/nginx.pid
ENV API_UPSTREAM=api:4601
COPY --chown=nginx:nginx apps/portal/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder --chown=nginx:nginx /repo/apps/portal/dist /usr/share/nginx/html

USER nginx

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
# nginx:alpine's entrypoint already handles template rendering via
# envsubst; we just need tini for signal forwarding.
ENTRYPOINT ["/sbin/tini", "--", "/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
