import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { bulkSetTags, listDocuments, setFavorite, MAX_BULK_IDS } from './documents';
import { codeMessage } from './error-message';
import { listComments } from './comments';
import { setDocumentTags } from './tags';

/**
 * The v4 collaboration clients, at the wire level.
 *
 * These assert the SHAPE of each request rather than the response handling: the
 * three parameters below are all read by the API as `=== 'true'`, the favourite
 * toggle is a method switch rather than a body, and the bulk tag call is a delta
 * where its single-document twin is a whole-set replacement. Every one of those
 * is a distinction a refactor can flatten without a type error.
 */

const OK = { items: [], nextCursor: null, total: 0 };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(OK), { status: 200 })));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The path the last call went to, with the origin stripped. */
function calledPath(): string {
  return String(fetchMock.mock.calls[0][0]).replace(/^https?:\/\/[^/]+/, '');
}

function calledInit(): RequestInit {
  return (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
}

describe('listDocuments', () => {
  it('omits the v4 filters entirely when they are off', async () => {
    await listDocuments('token', {});

    expect(calledPath()).toBe('/api/documents');
  });

  /**
   * The API reads these as `=== 'true'`, so sending `favorite=false` would work
   * — and would put a filter in the URL that is not filtering, which is then a
   * shareable link that looks like it narrows something.
   */
  it('sends the filters as the string true, and only when set', async () => {
    await listDocuments('token', { favorite: true, includeArchived: true, tagId: 'tag-1' });

    const path = calledPath();

    expect(path).toContain('favorite=true');
    expect(path).toContain('includeArchived=true');
    expect(path).toContain('tagId=tag-1');
    expect(path).not.toContain('false');
  });

  /**
   * `folderId: ''` means the company root and must survive; the v4 filters must
   * not appear beside it. Both halves of that are easy to break with one tidy-up
   * of the query builder.
   */
  it('keeps a deliberate blank folder while dropping unset filters', async () => {
    await listDocuments('token', { folderId: '', favorite: false });

    expect(calledPath()).toBe('/api/documents?folderId=');
  });
});

describe('setFavorite', () => {
  it('stars with POST and unstars with DELETE, carrying no body either way', async () => {
    await setFavorite('token', 'doc-1', true);
    expect(calledPath()).toBe('/api/documents/doc-1/favorite');
    expect(calledInit().method).toBe('POST');
    expect(calledInit().body).toBeUndefined();

    fetchMock.mockClear();

    await setFavorite('token', 'doc-1', false);
    expect(calledInit().method).toBe('DELETE');
  });

  /**
   * No user id, anywhere. A favourite is private and colleagues share a company,
   * so `?userId=` would be a within-tenant leak the tenant guard cannot see —
   * the API takes the caller from the token and offers no other spelling.
   */
  it('never names a user', async () => {
    await setFavorite('token', 'doc-1', true);

    expect(calledPath()).not.toContain('user');
  });
});

describe('tagging', () => {
  /**
   * The two calls have deliberately different semantics, and the test exists
   * because they are one word apart in the source: PUT on one document replaces
   * the whole set, POST across a selection adds and removes named tags only.
   * Whole-set semantics across a multi-select would clear labels the caller
   * never saw on rows they never opened.
   */
  it('replaces the whole set for one document', async () => {
    await setDocumentTags('token', 'doc-1', ['a', 'b']);

    expect(calledPath()).toBe('/api/documents/doc-1/tags');
    expect(calledInit().method).toBe('PUT');
    expect(JSON.parse(String(calledInit().body))).toEqual({ tagIds: ['a', 'b'] });
  });

  it('sends a delta across a selection', async () => {
    await bulkSetTags('token', ['doc-1', 'doc-2'], { add: ['a'], remove: ['b'] });

    expect(calledPath()).toBe('/api/documents/bulk/tags');
    expect(JSON.parse(String(calledInit().body))).toEqual({
      ids: ['doc-1', 'doc-2'],
      add: ['a'],
      remove: ['b'],
    });
  });

  it('omits the half of the delta that is empty', async () => {
    await bulkSetTags('token', ['doc-1'], { add: ['a'] });

    expect(JSON.parse(String(calledInit().body))).toEqual({ ids: ['doc-1'], add: ['a'] });
  });
});

describe('MAX_BULK_IDS', () => {
  /**
   * Mirrors the API's own cap. Above the page size of 100 so "select all on this
   * page" fits twice over — a client ceiling below the server's would refuse
   * batches the API would have accepted.
   */
  it('matches the API cap and clears the page size', () => {
    expect(MAX_BULK_IDS).toBe(200);
    expect(MAX_BULK_IDS).toBeGreaterThan(100);
  });
});

describe('listComments', () => {
  it('hangs the thread off the document and passes the cursor through', async () => {
    await listComments('token', 'doc-1', { cursor: 'c-9' });

    expect(calledPath()).toBe('/api/documents/doc-1/comments?cursor=c-9');
  });
});

describe('codeMessage', () => {
  const errors = { DOCUMENT_ALREADY_ARCHIVED: 'Already archived' } as never;

  /**
   * Bulk reports refusals as bare `{ id, code }` rows inside a 200, with no
   * English message beside them — so unlike a thrown ApiError there is nothing
   * to fall through to, and an untranslated code renders as
   * DOCUMENT_ALREADY_ARCHIVED in the middle of an Arabic page.
   */
  it('translates a known code', () => {
    expect(codeMessage('DOCUMENT_ALREADY_ARCHIVED', errors, 'fallback')).toBe('Already archived');
  });

  it('falls back rather than showing the raw code', () => {
    expect(codeMessage('SOMETHING_NEW', errors, 'fallback')).toBe('fallback');
  });
});
