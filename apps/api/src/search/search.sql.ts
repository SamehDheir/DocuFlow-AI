import { Prisma } from '@prisma/client';

/**
 * The search statement, built in isolation so it can be tested.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THIS QUERY IS NOT COVERED BY THE TENANT GUARD.
 *
 *  `applyTenantGuard` extends Prisma's model delegates. `$queryRaw` names no
 *  model, so nothing intercepts it and nothing injects `company_id` — the one
 *  place in this system where tenant isolation is written by hand rather than
 *  enforced centrally. Full text has to be raw: Prisma cannot express tsvector
 *  ranking, ts_headline, or the weighted @@ operator.
 *
 *  Two rules, both covered by search.sql.spec.ts:
 *    1. `d.company_id = ${companyId}` is present, always, and comes from
 *       TenantContextService — never from a request parameter.
 *    2. Every value is a ${} placeholder. Prisma.sql produces a parameterised
 *       statement; string concatenation here would be SQL injection through a
 *       search box, which is the most exposed input in the product.
 * ══════════════════════════════════════════════════════════════════════════
 */

export interface SearchParams {
  companyId: string;
  /** Raw user input. Never interpolated — only ever bound as a parameter. */
  query: string;
  folderId?: string;
  mimeType?: string;
  tagId?: string;
  limit: number;
  offset: number;
}

/**
 * Trigram similarity floor for the filename fallback.
 *
 * 0.3 is pg_trgm's own default. Lower drags in unrelated names on short
 * queries; higher stops tolerating the single-character typo this exists for.
 */
const NAME_SIMILARITY_THRESHOLD = 0.3;

/**
 * Builds the ranked search.
 *
 * Two ways to match, deliberately OR-ed rather than chosen between:
 *
 *   - Full text over the weighted vector (title ▸ keywords ▸ description and
 *     summary ▸ body), which is what finds a phrase buried in page 40 of a
 *     scan. `websearch_to_tsquery` is used rather than `plainto_tsquery` so
 *     quoted phrases and OR work the way people already expect from a search
 *     box, and so malformed input yields no rows instead of a syntax error.
 *
 *   - Trigram similarity on the filename, which is what still finds
 *     `Invoce-2026.pdf` when someone types `invoice`. Full text cannot: a
 *     misspelling is simply a different lexeme.
 *
 * Both sides are normalised with f_normalize() — the same function the indexing
 * trigger uses. That is the point of putting it in the database: the query and
 * the index cannot drift into normalising differently, which would silently
 * return nothing.
 */
export function buildSearchQuery(params: SearchParams): Prisma.Sql {
  const { companyId, query, folderId, mimeType, tagId, limit, offset } = params;

  const filters: Prisma.Sql[] = [
    // The tenant predicate. See the header — this is load-bearing.
    Prisma.sql`d.company_id = ${companyId}::uuid`,
    // Soft-deleted rows are never searchable; the guard does not filter these.
    Prisma.sql`d.deleted_at IS NULL`,
    /**
     * Only READY. A document mid-pipeline has partial or no extracted text, and
     * returning it would rank it as though its content simply did not match.
     */
    Prisma.sql`d.status = 'READY'::"DocumentStatus"`,
  ];

  if (folderId !== undefined) {
    filters.push(
      folderId === ''
        ? Prisma.sql`d.folder_id IS NULL`
        : Prisma.sql`d.folder_id = ${folderId}::uuid`,
    );
  }

  if (mimeType) {
    filters.push(Prisma.sql`d.mime_type = ${mimeType}`);
  }

  /**
   * EXISTS rather than a join, so a document carrying the tag is returned once
   * — a join would multiply rows per matching link and corrupt both the ranking
   * and the LIMIT.
   *
   * `document_tags` has no company_id of its own. It does not need one here:
   * the correlation is to `d.id`, and `d` is already pinned to the tenant by
   * the predicate at the top of this list. That is the whole reason the tenant
   * filter has to stay where it is.
   */
  if (tagId) {
    filters.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM document_tags dt
         WHERE dt.document_id = d.id AND dt.tag_id = ${tagId}::uuid
      )`,
    );
  }

  return Prisma.sql`
    WITH q AS (
      SELECT websearch_to_tsquery('simple', f_normalize(${query})) AS tsq,
             f_normalize(${query})                                 AS norm
    )
    SELECT d.id,
           d.name,
           d.original_name,
           d.mime_type,
           d.extension,
           d.size::text        AS size,
           d.status,
           d.folder_id,
           d.owner_id,
           d.created_at,
           d.updated_at,
           dm.language,
           dm.summary,
           dm.ocr_status,
           dm.ai_status,
           -- Rank text hits by weighted relevance; a filename-only match scores
           -- below every real content hit but still above nothing.
           GREATEST(
             COALESCE(ts_rank_cd(dm.search_vector, q.tsq), 0),
             COALESCE(similarity(f_normalize(d.name), q.norm), 0) * 0.15
           )                   AS rank,
           -- The matched fragment, for the result list. StartSel/StopSel are
           -- markers the client escapes and replaces, never raw HTML from here.
           CASE
             WHEN dm.extracted_text IS NULL THEN NULL
             ELSE ts_headline(
                    'simple',
                    f_normalize(LEFT(dm.extracted_text, 20000)),
                    q.tsq,
                    'StartSel=<<,StopSel=>>,MaxWords=28,MinWords=12,MaxFragments=1'
                  )
           END                 AS snippet
      FROM documents d
      CROSS JOIN q
      LEFT JOIN document_metadata dm ON dm.document_id = d.id
     WHERE ${Prisma.join(filters, ' AND ')}
       AND (
             (dm.search_vector IS NOT NULL AND dm.search_vector @@ q.tsq)
          OR similarity(f_normalize(d.name), q.norm) > ${NAME_SIMILARITY_THRESHOLD}
           )
     ORDER BY rank DESC, d.created_at DESC, d.id DESC
     LIMIT ${limit} OFFSET ${offset}
  `;
}
