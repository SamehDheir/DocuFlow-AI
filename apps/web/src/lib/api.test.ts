import { describe, expect, it } from 'vitest';
import { query } from './api';

describe('query', () => {
  it('returns an empty string when nothing is set', () => {
    expect(query({})).toBe('');
    expect(query({ folderId: undefined, cursor: undefined })).toBe('');
  });

  /**
   * The distinction this protects is load-bearing and easy to "tidy away" with
   * a falsy check: `folderId: ''` means the ROOT folder and must reach the API,
   * while `folderId: undefined` means "no filter" and must not. A `if (value)`
   * would collapse the two and silently move root browsing to unfiltered.
   */
  it('keeps a deliberate blank but drops undefined', () => {
    expect(query({ folderId: '' })).toBe('?folderId=');
    expect(query({ folderId: undefined })).toBe('');
  });

  it('encodes values and preserves insertion order', () => {
    expect(query({ q: 'a b&c', limit: 20 })).toBe('?q=a+b%26c&limit=20');
  });

  it('renders numbers, including zero', () => {
    expect(query({ limit: 0 })).toBe('?limit=0');
  });
});
