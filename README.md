# DocuFlow AI

Enterprise document management platform with AI assistance — multi-tenant SaaS.

Companies store documents in one place, control who sees what, keep full version
history and audit trails, and use AI to summarise, search, and extract data from
their files.

Full product specification: [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md)
Engineering guidance for AI assistants: [CLAUDE.md](CLAUDE.md)

---

## Status

**Foundation complete, no features yet.** Both apps are scaffolded, build, and
boot. There is no domain functionality: no authentication, no upload, no
folders, no endpoints beyond the health probes.

| Area                       | State                                                             |
| -------------------------- | ----------------------------------------------------------------- |
| Development infrastructure | Working — Postgres, Redis, MinIO run via Docker Compose           |
| Database schema            | Migration `init` applied — 14 tables, composite tenant indexes    |
| `apps/api` (NestJS 11)     | Boots. Env validation, tenant guard, `GET /health`. 8 tests pass. |
| `apps/web` (Next.js 16)    | Boots. Default page + `GET /api/health`. No tests yet.            |
| CI pipeline                | Working — API and web jobs now active                             |
| GHCR image publishing      | Configured; images not yet built in CI                            |
| Production compose, nginx  | Template — still never executed                                   |
| Auth, documents, storage   | Not started                                                       |

Docker images have still never been built — the Dockerfiles are written against
this layout and verified by inspection (`dist/main.js` and
`.next/standalone/apps/web/server.js` both land where the Dockerfiles expect),
but no `docker build` has run.

---

## Prerequisites

| Tool           | Version | Notes                                             |
| -------------- | ------- | ------------------------------------------------- |
| Node.js        | 22.x    | `.nvmrc` pins the major — `nvm use`               |
| npm            | ≥ 10    | Workspaces are used; no pnpm/yarn needed          |
| Docker Desktop | recent  | Must be **running** — the CLI alone is not enough |
| Git            | any     |                                                   |

---

## Quick start

```bash
git clone <your-repo-url> && cd "DocuFlow AI"

# 1. Environment. Defaults match docker-compose.yml, so no edits are needed
#    to get running locally.
cp .env.example .env

# 2. Install every workspace (root tooling + both apps).
npm install

# 3. Backing services: Postgres + Redis + MinIO
npm run infra:up

# 4. Apply the database schema
npm run prisma:migrate:deploy --workspace=@docuflow/api

# 5. Both apps in watch mode — API on :3001, web on :3000
npm run dev
```

The API refuses to boot without the infrastructure running: it validates the
environment at startup and connects to Postgres immediately.

Confirm everything came up:

```bash
docker compose ps
```

`postgres`, `redis`, and `minio` should read `healthy`. **`minio-init` showing
`Exited (0)` is correct** — it is a one-shot job that creates the storage bucket
and stops.

### What is now running

| Service       | URL / port            | Credentials                          |
| ------------- | --------------------- | ------------------------------------ |
| PostgreSQL 17 | `localhost:5432`      | `docuflow` / `docuflow_dev_password` |
| Redis 7       | `localhost:6379`      | password `docuflow_dev_password`     |
| MinIO API     | `localhost:9000`      | `docuflow` / `docuflow_dev_password` |
| MinIO Console | http://localhost:9001 | same                                 |

Optional extras, off by default:

```bash
docker compose --profile tools up -d   # Adminer (DB browser) → localhost:8080
docker compose --profile mail up -d    # Mailpit (catches outgoing mail) → localhost:8025
```

### Managing the stack

```bash
npm run infra:logs     # tail all service logs
npm run infra:down     # stop, keep data
npm run infra:reset    # destroy volumes and start clean
```

`infra:reset` deletes all local database and object-storage data. It is also the
only way to re-run `docker/postgres/init/*.sql`, which executes just once when
the Postgres volume is first created.

---

## Repository layout

```
.
├── apps/
│   ├── api/                    @docuflow/api — NestJS 11 + Prisma 7
│   │   ├── prisma/
│   │   │   ├── schema.prisma   14 models, tenant-scoped
│   │   │   └── migrations/
│   │   ├── prisma.config.ts    Prisma 7 CLI config (connection URL lives here)
│   │   └── src/
│   │       ├── common/tenant/  AsyncLocalStorage tenant context + middleware
│   │       ├── config/         zod environment validation
│   │       ├── health/         GET /health  (outside the /api prefix)
│   │       └── prisma/         PrismaService + tenant guard extension
│   └── web/                    @docuflow/web — Next.js 16 + Tailwind 4
├── packages/                   shared types / Zod schemas (planned)
├── docker/
│   ├── api.Dockerfile          multi-stage NestJS build      [template]
│   ├── web.Dockerfile          multi-stage Next.js build     [template]
│   ├── nginx/nginx.conf        reverse proxy, TLS off        [template]
│   └── postgres/init/          extensions, run once on init
├── .github/
│   ├── workflows/ci.yml        lint, typecheck, test, build
│   ├── workflows/release.yml   build + push images to GHCR
│   ├── ISSUE_TEMPLATE/
│   ├── dependabot.yml
│   └── pull_request_template.md
├── docker-compose.yml          local backing services
├── docker-compose.prod.yml     full stack incl. apps + nginx  [template]
└── .env.example                every variable, documented
```

Files marked `[template]` have **never been executed**. They are written against
the current layout — the API's `dist/main.js` and the web app's
`.next/standalone/apps/web/server.js` both land exactly where the Dockerfiles
expect — but no `docker build` has been run against them. Expect to fix small
details the first time each one does.

---

## Scripts

Root scripts fan out across every workspace via `scripts/run-workspaces.mjs`,
skipping any workspace that does not define the script. `npm test` therefore
runs the API suite and silently skips `apps/web`, which has no test runner yet.

| Command                | Does                                     |
| ---------------------- | ---------------------------------------- |
| `npm run lint`         | Lint all workspaces                      |
| `npm run typecheck`    | Typecheck all workspaces                 |
| `npm test`             | Test all workspaces                      |
| `npm run build`        | Build all workspaces                     |
| `npm run dev`          | Start all workspaces in dev mode         |
| `npm run format`       | Rewrite files with Prettier              |
| `npm run format:check` | Verify formatting (this is what CI runs) |
| `npm run infra:*`      | Manage Docker services (see above)       |

---

## Branching

git-flow. `develop` is the integration branch — everything branches from it and
merges back into it. `main` holds production and receives releases only.

```
main                 tagged releases only; every merge publishes images to GHCR
  └── develop        integration branch — branch from here
        ├── feature/…
        ├── fix/…
        ├── chore/…
        └── docs/…
```

```bash
git checkout develop && git pull origin develop
git checkout -b feature/document-upload
# …then open a PR into develop
```

Never commit directly to `main` or `develop`. Full conventions — naming, commit
format, release and hotfix procedure — are in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## CI/CD

### `ci.yml` — every pull request and push to `main`/`develop`

| Job             | Runs                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| **Static**      | Prettier check, `actionlint`, both compose files parsed                  |
| **Dockerfiles** | `hadolint` on the api and web Dockerfiles                                |
| **Secret scan** | `gitleaks` across full history                                           |
| **API**         | Prisma migrate + lint/typecheck/test/build against live Postgres + Redis |
| **Web**         | lint/typecheck/test/build                                                |
| **CI OK**       | Aggregate gate — use _this_ for branch protection                        |

API and Web skip themselves until their app directory exists. Protect the **CI
OK** check rather than the individual jobs: a skipped job never reports a status,
so requiring it directly would block every merge permanently.

CI runs migrations with `prisma migrate deploy`, not `db push`. That is
intentional — `db push` derives the schema from `schema.prisma` and would hide a
missing or broken migration that then fails in production.

### `release.yml` — merges to `main` and `v*.*.*` tags

Builds each app image and pushes to `ghcr.io/<owner>/docuflow-api` and
`docuflow-web`, tagged with the branch, short SHA, semver, and `latest` on the
default branch. Layer caching uses the GitHub Actions cache.

It **publishes only — it does not deploy.** No host or credentials are configured,
so deployment is the manual step below.

---

## One-time GitHub setup

In the repository settings:

1. **Default branch → `develop`** (Settings → General → Default branch). This
   matters beyond convenience: new pull requests target the default branch, and
   **Dependabot reads `.github/dependabot.yml` from the default branch only**.
   Until this is changed, Dependabot keeps using the copy on `main` and keeps
   opening PRs against `main`, regardless of the `target-branch` setting.
2. **Branch protection** on **both** `main` and `develop` — require pull
   requests, and require the status check named **`CI OK`** (only this one; see
   the CI/CD section for why).
3. **Actions → General → Workflow permissions** — confirm `GITHUB_TOKEN` may
   write packages, so `release.yml` can push to GHCR.
4. **Packages** — images are private by default. Make them public from the
   package settings if you want them pullable without authentication.
5. **`.github/CODEOWNERS`** — replace `@your-github-username` and uncomment to
   enable automatic review requests.
6. **`.github/ISSUE_TEMPLATE/config.yml`** — replace `OWNER/REPO` in the security
   advisory link.
7. Add a CI badge to the top of this file:
   ```markdown
   [![CI](https://github.com/SamehDheir/DocuFlow-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/SamehDheir/DocuFlow-AI/actions/workflows/ci.yml)
   ```

Any Dependabot pull requests opened before step 1 still target `main`. Either
retarget them in the GitHub UI, or close them and let the next scheduled run
reopen them against `develop`.

**Note on `gitleaks`:** free for public repositories and personal accounts. Under
a GitHub _organisation_ it requires a `GITLEAKS_LICENSE` secret and the job will
fail without one — swap it for `docker run zricethezav/gitleaks:latest detect` if
that applies.

---

## Deploying

Deployment is deliberately manual. On a host with Docker:

```bash
# Provide real secrets — docker-compose.prod.yml refuses to start without them.
cp .env.example .env && "$EDITOR" .env

docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Generate every secret fresh:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`JWT_SECRET` and `JWT_REFRESH_SECRET` must differ. If they match, any access
token is structurally valid as a refresh token, letting a short-lived leaked
token be traded for indefinite session renewal.

This is a **single-host** deployment: no replication, no failover, and Postgres
and MinIO data live on that host's volumes. Backups are your responsibility.
TLS is not configured — terminate it at a load balancer, or with certbot or
Caddy in front of nginx.

---

## Next steps

The foundation is in place. Toward the MVP (PROJECT_DOCUMENTATION.md §16), in
rough order:

1. **Authentication** — register company + admin, login, JWT, refresh. This is
   the unblocking task: `TenantMiddleware` reads `req.user.companyId`, so until
   a JWT guard populates it, every tenant-scoped query throws by design and no
   other feature can be built on top.
2. **Permission seeding** — `permissions` is a global catalogue; seed it and the
   default per-company roles (Admin, Manager, Employee, Guest).
3. **Folders** — create/list/rename, scoped by company.
4. **Documents** — upload to MinIO, list, download, soft delete, restore. Add
   the MinIO client; it is not installed yet.
5. **Audit logging** — an interceptor writing `audit_logs` on mutations, rather
   than scattered per-handler calls.
6. **Dashboard** — storage usage, recent documents, activity.

Deferred by design: BullMQ queues, OCR, AI, and Swagger are all v2 (§17) and
none of their packages are installed.

Before feature work, two things are worth doing: give `apps/web` a test runner
(it has no `test` script, so CI silently skips it), and run `docker build` once
against each Dockerfile — they have never been executed.

---

## Troubleshooting

**`docker compose` fails with a daemon connection error.** Docker Desktop is
installed but not started. Launch it and wait for the whale icon to settle.

**Port already in use.** Something else holds 5432, 6379, or 9000. Change the
`*_PORT` value in `.env` — every published port is configurable for this reason.

**Postgres extensions missing.** `docker/postgres/init/*.sql` runs only on first
initialisation of an empty volume. Editing it later changes nothing until
`npm run infra:reset`.

**`npm ci` fails in CI with a lockfile error.** `package-lock.json` is out of
sync with `package.json`. Run `npm install` locally and commit the updated lockfile.

**Line-ending or shell-script errors inside containers.** `.gitattributes`
normalises everything to LF. If you cloned before it existed, refresh the working
tree with `git add --renormalize . && git checkout -- .`.
