# Contributing

## Branching model

This repository follows git-flow. Every branch is cut from `develop` and merges
back into `develop`; `main` only ever receives releases.

```
main         production. Tagged releases only. Every merge here publishes images.
  │
  └── develop            integration branch. Everything branches from here.
        ├── feature/…    new functionality
        ├── fix/…        bug fixes
        ├── chore/…      tooling, dependencies, config
        └── docs/…       documentation only

hotfix/…     the one exception: branches from main (see below)
```

**Never commit directly to `main` or `develop`.** Both take changes through pull
requests only.

### Branch naming

| Prefix      | For                                | Example                        |
| ----------- | ---------------------------------- | ------------------------------ |
| `feature/`  | New functionality                  | `feature/document-upload`      |
| `fix/`      | Bug fix                            | `fix/refresh-token-expiry`     |
| `chore/`    | Tooling, dependencies, CI          | `chore/bump-prisma`            |
| `docs/`     | Documentation only                 | `docs/api-authentication`      |
| `refactor/` | Restructuring, no behaviour change | `refactor/tenant-context`      |
| `hotfix/`   | Urgent production fix              | `hotfix/document-download-500` |

Use lowercase and hyphens. Reference the issue when there is one:
`feature/142-ocr-queue`.

### Everyday workflow

```bash
# Always start from an up-to-date develop
git checkout develop
git pull origin develop

git checkout -b feature/document-upload

# …work…
git add -A
git commit -m "feat(documents): add multipart upload endpoint"
git push -u origin feature/document-upload
```

Then open a pull request **into `develop`**.

Keeping a long-running branch current:

```bash
git checkout feature/document-upload
git rebase develop        # or: git merge develop
```

Prefer rebase before the branch is shared, merge after — rebasing a branch
someone else has pulled rewrites history under them.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). The prefixes match
the ones Dependabot is configured to use, so history stays consistent:

```
feat(documents): add multipart upload endpoint
fix(auth): reject refresh tokens signed with the access secret
chore(deps): bump prisma to 6.2.0
ci(deps): bump actions/checkout to v5
docs(readme): document the branching model
refactor(tenant): centralise company_id filtering
test(documents): cover cross-tenant access rejection
```

Scope is optional but helps. Write the subject in the imperative — "add", not
"added".

## Pull requests

1. Fill in the PR template, including the **tenant isolation** section. A query
   missing its `company_id` filter behaves perfectly in single-tenant testing and
   leaks data in production — that checklist exists because the bug class is
   invisible to normal review.
2. CI must be green. The required check is **`CI OK`**, a single aggregate gate.
3. Keep PRs small enough to review in one sitting.

## Releases

Releases flow `develop → main`. Merging to `main` publishes images to GHCR
(`.github/workflows/release.yml`).

```bash
# 1. Open a PR from develop into main, review, merge.

# 2. Tag the release on main
git checkout main
git pull origin main
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

The tag produces semver-tagged images (`1.0.0`, `1.0`, `latest`); merging to
`main` alone produces `main` and `sha-<short>` tags.

## Hotfixes

The only branch that does not start from `develop`:

```bash
git checkout main
git pull origin main
git checkout -b hotfix/document-download-500
```

Merge the hotfix into `main` **and** back into `develop`, or the next release
silently reverts the fix.

## Before pushing

```bash
npm run format         # apply Prettier
npm run lint
npm run typecheck
npm test
```

These fan out across both workspaces. `npm test` covers the unit suites only —
CI additionally runs the API's e2e suite, which boots the real AppModule, so run
it yourself for anything touching a controller, the tenant guard, or the schema:

```bash
npm run infra:up
npm run test:e2e --workspace=@docuflow/api
```

## Things that are easy to get wrong here

Worth knowing before a first pull request; each one has bitten this repository
already and is documented where it lives.

- **Never add a manual `companyId` filter.** Isolation is a Prisma client
  extension, and hand-filtering hides whether the guard is doing its job. Inject
  `TENANT_PRISMA`; `PrismaService` is the raw client and is for infrastructure
  only. Raw SQL is not covered — pin the predicate by hand and add a spec.
- **A new tenant-scoped model must be registered in `tenant-guard.ts`.** A model
  with a `companyId` that is missing from the list is not merely unfiltered on
  read: the guard also stops stamping the company on create, so inserts fail.
  `tenant-registration.spec.ts` parses `schema.prisma` and fails if one is
  missing — it exists because this shipped undetected once.
- **Prisma promises are lazy**, which interacts badly with `AsyncLocalStorage`.
  Returning an unawaited query out of a context callback runs it after the scope
  has unwound, with no tenant bound.
- **Enqueue after the transaction commits.** Redis and Postgres share no
  transaction, so a job picked up mid-transaction cannot see the row it names.
- **Adding an error code means adding a translation.** `dictionaries.test.ts`
  parses `error-codes.ts` and fails if either locale is missing an entry.
- **Restart the web dev server after editing a dictionary.** Turbopack does not
  hot-reload the JSON, so a new key renders as `undefined` while typecheck passes.
- **Stop the dev server before running e2e.** `npm run dev` starts an API with
  `QUEUE_WORKER_ENABLED` at its default of `true`; its worker consumes the jobs
  the suite enqueues and moves those documents through the pipeline underneath
  the assertions. `test/e2e-env.ts` puts the suite on Redis database 1 to prevent
  it, but if you ever see status assertions failing differently on each run, this
  is the first thing to check — it looks exactly like a regression.
- **Do not depend on a callback prop inside an effect that sets something up.**
  Callers pass inline arrows, so the identity changes every render and the effect
  tears down and rebuilds continuously. `useModalBehavior` did this with
  `onClose` and stole focus back to the first field on every keystroke, in every
  dialog and drawer in the app. Hold the callback in a ref and key the effect on
  what actually changed.
- **`truncate` needs `min-w-0` on a flex item.** A flex item will not shrink
  below its content by default, so the text overflows its container instead of
  ellipsing. This is why a checksum hung outside its card.
- **Derive, do not reset.** `react-hooks/set-state-in-effect` rejects setting
  state in response to other state. Compute the value during render instead — a
  stale selection reading as empty is the same answer without the cascading
  render.

The tenant-isolation section of the pull request template is not a formality: a
query missing its filter behaves perfectly in single-tenant testing and leaks
data in production.
