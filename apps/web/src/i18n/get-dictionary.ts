import 'server-only';
import type { Locale } from './config';

/**
 * Dictionary loading.
 *
 * The dictionaries are behind dynamic `import()` rather than a static import so
 * that only the requested locale's JSON is pulled into a given render. Importing
 * both statically would ship the Arabic strings to English readers and vice
 * versa — small here, but it grows with every page added.
 *
 * `server-only` makes an accidental client import a build error instead of a
 * silent bundle-size regression. (interpolate() lives in ./interpolate.ts for
 * exactly that reason — client components need it.)
 *
 * NOTE: deliberately no `satisfies Record<Locale, () => Promise<unknown>>` here.
 * That annotation contextually types the `.then()` callbacks, which collapses
 * every dictionary to `Promise<unknown>` and makes `dict.login.title` an error
 * at every call site. Exhaustiveness is enforced by the assertions below instead.
 */
const dictionaries = {
  en: () => import('./dictionaries/en.json').then((m) => m.default),
  ar: () => import('./dictionaries/ar.json').then((m) => m.default),
};

/** English is the source of truth for the dictionary shape. */
export type Dictionary = Awaited<ReturnType<typeof dictionaries.en>>;

type Assert<T extends true> = T;

/**
 * Compile-time guarantees, erased at runtime:
 *
 *  1. Every locale has a loader — adding 'fr' to config.ts without a dictionary
 *     becomes a type error rather than a 500 at request time.
 *  2. The Arabic file structurally matches the English one — a missing or
 *     renamed key surfaces in `npm run typecheck`, not as `undefined` rendered
 *     into the page.
 */
export type _EveryLocaleHasLoader = Assert<Locale extends keyof typeof dictionaries ? true : never>;
export type _ArabicMatchesEnglish = Assert<
  Awaited<ReturnType<typeof dictionaries.ar>> extends Dictionary ? true : never
>;

export async function getDictionary(locale: Locale): Promise<Dictionary> {
  // The union of loaders resolves to En | Ar; the assertion above proves Ar is
  // assignable to Dictionary, so this narrowing is sound rather than a
  // convenience cast.
  return dictionaries[locale]() as Promise<Dictionary>;
}
