# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current State

This repository contains **no code**. The only file is [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md), a planning/architecture spec for DocuFlow AI, a multi-tenant SaaS document management platform. The spec itself declares the stage as: discovery completed, architecture defined, database design pending, implementation not started.

There is also no git repository, no package manifest, and therefore **no build, lint, or test commands yet**. Do not invent them or claim a command works without having run it. When scaffolding begins, add the real commands to this file.

The spec is bilingual — prose is in Arabic, technical terms and all identifiers in English. Keep code, schema names, and API contracts in English.

## Planned Stack

- **Frontend**: Next.js (App Router) + TypeScript, Tailwind, shadcn/ui, TanStack Query, Zustand, React Hook Form + Zod
- **Backend**: NestJS + TypeScript, Prisma, PostgreSQL, Redis, BullMQ, Swagger
- **Storage**: MinIO (S3-compatible)
- **AI**: OpenAI or Gemini API, optional LangChain, pgvector or Qdrant for embeddings
- **Infra**: Docker, Nginx, CI/CD

The spec lists these as choices, not as installed dependencies. Confirm what actually exists in `package.json` before assuming a library is available.

## Architecture Constraints

These are the decisions that cut across modules; violating them is a correctness/security bug, not a style issue.

**Multi-tenancy is shared-database with a `company_id` discriminator.** Every tenant-scoped table carries `company_id`, and every query must filter on the current company. A missing filter leaks one customer's documents to another. Prefer enforcing this centrally — Prisma middleware/extension or a request-scoped tenant context — over relying on each call site to remember the `where` clause. `permissions` is the one global table in the spec (no `company_id`); `roles` are per-company.

**Files never live in PostgreSQL.** Postgres stores metadata, references, and permissions; MinIO stores bytes. `documents.storage_key` is the join between them. Storage layout is `documents/company_<id>/<year>/<month>/<uuid>.<ext>` — the company segment keeps tenant data separable at the object-store level too.

**Upload is a pipeline, not a single request.** Validate permission → validate file → persist metadata → upload to MinIO → thumbnail → OCR → AI processing → search index → audit log. Everything after the MinIO write is asynchronous work (BullMQ is in the stack for this reason). The document's `status` column tracks position in the lifecycle: Created → Uploading → Uploaded → Processing → OCR → AI Analysis → Ready → Archived → Deleted. Treat `Ready` as the only state safe to serve for search/AI, and note that Archived and Deleted are states, not row removal — deletes are soft, since Restore is a required feature.

**A document is an aggregate**, not a row: file + metadata + permissions + versions + comments + tags + audit logs + OCR data + AI data. Uploading a new file for an existing document appends to `document_versions` rather than overwriting.

**JWT carries the tenant.** Payload is `{ sub, company_id, roles[], exp }`. The tenant context comes from the token, never from a client-supplied body/query parameter — accepting `company_id` from the request is the obvious path to cross-tenant access.

**Audit logging is a requirement, not a nicety.** "Who changed/deleted what" is a stated problem the product exists to solve. Mutating operations should produce an `audit_logs` row (company, user, action, entity type/id, IP).

## Module Layout

Backend `src/` is organized by domain module: `auth`, `users`, `companies`, `roles`, `permissions`, `documents`, `storage`, `ai`, `search`, `notifications`, `audit`, plus `prisma`, `common`, `config`.

## Scope Discipline

The spec defines a deliberate MVP. Version 1 is auth (register, login, JWT, refresh, roles), documents (create folder, upload, list, download, delete), and a dashboard (storage usage, recent documents, activity).

Deferred to v2: OCR, AI summary, smart search, notifications, approval workflow. Deferred to v3: mobile app, external API, integrations, billing, enterprise features.

Sections 12 and 8 of the spec enumerate the full long-term feature surface (watermarking, encryption, mentions, translation, classification, and so on). Treat those as the roadmap, not the current build target — don't pull v2/v3 features into MVP work unless asked. Do, however, leave room for them in the schema where it is cheap to do so.

## Working With the Spec

[PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) contains draft table sketches (companies, users, roles, permissions, documents, document_versions, document_metadata, tags, audit_logs) with column names but no types, indexes, constraints, or relations. They are a starting point for the Prisma schema, not a finished design — expect to add types, foreign keys, unique constraints, and the composite indexes that tenant-scoped queries will need.
