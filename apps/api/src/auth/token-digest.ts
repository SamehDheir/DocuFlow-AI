import { createHmac } from 'node:crypto';

/**
 * Digest used for every credential this system stores but never needs to read
 * back: refresh tokens and password-reset grants.
 *
 * Keyed HMAC rather than a bare hash. The tokens are already CSPRNG output so
 * there is no dictionary to attack, but keying the digest with a secret that
 * lives outside the database means a stolen dump cannot be used to recognise a
 * token that later turns up. It stays a plain digest rather than bcrypt because
 * lookup happens by exact value on every refresh, which has to be one indexed
 * read.
 */
export function digestToken(token: string, key: string): string {
  return createHmac('sha256', key).update(token).digest('hex');
}
