# Next Steps

Rewritten 2026-08-08, after v4 and after wiring it into the web. The original
document was an ordered plan for building v1 and was kept updated through v2; by
v4 every section in it was finished and it had become a record rather than a
plan. What follows is what is actually left, and what the finished work decided
that the next piece has to respect.

Closed since the last revision: the four v3 audit actions
(`auth.invitation_accepted`, `users.invited`, `users.invitation_revoked`,
`users.roles_changed`) now have activity labels in both locales, so the feed no
longer renders them as raw identifiers.

For what exists today, see the Status table in [README.md](README.md). For the
rules that cut across modules, see [CLAUDE.md](CLAUDE.md).

---

## Known gaps in what is built

These are not new features. They are places where the current build stops short,
in rough order of how much they matter.

### 1. There is no mailer

The single largest gap, and it touches three finished features:

- `forgot-password` logs the reset URL in development and withholds it in
  production, which means password reset does not work on a deployed instance.
- `POST /api/invitations` returns the link to the inviter to deliver by hand.
- Notifications are in-app only.

Everything is already shaped for it — both tokens are single-use HMAC digests
with expiries, and `NotificationsService` stores a type and a payload rather than
rendered text, so an email renderer can read the same rows. What is missing is a
transport and templates. Mailpit is already in `docker-compose.yml` behind the
`mail` profile.

### 2. Sign-in cannot choose a company

Email is unique **per company**, so one address may exist in several tenants.
Login takes the password and picks the oldest match on a tie. That was harmless
while registration was the only way in; invitations made it reachable, because a
person can now legitimately hold accounts in two workspaces with one address.

The fix is a workspace picker after a password match against more than one
account — a second step, not a schema change.

### 3. Tags can be created but never renamed or deleted

`PATCH /api/tags/:id` and `DELETE /api/tags/:id` exist and are tested. Nothing in
the web calls them: the picker on a document creates a tag inline, which is the
common case, but there is no screen that lists the company vocabulary and lets
someone fix a typo or retire a label. `lib/tags.ts` deliberately does **not**
wrap the two routes — an export with no caller is the dormant-code pattern this
repository has already been bitten by, and they arrive with the screen.

`deleteTag` returning `{ id, unlabelled }` is shaped for that screen: the count
is what lets it warn how many documents are about to lose the label, since a tag
is refused nothing on the way out the way an occupied folder is.

### 4. The `Departments` and `Reports` modules are unallocated

Both appear in the spec's module list and in no version plan. Approvals gate on
the `documents.approve` permission precisely because the spec's "Department
Manager" role has no schema behind it. Decide before building either.

### 5. Bulk selection cannot exceed what is on screen

`MAX_BULK_IDS` is 200 against a page size of 50, so "select all" covers several
pages of "load more" and the ceiling is not reachable by clicking. The gap is the
other direction: the endpoints take a list of ids, so there is nothing to send
for rows the client has never loaded. "Select everything matching this filter"
needs either the client to page the request itself, or the API to accept a filter
in place of ids — and the second means a batch whose size the caller cannot see
before pressing the button.

### 6. Search results carry no tags or favourites

The search endpoint accepts `?tagId=` and the web now sends it, so results can be
narrowed by a label — but a hit cannot show which labels it carries or whether it
is starred. The projection is raw SQL over the search index rather than the
Prisma select the documents list uses, so both would have to be joined by hand,
in the one query the tenant guard does not cover. Worth doing with a second pass
that resolves the hit ids through Prisma, rather than by widening the raw query.

---

## Where the next feature is likely to land

### Per-document permissions

The single biggest architectural question left. Today authorisation is
company-wide: holding `documents.read` means reading every document in the
company. The spec's sharing model implies per-document ACLs, and that changes
three things:

- `BulkDocumentsService` checks permission once, at the route, because there is
  nothing per-document to check. It would grow a filter step — the comment
  saying so is already in the file.
- The tenant guard filters by company; a document ACL is a second, orthogonal
  predicate and does **not** belong inside it. Stacking a second concern into the
  security boundary would put every cross-tenant guarantee behind a change to
  unrelated logic.
- Search is raw SQL. An ACL predicate has to be written there by hand, as the
  tenant predicate already is.
- The web assumes company-wide authorisation throughout. Every screen decides
  what to offer from a single `/auth/me` permission list fetched once — the
  checkbox column, the bulk bar's buttons, the tag editor, the comment actions.
  Per-document rights make that a per-row question, which is a different fetch
  and a different shape, not a stricter version of the same one.

### Threaded comments

`Comment` is deliberately flat, with no `parentId`. A reply chain is a nullable
self-reference plus a recursive read — the schema comment records why it was left
out rather than added dormant: `Tag` sat unused through three releases and that
is the pattern worth not repeating.

### Semantic search

`document_metadata.embedding vector(1024)` exists and stays NULL, because neither
Groq nor xAI publishes an embeddings endpoint. Setting `VOYAGE_API_KEY` is meant
to switch it on with no migration — the column is dormant, not missing. What is
not written is the backfill for documents indexed before it.

### Sequential approvals

The workflow is single-step by design. A chain of approvers is a child table
(`approval_steps`) and an ordering rule, not a reshape of `ApprovalRequest`.

---

## v5, per the spec

Deferred deliberately and not started: **mobile app, external API, third-party
integrations, billing.** Sections 12 and 8 of
[PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) enumerate the long-term
surface — watermarking, encryption, mentions, translation, classification. Treat
those as the roadmap, not the current target.

An external API is the one with a prerequisite worth naming early: there is no
Swagger in the stack, and no API-key or scope model. Both are additions to
`auth`, not to the modules being exposed.

---

## Decisions worth not re-litigating

Recorded because each was made against a real constraint, and each looks
arbitrary without it.

- **The AI provider is Groq, not Anthropic** — and Groq needs two models, because
  its text models reject image content. `anthropic` and `openai` remain in the
  env enum with no implementation; selecting one warns and falls back to the stub.
- **No AI key is a supported configuration.** The pipeline, the notifications and
  the search indexing all run against a deterministic stub, and the UI labels it
  as one.
- **Failure is never terminal for a document.** A failed OCR or summary still
  ends at `READY` — the bytes uploaded fine and the file must stay downloadable.
  The failure lives on `ocrStatus`/`aiStatus`.
- **`f_normalize()` replaced `f_unaccent()`.** Postgres' `unaccent` covers Latin
  diacritics only, so `مستند` would not have matched `مُسْتَنَد`. Both the
  indexing trigger and every query call the same function so they cannot drift.
- **Deletes are soft, everywhere** — documents and comments alike. "Who deleted
  what, and can we get it back" is the question the product exists to answer.
- **Favourites are the one write that is not audited.** A favourite changes
  nothing about the document, and an audit row would publish a private shortlist
  to everyone holding `audit.read`.
- **Bulk operations report per-id partial success rather than failing the batch.**
  A multi-select runs over a paginated list, so some rows are always stale; all
  or nothing means never completing the action without hunting for the offender.
- **Tagging one document replaces the whole set; tagging a selection is a delta.**
  Whole-set semantics across a multi-select would clear labels the caller never
  saw, on rows they never opened. The single-document form can afford replacement
  because it shows what is there first — which is also why it is read-then-edit
  rather than a picker that saves on every keystroke.
- **A favourite is never asked for on anyone else's behalf.** There is no
  `?userId=` beside `?favorite=true`, in the API or the client. Colleagues share
  a company, so someone else's shortlist is a within-tenant leak the tenant guard
  cannot see.
- **The e2e suite runs on its own Redis database.** `QUEUE_WORKER_ENABLED=false`
  only silences the workers in the test process; a dev server left running has
  one at its default of `true`, on the same Redis, and it consumes the suite's
  jobs. The failure looks like a regression in whichever specs lose the race.
