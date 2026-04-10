# syntax=docker/dockerfile:1

# ── Stage 1: Install all dependencies ────────────────────────────────────────
FROM node:22-alpine AS deps

# Install pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy manifests only so this layer is cached unless deps change
COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

# ── Stage 2: Build TypeScript ─────────────────────────────────────────────────
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source + config
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN pnpm build

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy manifests for production install
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist

# Run as non-root user (node user exists in node:alpine)
USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT:-3000}/healthz?probe=liveness" || exit 1

CMD ["node", "dist/index.js"]
