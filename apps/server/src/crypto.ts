import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseEncryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('ORCH_ENCRYPTION_KEY must be 32 random bytes encoded as base64');
  return key;
}

/** Development convenience: a key persisted next to the embedded database (never used in production). */
export function loadOrCreateDevKey(dataDir: string): Buffer {
  const path = join(dataDir, 'encryption.key');
  // Read first and create exclusively ('wx') instead of check-then-act, so concurrent starts cannot race.
  try {
    return parseEncryptionKey(readFileSync(path, 'utf8').trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32);
  try {
    writeFileSync(path, key.toString('base64'), { mode: 0o600, flag: 'wx' });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return parseEncryptionKey(readFileSync(path, 'utf8').trim());
  }
}

/** AES-256-GCM; output format `v1:<iv>:<tag>:<ciphertext>` (base64 parts). */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSecret(key: Buffer, payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split(':');
  if (version !== 'v1' || !iv || !tag || ciphertext === undefined) throw new Error('unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Session tokens are stored only as SHA-256 hashes (ADR-007). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hmacKey(key: Buffer): Buffer {
  return createHash('sha256').update(key).update('orchestrator-hmac').digest();
}

export function signValue(key: Buffer, value: string): string {
  return `${value}.${createHmac('sha256', hmacKey(key)).update(value).digest('base64url')}`;
}

export function verifySignedValue(key: Buffer, signed: string): string | null {
  const index = signed.lastIndexOf('.');
  if (index <= 0) return null;
  const value = signed.slice(0, index);
  const expected = Buffer.from(signValue(key, value));
  const received = Buffer.from(signed);
  return expected.length === received.length && timingSafeEqual(expected, received) ? value : null;
}
