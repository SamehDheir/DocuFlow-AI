import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_SIZE, formatBytes, isPreviewable, isProcessing } from './documents';

describe('isProcessing', () => {
  it('covers every stage a worker still owns', () => {
    for (const status of ['UPLOADING', 'PROCESSING', 'OCR', 'AI_ANALYSIS'] as const) {
      expect(isProcessing(status)).toBe(true);
    }
  });

  it('is false once the document has settled', () => {
    for (const status of ['CREATED', 'UPLOADED', 'READY', 'ARCHIVED', 'DELETED'] as const) {
      expect(isProcessing(status)).toBe(false);
    }
  });
});

describe('isPreviewable', () => {
  it('accepts the types the preview route can stream inline', () => {
    expect(isPreviewable('application/pdf')).toBe(true);
    expect(isPreviewable('image/png')).toBe(true);
    expect(isPreviewable('text/plain')).toBe(true);
  });

  it('is case-insensitive, because a browser may send a capitalised type', () => {
    expect(isPreviewable('Application/PDF')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(
      isPreviewable('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe(false);
    expect(isPreviewable('')).toBe(false);
  });
});

describe('formatBytes', () => {
  it('renders bytes without a fraction and larger units with one', () => {
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(1024, 'en')).toBe('1 KB');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(1048576, 'en')).toBe('1 MB');
  });

  it('accepts the string the API sends, because Document.size is a BigInt', () => {
    expect(formatBytes('1048576', 'en')).toBe('1 MB');
  });

  it('stops at TB rather than running off the end of the unit list', () => {
    expect(formatBytes(1024 ** 5, 'en')).toBe('1,024 TB');
  });

  /**
   * The number goes through Intl rather than `toFixed()`, so grouping and the
   * decimal mark follow the locale. Checked against de-DE, which inverts both
   * separators — `ar` shares en's Latin digits and separators in Node's ICU, so
   * it cannot tell the two implementations apart.
   */
  it('formats the number through Intl, so separators follow the locale', () => {
    expect(formatBytes(1024 ** 5, 'en')).toBe('1,024 TB');
    expect(formatBytes(1024 ** 5, 'de')).toBe('1.024 TB');
    expect(formatBytes(1536, 'de')).toBe('1,5 KB');
  });
});

describe('MAX_FILE_SIZE', () => {
  /**
   * Falls back to the API's own 100 MB default. A missing NEXT_PUBLIC_MAX_FILE_SIZE
   * must never raise the client's ceiling above the server's — the failure mode
   * is a connection reset mid-upload instead of a clean 413.
   */
  it('defaults to the server default rather than to NaN or Infinity', () => {
    expect(MAX_FILE_SIZE).toBe(104857600);
  });

  /** Read at module load, so each case needs a fresh module registry. */
  async function reimport(value: string | undefined): Promise<number> {
    vi.resetModules();

    if (value === undefined) {
      vi.stubEnv('NEXT_PUBLIC_MAX_FILE_SIZE', undefined);
    } else {
      vi.stubEnv('NEXT_PUBLIC_MAX_FILE_SIZE', value);
    }

    const reloaded = await import('./documents');
    return reloaded.MAX_FILE_SIZE;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('honours a configured ceiling', async () => {
    await expect(reimport('524288000')).resolves.toBe(524288000);
  });

  /**
   * The case that matters. This is a NEXT_PUBLIC_* value inlined from a Docker
   * build arg, and an arg declared but left empty — an unset repository variable
   * in release.yml — arrives as ''. `?? default` does not catch it, because ''
   * is not nullish, and Number('') is 0: a ceiling that rejects every file.
   */
  it.each([
    ['an empty string, from an unset build arg', ''],
    ['a non-numeric value', 'lots'],
    ['zero', '0'],
    ['a negative value', '-1'],
  ])('falls back on %s', async (_case, value) => {
    await expect(reimport(value)).resolves.toBe(104857600);
  });
});
