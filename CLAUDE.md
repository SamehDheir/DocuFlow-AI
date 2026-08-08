# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current State

npm-workspaces monorepo. **v1 through v4 are complete end to end.**

| Workspace       | State                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@docuflow/api` | NestJS 11 + Prisma 7. Tenant guard, `GET /health`, and the `auth`, `permissions`, `storage`, `folders`, `documents`, `queue`, `ai`, `search`, `notifications`, `events`, `approvals`, `audit`, `users`, `roles`, `invitations`, `tags`, `comments`, `favorites` modules. |
| `@docuflow/web` | Next.js 16 + Tailwind 4. Design system, Arabic/English i18n, auth screens, and guarded `/dashboard`, `/documents`, `/documents/[id]`, `/search`, `/approvals`, `/trash`, `/activity`, `/members`.                                                                        |
| Infrastructure  | Postgres 17 (pgvector), Redis 7, MinIO via Docker Compose. Redis carries the BullMQ queue and the SSE event bus.                                                                                                                                                         |
| Database        | Seven migrations — `init`, `auth_tokens`, `v2_ai_notifications_approvals`, `arabic_search_normalisation`, `members_and_invitations`, `v4_collaboration`, `v4_document_versions`. 20 tables with composite tenant indexes.                                                |
| Tests           | **316 unit** (25 suites) · **95 e2e** (9 suites) · **73 web** (8 files). CI runs all three.                                                                                                                                                                              |

A user can register, create folders, upload files, browse and search them, download, soft-delete, and restore from trash. An upload is text-extracted and summarised on a queue worker, its contents are full-text searchable in Arabic and English, the browser is told live over SSE when it finishes, and a document can be routed for single-step sign-off. Every mutation is audited.

**A company can hold more than its founder.** `register` necessarily creates a new company, so before invitations there was no way to add a second person and the seeded Owner/Admin/Member roles had nobody to apply to. See §"Members, roles and invitations".

**v4 made a document an aggregate in practice, not just in the schema** — tags, comments, favourites, version history with revert, archive, and bulk operations, with a detail route to show all of it, and every one of them reachable from the browser. See §"v4 as built".

What remains is in [NEXT_STEPS.md](NEXT_STEPS.md); v5 is the deferred surface — mobile app, external API, integrations, billing.

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

`npm test` runs jest with `rootDir: src`, so it covers `src/**/*.spec.ts` only. The e2e suite under `test/` boots the real AppModule and needs live Postgres, Redis **and MinIO** — CI runs it too, so a red e2e blocks the merge.

The web workspace runs vitest:

```bash
npm run test --workspace=@docuflow/web
npm run test:watch --workspace=@docuflow/web
```

## Stack (installed, not aspirational)

- **API**: NestJS 11, Prisma 7 + `@prisma/adapter-pg`, `@nestjs/config`, zod 4 (env), class-validator (DTOs), `minio` 8, `multer` 2, jest — plus v2: `bullmq` + `ioredis` (queue and SSE bus), `officeparser` (docx/pptx/xlsx/pdf text layers), `pdfjs-dist` + `@napi-rs/canvas` (rasterising scans), `sharp` (image normalisation)
- **Web**: Next.js 16 (App Router, `src/`), React 19, Tailwind 4, `motion` — no form, icon, data-fetching or component library. Tests run on **vitest** + Testing Library under jsdom (v4); Playwright is deliberately absent, since a browser suite would need live Postgres, Redis and MinIO in CI to assert what the API's own e2e specs already cover.
- **Infra**: Postgres 17 via `pgvector/pgvector:pg17`, Redis 7, MinIO

**No AI SDK is installed, deliberately** — both providers speak the OpenAI wire format, so `ai/openai-compatible.provider.ts` is one `fetch` and a zod parse, and `groq.provider.ts` / `xai.provider.ts` are just configuration on top of it.

Still not installed despite appearing in the spec: Swagger, shadcn/ui, TanStack Query, Zustand. Check `package.json` before assuming a library is available.

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

`apps/api/src/` holds `config/`, `common/{tenant,audit,errors,http}/`, `prisma/`, `health/`, `permissions/`, `auth/`, `storage/`, `folders/`, `documents/` (with `extraction/` and `processing/`), `queue/`, `ai/`, `search/`, `notifications/`, `events/`, `approvals/`, `audit/`, `users/`, `roles/`, `invitations/`, `tags/`, `comments/`, and `favorites/`. Still to be added: `companies`.

**A new tenant-scoped model must be registered in `tenant-guard.ts`.** `TENANT_SCOPED_MODELS` is a hand-kept list, and a model with a `companyId` that is missing from it is not merely unfiltered on read — the guard also stops stamping the company on create, so inserts fail with Prisma demanding a nested `company` connect. `Invitation` shipped without its entry and nothing caught it: it type-checks, it lints, the unit suite passes (services are constructed with fakes and never touch the extension) and the build is clean. `tenant-registration.spec.ts` now parses `schema.prisma` and fails if any model carrying a `companyId` is in neither list.

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
- **Upload order matters**: validate → row at `UPLOADING` → bytes to MinIO → row to `PROCESSING` + version #1 + audit → enqueue, after the transaction commits. A crash leaves a sweepable `UPLOADING` row rather than an object nothing references.
- **`deletedAt` is NOT filtered by the tenant guard.** That extension handles `companyId` only, on purpose. Every document read spells out `deletedAt: null` — see `ACTIVE` in `documents/document-rules.ts`, which also holds `IN_FLIGHT` and the archive predicates. Those live in their own file because `BulkDocumentsService` cannot call the single-document methods (200 ids × find/validate/update/audit is 800 round trips) and re-implements the same decisions against a set — the classic drift pair.
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
- Email is unique **per company**, so one address can exist in several tenants; the password selects the account, oldest wins on a tie. Picking a company explicitly at sign-in is still unbuilt — and now reachable, since one person can be invited into a second workspace.
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

## Members, roles and invitations

`POST /api/auth/register` always creates a **new** company — it has to, since the tenant does not exist yet — so invitations are the only path by which a workspace gains a second person.

- **Accepting lives in `AuthService`, not `InvitationsService`.** It creates an account and issues a session, which is registration's other half. The company comes from the token; accepting a `companyId` from the body is the obvious cross-tenant hole. `InvitationsService.resolve()` owns the validity rule so previewing and accepting cannot disagree about what "valid" means.
- **The invitation is consumed by the same statement that checks it is open** — `updateMany` with `acceptedAt: null, revokedAt: null` matches exactly once, so two people racing one forwarded link cannot both get an account.
- **`Invitation` is shaped after `PasswordResetToken`**: same keyed HMAC digest via `digestToken()`, single use, expiry (7 days). Only the digest is stored.
- **There is still no mailer**, so `POST /api/invitations` returns the link to the inviter, who delivers it. Withholding the token from the administrator who just created it would make the feature unusable, not safer — they already hold `users.invite`. Development logs it; production does not.
- **`email` on an invitation is what it was issued _for_, not proof of who accepts.** Anyone holding the link can accept, exactly as with a reset link. The accept form shows the address disabled so it cannot be redirected to someone else.
- **Preview is `POST /api/invitations/preview` with the token in the body**, not a GET with it in the path — the token is a bearer credential and a path lands in every access log between the browser and the API. Expired, revoked, used and unknown all return one message.
- **`roles.manage` gates role assignment, not `users.update`.** Editing someone's name and granting them authority are different powers; Admin holds the first and deliberately not the second, or the distinction from Owner would be meaningless. The web reflects this — an Admin sees roles as text where an Owner sees a picker.
- **The last Owner cannot be demoted.** Owner is the only role holding `roles.manage`, so that edit produces a company nobody can ever administer again, and there is no repair path through the API. The check counts holders rather than trusting the caller not to be the last one.
- **Role assignment is a whole-set `PUT`**, so it is idempotent and two administrators cannot interleave into a combination neither chose. An empty set is refused: a member with no roles cannot be told apart from a bug, and removing access is what deactivation is for.
- `/invite` is deliberately **not** in the proxy's `AUTH_ONLY` list. Someone signed in to one company may legitimately hold an invitation to another, and bouncing them to their own dashboard would make that link unusable.

## Scope Discipline

The spec defines a deliberate MVP. Version 1 is auth (register, login, JWT, refresh, roles), documents (create folder, upload, list, download, delete), and a dashboard (storage usage, recent documents, activity).

v2 is now built: OCR, AI summary, smart search, notifications, approval workflow. Member management (invitations and role assignment) followed, because the seeded roles had nobody to apply to without it. v4 added the collaboration layer — tags, comments, favourites, versions, archive, bulk. Deferred: mobile app, external API, integrations, billing.

The approval workflow is **single-step and permission-gated**. The spec routes approvals to a `Department Manager`, a role that does not exist here — `Departments` is unallocated scope with no schema — so it gates on `documents.approve` against the real Owner/Admin/Member roles instead. Sequential approver chains would be a child table, not a reshape.

Sections 12 and 8 of the spec enumerate the full long-term feature surface (watermarking, encryption, mentions, translation, classification, and so on). Treat those as the roadmap, not the current build target — don't pull v2/v3 features into MVP work unless asked. Do, however, leave room for them in the schema where it is cheap to do so.

## Working With the Spec

[PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) contains draft table sketches (companies, users, roles, permissions, documents, document_versions, document_metadata, tags, audit_logs) with column names but no types, indexes, constraints, or relations. They are a starting point for the Prisma schema, not a finished design — expect to add types, foreign keys, unique constraints, and the composite indexes that tenant-scoped queries will need.

Note the spec's stack section names OpenAI/Gemini for AI and lists modules (`Departments`, `Reports`) that appear in no version plan. The `.env` default is Anthropic, and those two modules are unallocated scope — decide before building either.

## v2 as built

v1 left seams for v2. Two did not survive contact with the available API key, and the corrections matter more than the original plan:

- **The provider is Groq, not Anthropic.** `AI_PROVIDER=groq`, over plain `fetch` at `GROQ_BASE_URL`. **Groq is not Grok** — different company, one letter apart. xAI is implemented too (`AI_PROVIDER=xai`); both share `ai/openai-compatible.provider.ts` and differ only by configuration. `anthropic` and `openai` remain in the env enum with no implementation; selecting one logs a warning and falls back to the stub.
- **Groq needs TWO models.** Its text models reject image content outright (`messages[0].content must be a string`); only the Qwen multimodal model accepts it. So `GROQ_MODEL` does summaries and `GROQ_VISION_MODEL` does OCR. Do not point `GROQ_MODEL` at Qwen: it is a reasoning model, and its preamble breaks Groq's server-side JSON validation, failing every summary with `json_validate_failed`. Blank `GROQ_VISION_MODEL` disables OCR while leaving summaries working — `AiProvider.supportsVision` is how the extractor knows not to rasterise.
- **No vision model reads PDFs** — images only. So OCR is a dispatch, not a single call: `text/plain` is read directly, PDFs and Office files are parsed for their text layer with `officeparser` (free, exact, zero API calls), and **only a PDF with no text layer** — a real scan — is rasterised to page images with `pdfjs-dist` + `@napi-rs/canvas` and sent to the model. See `documents/extraction/`.
- **Reasoning models must be muzzled.** Qwen narrates inside `<think>` tags, and that text would be stored as the document's contents and indexed for search. `reasoning_format: 'hidden'` suppresses it — but it is **per-model**, and sending it to a non-reasoning model is a hard 400. The provider discovers this from the vendor's own rejection and caches it, so the config cannot be set up wrongly. `stripReasoning()` is the belt-and-braces.
- **There are no embeddings.** Neither Groq nor xAI publishes an embeddings endpoint, so `document_metadata.embedding vector(1024)` exists and stays NULL. Search runs on Postgres full text plus `pg_trgm`. Setting `VOYAGE_API_KEY` switches semantic search on with no migration — that is the whole point of the dormant column.
- **The free tier is the design constraint.** Measured on Groq: 8,000 tokens/min on the vision model against 1,200-3,000 for one page image. Hence `AI_MAX_OCR_PAGES=8` by default, a 429 handler that honours the vendor's own Retry-After, and an OCR loop that **keeps the pages it already read** when a later one fails rather than discarding paid-for work.
- **`f_normalize()` replaced `f_unaccent()` for search.** Postgres' `unaccent` covers Latin diacritics only and leaves Arabic tashkeel untouched, so `مستند` would not have matched `مُسْتَنَد`. The migration `arabic_search_normalisation` strips tashkeel and folds أإآٱ→ا, ى→ي, ة→ه. **Both the indexing trigger and every query call that one function**, so they cannot drift.
- **No AI key is a supported configuration.** `NullAiProvider` returns deterministic, input-derived, clearly-labelled output, so the queue, the status transitions, the notifications and the search indexing all run and are all testable without a credential. `aiModel: 'null'` is how the UI knows to say so.
- **Failure is never terminal for a document.** A failed OCR or summary still ends at `READY` — the bytes uploaded fine and the file must stay downloadable. The failure lives on `ocrStatus`/`aiStatus` instead.
- **Reserved and now used**: `derived/company_<id>/<documentId>/pages/<n>.png` for rasterised OCR pages.

### Things that will bite

- **`$queryRaw` is NOT covered by the tenant guard.** The guard extends `query.$allModels`; raw SQL names no model. `SearchService` is the only raw query in the system and pins `company_id` by hand from `TenantContextService`, with `search.sql.spec.ts` asserting the predicate is present. Any future raw query must do the same.
- **A queue worker has no request, so no tenant context.** Use `TenantContextService.runAs(companyId, userId, fn)` — not `runAsSystem()`, which would hand a job for one customer the whole database. The company travels in the job payload.
- **Enqueue AFTER the transaction commits.** Redis and Postgres share no transaction; a job picked up mid-transaction cannot see the row it names.
- **`QUEUE_WORKER_ENABLED=false` in the e2e suite.** Each spec file boots its own AppModule, and four workers racing one queue process each other's documents. `processing.e2e-spec.ts` drives the pipeline directly instead. It is also the flag that lets the API scale separately from the workers.
- **The e2e suite runs on Redis database 1, and that is not tidiness.** The flag above only silences the workers inside the test process. `npm run dev` runs an API with it at its default of `true`, against the same Redis and the same Postgres, so **a dev server left running eats the suite's jobs** and walks its documents through the pipeline underneath the assertions. The symptom is a status assertion failing against a status nothing in the test set, in whichever specs lose the race, differing run to run — it looks exactly like a regression and is not one. `e2e-env.ts` rewrites `REDIS_URL` to db 1, which isolates the queue and the SSE bus both. If e2e ever fails non-deterministically on statuses, check for a dev server before reading the diff.
- **Jest cannot dynamically import ESM** without `--experimental-vm-modules`, so the pdfjs and officeparser paths are unit-tested with mocks and exercised for real only through the `text/plain` path in e2e.
- **A tsvector/vector column must be declared `Unsupported(...)` in the schema** even though Prisma never touches it, or `migrate dev` diffs it away as a column it cannot see.

## v4 as built

The collaboration layer. Most of it is ordinary CRUD; these are the decisions that are not, and the ones a later change is most likely to undo by accident.

- **`Comment` and `DocumentFavorite` carry their own `companyId`.** `PATCH`/`DELETE /api/comments/:id` route on a bare comment id with no document in the path, so the guard has to filter before execution rather than reach the tenant through a parent. Both are in `TENANT_SCOPED_MODELS`.
- **Authorship is checked in the service, not the guard.** `PermissionsGuard` ANDs a fixed list and cannot express "the author, OR anyone holding `comments.moderate`". The route asks for what everyone in a conversation holds; whose comment you may delete is decided in `CommentsService`. Editing is author-only **even for a moderator** — that permission is "delete anyone's comment", and putting different words in someone's mouth is not moderation.
- **Archive is read-only for what a document IS, not for what is said about it.** `assertWritable` refuses renames, moves, new versions and reprocessing, and is deliberately NOT applied to reading, downloading, commenting, or moving to the trash. Freezing a record is not sealing it away, and an archived document nobody could ever delete would be worse than one deleted by mistake — the trash is reversible.
- **Archive is refused mid-pipeline.** The processing run ends with an unconditional advance to `READY`, so a document archived while a worker held it would quietly un-archive itself with nothing in the trail to explain it.
- **Nothing in the version history rewinds.** Uploading a replacement appends, and so does reverting — the old bytes are COPIED to a fresh storage key and become version N+1. `DocumentVersion.storageKey` is unique, so two rows cannot name one object. Each version carries its own `mimeType` and `originalName` so a revert restores what the document was, not merely its bytes.
- **Bulk reports partial success and returns 200 either way.** A multi-select runs over a paginated list, so some rows are always stale by the time the button is pressed; all-or-nothing means a user can never finish the action without hunting for the offender, and fifty deletes are fifty independent facts with no invariant for a transaction to protect. Every id comes back as done or skipped-with-a-code.
- **One bulk route per action, not one endpoint taking an action name.** The permission genuinely differs per action, and a single route would have to demand the strictest of them — costing a Member bulk delete, which they can already do one at a time — or move authorisation out of the guard.
- **`DocumentsModule` lists `BulkDocumentsController` FIRST, and that is load-bearing.** `documents/bulk/restore` and `documents/:id/restore` are both two-segment patterns; Nest registers controllers in array order, so reversing them binds `:id` to the literal `"bulk"` and every bulk route fails in `ParseUUIDPipe`. That is a **400**, so a test checking only for "not 500" would miss it. `bulk.e2e-spec.ts` asserts it directly.
- **Favourites are the one write that is not audited.** A favourite changes nothing about the document, and an audit row would publish a private shortlist to everyone holding `audit.read`. `FavoritesModule` is the only module that does not import `AuditModule`.
- **A favourite is a create, never an upsert.** The guard refuses an upsert whose where-clause cannot pin the tenant, and `@@id([userId, documentId])` does not include `companyId`. So P2002 is read as "already starred" and unfavouriting is a `deleteMany` — both halves of a toggle are idempotent.
- **`userId` for favourites always comes from the token.** There is deliberately no `?userId=` beside `?favorite=true`: colleagues share a company, so "anyone's shortlist" is a within-tenant leak the guard cannot see.
- **Bulk tags is a DELTA; the single-document route is a whole-set `PUT`.** Whole-set semantics across a selection would clear labels the caller never saw on rows they never opened. A tag named on both sides is refused rather than resolved by picking an order.
- **`AuditService.recordMany()` exists because bulk still owes one row per document.** "Who deleted this file" is a question about one file, so a summary row naming fifty ids would not answer it — but looping `record()` is fifty round trips. Same action names as the single-document routes, so existing `?action=` filters keep working; `bulk: true` in the metadata separates fifty deliberate deletions from one careless click.
- **The `DocumentTag` writes in bulk go direct, which the guard does not filter.** That is the documented escape hatch, used in its sanctioned form: every document id came back from a tenant-scoped `findMany` and every tag id from a tenant-scoped `tag.findMany` before either statement runs. The alternative is one nested write per selected row.

### Web, v4

- **The primitives in `components/ui/` are the design system**; do not hand-roll a checkbox, table, tooltip, avatar or page header. Three copies of the initials avatar had already accumulated and two were wrong — they sliced with `charAt(0)`, which splits a surrogate pair.
- **`indeterminate` is a DOM property with no HTML attribute.** React will not render it, so `Checkbox` assigns it to the node through a ref. A "select all" box showing a tick when three of fifty rows are selected is a lie the user acts on.
- **`vitest.setup.ts` registers `afterEach(cleanup)` by hand.** React Testing Library registers it itself only by reaching for a **global** `afterEach`, and `globals: false` means there is not one. Without it every render stays in the document and the failures are baffling rather than obvious — a query matching "multiple elements" the test never rendered, `user.tab()` landing on a control from the previous test.
- **The processing panels live in `components/documents/document-panels.tsx`**, shared by the quick-look dialog and the detail route. Two renderings of the same `ProcessingStage` is how a document ends up meaning different things on different screens.
- **`DocumentBytes` owns the object URL and its revocation.** The blob pins the whole file in memory until released, and a component unmounted mid-fetch has already run its cleanup and will never see the URL that arrives afterwards — so that case revokes inline.
- **A document's name is never put in `generateMetadata`.** It is tenant data behind a permission check, and that function runs server-side with no session; the heading shows it after the API has authorised the read. The detail route is `robots: noindex`.

### Wiring v4 into the views

The collaboration layer shipped as an API before it shipped as a UI, so this is the half that connects them. The decisions that are not obvious from the markup:

- **The list projection carries tags, and that was an API change made for the browser.** `?tagId=` had existed since v4 with nothing able to show which labels a row carries — a filter nobody could discover and a match nobody could explain. `isFavorite` and `tags` are OPTIONAL on the web's `DocumentSummary`, because only the list resolves them: a row patched from a rename or archive response would otherwise silently read as unstarred and untagged.
- **The star is optimistic, and it is safe to be.** Both halves are idempotent server-side — starring twice is not an error, nor is unstarring what was never starred — so a reverted click leaves nothing half-done. The parent owns the value rather than the button, because one document can be on screen in a list and again in a dialog.
- **Tags on the detail page are read-then-edit, never a live picker.** `PUT /documents/:id/tags` replaces the whole set, and whole-set semantics are only safe once the form has shown what is already there. A picker firing per chip would also let two rapid changes settle on the earlier one.
- **Bulk reports into a PANEL, not a toast.** "43 archived, 7 skipped" is a result someone has to sit and read; four seconds of toast is the wrong shape, and dropping the detail to fit one line is how a user comes to believe all fifty went through. Skips are grouped by reason — fifty ids is a wall of UUIDs nobody can map to anything. `codeMessage()` exists for this: a bulk refusal is a bare code inside a 200, with no English message to fall back to the way a thrown `ApiError` has.
- **`BulkBar` outlives the selection.** A batch clears what it acted on, so gating the whole bar on `count > 0` would take the report away in the frame it arrived.
- **The selection is stamped with the filter it was made under**, and compared during render. Clearing it from an effect is a cascading render — see the lint rule below — and a selection surviving a filter change would act on rows nobody can see.
- **Comment bodies render as plain text.** No markdown pass, no linkifier: both are HTML-injection surfaces added for a formatting need nobody has stated. `whitespace-pre-wrap` and nothing else.
- **`comment.changed` broadcasts to the whole company including the author**, so `CommentThread` remembers the ids it just wrote and ignores its own echo. Without that, every post refetches a list the client already holds the authoritative response for, and the thread flickers between the appended row and the refetched one.

### Things the browser got wrong once

Each of these was a real reported bug, and each is a class rather than a one-off.

- **`useModalBehavior` must not depend on `onClose`.** Every caller passes an inline arrow, so its identity changes on every render of the component owning the dialog. Depending on it made the setup effect tear down and rebuild on **every keystroke**: the cleanup fired `restoreTo.current?.focus()` and the setup re-focused the panel's first control, so typing into the second field of a dialog threw focus back to the first. It is shared by `Dialog` and `Drawer`, so it was every overlay at once. The handler reads `onClose` through a ref and the effect keys on `open` alone. `dialog.test.tsx` covers it.
- **`truncate` does nothing to a flex item without `min-w-0`.** A flex item's min-width defaults to `auto`, which refuses to shrink below its content, so the element overflows its container instead of ellipsing. This put a 64-character checksum outside the details card. `Tooltip` now carries `min-w-0 max-w-full` itself — a tooltip must never change the box its trigger occupies — and every long value in that card sets it too.
- **`react-hooks/set-state-in-effect` means derive, do not reset.** Resetting state in response to other state is a cascading render and the lint rejects it. Both cases here became a value computed during render: the stale selection reads as empty, and an edit whose comment has vanished reads as closed.
- **A link that names a thing must go to that thing.** The notification bell resolved `documentId` and then linked to `/documents` — the list — and the detail breadcrumb linked to `?folderId=` that the list never read. Both are fixed, which means both routes now call `useSearchParams` and both pages need a `<Suspense>` boundary or the whole route opts into client rendering. The boundary's fallback is the route's own `loading.tsx`, so a navigation and a suspended params read look identical. `next build` still reports `/[lang]/documents` as SSG — check that it does after touching either page.
