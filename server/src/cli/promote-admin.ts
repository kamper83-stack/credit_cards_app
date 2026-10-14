import 'dotenv/config';
import db from '../db.js';
import { parseCliArgs, usageExit, UsageError } from './args.js';
import { cliPromoteAdmin, CliError } from './actions.js';

/**
 * Admin CLI: npm run promote-admin --workspace=server -- <email> [--as admin@email]
 * Makes an existing, enabled user an admin (recovery when users exist but no admin does). Writes an
 * admin_audit row; the actor is --as, else the oldest enabled admin, else the promoted user itself.
 */
const USAGE = 'promote-admin <email> [--as admin@email]';

let email: string;
let as: string | undefined;
try {
  const { flags, positionals } = parseCliArgs(process.argv.slice(2), { as: 'string' }, 1);
  if (!positionals[0]?.trim()) throw new UsageError('Missing <email>.');
  email = positionals[0];
  as = flags.as;
} catch (e) {
  if (e instanceof UsageError) usageExit(e, USAGE);
  throw e;
}

try {
  const r = cliPromoteAdmin(db, { email, as, nowSec: Math.floor(Date.now() / 1000) });
  console.log(r.alreadyAdmin ? `${r.email} is already an admin. Nothing changed.` : `${r.email} is now an admin.`);
} catch (e) {
  if (e instanceof CliError) { console.error(e.message); process.exit(1); }
  throw e;
}
