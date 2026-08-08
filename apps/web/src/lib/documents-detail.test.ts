import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { addVersion, fetchVersionBlob, revertToVersion } from './documents';

/**
 * The version client.
 *
 * `addVersion` and `fetchVersionBlob` are the two calls in this module that go
 * through raw `fetch` rather than `apiSend` — one because it is multipart, the
 * other because it returns bytes — so neither inherits the shared error
 * unwrapping. That is exactly the kind of thing that is fine until the day a 409
 * arrives and the user is told "something went wrong".
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const spy = vi.fn().mockResolvedValue(response as Response);
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe('addVersion', () => {
  it('sends the file and note as multipart, with the bearer token', async () => {
    const spy = mockFetch({ ok: true, json: () => Promise.resolve({ id: 'doc-1' }) });

    await addVersion('token-abc', 'doc-1', new File(['x'], 'contract.pdf'), 'Signed copy');

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];

    expect(url).toMatch(/\/api\/documents\/doc-1\/versions$/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-abc');

    const body = init.body as FormData;
    expect((body.get('file') as File).name).toBe('contract.pdf');
    expect(body.get('note')).toBe('Signed copy');

    // No Content-Type is set by hand: the browser has to add the multipart
    // boundary, and naming the type ourselves omits it and breaks the parse.
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('omits an absent note rather than sending an empty field', async () => {
    const spy = mockFetch({ ok: true, json: () => Promise.resolve({ id: 'doc-1' }) });

    await addVersion('token', 'doc-1', new File(['x'], 'a.pdf'));

    const body = (spy.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(body.has('note')).toBe(false);
  });

  /**
   * The whole reason this helper exists. Without it the caller sees a bare
   * "could not upload" and the translated message behind DOCUMENT_ARCHIVED never
   * reaches the screen.
   */
  it('unwraps the API error body, code included', async () => {
    mockFetch({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({ code: 'DOCUMENT_ARCHIVED', message: 'That document is archived' }),
    });

    const error = await addVersion('token', 'doc-1', new File(['x'], 'a.pdf')).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('DOCUMENT_ARCHIVED');
    expect((error as ApiError).status).toBe(409);
  });

  it('survives a non-JSON error body', async () => {
    mockFetch({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('not json')),
    });

    const error = await addVersion('token', 'doc-1', new File(['x'], 'a.pdf')).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });
});

describe('revertToVersion', () => {
  it('posts to the revert route and sends a note only when there is one', async () => {
    const spy = mockFetch({ ok: true, status: 200, json: () => Promise.resolve({ id: 'doc-1' }) });

    await revertToVersion('token', 'doc-1', 'v-2');
    const [, first] = spy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(first.body as string)).toEqual({});

    await revertToVersion('token', 'doc-1', 'v-2', 'Back to the signed copy');
    const [url, second] = spy.mock.calls[1] as [string, RequestInit];

    expect(url).toMatch(/\/api\/documents\/doc-1\/versions\/v-2\/revert$/);
    expect(JSON.parse(second.body as string)).toEqual({ note: 'Back to the signed copy' });
  });
});

describe('fetchVersionBlob', () => {
  it('asks for the download route, never a preview one', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:version');
    vi.stubGlobal('URL', { ...URL, createObjectURL });

    const spy = mockFetch({ ok: true, blob: () => Promise.resolve(new Blob(['bytes'])) });

    await expect(fetchVersionBlob('token', 'doc-1', 'v-3')).resolves.toBe('blob:version');

    // The API deliberately offers no inline preview of an old version: inline is
    // a hardened surface and doubling it for a rare need is not worth it.
    const [url] = spy.mock.calls[0] as [string];
    expect(url).toMatch(/\/versions\/v-3\/download$/);
    expect(url).not.toMatch(/preview/);
  });
});
