import type { TransformFnParams } from 'class-transformer';

/**
 * Normalises an address before it is stored or looked up.
 *
 * Lowercased so `Sameh@x.com` and `sameh@x.com` cannot become two accounts in
 * the same company — and so a login typed with different casing still matches
 * the row that registration wrote.
 */
export const normaliseEmail = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : (value as unknown);

export const trimmed = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : (value as unknown);
