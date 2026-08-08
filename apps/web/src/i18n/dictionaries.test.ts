import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ar from './dictionaries/ar.json';
import en from './dictionaries/en.json';

/**
 * Guards on the translation layer that the type system cannot express.
 *
 * `get-dictionary.ts` carries compile-time `Assert<>` types that force ar.json
 * to structurally match en.json — but only in that direction. An Arabic key
 * with no English twin, an empty string, or an error code the API can emit and
 * neither dictionary covers all typecheck cleanly and fail at runtime.
 *
 * The API has the same pattern in `tenant-registration.spec.ts`, which parses
 * schema.prisma rather than trusting a hand-kept list.
 */

/**
 * Arrays are part of the shape — `register.strength.levels` is a string[] whose
 * length is meaningful, since the password meter indexes into it. Walking them
 * by index means a locale that drops an entry fails the parity check.
 */
type Json = string | Json[] | { [key: string]: Json };

function leafEntries(node: Json, prefix = ''): [string, string][] {
  if (typeof node === 'string') {
    return [[prefix, node]];
  }

  const children: [string, Json][] = Array.isArray(node)
    ? node.map((value, index) => [String(index), value])
    : Object.entries(node);

  return children.flatMap(([key, value]) => leafEntries(value, prefix ? `${prefix}.${key}` : key));
}

/** Every leaf path, as dotted strings: `documents.actions.rename`. */
function leafPaths(node: Json, prefix = ''): string[] {
  return leafEntries(node, prefix).map(([path]) => path);
}

const english = en as Json;
const arabic = ar as Json;

describe('dictionaries', () => {
  it('carry exactly the same keys in both locales', () => {
    const enPaths = leafPaths(english).sort();
    const arPaths = leafPaths(arabic).sort();

    // Reported as a diff of the two sets rather than a length comparison, so a
    // failure names the offending key instead of just a count.
    expect(arPaths.filter((path) => !enPaths.includes(path))).toEqual([]);
    expect(enPaths.filter((path) => !arPaths.includes(path))).toEqual([]);
  });

  it.each([
    ['en', english],
    ['ar', arabic],
  ])('have no blank values (%s)', (_locale, dictionary) => {
    const blank = leafEntries(dictionary)
      .filter(([, value]) => value.trim() === '')
      .map(([path]) => path);

    expect(blank).toEqual([]);
  });

  it('translate every error code the API can emit', () => {
    /**
     * Parsed from the API source rather than imported: apps/web has no
     * dependency on apps/api, and adding one to reach a constant would couple
     * the two builds. The shape is a flat `as const` object of string literals.
     */
    // Resolved from the vitest root (apps/web) rather than from import.meta.url,
    // which Vite rewrites to a non-file URL under the jsdom environment.
    const source = readFileSync(
      resolve(process.cwd(), '../api/src/common/errors/error-codes.ts'),
      'utf8',
    );

    const codes = [...source.matchAll(/^ {2}([A-Z][A-Z0-9_]*): '([A-Z][A-Z0-9_]*)',$/gm)].map(
      (match) => match[2],
    );

    // A regex that matched nothing would make this test vacuously pass.
    expect(codes.length).toBeGreaterThan(20);

    const enErrors = Object.keys((en as { errors: Record<string, string> }).errors);
    const arErrors = Object.keys((ar as { errors: Record<string, string> }).errors);

    expect(codes.filter((code) => !enErrors.includes(code))).toEqual([]);
    expect(codes.filter((code) => !arErrors.includes(code))).toEqual([]);
  });
});
