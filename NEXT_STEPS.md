# Next Steps

Ordered build plan, written 2026-08-02 against commit `b548dd0` (branch `feature/i18n-arabic-english`). Section 1 was completed 2026-08-04 on `feature/auth-backend`.

## Where the project actually stands

| Area          | State                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| API           | `config/`, `common/tenant/`, `common/audit/`, `prisma/`, `health/`, `permissions/`, `auth/`. No documents or storage modules yet.   |
| Web           | Design system, Arabic/English i18n with locale routing, finished login / register / forgot-password screens — **not yet wired up**. |
| Database      | Migrations `init` and `auth_tokens` applied. 15 tables.                                                                             |
| Contract gaps | [auth.ts](apps/web/src/lib/auth.ts) now reaches live endpoints, but nothing stores the session or acts on the response.             |

---

## ~~1. Auth backend~~ — done

Delivered as specified below, with three deviations worth recording:

- **Refresh digests are HMAC-SHA256 keyed with `JWT_REFRESH_SECRET`**, not a bare SHA-256. Same cost, and it gives that env var a real job — the refresh token is opaque rather than a JWT, so nothing else would have signed with it.
- **The permission catalogue is defined in code and reconciled at boot** by `PermissionsService`, instead of a `prisma/seed.ts`. Registration depends on the catalogue existing, and a seed script that someone forgets to run produces companies whose roles silently grant nothing.
- **`POST /auth/reset-password` was added.** The endpoint table below omitted it, which would have left `password_reset_tokens` write-only.

One latent bug surfaced during the e2e run and is worth remembering: **Prisma promises are lazy**, so `runAsSystem(() => db.user.findMany())` handed the unexecuted query back to a caller who awaited it after the context had unwound, and it failed closed. `runAsSystem()` now awaits internally. See the Architecture Constraints note in [CLAUDE.md](CLAUDE.md).

<details>
<summary>Original plan, kept for reference</summary>

### 1.1 Resolve the middleware/guard ordering trap first

This is the one design decision to make before writing code, because getting it wrong is discovered late and refactors the whole module.

[tenant.middleware.ts:21-24](apps/api/src/common/tenant/tenant.middleware.ts#L21-L24) expects a JWT layer to have attached `req.user` by the time it runs. But Nest's request lifecycle is **middleware → guards → interceptors → pipes → handler**: a conventional `JwtAuthGuard` runs _after_ `TenantMiddleware` and would be too late. `TenantContextService.run()` also wraps `next()`, so the AsyncLocalStorage scope has to be opened in middleware to cover the whole request.

Split the responsibility:

- **`JwtMiddleware`** — verifies the `Authorization: Bearer` token, attaches `req.user = { sub, companyId, roles }`, and **does not throw** on a missing or invalid token. Registered in `AppModule` _before_ `TenantMiddleware` (registration order in `configure()` is execution order).
- **`JwtAuthGuard`** — enforces that `req.user` exists, returns 401 otherwise. Honours an `@Public()` decorator for `/auth/login`, `/auth/register`, `/auth/forgot-password`, and `/health`. Apply it globally via `APP_GUARD` so new controllers are protected by default rather than by remembering to opt in.

### 1.2 Dependencies

```bash
npm install @nestjs/jwt bcrypt cookie-parser --workspace=@docuflow/api
npm install -D @types/bcrypt @types/cookie-parser --workspace=@docuflow/api
```

`bcrypt` rather than argon2 — `BCRYPT_ROUNDS` is already validated in [env.validation.ts:33](apps/api/src/config/env.validation.ts#L33). Skip passport: a hand-written guard over `@nestjs/jwt` is less machinery than passport + strategy + `@nestjs/passport` for one token type. `cookie-parser` is needed to read the refresh cookie, and must be wired in `main.ts` alongside the existing CORS config (which already sets `credentials: true`, matching the web client).

### 1.3 Schema migration — two new tables

Neither exists yet, and both are required for the flows the UI already offers.

- **`RefreshToken`** — `id`, `companyId`, `userId`, `tokenHash`, `expiresAt`, `revokedAt?`, `createdAt`, plus `userAgent`/`ip` for a future session list. Store a **hash** of the token, never the token. Without this table a refresh token cannot be revoked, so logout is cosmetic and a stolen 7-day token stays valid for its full life. Rotate on every refresh and treat reuse of an already-rotated token as theft: revoke the whole family.
- **`PasswordResetToken`** — `id`, `companyId`, `userId`, `tokenHash`, `expiresAt`, `usedAt?`. Single-use, short TTL.

Both carry `companyId` so the tenant guard covers them. Run with `npm run prisma:migrate --workspace=@docuflow/api -- --name auth_tokens`.

### 1.4 Permissions catalogue and default roles

`permissions` is the global catalogue and `roles` are per-company, so registration has to materialise a role set for each new tenant.

- Seed the `Permission` catalogue (`prisma/seed.ts`) with the v1 surface: `documents.{create,read,update,delete,restore}`, `folders.{create,read,update,delete}`, `users.{read,invite,update}`, `roles.{read,manage}`, `audit.read`.
- On registration, create **Owner / Admin / Member** roles for the new company and grant the registering user Owner.

### 1.5 The module

`apps/api/src/auth/` with `auth.module.ts`, `auth.controller.ts`, `auth.service.ts`, `token.service.ts`, `dto/`, `guards/`, `decorators/`.

| Endpoint                         | Notes                                                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/register`        | Company + Owner/Admin/Member roles + user + `UserRole`, in **one transaction** under `runAsSystem()`. Returns `{ accessToken, user }`. |
| `POST /api/auth/login`           | Lookup under `runAsSystem()` — there is no tenant context yet at this point. Same generic error for unknown email and bad password.    |
| `POST /api/auth/refresh`         | Reads the httpOnly cookie, rotates, re-issues. Detects reuse.                                                                          |
| `POST /api/auth/logout`          | Revokes the refresh token and clears the cookie.                                                                                       |
| `POST /api/auth/forgot-password` | **Always 200**, whatever the email. The UI depends on this; returning 404 for unknown addresses is an account-enumeration oracle.      |
| `GET /api/auth/me`               | Session hydration for the web app.                                                                                                     |

JWT payload is `{ sub, company_id, roles[], exp }` per CLAUDE.md. Set the refresh cookie `httpOnly`, `sameSite: 'lax'`, `secure` in production, and path-scoped to `/api/auth`.

**Open decision — no mailer is in the stack.** For MVP, have forgot-password persist the token and log the reset URL at `info` level in development. Flag it in the README rather than pulling in an email provider now.

### 1.6 Audit logging

Register, login success, login failure, and logout each write an `audit_logs` row (company, user, action, entity, IP). Doing it here establishes the pattern every later mutating endpoint copies — retrofitting it across a dozen endpoints later is the expensive path.

### 1.7 Tests

- Unit specs beside the source (`npm test` only picks up `src/**/*.spec.ts`): password hashing, token rotation, reuse detection, the `runAsSystem()` boundaries.
- E2E in `test/`: register → login → refresh → me → logout.
- **A cross-tenant test.** Register two companies, then assert company A's token cannot read company B's rows. This is the guard's whole reason for existing and the one regression worth catching automatically.

</details>

---

## ~~2. Wire the web to the real auth~~ — done

Session handling, route guarding, and a `/dashboard` landing page. Two decisions worth carrying forward:

- **The access token lives in memory only**, so a reload restores the session from the refresh cookie instead. That is why `SessionProvider` has a `restoring` state and why the shell shows a skeleton rather than a signed-out page on a cold load.
- **The refresh cookie is scoped to `/api/auth` and cannot be seen by `proxy.ts`.** The API therefore also sets `docuflow_session` — path `/`, script-readable, carrying no credential — purely so a navigation can be routed without a flash. It is a hint, not authorisation: it outlives revocation, and every protected read is still checked by the API.

Rotation also gained a 10-second leeway before a spent refresh token counts as replay. Browser tabs share one cookie jar, so restoring several at once sends the same token from each; without the leeway that read as theft and signed the user out everywhere.

Still open: **API error messages are English only.** The dictionaries cover client-side validation, but a 409 from registration renders untranslated. Fixing it properly means the API returning stable codes the web maps to strings.

---

## 3. Documents MVP backend

In dependency order: `storage` → `folders` → `documents`.

1. **`storage`** — MinIO client (`npm install minio`; the env vars are already validated). Bucket bootstrap, presigned upload/download URLs, `documents/company_<id>/<year>/<month>/<uuid>.<ext>` key layout.
2. **`folders`** — CRUD. The `@@unique([companyId, parentId, name])` constraint needs a friendly duplicate-name error rather than a raw Prisma P2002.
3. **`documents`** — create, upload (metadata → MinIO → status transitions), list with pagination and filters, download, soft delete, restore. Deletes set `DELETED`; they never remove rows, because Restore is a v1 feature.

Defer BullMQ. Without OCR or AI in v1, the only post-upload async work is thumbnails — the queue can wait until there is a real job for it. `status` still advances through the lifecycle so the column stays meaningful.

---

## 4. Dashboard and document UI

Storage usage, recent documents, activity feed, folder tree, upload with progress, document list. Per the Frontend Design Standard, empty / loading / error / dense states are part of each page, not a follow-up — and the 10,000-document case is the one that shows the work.

---

## Housekeeping (fold into the next commit — don't make it a task)

- **[CLAUDE.md](CLAUDE.md) `Current State` is stale.** It describes the web app as "Default page + `GET /api/health`" and says "no domain functionality yet"; the web app now has a design system, i18n, and three auth screens. It is the file that primes every session, so a wrong table there misdirects work.
- Same table says 14 tables; the `init` migration creates 13.
- Delete the unused Next.js starter SVGs in [apps/web/public/](apps/web/public/) (`next.svg`, `vercel.svg`, `file.svg`, `globe.svg`, `window.svg`).
