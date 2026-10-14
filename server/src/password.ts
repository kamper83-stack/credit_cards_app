import { hash, verify } from '@node-rs/argon2';

// argon2id with the OWASP minimum parameters (m=19 MiB, t=2, p=1).
// Algorithm.Argon2id === 2 (const enum, so the numeric value is used directly).
const OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** Returns false for a wrong password or a malformed hash (never throws on bad input). */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
