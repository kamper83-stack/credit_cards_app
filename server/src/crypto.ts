import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// AES-256-GCM encryption of RiseUp PATs at rest.
// Generate a key with:  openssl rand -base64 32
// TOKEN_ENC_KEY           current key (base64 or hex, exactly 32 bytes)
// TOKEN_ENC_KEY_VERSION   version number of the current key (default 1)
// TOKEN_ENC_KEY_PREV      previous key, used to decrypt rows with key_version = VERSION - 1

export interface EncryptedPat {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

type Env = Record<string, string | undefined>;

export function parseKey(raw: string | undefined, name: string): Buffer {
  const v = raw?.trim();
  if (!v) throw new Error(`${name} is not set. Generate one with: openssl rand -base64 32`);
  let key: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(v)) key = Buffer.from(v, 'hex');
  else if (/^[A-Za-z0-9+/]{43}=$/.test(v)) key = Buffer.from(v, 'base64');
  if (!key || key.length !== 32) {
    throw new Error(`${name} must be exactly 32 bytes, encoded as base64 (44 chars) or hex (64 chars). Generate one with: openssl rand -base64 32`);
  }
  return key;
}

export function currentKeyVersion(env: Env = process.env): number {
  const v = env.TOKEN_ENC_KEY_VERSION;
  if (v === undefined || v === '') return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error('TOKEN_ENC_KEY_VERSION must be a positive integer');
  return n;
}

function keyForVersion(version: number, env: Env): Buffer {
  const current = currentKeyVersion(env);
  if (version === current) return parseKey(env.TOKEN_ENC_KEY, 'TOKEN_ENC_KEY');
  if (version === current - 1) return parseKey(env.TOKEN_ENC_KEY_PREV, 'TOKEN_ENC_KEY_PREV');
  throw new Error(`No encryption key configured for key_version ${version}`);
}

/** Throws a clear error if TOKEN_ENC_KEY is missing or malformed. */
export function assertEncryptionKey(env: Env = process.env): void {
  parseKey(env.TOKEN_ENC_KEY, 'TOKEN_ENC_KEY');
}

export function encryptPat(plain: string, userId: string, env: Env = process.env): EncryptedPat {
  const keyVersion = currentKeyVersion(env);
  const key = parseKey(env.TOKEN_ENC_KEY, 'TOKEN_ENC_KEY');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(userId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion };
}

export function decryptPat(
  row: { pat_ciphertext: Buffer; iv: Buffer; tag: Buffer; key_version: number },
  userId: string,
  env: Env = process.env,
): string {
  const key = keyForVersion(row.key_version, env);
  const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
  decipher.setAAD(Buffer.from(userId, 'utf8'));
  decipher.setAuthTag(row.tag);
  try {
    return Buffer.concat([decipher.update(row.pat_ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Do not leak anything from the underlying error.
    throw new Error('Failed to decrypt token (wrong key, wrong user, or tampered data)');
  }
}
