import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, with later Tailwind utilities winning over earlier ones.
 *
 * Without tailwind-merge, `cn('px-4', props.className)` silently keeps both
 * `px-4` and an overriding `px-6`, and which one applies comes down to CSS
 * source order rather than intent.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
