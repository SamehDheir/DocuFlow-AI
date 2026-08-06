import { NullAiProvider } from './null.provider';

/**
 * The fallback used when no API key is configured.
 *
 * Its whole value is being a working provider rather than a disabled one: CI
 * has no credential, and a pipeline that throws without one would leave the
 * queue, the status transitions, the notifications and the search indexing
 * untested. So what matters is that its output is deterministic, derived from
 * the input, and unmistakably labelled.
 */
describe('NullAiProvider', () => {
  const provider = new NullAiProvider();

  it('reports itself unavailable, so callers can tell', () => {
    expect(provider.available).toBe(false);
    expect(provider.name).toBe('null');
  });

  describe('summarise', () => {
    it('is deterministic for the same input', async () => {
      const first = await provider.summarise('Invoice number 4471 issued to Acme Corporation.');
      const second = await provider.summarise('Invoice number 4471 issued to Acme Corporation.');

      // A test can assert on this; random output would make the whole pipeline
      // untestable without a key.
      expect(first).toEqual(second);
    });

    it('labels its output so it is never mistaken for real analysis', async () => {
      const result = await provider.summarise('Some contract text.');

      expect(result.summary).toMatch(/^\[stub summary]/);
    });

    it('derives keywords from the actual text', async () => {
      const result = await provider.summarise('invoice invoice invoice payment payment shipping');

      expect(result.keywords).toContain('invoice');
      expect(result.keywords).toContain('payment');
      // Short words are noise, not keywords.
      expect(result.keywords?.every((word) => word.length > 4)).toBe(true);
    });

    it('detects Arabic content', async () => {
      const result = await provider.summarise('فاتورة رقم صادرة لشركة أكمي المحدودة');

      expect(result.language).toBe('ar');
    });

    it('detects English content', async () => {
      const result = await provider.summarise('Invoice issued to Acme Corporation.');

      expect(result.language).toBe('en');
    });

    it('returns no summary for empty text rather than an empty string', async () => {
      const result = await provider.summarise('   ');

      expect(result.summary).toBeUndefined();
    });
  });

  describe('ocr', () => {
    it('reports one page per image, labelled as a stub', async () => {
      const result = await provider.ocr([
        { data: Buffer.from('a'), mimeType: 'image/png', page: 1 },
        { data: Buffer.from('bb'), mimeType: 'image/png', page: 2 },
      ]);

      expect(result.pages).toBe(2);
      expect(result.text).toContain('[stub OCR — page 1');
      expect(result.text).toContain('[stub OCR — page 2');
    });
  });

  describe('embed', () => {
    it('returns null rather than a fabricated vector', async () => {
      /**
       * A random vector would populate the column with numbers that rank
       * nonsensically — worse than the honest empty state, which simply leaves
       * search on full text where it already works correctly.
       */
      await expect(provider.embed()).resolves.toBeNull();
    });
  });
});
