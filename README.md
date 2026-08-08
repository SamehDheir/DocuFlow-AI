<div align="center">

# DocuFlow AI

**Multi-tenant document management with AI assistance.**

Companies store documents in one place, control who sees what, keep full version
history and audit trails, and use AI to read, summarise and search their files —
in Arabic and English.

[![CI](https://github.com/SamehDheir/DocuFlow-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/SamehDheir/DocuFlow-AI/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-22.x-5FA04E?logo=node.js&logoColor=white)](.nvmrc)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white)](apps/api)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)](apps/web)
[![Postgres](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)](docker-compose.yml)
[![Tests](https://img.shields.io/badge/tests-484%20passing-3FB950)](#testing)

[Quick start](#quick-start) · [Architecture](#architecture) ·
[Testing](#testing) · [Deploying](#deploying) · [Roadmap](NEXT_STEPS.md)

</div>

---

## Contents

- [Screenshots](#screenshots)
- [Status](#status)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Scripts](#scripts)
- [CI/CD](#cicd)
- [Deploying](#deploying)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Security](#security)
- [Licence](#licence)

---

## Screenshots

<!--
  Drop images in docs/screenshots/ and uncomment. Two or three are enough:
  the document browser with a selection active, the document detail route, and
  the Arabic layout — the RTL shot is the one that shows the i18n is real.

  | Documents | Detail |
  | --- | --- |
  | ![Document browser](docs/screenshots/documents.png) | ![Document detail](docs/screenshots/detail.png) |
-->

> Not yet captured. Run `npm run dev`, then add images to `docs/screenshots/`
> and uncomment the block above.

---

## Status

**v1–v4 are complete end to end.** A person can register a company, invite
colleagues, upload files, watch them be read and summarised on a queue worker,
search inside them in Arabic or English, tag and discuss and version them, route
them for sign-off, and restore what they delete — with every mutation audited.

| Area                    | State                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api` (NestJS 11)  | Auth, permissions, storage, folders, documents, queue, AI, search, notifications, events, approvals, audit, users, roles, invitations, tags, comments, favourites |
| `apps/web` (Next.js 16) | Design system, Arabic/English i18n with RTL, auth screens, and eight guarded app routes                                                                           |
| Database                | 7 migrations, 20 tables, composite tenant indexes throughout                                                                                                      |
| Infrastructure          | Postgres 17 (pgvector), Redis 7 (BullMQ + the SSE event bus), MinIO — via Docker Compose                                                                          |
| Tests                   | **316** API unit · **95** API e2e · **73** web. All green — see [Testing](#testing)                                                                               |
| CI                      | Lint, typecheck, unit **and e2e**, build. `release.yml` publishes nothing until CI passes on the same commit                                                      |

### What each version added

| Version | Shipped                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **v1**  | Auth (register, login, JWT + rotating refresh, roles), folders, upload/list/download, soft delete and restore, dashboard, audit log              |
| **v2**  | Text extraction and OCR, AI summaries, full-text search with Arabic normalisation, in-app notifications, live SSE updates, single-step approvals |
| **v3**  | Members, role assignment, invitations — the first way a company can hold more than its founder                                                   |
| **v4**  | Tags, comments, favourites, version history with revert, archive, bulk operations, and a document detail route to hold them                      |

Deferred by design: mobile app, external API, third-party integrations, billing.

---

## Features

**Documents**

- Folder tree, drag-and-drop upload with per-file progress, streamed downloads
- Inline preview for PDFs, images and text; extracted text as the fallback for
  formats no browser renders
- Version history — uploading a replacement appends, and so does reverting.
  Nothing rewinds, and every version keeps its own filename and type
- Archive (read-only, still readable) and a soft-delete trash with restore
- Bulk delete, restore, archive, move and tag across a selection, with a per-id
  report rather than an all-or-nothing batch

**AI and search**

- Text layers parsed locally for PDF and Office files; only a genuine scan is
  rasterised and sent to a vision model
- AI summaries and keywords, on a BullMQ worker, pushed to the browser over SSE
- Full-text search across document contents with **Arabic normalisation** —
  tashkeel stripped and أإآٱ→ا, ى→ي, ة→ه folded, so `مستند` matches `مُسْتَنَد`
- Works with **no AI key at all** against a deterministic stub, clearly labelled
  as one

**Collaboration**

- Tags with a company-wide vocabulary, applied per document or across a selection
- Comments, with author-only editing even for moderators
- Private favourites — never visible to a colleague, and never audited
- In-app notifications that link to the thing they are about

**Access control**

- Multi-tenant by `company_id`, enforced by a fail-closed Prisma client extension
- Owner / Admin / Member roles over a permission catalogue, resolved per request
- Invitations, so a workspace can grow past its founder
- Audit log on every mutation: who, what, when, from where

**Craft**

- Arabic and English with real RTL, not a mirrored stylesheet
- Designed empty, loading, error and dense states — skeletons over spinners
- Motion throughout, and `prefers-reduced-motion` honoured everywhere
- Keyboard paths, visible focus rings and labelled controls on every interaction

---

## Tech stack

| Layer       | Choice                                                                          |
| ----------- | ------------------------------------------------------------------------------- |
| **API**     | NestJS 11, Prisma 7 (`@prisma/adapter-pg`), zod 4 for env, class-validator DTOs |
| **Web**     | Next.js 16 (App Router), React 19, Tailwind 4, `motion`                         |
| **Data**    | PostgreSQL 17 (`pgvector`, `pg_trgm`), Redis 7, MinIO                           |
| **Async**   | BullMQ for the processing queue; Redis pub/sub for the SSE event bus            |
| **AI**      | Groq or xAI over plain `fetch` — both speak the OpenAI wire format              |
| **Tests**   | Jest (API unit + e2e), Vitest + Testing Library (web)                           |
| **Tooling** | npm workspaces, TypeScript 6, ESLint 9, Prettier, Docker Compose                |

**No AI SDK, no component library, no data-fetching library.** Both AI providers
speak one wire format, so the provider is a single `fetch` and a zod parse; the
design system and the API clients are hand-written on purpose. Check
`package.json` before assuming a dependency exists.

---

## Quick start

**Prerequisites:** Node 22.x (`nvm use`), npm ≥ 10, Docker Desktop **running**,
Git. An AI API key is optional — see [AI providers](#ai-providers).

```bash
git clone https://github.com/SamehDheir/DocuFlow-AI.git && cd DocuFlow-AI

cp .env.example .env      # defaults match docker-compose.yml — no edits needed
npm install               # root tooling + both workspaces
npm run infra:up          # Postgres + Redis + MinIO

npm run prisma:migrate:deploy --workspace=@docuflow/api
npm run dev               # API on :3001, web on :3000
```

Open <http://localhost:3000>, create a workspace, and upload something.

The API refuses to boot without the infrastructure: it validates the environment
at startup and connects to Postgres immediately.

```bash
docker compose ps
```

`postgres`, `redis` and `minio` should read `healthy`. **`minio-init` showing
`Exited (0)` is correct** — it is a one-shot job that creates the bucket and stops.

| Service       | URL / port              | Credentials                          |
| ------------- | ----------------------- | ------------------------------------ |
| PostgreSQL 17 | `localhost:5432`        | `docuflow` / `docuflow_dev_password` |
| Redis 7       | `localhost:6379`        | password `docuflow_dev_password`     |
| MinIO API     | `localhost:9000`        | `docuflow` / `docuflow_dev_password` |
| MinIO Console | <http://localhost:9001> | same                                 |

<details>
<summary><b>Optional services, and managing the stack</b></summary>

```bash
docker compose --profile tools up -d   # Adminer (DB browser) → localhost:8080
docker compose --profile mail up -d    # Mailpit (catches mail) → localhost:8025
```

```bash
npm run infra:logs     # tail all service logs
npm run infra:down     # stop, keep data
npm run infra:reset    # destroy volumes and start clean
```

`infra:reset` deletes all local database and object-storage data. It is also the
only way to re-run `docker/postgres/init/*.sql`, which executes just once when the
Postgres volume is first created.

The single `.env` lives at the **repository root**, not per app.

</details>

---

## Architecture

**Multi-tenancy is enforced centrally, not per query.** A Prisma client extension
injects `company_id` into every query and stamps it onto every create, reading the
current tenant from `AsyncLocalStorage`. It is **fail-closed**: with no tenant
bound, a tenant-scoped query throws rather than returning unfiltered rows.
Application code injects `TENANT_PRISMA` and never writes a `companyId` filter by
hand. The one raw-SQL path — full-text search, which Prisma cannot express — pins
the predicate itself, and a spec asserts it is there.

**JWT carries the tenant.** The payload is `{ sub, company_id, roles[], exp }`.
The tenant comes from the verified token, never from a request body or query
parameter. Permissions are resolved per request rather than carried in the token,
because a token lasts 15 minutes and revoking a role has to bite sooner.

**Upload is a pipeline, not a request.** Validate → row at `UPLOADING` → bytes to
MinIO → row to `PROCESSING` + version #1 + audit → _then_ enqueue. A crash leaves
a sweepable row rather than an object nothing references, and the job is queued
only after the transaction commits, because Redis and Postgres share no
transaction.

A worker then takes over: `text/plain` is read directly, PDFs and Office files are
parsed for their text layer with `officeparser`, and **only a PDF with no text
layer** — a real scan — is rasterised to page images and sent to a vision model.
The browser is told over SSE as each step lands. A failed OCR or summary still
ends at `READY`: the bytes uploaded fine and the file must stay downloadable.

**Files never live in Postgres.** Postgres holds metadata, references and
permissions; MinIO holds bytes, keyed
`documents/company_<id>/<year>/<month>/<uuid>.<ext>`. Keys are derived
server-side, never accepted from a client, and there are **no presigned URLs** —
every download and preview streams through the API so each byte stays behind the
same permission check.

**A document is an aggregate**, not a row: file + metadata + permissions +
versions + comments + tags + audit logs + OCR data + AI data.

**Bulk operations report per-id partial success and return 200 either way.** A
multi-select runs over a paginated list, so some rows are always stale by the time
the button is pressed. All-or-nothing would mean never completing the action
without first hunting for whichever id went bad, and fifty deletes are fifty
independent facts with no invariant for a transaction to protect.

### AI providers

The provider is **Groq** by default (`AI_PROVIDER=groq`); xAI is implemented too.
Groq needs **two** models: `GROQ_MODEL` for summaries and `GROQ_VISION_MODEL` for
OCR, because its text models reject image content outright. Leave the vision model
blank to disable OCR while keeping summaries.

**No key is a supported configuration.** `NullAiProvider` returns deterministic,
clearly-labelled output, so the queue, the status transitions, the notifications
and the search indexing all run and are all testable without a credential.

There are no embeddings — neither vendor publishes an endpoint — so search runs on
Postgres full text plus `pg_trgm`. The `vector(1024)` column exists and stays
NULL; setting `VOYAGE_API_KEY` switches semantic search on with no migration.

---

## Testing

| Suite    | Count   | Runner | Needs infra         |
| -------- | ------- | ------ | ------------------- |
| API unit | **316** | Jest   | no                  |
| API e2e  | **95**  | Jest   | **yes** — all three |
| Web      | **73**  | Vitest | no                  |

```bash
npm test                                    # unit suites, both workspaces
npm run infra:up && npm run test:e2e --workspace=@docuflow/api
```

`npm test` runs Jest with `rootDir: src`, so it only sees `src/**/*.spec.ts`. The
e2e suite under `apps/api/test/` boots the real AppModule and is where the
cross-tenant assertions live — CI runs it too, so a red e2e blocks the merge.

Three of these tests exist to catch a specific class of silent failure, and are
worth knowing about:

- `tenant-registration.spec.ts` parses `schema.prisma` and fails if a model
  carrying a `companyId` is not registered with the tenant guard. Such a model is
  not merely unfiltered — the guard also stops stamping the company on create.
  This shipped undetected once.
- `dictionaries.test.ts` forces both locales to carry identical keys, no blank
  values, and a translation for every error code the API can emit — parsed out of
  the API source, since the web has no dependency on it.
- `search.sql.spec.ts` asserts the raw full-text query still pins `company_id` by
  hand. The tenant guard extends `query.$allModels`; raw SQL names no model.

**Stop the dev server before running e2e.** `npm run dev` starts an API with
`QUEUE_WORKER_ENABLED` at its default of `true`, and its worker consumes the jobs
the suite enqueues. `test/e2e-env.ts` puts the suite on Redis database 1 to
prevent it, but non-deterministic status failures are this before they are a
regression.

---

## Project structure

```
.
├── apps/
│   ├── api/                    @docuflow/api — NestJS 11 + Prisma 7
│   │   ├── prisma/
│   │   │   ├── schema.prisma   20 models, tenant-scoped
│   │   │   └── migrations/     7 migrations
│   │   ├── prisma.config.ts    Prisma 7 CLI config (connection URL lives here)
│   │   ├── src/                one directory per module
│   │   └── test/               e2e specs; boot the real AppModule
│   └── web/                    @docuflow/web — Next.js 16 + Tailwind 4
│       └── src/
│           ├── app/[lang]/     locale-routed App Router pages
│           ├── components/ui/  the design system primitives
│           ├── i18n/           en/ar dictionaries + parity tests
│           └── lib/            API clients, one per module
├── docker/
│   ├── api.Dockerfile          multi-stage NestJS build
│   ├── web.Dockerfile          multi-stage Next.js build
│   ├── nginx/nginx.conf        reverse proxy; proxy_buffering off on file routes
│   └── postgres/init/          extensions, run once on init
├── .github/workflows/
│   ├── ci.yml                  lint, typecheck, unit + e2e, build
│   └── release.yml             calls ci.yml, then pushes images to GHCR
├── docker-compose.yml          local backing services
├── docker-compose.prod.yml     full stack incl. apps + nginx
└── .env.example                every variable, documented
```

---

## Scripts

Root scripts fan out across every workspace via `scripts/run-workspaces.mjs`,
skipping any workspace that does not define the script.

| Command                | Does                                     |
| ---------------------- | ---------------------------------------- |
| `npm run dev`          | Start all workspaces in dev mode         |
| `npm run lint`         | Lint all workspaces                      |
| `npm run typecheck`    | Typecheck all workspaces                 |
| `npm test`             | Unit tests, all workspaces               |
| `npm run build`        | Build all workspaces                     |
| `npm run format`       | Rewrite files with Prettier              |
| `npm run format:check` | Verify formatting (this is what CI runs) |
| `npm run infra:*`      | Manage Docker services                   |

Per workspace, and the ones not wired into the root:

```bash
npm run test --workspace=@docuflow/api -- --testPathPatterns=tenant
npm run test:e2e --workspace=@docuflow/api
npm run prisma:generate --workspace=@docuflow/api
npm run prisma:migrate --workspace=@docuflow/api -- --name <migration-name>
```

### Version traps

Two majors moved past common training data. **Verify rather than recall:**

- **Prisma 7** removed `url` from the `datasource` block. CLI connection config
  lives in `apps/api/prisma.config.ts`; the runtime client needs a driver adapter
  (`PrismaPg`). Prisma no longer auto-loads `.env`.
- **Next.js 16** ships its own docs at `node_modules/next/dist/docs/`. Read those
  before writing config.
- **Turbopack does not hot-reload the i18n dictionaries.** Edit `en.json` or
  `ar.json` while `npm run dev` is running and the component reloads but the JSON
  does not, so a freshly added key renders as `undefined`. **Restart the web dev
  server after touching a dictionary.**
- **TypeScript is pinned to 6, ESLint to 9.** TS 7 ships no programmatic compiler
  API, which the Nest CLI and `ts-jest` both need; ESLint 10 removed
  `context.getFilename()`, which `eslint-plugin-react` still calls. Dependabot
  will keep proposing both — do not merge them until the ecosystem catches up.

---

## CI/CD

### `ci.yml` — every pull request and push to `main`/`develop`

| Job             | Runs                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------- |
| **Static**      | Prettier check, `actionlint`, both compose files parsed                                           |
| **Dockerfiles** | `hadolint` on the api and web Dockerfiles                                                         |
| **Secret scan** | `gitleaks` across full history                                                                    |
| **API**         | Prisma migrate, then lint/typecheck/**unit**/**e2e**/build against live Postgres, Redis and MinIO |
| **Web**         | lint/typecheck/test/build                                                                         |
| **CI OK**       | Aggregate gate — use _this_ for branch protection                                                 |

Protect the **CI OK** check rather than the individual jobs: a skipped job never
reports a status, so requiring it directly would block every merge permanently.

CI runs migrations with `prisma migrate deploy`, not `db push` — `db push` derives
the schema from `schema.prisma` and would hide a missing or broken migration that
then fails in production.

MinIO runs as an ordinary step rather than a `services:` container, because it
needs `server /data` as its command and a service container cannot express argv.

### `release.yml` — merges to `main` and `v*.*.*` tags

**Calls `ci.yml` first and publishes nothing until it passes**, so a tag pointing
at a red commit cannot ship. It then builds each app image and pushes to
`ghcr.io/<owner>/docuflow-api` and `docuflow-web`, tagged with the branch, short
SHA, semver, and `latest` on the default branch. It **publishes only — it does not
deploy.**

Two build args are inlined into the web bundle and must be set as repository
variables: `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_MAX_FILE_SIZE`. The second must
match the API's `MAX_FILE_SIZE` — lower rejects valid uploads, higher trades a
clean 413 for a connection reset mid-transfer.

### Branching

git-flow. `develop` is the integration branch; `main` holds production and
receives releases only. Never commit directly to either. Full conventions are in
[CONTRIBUTING.md](CONTRIBUTING.md).

```
main                 tagged releases only; every merge publishes images to GHCR
  └── develop        integration branch — branch from here
        ├── feature/…  fix/…  chore/…  docs/…
```

<details>
<summary><b>One-time GitHub setup</b></summary>

1. **Default branch → `develop`** (Settings → General). This matters beyond
   convenience: new pull requests target the default branch, and **Dependabot
   reads `.github/dependabot.yml` from the default branch only**. Until this is
   changed, Dependabot keeps using the copy on `main` and keeps opening PRs
   against `main`, regardless of the `target-branch` setting.
2. **Branch protection** on **both** `main` and `develop` — require pull requests,
   and require the status check named **`CI OK`** (only this one; see above).
3. **Actions → General → Workflow permissions** — confirm `GITHUB_TOKEN` may
   write packages, so `release.yml` can push to GHCR.
4. **Variables** — set `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_MAX_FILE_SIZE`.
5. **Packages** — images are private by default. Make them public from the package
   settings if you want them pullable without authentication.
6. **`.github/CODEOWNERS`** — replace `@your-github-username` and uncomment.
7. **`.github/ISSUE_TEMPLATE/config.yml`** — replace `OWNER/REPO` in the security
   advisory link.

Any Dependabot pull requests opened before step 1 still target `main`. Either
retarget them in the UI, or close them and let the next scheduled run reopen them
against `develop`.

**Note on `gitleaks`:** free for public repositories and personal accounts. Under
a GitHub _organisation_ it requires a `GITLEAKS_LICENSE` secret and the job fails
without one — swap it for `docker run zricethezav/gitleaks:latest detect` if that
applies.

</details>

---

## Deploying

Deployment is deliberately manual. On a host with Docker:

```bash
cp .env.example .env && "$EDITOR" .env    # real secrets; prod refuses to start without them

docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Generate every secret fresh:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`JWT_SECRET` and `JWT_REFRESH_SECRET` **must differ**. If they match, any access
token is structurally valid as a refresh token, letting a short-lived leaked token
be traded for indefinite session renewal.

`QUEUE_WORKER_ENABLED` lets the API and the processing workers scale separately —
run the API with it off and a second set of containers with it on.

> [!WARNING]
> This is a **single-host** deployment: no replication, no failover, and Postgres
> and MinIO data live on that host's volumes. Backups are your responsibility.
> TLS is not configured — terminate it at a load balancer, or with certbot or
> Caddy in front of nginx.

---

## Troubleshooting

<details>
<summary><b>Common problems, and what they actually mean</b></summary>

**`docker compose` fails with a daemon connection error.** Docker Desktop is
installed but not started. Launch it and wait for the whale icon to settle.

**Port already in use.** Something else holds 5432, 6379 or 9000. Change the
`*_PORT` value in `.env` — every published port is configurable for this reason.

**Postgres extensions missing.** `docker/postgres/init/*.sql` runs only on first
initialisation of an empty volume. Editing it later changes nothing until
`npm run infra:reset`.

**A newly added dictionary key renders as `undefined`.** Turbopack cached the old
JSON. Restart the web dev server.

**The e2e suite fails with `ECONNREFUSED`.** Infrastructure is down —
`npm run infra:up`. The suite needs all three services, MinIO included.

**The e2e suite fails on document statuses, differently each run.** A dev server
is probably still running; its queue worker is consuming the suite's jobs. The
suite runs on Redis database 1 to prevent this, so check that
`apps/api/test/e2e-env.ts` still rewrites `REDIS_URL` before going looking for a
regression.

**`npm ci` fails in CI with a lockfile error.** `package-lock.json` is out of sync
with `package.json`. Run `npm install` locally and commit the updated lockfile.

**Line-ending or shell-script errors inside containers.** `.gitattributes`
normalises everything to LF. If you cloned before it existed, refresh the working
tree with `git add --renormalize . && git checkout -- .`.

</details>

---

## Documentation

| File                                                 | What it is                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) | The product specification. Prose in Arabic, identifiers in English   |
| [CLAUDE.md](CLAUDE.md)                               | Engineering guidance — the constraints that cut across modules       |
| [NEXT_STEPS.md](NEXT_STEPS.md)                       | Known gaps, and where the next feature lands                         |
| [CONTRIBUTING.md](CONTRIBUTING.md)                   | Branching, commits, and what is easy to get wrong here               |
| [SECURITY.md](SECURITY.md)                           | Reporting, scope, and behaviour that looks like a finding but is not |

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first — particularly "things that are easy
to get wrong here", which is a short list of footguns this repository has already
been bitten by.

```bash
npm run format && npm run lint && npm run typecheck && npm test
```

Branch from `develop`, use [Conventional Commits](https://www.conventionalcommits.org/),
and fill in the **tenant isolation** section of the PR template. That section is
not a formality: a query missing its `company_id` filter behaves perfectly in
single-tenant testing and leaks data in production.

---

## Security

Report vulnerabilities privately through **GitHub Security Advisories**, not a
public issue. Scope, and the list of intentional behaviour that resembles a
finding, are in [SECURITY.md](SECURITY.md).

Every credential in `.env.example`, `docker-compose.yml` and the CI workflows is a
placeholder for local development against throwaway containers. They are published
deliberately and are not a vulnerability.

---

## Licence

**No licence is currently granted.** `package.json` declares `UNLICENSED` and
there is no `LICENSE` file, which under copyright default means all rights
reserved — nobody may use, copy or redistribute this code.

That is fine for a private repository, but if this is published as a portfolio
piece it is worth choosing deliberately: add a `LICENSE` file (MIT is the usual
choice for work you want read and reused) and set the matching `license` field in
`package.json`. GitHub will then show the licence in the repository sidebar.
