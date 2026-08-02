# syntax=docker/dockerfile:1.7
#
# NestJS API production image.
#
# STATUS: TEMPLATE — apps/api/ does not exist yet, so this has never been built.
# It encodes the intended build for an npm-workspaces monorepo. Expect to run it
# once and fix small things (exact dist path, Prisma client output location)
# when the API is first scaffolded.
#
# Build from the REPOSITORY ROOT, not from docker/:
#   docker build -f docker/api.Dockerfile -t docuflow-api .

# ------------------------------------------------------------------------------
# Stage 1 — dependencies
# ------------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

# NOTE: copying the whole tree here is deliberate while the workspace layout is
# still settling — npm workspaces needs every workspace package.json present to
# resolve the lockfile, and COPY fails outright on directories that don't exist.
# Once apps/ and packages/ are stable, narrow this to the manifests only:
#     COPY package.json package-lock.json ./
#     COPY apps/api/package.json apps/api/
#     COPY packages/*/package.json packages/
# That change lets Docker cache the install layer across source-only edits.
COPY . .

# npm ci requires a committed lockfile and installs exactly what it pins.
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ------------------------------------------------------------------------------
# Stage 2 — build
# ------------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

# Prisma client is generated code; it must be built before tsc compiles against it.
RUN npm run prisma:generate --workspace=@docuflow/api --if-present
RUN npm run build --workspace=@docuflow/api

# Strip dev dependencies so they are not carried into the runtime stage.
RUN npm prune --omit=dev

# ------------------------------------------------------------------------------
# Stage 3 — runtime
# ------------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# dumb-init reaps zombies and forwards signals, so SIGTERM reaches Node and
# in-flight uploads can drain instead of being killed mid-write.
RUN apk add --no-cache dumb-init

# Run unprivileged. node:alpine ships a `node` user (uid 1000) already.
USER node

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/apps/api/dist ./dist
COPY --chown=node:node --from=build /app/apps/api/package.json ./package.json
# Migrations ship with the image so a release can apply its own schema changes.
COPY --chown=node:node --from=build /app/apps/api/prisma ./prisma

EXPOSE 3001

# Assumes the API exposes GET /health (see README "Health checks").
# Exec form: runs node directly with no intervening shell.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
