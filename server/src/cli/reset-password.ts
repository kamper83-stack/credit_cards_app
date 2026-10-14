import 'dotenv/config';
import { createInterface } from 'readline';
import db from '../db.js';
import { hashPassword } from '../password.js';
import { checkPassword } from '../auth/passwordPolicy.js';
import { revokeAllSessions } from '../auth/sessions.js';
import { parseCliArgs, usageExit, UsageError } from './args.js';

/**
 * Admin CLI: npm run reset-password --workspace=server -- <email>
 * The new password is read from the terminal without echo (or from stdin when piped). It is never
 * accepted via argv or the environment, so it cannot leak into shell history or `ps`.
 */

class Cancelled extends Error {}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Piped input: read the first line.
      const rl = createInterface({ input: stdin });
      rl.once('line', (l) => { resolve(l); rl.close(); });
      rl.once('close', () => resolve(''));
      return;
    }
    process.stderr.write(prompt);
    let value = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { finish(); return resolve(value); }
        // Raw mode swallows SIGINT, so Ctrl-C arrives as a character: restore the terminal and cancel.
        if (ch === '\u0003') { finish(); return reject(new Cancelled('Cancelled.')); }
        if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

// Never leave the terminal in raw mode (no echo) however the process ends.
process.on('exit', () => { try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* ignore */ } });
process.on('SIGINT', () => { process.stderr.write('\nCancelled.\n'); process.exit(130); });

async function main() {
  const USAGE = 'reset-password <email>';
  let email: string;
  try {
    const { positionals } = parseCliArgs(process.argv.slice(2), {}, 1);
    if (!positionals[0]?.trim()) throw new UsageError('Missing <email>.');
    email = positionals[0].trim().toLowerCase();
  } catch (e) {
    if (e instanceof UsageError) usageExit(e, USAGE);
    throw e;
  }
  const user = db.prepare(`SELECT id, disabled_at FROM users WHERE email = ?`).get(email) as { id: string; disabled_at: number | null } | undefined;
  if (!user) {
    console.error('No user with that email.');
    process.exit(1);
  }
  if (user.disabled_at) console.error('Warning: this user is DISABLED. Resetting the password does not re-enable the account (they still cannot log in).');
  const password = await readHidden('New password: ');
  if (process.stdin.isTTY) {
    const again = await readHidden('Repeat password: ');
    if (again.normalize('NFC') !== password.normalize('NFC')) { console.error('Passwords do not match.'); process.exit(1); }
  }
  const problem = checkPassword(password, email);
  if (problem) { console.error(problem); process.exit(1); }

  const newHash = await hashPassword(password);
  db.transaction(() => {
    db.prepare(`UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?`).run(newHash, user.id);
    revokeAllSessions(db, user.id);
  })();
  console.log(`Password reset for ${email}. All sessions revoked, lockout cleared.`);
}

main().then(() => process.exit(0)).catch((e) => {
  if (e instanceof Cancelled) { console.error('Cancelled. Nothing was changed.'); process.exit(130); }
  console.error(e.message);
  process.exit(1);
});
