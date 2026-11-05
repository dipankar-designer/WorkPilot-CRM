// Operator command: grant or revoke platform administration for an existing account.
//   npm run admin:grant -- someone@example.com          (grant)
//   npm run admin:grant -- someone@example.com --revoke (revoke)
import { normaliseEmail } from '@workpilot/shared';
import { one, systemPool } from '../db/pool.js';

const email = normaliseEmail(process.argv[2] ?? '');
const revoke = process.argv.includes('--revoke');
if (!email) {
  console.error('Usage: npm run admin:grant -- <email> [--revoke]');
  process.exit(1);
}
const row = await one<{ email: string }>(systemPool, 'UPDATE users SET is_platform_admin = $2 WHERE email = $1 RETURNING email', [email, !revoke]);
console.log(row ? `${row.email} is ${revoke ? 'no longer' : 'now'} a platform administrator.` : `No account found for ${email}.`);
await systemPool.end();
process.exit(row ? 0 : 1);
