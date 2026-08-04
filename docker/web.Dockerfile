# syntax=docker/dockerfile:1.7
#
# Next.js web production image.
#
# STATUS: TEMPLATE — apps/web/ does not exist yet, so this has never been built.
#
# PREREQUISITE: the runtime stage below copies Next.js standalone output, which
# Next only emits when apps/web/next.config.ts sets:
#     output: 'standalone'
# Without that setting the .next/standalone COPY will fail.
#
# Build from the REPOSITORY ROOT:
#   docker build -f docker/web.Dockerfile -t docuflow-web .

# ------------------------------------------------------------------------------
# Stage 1 — dependencies
# ------------------------------------------------------------------------------
FROM node:26-alpine AS deps
WORKDIR /app

# See the note in api.Dockerfile — narrow this to manifests once the workspace
# layout stops changing, to make the install layer cacheable.
COPY . .

RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ------------------------------------------------------------------------------
# Stage 2 — build
# ------------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, not read
# at runtime. That means each environment needs its own image build, or these
# must be fetched at runtime instead of baked in. Passed via build args in
# .github/workflows/release.yml.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build --workspace=@docuflow/web

# ------------------------------------------------------------------------------
# Stage 3 — runtime
# ------------------------------------------------------------------------------
FROM node:26-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apk add --no-cache dumb-init
USER node

# Standalone output bundles only the modules actually reached by the build, so
# no node_modules copy is needed here.
COPY --chown=node:node --from=build /app/apps/web/.next/standalone ./
COPY --chown=node:node --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node --from=build /app/apps/web/public ./apps/web/public

EXPOSE 3000

# Exec form: runs node directly with no intervening shell.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["dumb-init", "--"]
# Standalone emits its server entrypoint at the workspace path inside the bundle.
CMD ["node", "apps/web/server.js"]
