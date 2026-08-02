# Security Policy

## Reporting a vulnerability

Report privately through **GitHub Security Advisories** — open the repository's
Security tab and choose "Report a vulnerability". Please do not open a public
issue for a security problem.

Include reproduction steps, affected version or commit, and impact if you know it.

## Scope

DocuFlow AI is a multi-tenant document management system, so the highest-severity
class of bug is anything that crosses a tenant boundary:

- Reading, writing, or listing another company's documents, users, or folders
- Any endpoint that trusts a client-supplied `company_id` instead of the JWT claim
- A database query on a tenant-scoped table with no `company_id` filter
- Signed/pre-signed storage URLs that grant access outside the issuing company
- Privilege escalation between roles (Guest → Employee → Manager → Admin)

Authentication issues (token forgery, refresh-token replay, reset-token
prediction) and unauthenticated access to document bytes in object storage are
also in scope.

## Project status

This project is **pre-implementation** — the repository currently contains
infrastructure and CI configuration only, with no running application. There is
no deployed instance to test against and no released version to patch.

## Development-environment credentials

Every credential in `.env.example`, `docker-compose.yml`, and the CI workflows is
a placeholder intended for local development against throwaway containers. They
are published deliberately and are not a vulnerability. Generate fresh secrets
for any deployment: `docker-compose.prod.yml` requires all of them explicitly and
refuses to start without them.
