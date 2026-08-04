/**
 * Replace {placeholders} in a translated string.
 *
 * Lives in its own module, separate from get-dictionary.ts, because that file is
 * marked `server-only` — client components need interpolation too (the register
 * form's "Step 1 of 2"), and importing it from there would fail the build.
 *
 * Deliberately minimal: no plural rules, no number formatting. Arabic has six
 * plural categories, so anything needing pluralisation should use
 * Intl.PluralRules rather than growing this function.
 */
export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
