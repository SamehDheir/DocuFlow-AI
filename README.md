# DocuFlow AI

Enterprise document management platform with AI assistance — multi-tenant SaaS.

Companies store documents in one place, control who sees what, keep full version
history and audit trails, and use AI to summarise, search, and extract data from
their files.

Full product specification: [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md)
Engineering guidance for AI assistants: [CLAUDE.md](CLAUDE.md)

---

## Status

**Pre-implementation.** This repository currently contains infrastructure,
tooling, and CI/CD only — there is no application code yet.

| Area                       | State                                                   |
| -------------------------- | ------------------------------------------------------- |
| Development infrastructure | Working — Postgres, Redis, MinIO run via Docker Compose |
| CI pipeline                | Working — passes with the current empty `apps/`         |
| GHCR image publishing      | Configured, dormant until `apps/` has code              |
| Production compose, nginx  | Template — unbuildable until the apps exist             |
| `apps/api` (NestJS)        | Not scaffolded                                          |
| `apps/web` (Next.js)       | Not scaffolded                                          |

The API and web jobs in CI detect their own app directories and skip when absent,
so they activate on their own as soon as each app is scaffolded — no workflow
changes needed.

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

# 2. Root tooling (Prettier). Applications bring their own dependencies later.
npm install

# 3. Backing services: Postgres + Redis + MinIO
npm run infra:up
```

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
├── apps/                       not created yet
│   ├── api/                    NestJS + Prisma  (planned)
│   └── web/                    Next.js          (planned)
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

Files marked `[template]` have **never been executed** — they encode the intended
setup but depend on application code that does not exist yet. Expect to fix small
details the first time each one runs.

---

## Scripts

Root scripts fan out across every workspace via `--if-present`, so they succeed
harmlessly while `apps/` is empty.

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

The infrastructure is ready; the applications are not. In rough order:

1. Scaffold `apps/api` (`nest new`) with package name `@docuflow/api`, exposing
   `GET /health` — both the Dockerfile healthcheck and the compose stack assume it.
2. Add Prisma, and model `companies`, `users`, `roles`, `permissions`, and
   `documents` from PROJECT_DOCUMENTATION.md §14 — noting that those sketches
   list column names only, with no types, relations, or indexes.
3. Enforce tenant isolation centrally (Prisma middleware or a request-scoped
   tenant context) before writing feature code. Retrofitting `company_id`
   filtering onto scattered queries is how tenant leaks happen.
4. Scaffold `apps/web` (`create-next-app`) as `@docuflow/web`, with
   `output: 'standalone'` in `next.config.ts` — `web.Dockerfile` requires it.
5. Add each app's `lint`, `typecheck`, `test`, and `build` scripts. CI picks them
   up automatically.

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
