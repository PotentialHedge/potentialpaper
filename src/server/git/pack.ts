import { createHash, type Hash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { GitObjectType } from '../pages/git-objects';

/**
 * Writing git packfiles (gitformat-pack(5)), version 2, with every object whole: no deltas, so a pack is
 * bigger than git's own, but it costs no search and nothing about earlier objects has to be kept. A pack
 * reader (deltas included) belongs beside this, for pushes.
 *
 * A pack is `PACK`, the version and the object count, each object (a type-and-size header, then its body
 * deflated with zlib), and a SHA-1 of everything before it.
 */

export const PACK_TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3 };

export function packHeader(count: number): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(count, 8);
  return header;
}

/**
 * An object's entry header: the type in bits 4–6 of the first byte, the size's low four bits under it,
 * and the rest of the size seven bits a byte, each but the last with its top bit set.
 */
export function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (PACK_TYPE_CODES[type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

export function packEntry(type: GitObjectType, body: Buffer): Buffer {
  return Buffer.concat([packObjectHeader(type, body.length), deflateSync(body)]);
}

/**
 * A pack as a stream of chunks, for objects read a batch at a time. The count goes first, so it must be
 * known before any object is; a source that yields a different number is a bug and throws before the
 * trailer, which leaves the client with a pack it will refuse rather than a wrong one.
 */
export async function* writePack(
  count: number,
  objects: AsyncIterable<{ type: GitObjectType; body: Buffer }> | Iterable<{ type: GitObjectType; body: Buffer }>,
): AsyncGenerator<Buffer> {
  const hash: Hash = createHash('sha1');
  const out = (chunk: Buffer) => {
    hash.update(chunk);
    return chunk;
  };
  yield out(packHeader(count));
  let written = 0;
  for await (const { type, body } of objects) {
    written += 1;
    if (written > count) throw new Error(`pack promised ${count} objects and got more`);
    yield out(packEntry(type, body));
  }
  if (written !== count) throw new Error(`pack promised ${count} objects and got ${written}`);
  yield hash.digest();
}

/** A whole pack in one buffer, for tests and small packs. */
export async function packBuffer(objects: readonly { type: GitObjectType; body: Buffer }[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of writePack(objects.length, objects)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
