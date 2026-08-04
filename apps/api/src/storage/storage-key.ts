import { randomUUID } from 'node:crypto';

/**
 * Object key layout for MinIO.
 *
 * PROJECT_DOCUMENTATION.md §13: bytes never live in PostgreSQL. Postgres holds
 * metadata and `documents.storage_key` is the join between the two.
 *
 * Layout is `documents/company_<id>/<year>/<month>/<uuid>.<ext>`. The company
 * segment is the point — it keeps one tenant's objects separable from another's
 * at the object-store level too, so a bucket policy or an export can be scoped
 * per customer without consulting the database.
 *
 * The `derived/` prefix is reserved for artifacts generated FROM a document —
 * thumbnails now, OCR page images and AI output in v2 — so they can never
 * collide with an original.
 */
const ORIGINALS_PREFIX = 'documents';

/** Extensions are cosmetic; the key must stay predictable and traversal-free. */
const MAX_EXTENSION_LENGTH = 12;
const FALLBACK_EXTENSION = 'bin';

/**
 * Builds the key an uploaded file is stored under.
 *
 * `companyId` comes from the JWT, never from the request body — accepting it
 * from a client is the direct path to writing into another tenant's prefix.
 * It is still validated here, because a key is a path and this function is the
 * only place that shape is decided.
 */
export function buildStorageKey(companyId: string, extension: string, now = new Date()): string {
  if (!isUuid(companyId)) {
    throw new Error(`Refusing to build a storage key for a non-uuid company id: ${companyId}`);
  }

  const year = now.getUTCFullYear().toString();
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');

  return `${ORIGINALS_PREFIX}/company_${companyId}/${year}/${month}/${randomUUID()}.${normaliseExtension(extension)}`;
}

/**
 * Extracts a storable extension from an uploaded filename.
 *
 * Deliberately not `path.extname`: the input is an untrusted client-supplied
 * name, and everything outside `[a-z0-9]` is dropped rather than escaped. A
 * name like `report.pdf.exe` yields `exe`, and one like `../../etc/passwd`
 * yields the fallback — the extension never carries a separator.
 */
export function extensionOf(filename: string): string {
  const lastDot = filename.lastIndexOf('.');

  if (lastDot < 0 || lastDot === filename.length - 1) {
    return FALLBACK_EXTENSION;
  }

  return normaliseExtension(filename.slice(lastDot + 1));
}

function normaliseExtension(extension: string): string {
  const cleaned = extension.toLowerCase().replace(/[^a-z0-9]/g, '');

  return cleaned.slice(0, MAX_EXTENSION_LENGTH) || FALLBACK_EXTENSION;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
