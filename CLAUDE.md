# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current State

npm-workspaces monorepo. Both applications are scaffolded and boot, but only the foundation exists — there is **no domain functionality yet**: no auth, no upload, no folders, no endpoints beyond the health probe.

| Workspace       | State                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| `@docuflow/api` | NestJS 11 + Prisma 7. Env validation, tenant guard, `GET /health`. Boots.    |
| `@docuflow/web` | Next.js 16 + Tailwind 4. Default page + `GET /api/health`. Boots.            |
| Infrastructure  | Postgres 17 (pgvector), Redis 7, MinIO via Docker Compose. Verified healthy. |
| Database        | Migration `init` applied — 14 tables with composite tenant indexes.          |

[PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) is the product spec. It is bilingual — prose in Arabic, identifiers in English. Keep code, schema names, and API contracts in English.

## Commands

Run from the repository root. Root scripts fan out across workspaces via `scripts/run-workspaces.mjs`.

```bash
npm run infra:up          # Postgres + Redis + MinIO (required before the API boots)
npm run dev               # both apps in watch mode
npm run lint              # both workspaces
npm run typecheck
npm test
npm run build
npm run format            # Prettier; format:check is what CI enforces
```

Single workspace, and the Prisma commands:

```bash
npm run test --workspace=@docuflow/api
npm run test --workspace=@docuflow/api -- --testPathPattern=tenant
npm run prisma:generate --workspace=@docuflow/api
npm run prisma:migrate --workspace=@docuflow/api -- --name <migration-name>
npm run test:e2e --workspace=@docuflow/api    # needs infra up; not run by `npm test`
```

`npm test` runs jest with `rootDir: src`, so it covers `src/**/*.spec.ts` only. The e2e suite under `test/` boots the real AppModule and needs a live database.

## Stack (installed, not aspirational)

- **API**: NestJS 11, Prisma 7 + `@prisma/adapter-pg`, `@nestjs/config`, zod 4 (env), class-validator (DTOs), jest
- **Web**: Next.js 16 (App Router, `src/`), React 19, Tailwind 4
- **Infra**: Postgres 17 via `pgvector/pgvector:pg17`, Redis 7, MinIO

Not yet installed despite appearing in the spec: BullMQ, Swagger, MinIO client, shadcn/ui, TanStack Query, Zustand. Check `package.json` before assuming a library is available.

### Version traps

Both majors moved past common training data — verify rather than recall:

- **Prisma 7** removed `url` from the `datasource` block. Connection config for the CLI lives in `apps/api/prisma.config.ts`; the runtime client requires a **driver adapter** (`PrismaPg`), constructed in `prisma.service.ts`. Prisma no longer auto-loads `.env`.
- **Next.js 16** ships its own docs at `node_modules/next/dist/docs/` — read those before writing config, per `apps/web/AGENTS.md`.

The single `.env` lives at the **repo root**, not per app. `@nestjs/config` reads `['.env', '../../.env']` and `prisma.config.ts` loads it via dotenv.

## Architecture Constraints

These are the decisions that cut across modules; violating them is a correctness/security bug, not a style issue.

**Multi-tenancy is shared-database with a `company_id` discriminator, enforced centrally.** This is already implemented — do not add manual `companyId` filters to individual queries, and do not work around the guard.

- `TenantContextService` ([tenant-context.service.ts](apps/api/src/common/tenant/tenant-context.service.ts)) holds the current company in `AsyncLocalStorage`. `TenantMiddleware` binds it per request from the authenticated principal.
- `applyTenantGuard` ([tenant-guard.ts](apps/api/src/prisma/tenant-guard.ts)) is a Prisma client extension that injects `companyId` into every query and stamps it onto every create.
- Inject **`TENANT_PRISMA`** for application code. `PrismaService` is the raw, unfiltered client and is for infrastructure only (health probes, connection lifecycle).

The guard is **fail-closed**: with no tenant context bound, a tenant-scoped query throws rather than returning unfiltered rows. Since auth does not exist yet, `req.user` is always undefined, so this throw is the expected behaviour today — not a bug to route around. Use `runAsSystem()` for the genuine exceptions (registration, login lookup, queue workers).

Two known limits, documented in the guard itself: `findUnique`/`findUniqueOrThrow` are verified _after_ execution (Prisma only accepts unique fields in their `where`), and join models with no `companyId` of their own — `DocumentVersion`, `DocumentMetadata`, `DocumentTag`, `RolePermission`, `UserRole` — are only protected transitively, so reach them through their parent.

`permissions` is the one global table (no `company_id`); `roles` are per-company.

**Files never live in PostgreSQL.** Postgres stores metadata, references, and permissions; MinIO stores bytes. `documents.storage_key` is the join between them. Storage layout is `documents/company_<id>/<year>/<month>/<uuid>.<ext>` — the company segment keeps tenant data separable at the object-store level too.

**Upload is a pipeline, not a single request.** Validate permission → validate file → persist metadata → upload to MinIO → thumbnail → OCR → AI processing → search index → audit log. Everything after the MinIO write is asynchronous work (BullMQ is in the stack for this reason). The document's `status` column tracks position in the lifecycle: Created → Uploading → Uploaded → Processing → OCR → AI Analysis → Ready → Archived → Deleted. Treat `Ready` as the only state safe to serve for search/AI, and note that Archived and Deleted are states, not row removal — deletes are soft, since Restore is a required feature.

**A document is an aggregate**, not a row: file + metadata + permissions + versions + comments + tags + audit logs + OCR data + AI data. Uploading a new file for an existing document appends to `document_versions` rather than overwriting.

**JWT carries the tenant.** Payload is `{ sub, company_id, roles[], exp }`. The tenant context comes from the token, never from a client-supplied body/query parameter — accepting `company_id` from the request is the obvious path to cross-tenant access.

**Audit logging is a requirement, not a nicety.** "Who changed/deleted what" is a stated problem the product exists to solve. Mutating operations should produce an `audit_logs` row (company, user, action, entity type/id, IP).

## Module Layout

`apps/api/src/` currently holds `config/`, `common/tenant/`, `prisma/`, and `health/`. Domain modules from the spec — `auth`, `users`, `companies`, `roles`, `permissions`, `documents`, `storage`, `ai`, `search`, `notifications`, `audit` — are still to be added alongside them.

Two paths are load-bearing and must not drift:

- **`GET /health`** sits outside the `/api` global prefix (`setGlobalPrefix('api', { exclude: ['health'] })`). Both `docker/api.Dockerfile`'s HEALTHCHECK and `docker-compose.prod.yml` target it. The e2e suite asserts `/api/health` returns 404 to catch regressions.
- **`apps/api/dist/main.js`** is the built entrypoint the Dockerfile CMD runs. `tsconfig.build.json` pins `rootDir: src` to keep it there, and pins `tsBuildInfoFile` inside `dist` — nest's `deleteOutDir` would otherwise wipe `dist` while the stale incremental cache convinced tsc nothing needed emitting, producing a silent empty build.

## Frontend Design Standard

**Non-negotiable, and it applies to every page — marketing, auth, and in-app alike.** Pages must carry a consistent visual identity, look professionally designed, and use motion deliberately. Work that reads as generic AI output is not acceptable here: this is a portfolio project, so visual craft is part of the deliverable, not decoration on top of it.

Concretely:

- **Build on the design tokens, never ad-hoc values.** Colour, type scale, spacing, radius, shadow, and easing all come from the token layer. A one-off `text-[13px]` or a hex literal in a component is the mechanism by which identity drifts apart page to page.
- **Every page gets intentional motion** — entrance/exit transitions, hover and press feedback, and layout transitions on state change. Motion should clarify what changed, not decorate. Honour `prefers-reduced-motion` in every animation without exception.
- **Design real states.** Empty, loading (skeletons over spinners), error, and dense/overflow states are part of the page, not an afterthought. A document system is judged on how it behaves with 0 items and with 10,000.
- **Accessibility is part of "professional."** Visible focus rings, keyboard paths for every interaction, labelled controls, AA contrast.

Avoid the recognisable AI-default tells: stock indigo/violet gradients, a centred hero above three equal feature cards, uniform card grids with no hierarchy, emoji used as iconography, unmodified shadcn defaults, flat spacing with no rhythm, and text that never varies in weight or size.

## Scope Discipline

The spec defines a deliberate MVP. Version 1 is auth (register, login, JWT, refresh, roles), documents (create folder, upload, list, download, delete), and a dashboard (storage usage, recent documents, activity).

Deferred to v2: OCR, AI summary, smart search, notifications, approval workflow. Deferred to v3: mobile app, external API, integrations, billing, enterprise features.

Sections 12 and 8 of the spec enumerate the full long-term feature surface (watermarking, encryption, mentions, translation, classification, and so on). Treat those as the roadmap, not the current build target — don't pull v2/v3 features into MVP work unless asked. Do, however, leave room for them in the schema where it is cheap to do so.

## Working With the Spec

[PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) contains draft table sketches (companies, users, roles, permissions, documents, document_versions, document_metadata, tags, audit_logs) with column names but no types, indexes, constraints, or relations. They are a starting point for the Prisma schema, not a finished design — expect to add types, foreign keys, unique constraints, and the composite indexes that tenant-scoped queries will need.
