import 'dotenv/config';
import db from '../db.js';
import { parseCliArgs, intFlag, usageExit, UsageError } from './args.js';
import { cliCreateInvite, CliError } from './actions.js';

/**
 * Admin CLI: npm run create-invite --workspace=server -- [--days 7] [--uses 1] [--label text] [--as admin@email]
 * Needs at least one enabled admin. The admin_audit actor is the admin given by --as, else the oldest enabled admin.
 * Prints the invite link path once; only its hash is stored. Unknown flags / missing values exit with code 2.
 */
const USAGE = 'create-invite [--days 1-90] [--uses 1-100] [--label text] [--as admin@email]';

let opts: { days: number; uses: number; label?: string; as?: string };
try {
  const { flags } = parseCliArgs(process.argv.slice(2), { days: 'int', uses: 'int', label: 'string', as: 'string' });
  opts = { days: intFlag(flags, 'days', 7, 1, 90), uses: intFlag(flags, 'uses', 1, 1, 100), label: flags.label, as: flags.as };
} catch (e) {
  if (e instanceof UsageError) usageExit(e, USAGE);
  throw e;
}

try {
  const inv = cliCreateInvite(db, { ...opts, nowSec: Math.floor(Date.now() / 1000) });
  console.log(`Invite created (valid ${opts.days} day(s), ${opts.uses} use(s)). Shown once; append to your site origin:`);
  console.log(inv.path);
} catch (e) {
  if (e instanceof CliError) { console.error(e.message); process.exit(1); }
  throw e;
}
