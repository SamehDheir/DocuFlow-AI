import { buildSearchQuery, type SearchParams } from './search.sql';

/**
 * These are the tests standing in for the tenant guard.
 *
 * Every other query in this system is scoped automatically by the Prisma
 * extension. Search cannot be — `$queryRaw` bypasses it — so the isolation is
 * hand-written, and hand-written isolation needs a test that fails loudly when
 * someone edits the statement and drops a line.
 */

const COMPANY = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

function build(overrides: Partial<SearchParams> = {}) {
  return buildSearchQuery({
    companyId: COMPANY,
    query: 'invoice',
    limit: 21,
    offset: 0,
    ...overrides,
  });
}

describe('buildSearchQuery', () => {
  describe('tenant isolation', () => {
    it('always constrains by company_id', () => {
      expect(build().sql).toContain('d.company_id =');
    });

    it('binds the company as a parameter, never inlined', () => {
      const query = build();

      // The literal must not appear in the SQL text...
      expect(query.sql).not.toContain(COMPANY);
      // ...it must be in the bound values instead.
      expect(query.values).toContain(COMPANY);
    });

    it('keeps the company predicate when every optional filter is set', () => {
      const query = build({
        folderId: '11111111-2222-4333-8444-555555555555',
        mimeType: 'application/pdf',
      });

      expect(query.sql).toContain('d.company_id =');
    });

    it('keeps the company predicate when no optional filter is set', () => {
      expect(build({ folderId: undefined, mimeType: undefined }).sql).toContain('d.company_id =');
    });
  });

  describe('injection safety', () => {
    it.each([
      ['a quote and a comment', "'; DROP TABLE documents; --"],
      ['a union attempt', "x' UNION SELECT * FROM users --"],
      ['a tsquery metacharacter soup', '&|!():*<->'],
    ])('binds %s rather than interpolating it', (_label, hostile) => {
      const query = build({ query: hostile });

      expect(query.sql).not.toContain(hostile);
      expect(query.values).toContain(hostile);
    });

    it('binds the folder and mime filters too', () => {
      const folderId = '11111111-2222-4333-8444-555555555555';
      const query = build({ folderId, mimeType: 'application/pdf' });

      expect(query.values).toContain(folderId);
      expect(query.values).toContain('application/pdf');
      expect(query.sql).not.toContain(folderId);
    });
  });

  describe('result scoping', () => {
    it('excludes soft-deleted documents, which the tenant guard does not filter', () => {
      expect(build().sql).toContain('d.deleted_at IS NULL');
    });

    it('only searches READY documents', () => {
      // Anything earlier in the pipeline has partial or absent extracted text.
      expect(build().sql).toContain("d.status = 'READY'");
    });

    it('treats an empty folderId as the root rather than as no filter', () => {
      const query = build({ folderId: '' });

      expect(query.sql).toContain('d.folder_id IS NULL');
      expect(query.values).not.toContain('');
    });
  });

  describe('matching', () => {
    it('normalises the query with the same function the index trigger uses', () => {
      // If these ever diverge, the index and the query tokenise differently and
      // search silently returns nothing.
      expect(build().sql).toContain('f_normalize');
    });

    it('uses websearch_to_tsquery so malformed input yields no rows, not an error', () => {
      expect(build().sql).toContain('websearch_to_tsquery');
    });

    it('falls back to trigram similarity on the name, for typos', () => {
      expect(build().sql).toContain('similarity(');
    });
  });
});
