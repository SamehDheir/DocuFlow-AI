const PATTERN = /^(\d+)\s*(ms|s|m|h|d)$/i;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Converts a JWT-style duration ("15m", "7d") to milliseconds.
 *
 * The same string configures both the token's `exp` and the refresh cookie's
 * `Max-Age`. Deriving one from the other keeps a cookie from outliving the
 * token it carries, or expiring while the token is still valid.
 */
export function durationToMs(value: string): number {
  const match = PATTERN.exec(value.trim());

  if (!match) {
    throw new Error(`Unsupported duration "${value}". Expected a form like 15m, 24h, or 7d.`);
  }

  return Number(match[1]) * UNIT_MS[match[2].toLowerCase()];
}
