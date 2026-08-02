## What & why

<!-- What changes, and what problem it solves. Link the issue: Closes #123 -->

## Type of change

- [ ] Feature
- [ ] Bug fix
- [ ] Refactor (no behaviour change)
- [ ] Infrastructure / CI
- [ ] Documentation

## How to test

<!-- Steps a reviewer can follow to verify this themselves. -->

1.
2.

## Tenant isolation

<!--
DocuFlow is multi-tenant on a shared database — isolation rests entirely on
company_id filtering. A missing filter exposes one customer's documents to
another, and it will not show up in testing with a single tenant.
-->

- [ ] Adds no new database query, **or** every new query filters by `company_id`
- [ ] No endpoint accepts `company_id` from the request body/query — it comes from the JWT
- [ ] New tenant-scoped tables include a `company_id` column

## Checklist

- [ ] Mutating operations write an `audit_logs` entry
- [ ] Prisma migrations are committed (not just `schema.prisma` edits)
- [ ] No secrets, keys, or real credentials in the diff
- [ ] Self-reviewed the diff

## Notes for the reviewer

<!-- Anything deliberately out of scope, known limitations, or follow-up work. -->
