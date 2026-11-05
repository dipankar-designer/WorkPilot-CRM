import crypto from 'node:crypto';

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** A random, URL-safe secret and the hash that is stored in its place. */
export function newToken(bytes = 32): { token: string; hash: string } {
  const token = crypto.randomBytes(bytes).toString('base64url');
  return { token, hash: sha256(token) };
}

/** Hash of the client IP for audit logs (no raw IPs are stored). */
export const ipHash = (ip: string | undefined) => (ip ? sha256(`wp-ip:${ip}`).slice(0, 24) : null);
