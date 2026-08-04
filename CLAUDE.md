# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current State

npm-workspaces monorepo. **The v1 MVP is complete end to end** — auth, storage, folders, documents, and the document UI.

| Workspace       | State                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@docuflow/api` | NestJS 11 + Prisma 7. Env validation, tenant guard, `GET /health`, and the `auth`, `permissions`, `storage`, `folders`, `documents` modules.         |
| `@docuflow/web` | Next.js 16 + Tailwind 4. Design system, Arabic/English i18n, auth screens, and guarded `/dashboard`, `/documents`, `/trash`.                         |
| Infrastructure  | Postgres 17 (pgvector), Redis 7, MinIO via Docker Compose. Verified healthy.                                                                         |
| Database        | Migrations `init` and `auth_tokens` applied — 15 tables with composite tenant indexes. **No migration was needed for documents**; the schema had it. |

A user can register, create folders, upload files, browse and search them, download, soft-delete, and restore from trash, with every mutation audited. 121 unit tests and 39 e2e tests pass.

The next task is v2: OCR, AI summary, smart search, notifications, approval workflow. See §"v2 seams" at the end of this file for the decisions v1 already made on its behalf.

### Web session handling

- **The access token is held in memory by `SessionProvider`, never in localStorage.** A reload therefore restores from the httpOnly refresh cookie, which is why there is a `restoring` state and a skeleton rather than a signed-out flash.
- **`proxy.ts` cannot see the refresh cookie** — it is scoped to `/api/auth`. The API also sets `docuflow_session` (path `/`, script-readable, no credential) purely so navigations can be routed. It is a hint that outlives revocation; `AppShell` does the real check, and the API authorises every read.
- **Refresh rotation has a 10-second leeway** before a spent token counts as replay, because tabs share one cookie jar and restoring several at once would otherwise read as theft.

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
# Jest 30 renamed this flag; --testPathPattern (singular) now errors out.
npm run test --workspace=@docuflow/api -- --testPathPatterns=tenant
npm run prisma:generate --workspace=@docuflow/api
npm run prisma:migrate --workspace=@docuflow/api -- --name <migration-name>
npm run test:e2e --workspace=@docuflow/api    # needs infra up; not run by `npm test`
```

`npm test` runs jest with `rootDir: src`, so it covers `src/**/*.spec.ts` only. The e2e suite under `test/` boots the real AppModule and needs a live database.

## Stack (installed, not aspirational)

- **API**: NestJS 11, Prisma 7 + `@prisma/adapter-pg`, `@nestjs/config`, zod 4 (env), class-validator (DTOs), `minio` 8, `multer` 2, jest
- **Web**: Next.js 16 (App Router, `src/`), React 19, Tailwind 4, `motion` — no form, icon, data-fetching or component library
- **Infra**: Postgres 17 via `pgvector/pgvector:pg17`, Redis 7, MinIO

Not yet installed despite appearing in the spec: BullMQ, Swagger, shadcn/ui, TanStack Query, Zustand. Check `package.json` before assuming a library is available. `apps/web` also has **no test runner**, so the CI web test step is currently a silent no-op.

### Version traps

Both majors moved past common training data — verify rather than recall:

- **Prisma 7** removed `url` from the `datasource` block. Connection config for the CLI lives in `apps/api/prisma.config.ts`; the runtime client requires a **driver adapter** (`PrismaPg`), constructed in `prisma.service.ts`. Prisma no longer auto-loads `.env`.
- **Next.js 16** ships its own docs at `node_modules/next/dist/docs/` — read those before writing config, per `apps/web/AGENTS.md`.
- **Turbopack does not hot-reload the i18n dictionaries.** `getDictionary` pulls `dictionaries/{en,ar}.json` through a dynamic `import()`, and the dev server keeps the resolved module in memory. Edit a dictionary while `npm run dev` is running and Turbopack reloads the component that reads it but **not** the JSON — so new code meets an old dictionary and a freshly added key renders as `undefined`, typically as `Cannot read properties of undefined`. `npm run typecheck` will pass, because the file on disk is correct. **Restart the web dev server after touching a dictionary.**
- **TypeScript is pinned to 6, not 7.** TypeScript 7 is the native compiler rewrite and ships the `tsc` binary only — no programmatic compiler API, which both the Nest CLI and `ts-jest` require. Under 7 the API cannot build and every test suite fails to run. The API is expected back in 7.1.
- **ESLint is pinned to 9, not 10.** ESLint 10 removed `context.getFilename()`, and `eslint-plugin-react` (pulled in transitively by `eslint-config-next`) still calls it, so linting the web app crashes outright.

Dependabot will keep proposing both majors. **Do not merge them until the ecosystem catches up** — CI catches it, but only if a red run is treated as blocking.

The single `.env` lives at the **repo root**, not per app. `@nestjs/config` reads `['.env', '../../.env']` and `prisma.config.ts` loads it via dotenv.

## Architecture Constraints

These are the decisions that cut across modules; violating them is a correctness/security bug, not a style issue.

**Multi-tenancy is shared-database with a `company_id` discriminator, enforced centrally.** This is already implemented — do not add manual `companyId` filters to individual queries, and do not work around the guard.

- `TenantContextService` ([tenant-context.service.ts](apps/api/src/common/tenant/tenant-context.service.ts)) holds the current company in `AsyncLocalStorage`. `TenantMiddleware` binds it per request from the authenticated principal.
- `applyTenantGuard` ([tenant-guard.ts](apps/api/src/prisma/tenant-guard.ts)) is a Prisma client extension that injects `companyId` into every query and stamps it onto every create.
- Inject **`TENANT_PRISMA`** for application code. `PrismaService` is the raw, unfiltered client and is for infrastructure only (health probes, connection lifecycle).

The guard is **fail-closed**: with no tenant context bound, a tenant-scoped query throws rather than returning unfiltered rows. Use `runAsSystem()` for the genuine exceptions (registration, login lookup, refresh, audit rows on anonymous requests, queue workers).

**Prisma promises are lazy, and that interacts badly with `AsyncLocalStorage`.** A query issues nothing until something awaits it, so returning one out of a context callback means it executes after the scope has unwound — with no tenant bound, failing closed. `runAsSystem()` awaits its callback internally to make that shape safe; `run()` cannot, because `TenantMiddleware` passes it a synchronous `next()`. Calling `run()` by hand means awaiting inside the callback.

Two known limits, documented in the guard itself: `findUnique`/`findUniqueOrThrow` are verified _after_ execution (Prisma only accepts unique fields in their `where`), and join models with no `companyId` of their own — `DocumentVersion`, `DocumentMetadata`, `DocumentTag`, `RolePermission`, `UserRole` — are only protected transitively, so reach them through their parent.

`permissions` is the one global table (no `company_id`); `roles` are per-company.

**Files never live in PostgreSQL.** Postgres stores metadata, references, and permissions; MinIO stores bytes. `documents.storage_key` is the join between them. Storage layout is `documents/company_<id>/<year>/<month>/<uuid>.<ext>` — the company segment keeps tenant data separable at the object-store level too.

**Upload is a pipeline, not a single request.** Validate permission → validate file → persist metadata → upload to MinIO → thumbnail → OCR → AI processing → search index → audit log. Everything after the MinIO write is asynchronous work (BullMQ is in the stack for this reason). The document's `status` column tracks position in the lifecycle: Created → Uploading → Uploaded → Processing → OCR → AI Analysis → Ready → Archived → Deleted. Treat `Ready` as the only state safe to serve for search/AI, and note that Archived and Deleted are states, not row removal — deletes are soft, since Restore is a required feature.

**A document is an aggregate**, not a row: file + metadata + permissions + versions + comments + tags + audit logs + OCR data + AI data. Uploading a new file for an existing document appends to `document_versions` rather than overwriting.

**JWT carries the tenant.** Payload is `{ sub, company_id, roles[], exp }`. The tenant context comes from the token, never from a client-supplied body/query parameter — accepting `company_id` from the request is the obvious path to cross-tenant access.

**Audit logging is a requirement, not a nicety.** "Who changed/deleted what" is a stated problem the product exists to solve. Mutating operations should produce an `audit_logs` row (company, user, action, entity type/id, IP).

## Module Layout

`apps/api/src/` holds `config/`, `common/{tenant,audit,errors,http}/`, `prisma/`, `health/`, `permissions/`, `auth/`, `storage/`, `folders/`, and `documents/`. Still to be added: `users`, `companies`, `roles`, `ai`, `search`, `notifications`.

### Authorisation

Authentication and authorisation are two guards, and the order is load-bearing.

- **`JwtAuthGuard`** (first `APP_GUARD`) enforces that a principal exists. Opt out with `@Public()`.
- **`PermissionsGuard`** (second `APP_GUARD`) enforces `@RequirePermissions('documents.create')`. A route with no decorator is authenticated but unrestricted, so authentication is opt-out and authorisation is opt-in.
- Permissions are read per request rather than carried in the JWT — a token lasts 15 minutes and revoking a role has to bite sooner than that. `PermissionsService.effectiveFor()` reads through `User`, never `UserRole`, because the join tables are only transitively scoped.

### Errors

Deliberate failures return `{ statusCode, code, message, errors? }`. `code` comes from `common/errors/error-codes.ts` and is what the web maps to a translated string — `message` stays as the English fallback. `PrismaExceptionFilter` and `MulterExceptionFilter` catch what slips through, so a duplicate name is a 409 and an oversized upload is a 413 rather than either being a 500.

### Storage and documents

- **Object keys are derived server-side, never accepted from a client** (`storage-key.ts`). Layout is `documents/company_<id>/<year>/<month>/<uuid>.<ext>`.
- **No presigned URLs.** Downloads and previews stream through the API so every byte stays behind the same permission check; `docker/nginx/nginx.conf` is already configured for it with `proxy_buffering off` on those routes.
- **Upload order matters**: validate → row at `UPLOADING` → bytes to MinIO → row to `READY` + version #1 + audit. A crash leaves a sweepable `UPLOADING` row rather than an object nothing references.
- **`deletedAt` is NOT filtered by the tenant guard.** That extension handles `companyId` only, on purpose. Every document read spells out `deletedAt: null` — see the `ACTIVE` constant in `documents.service.ts`.
- **`Document.size` is a BigInt** and does not survive `JSON.stringify`; it is serialised to a string at the controller boundary.
- **`tenantCreate()`** wraps create payloads so Prisma's static types accept the `companyId` the guard injects at runtime. One sanctioned assertion instead of a cast per call site.
- **A company that owns documents cannot be deleted in one statement.** `Document.owner`, `DocumentVersion.uploadedBy` and `Folder.createdBy` reference `User` with Prisma's default `Restrict`, and deleting a Company cascades to its users. Delete documents → folders → company, in that order.

### Auth

Endpoints: `POST /api/auth/{register,login,refresh,logout,forgot-password,reset-password}` and `GET /api/auth/me`.

- **Authentication is split across middleware and a guard, deliberately.** Nest runs middleware → guards → handler, but `TenantMiddleware` needs the principal and must open its `AsyncLocalStorage` scope around the whole request. So `JwtMiddleware` resolves `req.user` and never rejects, and `JwtAuthGuard` (global, via `APP_GUARD`) decides whether a route tolerates anonymity. Registration order in `AppModule.configure()` is execution order.
- **Routes are authenticated by default.** Opt out with `@Public()`, so a new controller is protected rather than quietly open.
- **Access tokens are stateless JWTs; refresh tokens are opaque random strings with a row behind them.** A stateless refresh token cannot be revoked, which would make logout cosmetic. Only an HMAC digest is stored, keyed with `JWT_REFRESH_SECRET`.
- **Refresh rotates, and replay of a spent token revokes the entire family.** Two parties holding one token is indistinguishable from theft, so the lineage dies and a real sign-in is forced.
- **Login and forgot-password never reveal whether an account exists** — one error message, a decoy bcrypt comparison to level the timing, and an unconditional 200 from forgot-password.
- Email is unique **per company**, so one address can exist in several tenants; the password selects the account, oldest wins on a tie. Picking a company explicitly is a v2 concern.
- No mailer is in the stack. `forgot-password` logs the reset URL in development and withholds it in production.

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

Note the spec's stack section names OpenAI/Gemini for AI and lists modules (`Departments`, `Reports`) that appear in no version plan. The `.env` default is Anthropic, and those two modules are unallocated scope — decide before building either.

## v2 seams

Decisions v1 already made on v2's behalf, so nothing has to be unpicked:

- **Embeddings come from Voyage AI, not Anthropic** — Anthropic ships no embeddings endpoint at all. `VOYAGE_API_KEY` and `EMBEDDING_MODEL` already have optional slots in `env.validation.ts`, so v2 needs no env migration.
- **OCR is Claude's native document/vision input**, not Tesseract — better on Arabic scans, and it collapses OCR, extraction and classification into one call. Use the Batch API (50%) for bulk backfill.
- **`DocumentMetadata` is the extension point** for `extractedText`, `summary`, an `embedding vector(1024)` and a `tsvector`. The `vector`, `pg_trgm` and `unaccent` extensions are already installed by `docker/postgres/init/01-extensions.sql`.
- **Reserve `derived/company_<id>/<documentId>/…`** for thumbnails and OCR page images, so generated artifacts can never collide with originals.
- **The `status` enum still carries `PROCESSING`, `OCR` and `AI_ANALYSIS`.** v1 goes `UPLOADING → READY` directly; step 4 of the upload pipeline is where v2 hands off to a queue instead.
- **BullMQ is still not installed**, deliberately — Redis is pinned to `noeviction` for it, but there is no async job until OCR exists.
