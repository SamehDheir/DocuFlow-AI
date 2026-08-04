# Next Steps

Ordered build plan, written 2026-08-02 against commit `b548dd0` (branch `feature/i18n-arabic-english`).

## Where the project actually stands

The two workspaces have drifted apart, and that drift determines the order below.

| Area          | State                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| API           | Foundation only — `config/`, `common/tenant/`, `prisma/`, `health/`. No domain modules.                                                          |
| Web           | **Ahead of the API.** Design system, Arabic/English i18n with locale routing, and finished login / register / forgot-password screens.           |
| Database      | Migration `init` applied. 13 tables. No table for refresh tokens or password-reset tokens.                                                       |
| Contract gaps | [auth.ts](apps/web/src/lib/auth.ts) issues real requests to `POST /api/auth/login`, `/auth/register`, `/auth/forgot-password`. All three 404.    |

Two structural facts make auth the only sensible next task, not merely the next one on the list:

1. **The tenant guard is fail-closed.** `applyTenantGuard` throws when no company is bound to the AsyncLocalStorage context, and only the authenticated principal may bind it. Until a JWT populates `req.user`, *no* tenant-scoped query can run — so no documents module, no folders module, and no dashboard can be built or even tested end-to-end.
2. **The frontend already declares the contract.** `SessionUser`, the `{ accessToken, user }` response shape, `credentials: 'include'` for an httpOnly refresh cookie, and the deliberate non-enumerating 200 from forgot-password are all decided. The backend implements a spec that exists rather than inventing one.

---

## 1. Auth backend — unblocks everything else

### 1.1 Resolve the middleware/guard ordering trap first

This is the one design decision to make before writing code, because getting it wrong is discovered late and refactors the whole module.

[tenant.middleware.ts:21-24](apps/api/src/common/tenant/tenant.middleware.ts#L21-L24) expects a JWT layer to have attached `req.user` by the time it runs. But Nest's request lifecycle is **middleware → guards → interceptors → pipes → handler**: a conventional `JwtAuthGuard` runs *after* `TenantMiddleware` and would be too late. `TenantContextService.run()` also wraps `next()`, so the AsyncLocalStorage scope has to be opened in middleware to cover the whole request.

Split the responsibility:

- **`JwtMiddleware`** — verifies the `Authorization: Bearer` token, attaches `req.user = { sub, companyId, roles }`, and **does not throw** on a missing or invalid token. Registered in `AppModule` *before* `TenantMiddleware` (registration order in `configure()` is execution order).
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

| Endpoint                    | Notes                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/register`   | Company + Owner/Admin/Member roles + user + `UserRole`, in **one transaction** under `runAsSystem()`. Returns `{ accessToken, user }`. |
| `POST /api/auth/login`      | Lookup under `runAsSystem()` — there is no tenant context yet at this point. Same generic error for unknown email and bad password.     |
| `POST /api/auth/refresh`    | Reads the httpOnly cookie, rotates, re-issues. Detects reuse.                                                                       |
| `POST /api/auth/logout`     | Revokes the refresh token and clears the cookie.                                                                                    |
| `POST /api/auth/forgot-password` | **Always 200**, whatever the email. The UI depends on this; returning 404 for unknown addresses is an account-enumeration oracle.  |
| `GET /api/auth/me`          | Session hydration for the web app.                                                                                                 |

JWT payload is `{ sub, company_id, roles[], exp }` per CLAUDE.md. Set the refresh cookie `httpOnly`, `sameSite: 'lax'`, `secure` in production, and path-scoped to `/api/auth`.

**Open decision — no mailer is in the stack.** For MVP, have forgot-password persist the token and log the reset URL at `info` level in development. Flag it in the README rather than pulling in an email provider now.

### 1.6 Audit logging

Register, login success, login failure, and logout each write an `audit_logs` row (company, user, action, entity, IP). Doing it here establishes the pattern every later mutating endpoint copies — retrofitting it across a dozen endpoints later is the expensive path.

### 1.7 Tests

- Unit specs beside the source (`npm test` only picks up `src/**/*.spec.ts`): password hashing, token rotation, reuse detection, the `runAsSystem()` boundaries.
- E2E in `test/`: register → login → refresh → me → logout.
- **A cross-tenant test.** Register two companies, then assert company A's token cannot read company B's rows. This is the guard's whole reason for existing and the one regression worth catching automatically.

---

## 2. Wire the web to the real auth

Only after §1 is green. The forms already call the right URLs, so the work is session handling, not forms.

- Store the access token and hydrate the session from `GET /api/auth/me`; refresh on 401 and retry once.
- Extend [proxy.ts](apps/web/src/proxy.ts) to guard app routes. It currently handles locale routing only — keep the two concerns separate inside the file, and preserve the `matcher` exclusions that keep `/api/health` unprefixed.
- Build the authenticated shell: nav, user menu, logout, and the `(app)` route group beside the existing `(auth)` group.
- Success and error states already exist in the forms; verify against real API error bodies, including the field-level `errors` map that `AuthError` expects.

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
