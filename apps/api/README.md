# @docuflow/api

DocuFlow AI backend — NestJS 11 + Prisma 7 + PostgreSQL.

Run commands from the **repository root**; see the root [README](../../README.md)
for full setup and [CLAUDE.md](../../CLAUDE.md) for architecture constraints.

```bash
npm run infra:up                                         # Postgres, Redis, MinIO
npm run prisma:migrate:deploy --workspace=@docuflow/api  # apply schema
npm run dev --workspace=@docuflow/api                    # watch mode, :3001
```

| Command                                                       | Does                            |
| ------------------------------------------------------------- | ------------------------------- |
| `npm run test --workspace=@docuflow/api`                       | Unit tests (`src/**/*.spec.ts`) |
| `npm run test:e2e --workspace=@docuflow/api`                   | E2E — needs infra running       |
| `npm run prisma:generate --workspace=@docuflow/api`            | Regenerate the client           |
| `npm run prisma:migrate --workspace=@docuflow/api -- --name x` | New migration                   |
| `npm run prisma:studio --workspace=@docuflow/api`              | Browse the database             |

## Layout

```
prisma.config.ts       Prisma 7 CLI config — the connection URL lives HERE,
                       not in schema.prisma (removed in Prisma 7)
prisma/schema.prisma   14 models; tenant tables indexed (company_id, …)
src/
  common/tenant/       AsyncLocalStorage tenant context + request middleware
  config/              zod environment validation, fails fast at boot
  health/              GET /health — deliberately outside the /api prefix
  prisma/              PrismaService (raw) + tenant guard extension
```

## Two things to know before writing code

**Inject `TENANT_PRISMA`, not `PrismaService`.** The guarded client filters every
query by `companyId` automatically. `PrismaService` is unfiltered and exists only
for health checks and connection lifecycle.

**The guard is fail-closed.** With no tenant context bound, a tenant-scoped query
throws. Authentication is not implemented yet, so this is the current expected
behaviour — not a bug to work around. Use `runAsSystem()` for operations that
legitimately span tenants (registration, login lookup, queue workers).
