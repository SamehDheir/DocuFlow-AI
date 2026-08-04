import { ApiError } from './api';
import type { Dictionary } from '@/i18n/get-dictionary';

/**
 * Turns any thrown value into a sentence the reader's language can show.
 *
 * The API writes its messages once, in English. It also returns a stable `code`
 * per failure, which is what makes translation possible without the server
 * knowing anything about locales — this is the fix for the open item in
 * NEXT_STEPS.md §2, where a 409 from registration rendered untranslated.
 *
 * Resolution order:
 *   1. the dictionary entry for the code
 *   2. the API's own English message
 *   3. the generic fallback
 *
 * Step 2 matters: a code added to the API before the dictionary catches up
 * still shows something true rather than "Something went wrong".
 */
export function errorMessage(
  error: unknown,
  errors: Dictionary['errors'],
  fallback: string,
): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }

  if (error.code && error.code in errors) {
    return errors[error.code as keyof Dictionary['errors']];
  }

  return error.message || fallback;
}

/** True when the user aborted an upload, which is not worth reporting as failure. */
export function isCancelled(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'UPLOAD_CANCELLED';
}
