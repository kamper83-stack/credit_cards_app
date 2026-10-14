import 'dotenv/config';
import { createInterface } from 'readline';
import db from '../db.js';
import { hashPassword } from '../password.js';
import { checkPassword } from '../auth/passwordPolicy.js';
import { revokeAllSessions } from '../auth/sessions.js';

/**
 * Admin CLI: npm run reset-password --workspace=server -- <email>
 * The new password is read from the terminal without echo (or from stdin when piped). It is never
 * accepted via argv or the environment, so it cannot leak into shell history or `ps`.
 */

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
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); return reject(new Error('בוטל')); }
        if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error('Usage: npm run reset-password --workspace=server -- <email>');
    process.exit(2);
  }
  const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as { id: string } | undefined;
  if (!user) {
    console.error('No user with that email.');
    process.exit(1);
  }
  const password = await readHidden('New password: ');
  if (process.stdin.isTTY) {
    const again = await readHidden('Repeat password: ');
    if (again !== password) { console.error('Passwords do not match.'); process.exit(1); }
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

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
