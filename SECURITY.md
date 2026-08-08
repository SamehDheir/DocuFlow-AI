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
- A database query on a tenant-scoped table with no `company_id` filter —
  including a raw `$queryRaw`, which the tenant guard cannot reach
- A direct query against one of the join models that carry no `company_id` of
  their own (`DocumentVersion`, `DocumentMetadata`, `DocumentTag`,
  `RolePermission`, `UserRole`), which are only protected transitively
- Storage keys or URLs that grant access outside the issuing company
- Privilege escalation between roles (Member → Admin → Owner)

Also in scope:

- **Within-tenant leaks.** Colleagues share a company, so the tenant guard cannot
  see them: reading someone else's notification inbox, favourites, or session.
  No endpoint anywhere accepts a user id beside a favourite — the caller comes
  from the verified token, and any route that grows another spelling is a finding.
- **Authorship bypasses.** Editing a comment is restricted to its author, and
  deliberately not granted by `comments.moderate`, which permits deletion only.
  Anything that lets one person's words be rewritten under another's name is in
  scope, including through the bulk routes.
- **Authentication.** Token forgery, refresh-token replay, reset- or
  invitation-token prediction, and account enumeration through timing or through
  a differing response.
- **Unauthenticated access to document bytes** in object storage.
- **Rendering untrusted bytes in our origin.** `documents.mime_type` originates
  from the uploading client, so anything that lets a stored file be interpreted
  as HTML or script inside the app's origin is a real finding.

## Project status

The application is **built and running**, but there is **no deployed public
instance** and no released version to patch. Report findings against `main`.

Security-relevant behaviour that is intentional, and not a finding:

- **Refresh rotation allows a 10-second replay window.** Browser tabs share one
  cookie jar, so restoring several at once sends the same token from each;
  without the leeway that reads as theft and signs the user out everywhere.
  Outside that window, replay revokes the whole token family.
- **`docuflow_session` is a script-readable cookie.** It carries no credential
  and says only that a session was started, so a navigation can be routed
  without a signed-out flash. It outlives revocation by design; every protected
  read is still authorised by the API.
- **`POST /api/invitations` returns the invitation link to its creator.** There
  is no mailer in the stack, and withholding the token from the administrator who
  just created it — and who already holds `users.invite` — would make the feature
  unusable rather than safer. Anyone holding the link can accept it, exactly as
  with a password-reset link.
- **`forgot-password` always returns 200**, and login gives one error for both an
  unknown address and a bad password, with a decoy bcrypt comparison to level the
  timing. Revealing which emails have accounts is the enumeration oracle this
  avoids.
- **A bulk operation returns 200 even when every id was refused.** The response
  carries a per-id report, and a refusal is a stale row rather than a denial —
  authorisation is checked once at the route, before any of it. A 403 is still a 403.
- **The live event stream carries ids, never content.** `comment.changed` names a
  document and a comment; a client with the thread open refetches through the
  endpoint that checks permissions. That is what makes the channel safe to
  broadcast company-wide, and any event that starts carrying a body instead is a
  finding.

## Development-environment credentials

Every credential in `.env.example`, `docker-compose.yml`, and the CI workflows is
a placeholder intended for local development against throwaway containers. They
are published deliberately and are not a vulnerability. Generate fresh secrets
for any deployment: `docker-compose.prod.yml` requires all of them explicitly and
refuses to start without them.

`JWT_SECRET` and `JWT_REFRESH_SECRET` must differ. If they match, any access
token is structurally valid as a refresh token.
