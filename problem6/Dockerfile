# syntax=docker/dockerfile:1.7
# ──────────────────────────────────────────────────────────────────────────────
# problem6 · Scoreboard API · Multi-stage production Dockerfile
# Target: small, reproducible, CI-cache-friendly, non-root runtime.
# Build: docker build --target runtime -t problem6/scoreboard-api .
# ──────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=22.11.0
ARG PNPM_VERSION=9.12.0

# ─── Stage 1 · base toolchain ────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
ENV CI=true \
    PNPM_HOME=/root/.local/share/pnpm \
    PATH=$PNPM_HOME:$PATH

# ─── Stage 2 · dependencies (cached layer) ───────────────────────────────────
# Using a BuildKit cache mount on the pnpm store makes cold CI builds fast and
# warm CI builds near-instant when pnpm-lock.yaml is unchanged.
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

# ─── Stage 3 · build ─────────────────────────────────────────────────────────
# Compiles TypeScript and prunes dev deps. Kysely does NOT need a codegen step
# at build time — its TypeScript types are committed to the repo under
# src/database/.
#
# NOTE: `jose` v6 is ESM-only.  The NestJS webpack custom config in
# webpack.config.js enables `experiments.outputModule` so the bundle is
# emitted as an ES module instead of CommonJS.  This lets the bundle use
# `import jose from "jose"` without a CJS→ESM compatibility shim.
# The runtime package.json receives `"type":"module"` so Node loads the
# bundle as ESM (package.json is patched inside the container only).
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm nest build --webpack \
 && node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); p.type='module'; require('fs').writeFileSync('package.json',JSON.stringify(p,null,2));" \
 && pnpm prune --prod --ignore-scripts

# ─── Stage 4 · runtime (final image) ─────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime

# tini  → proper PID-1 signal handling (graceful shutdown)
# curl  → used by HEALTHCHECK
# dumb-init alternative; tini is smaller and fine for most cases
RUN apk add --no-cache tini curl \
 && addgroup -S app -g 10001 \
 && adduser  -S -G app -u 10001 app

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NODE_OPTIONS=--enable-source-maps

# Copy only what's needed at runtime.
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist         ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json
# Lua scripts are loaded at runtime via __dirname (relative to /app).
# Webpack sets __dirname to the source file's relative path, so the CWD-relative
# lookup is: src/scoreboard/infrastructure/rate-limit/lua/token-bucket.lua
COPY --from=build --chown=app:app /app/src/scoreboard/infrastructure/rate-limit/lua \
     ./src/scoreboard/infrastructure/rate-limit/lua

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

# ─── Optional stage · CI test runner ─────────────────────────────────────────
# docker build --target test -t problem6/scoreboard-api:test .
FROM build AS test
CMD ["pnpm", "jest", "--ci", "--runInBand"]
