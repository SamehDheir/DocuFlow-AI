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

These fan out across workspaces and no-op cleanly while `apps/` is empty.
