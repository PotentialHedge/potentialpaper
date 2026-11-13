import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, sshKeys, type Account } from '@/db/schema';
import { ApiError } from './api/errors';
import { isUniqueViolation } from '@/db/errors';

/**
 * Public keys for git over SSH (`server/git/ssh.ts`): parsed and checked here, stored in `ssh_keys`. Only keys
 * worth trusting today are taken: Ed25519, ECDSA on the NIST curves, and RSA of at least 3072 bits (what
 * `ssh-keygen` makes by default). DSA and shorter RSA keys are refused, as are security-key (`sk-…`) keys, which
 * the SSH library can't check yet.
 */

export const KEY_TYPES = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
] as const;
export type KeyType = (typeof KEY_TYPES)[number];

export const MIN_RSA_BITS = 3072;
/** Far above an RSA-16384 key in `authorized_keys` form. */
const MAX_KEY_TEXT = 16 * 1024;
export const MAX_KEYS_PER_ACCOUNT = 50;
export const MAX_TITLE = 100;

export interface ParsedKey {
  type: KeyType;
  /** The key blob, as SSH sends it in a public-key request. */
  blob: Buffer;
  /** `<type> <base64>`, the line `authorized_keys` would have, without a comment. */
  publicKey: string;
  fingerprint: string;
  comment: string;
  /** RSA modulus size; 0 for other types. */
  bits: number;
}

export class KeyError extends Error {}

/** `SHA256:<unpadded base64>`, as `ssh-keygen -l` and GitHub print it. */
export function fingerprintOf(blob: Uint8Array): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** Reads SSH's wire format (RFC 4251 §5): strings and mpints are a 32-bit length, then the bytes. */
class Wire {
  private at = 0;
  constructor(private readonly buf: Buffer) {}
  string(): Buffer {
    if (this.at + 4 > this.buf.length) throw new KeyError('The key is cut short.');
    const length = this.buf.readUInt32BE(this.at);
    this.at += 4;
    if (this.at + length > this.buf.length) throw new KeyError('The key is cut short.');
    const out = this.buf.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }
  done(): boolean {
    return this.at === this.buf.length;
  }
}

const ECDSA_POINT: Record<string, number> = { nistp256: 65, nistp384: 97, nistp521: 133 };

/** The size of an mpint in bits (a leading zero byte only marks it positive). */
function mpintBits(n: Buffer): number {
  let i = 0;
  while (i < n.length && n[i] === 0) i++;
  if (i === n.length) return 0;
  return (n.length - i - 1) * 8 + (32 - Math.clz32(n[i]));
}

/**
 * One public key as `ssh-keygen` writes it (`~/.ssh/id_ed25519.pub`): `<type> <base64> [comment]`. Throws a
 * `KeyError` with a sentence for the person when it isn't one, or isn't a type we take.
 */
export function parsePublicKey(text: string): ParsedKey {
  const trimmed = text.trim();
  if (!trimmed) throw new KeyError('Paste a public key.');
  if (trimmed.length > MAX_KEY_TEXT) throw new KeyError('That is too long for a public key.');
  if (/^-----BEGIN/.test(trimmed)) {
    throw new KeyError(
      trimmed.includes('PRIVATE')
        ? 'That is a private key. Never share it: paste the .pub file instead.'
        : 'Paste the key as OpenSSH writes it (the .pub file), starting ssh-ed25519, ecdsa-sha2-… or ssh-rsa.',
    );
  }
  if (/[\r\n]/.test(trimmed)) throw new KeyError('Paste one key, on one line.');
  const match = /^(\S+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$/.exec(trimmed);
  if (!match) {
    throw new KeyError(
      'Paste the key as OpenSSH writes it (the .pub file), starting ssh-ed25519, ecdsa-sha2-… or ssh-rsa.',
    );
  }
  const [, typeText, base64, comment = ''] = match;
  if (typeText === 'ssh-dss')
    throw new KeyError('DSA keys are no longer safe. Make an Ed25519 key: ssh-keygen -t ed25519');
  if (typeText.startsWith('sk-')) {
    throw new KeyError('Security-key (sk-) keys are not supported yet. Use an Ed25519 key: ssh-keygen -t ed25519');
  }
  const type = KEY_TYPES.find((t) => t === typeText);
  if (!type) throw new KeyError(`Keys of type ${typeText.slice(0, 40)} are not supported. Use ssh-keygen -t ed25519.`);

  const blob = Buffer.from(base64, 'base64');
  if (blob.toString('base64') !== base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')) {
    throw new KeyError('The key is not valid base64.');
  }
  const wire = new Wire(blob);
  if (wire.string().toString('latin1') !== type) throw new KeyError(`The key inside is not an ${type} key.`);
  let bits = 0;
  if (type === 'ssh-ed25519') {
    if (wire.string().length !== 32) throw new KeyError('That Ed25519 key has the wrong length.');
  } else if (type === 'ssh-rsa') {
    wire.string(); // e
    bits = mpintBits(wire.string());
    if (bits < MIN_RSA_BITS) {
      throw new KeyError(
        `That RSA key has ${bits} bits; it needs at least ${MIN_RSA_BITS}. Make an Ed25519 key: ssh-keygen -t ed25519`,
      );
    }
    if (bits > 16384) throw new KeyError('That RSA key is larger than 16384 bits.');
  } else {
    const curve = type.slice('ecdsa-sha2-'.length);
    if (wire.string().toString('latin1') !== curve) throw new KeyError('The key names a different curve inside.');
    const point = wire.string();
    if (point.length !== ECDSA_POINT[curve] || point[0] !== 4) throw new KeyError('That ECDSA key is not valid.');
  }
  if (!wire.done()) throw new KeyError('The key has bytes after its end.');
  return {
    type,
    blob,
    publicKey: `${type} ${base64}`,
    fingerprint: fingerprintOf(blob),
    comment: comment.trim(),
    bits,
  };
}

// ------------------------------------------------------------------------------------------- storage

export async function listSshKeys(accountId: string, database: Database = getDb()) {
  return database
    .select({
      id: sshKeys.id,
      title: sshKeys.title,
      keyType: sshKeys.keyType,
      fingerprint: sshKeys.fingerprint,
      createdAt: sshKeys.createdAt,
      lastUsedAt: sshKeys.lastUsedAt,
    })
    .from(sshKeys)
    .where(eq(sshKeys.accountId, accountId))
    .orderBy(desc(sshKeys.createdAt));
}

/**
 * Adds a key to an account. Any signed-in account may add one, as any may make an API key; what a key may do
 * is decided when it is used (pushing needs a confirmed address, `server/git/ssh.ts`). 422 for a key we don't
 * take, 409 for one already on an account (this one or another: a key names one account).
 */
export async function addSshKey(
  account: Pick<Account, 'id'>,
  input: { key: string; title?: string },
  database: Database = getDb(),
) {
  let parsed: ParsedKey;
  try {
    parsed = parsePublicKey(input.key);
  } catch (err) {
    if (err instanceof KeyError) throw new ApiError(422, 'invalid_ssh_key', err.message);
    throw err;
  }
  const title = (input.title?.trim() || parsed.comment || parsed.type).slice(0, MAX_TITLE);
  const existing = await database.select({ id: sshKeys.id }).from(sshKeys).where(eq(sshKeys.accountId, account.id));
  if (existing.length >= MAX_KEYS_PER_ACCOUNT) {
    throw new ApiError(422, 'too_many_ssh_keys', `An account can have at most ${MAX_KEYS_PER_ACCOUNT} SSH keys.`);
  }
  try {
    const [row] = await database
      .insert(sshKeys)
      .values({
        accountId: account.id,
        title,
        keyType: parsed.type,
        publicKey: parsed.publicKey,
        fingerprint: parsed.fingerprint,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'ssh_key_taken', 'That key is already in use, on this account or another one.');
    }
    throw err;
  }
}

/** `false` if the account has no such key. */
export async function removeSshKey(accountId: string, keyId: string, database: Database = getDb()): Promise<boolean> {
  const deleted = await database
    .delete(sshKeys)
    .where(and(eq(sshKeys.id, keyId), eq(sshKeys.accountId, accountId)))
    .returning({ id: sshKeys.id });
  return deleted.length > 0;
}

/** The key with this blob and its account, or `null`. For the SSH server only. */
export async function findSshKey(blob: Uint8Array, database: Database = getDb()) {
  const [row] = await database
    .select({ key: sshKeys, account: accounts })
    .from(sshKeys)
    .innerJoin(accounts, eq(accounts.id, sshKeys.accountId))
    .where(eq(sshKeys.fingerprint, fingerprintOf(blob)));
  // The fingerprint is a hash of the blob; comparing the stored key too costs nothing.
  if (!row || row.key.publicKey.split(' ')[1] !== Buffer.from(blob).toString('base64')) return null;
  return row;
}

export async function touchSshKey(keyId: string, database: Database = getDb()): Promise<void> {
  await database.update(sshKeys).set({ lastUsedAt: new Date() }).where(eq(sshKeys.id, keyId));
}
