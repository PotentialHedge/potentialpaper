import { createHash, type Hash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { GitObjectType } from '../pages/git-objects';
import { PACK_TYPE_CODES } from './pack';

/**
 * Reading git packfiles (gitformat-pack(5)), version 2, as a push sends them: whole objects, and deltas
 * against an earlier object of the pack (OFS_DELTA) or against any object by id (REF_DELTA). A "thin" pack,
 * which git sends by default, has REF_DELTAs whose base is not in the pack but on the server already; `bases`
 * reads those. The trailer's SHA-1 is checked, and every size has a cap, so a pack can't make the server hold
 * more than a few times its own size, however its deltas are built.
 *
 * The pack is read off a byte stream up to its trailer and no further, as over SSH the client keeps the
 * stream open for the answer after it.
 */

export type PackObjectType = GitObjectType | 'tag';

export interface PackObject {
  type: GitObjectType;
  body: Buffer;
}

export class PackError extends Error {}

export interface PackLimits {
  /** The whole pack, as sent (compressed). */
  maxPackBytes: number;
  maxObjects: number;
  /** One object, inflated: whole, a delta, or a delta's result. */
  maxObjectBytes: number;
  /** Everything held at once: inflated objects, delta data and the objects deltas make. */
  maxTotalBytes: number;
}

/**
 * Far above what a push to a page can use (files are at most 256 KB, demo files 1 MB; a page has at most
 * 1,000 files and a push 50 commits), so only a pack that could never be accepted meets them.
 */
export const PACK_LIMITS: PackLimits = {
  maxPackBytes: 32 * 1024 * 1024,
  maxObjects: 50_000,
  maxObjectBytes: 4 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

/** Objects already on the server, by id, for a thin pack's deltas. Asked for once per round, in a batch. */
export type BaseReader = (oids: readonly string[]) => Promise<Map<string, { type: PackObjectType; body: Buffer }>>;

const TYPE_NAMES: Record<number, PackObjectType> = {
  [PACK_TYPE_CODES.commit]: 'commit',
  [PACK_TYPE_CODES.tree]: 'tree',
  [PACK_TYPE_CODES.blob]: 'blob',
  4: 'tag',
};
const OFS_DELTA = 6;
const REF_DELTA = 7;

/** Bytes off a stream, pulled only when needed, with a running SHA-1 of what has been consumed. */
class Input {
  private buffer: Buffer = Buffer.alloc(0);
  private at = 0;
  /** Bytes consumed so far: the offset of the next one in the pack. */
  offset = 0;
  private ended = false;
  private readonly hash: Hash = createHash('sha1');
  private readonly source: AsyncIterator<Uint8Array>;

  constructor(
    input: AsyncIterable<Uint8Array> | Uint8Array,
    private readonly maxBytes: number,
  ) {
    const iterable: AsyncIterable<Uint8Array> =
      input instanceof Uint8Array
        ? (async function* () {
            yield input;
          })()
        : input;
    this.source = iterable[Symbol.asyncIterator]();
  }

  get available(): Buffer {
    return this.buffer.subarray(this.at);
  }

  /** The source's next chunk, asked for and not yet taken. */
  private pending: Promise<IteratorResult<Uint8Array>> | null = null;

  /**
   * One more chunk from the source; false at its end. With `wait` false, only a chunk that is there already
   * (by the next turn of the event loop), and false if none is.
   */
  async more(wait = true): Promise<boolean> {
    if (this.ended) return false;
    for (;;) {
      this.pending ??= this.source.next();
      if (!wait) {
        const ready = await Promise.race([this.pending, new Promise<null>((r) => setImmediate(() => r(null)))]);
        if (ready === null) return false;
      }
      const next = await this.pending;
      this.pending = null;
      if (next.done) {
        this.ended = true;
        return false;
      }
      if (next.value.length === 0) continue;
      const rest = this.available;
      if (this.offset + rest.length + next.value.length > this.maxBytes + 20) {
        throw new PackError(`the pack is larger than ${this.maxBytes / 1024 / 1024} MB`);
      }
      this.buffer = rest.length ? Buffer.concat([rest, next.value]) : Buffer.from(next.value);
      this.at = 0;
      return true;
    }
  }

  async need(n: number): Promise<Buffer> {
    while (this.available.length < n) {
      if (!(await this.more())) throw new PackError('the pack ends early');
    }
    return this.available.subarray(0, n);
  }

  consume(n: number, hashed = true): Buffer {
    const bytes = this.buffer.subarray(this.at, this.at + n);
    if (hashed) this.hash.update(bytes);
    this.at += n;
    this.offset += n;
    return bytes;
  }

  async take(n: number): Promise<Buffer> {
    await this.need(n);
    return this.consume(n);
  }

  async byte(): Promise<number> {
    return (await this.take(1))[0];
  }

  digest(): Buffer {
    return this.hash.digest();
  }

  /**
   * The zlib stream that starts here, inflated, and consumed. `size` is what its entry header promised. The
   * stream's length is only known once it is inflated, so with too little buffered this waits for one more
   * chunk, takes whatever else has arrived up to twice as much as it tried with, and starts again: never
   * waiting for more than the object needs, which over SSH could be bytes that never come.
   */
  async inflate(size: number, max: number): Promise<Buffer> {
    if (size > max) throw new PackError(`an object is larger than ${max / 1024 / 1024} MB`);
    if (this.available.length === 0) await this.need(1);
    for (;;) {
      try {
        const { buffer, engine } = inflateSync(this.available, {
          info: true,
          maxOutputLength: size + 1,
        }) as unknown as {
          buffer: Buffer;
          engine: { bytesWritten: number };
        };
        if (buffer.length !== size) throw new PackError('an object is not the size its header says');
        this.consume(engine.bytesWritten);
        return buffer;
      } catch (err) {
        if (err instanceof PackError) throw err;
        const code = (err as { code?: string }).code;
        if (code === 'ERR_BUFFER_TOO_LARGE') throw new PackError('an object is not the size its header says');
        if (code !== 'Z_BUF_ERROR') throw new PackError('the pack has a corrupt object');
        const tried = this.available.length;
        if (!(await this.more())) throw new PackError('the pack ends early');
        while (this.available.length < 2 * tried && (await this.more(false)));
      }
    }
  }
}

interface Entry {
  offset: number;
  /** A whole object's type; `null` for a delta, until it is resolved. */
  type: PackObjectType | null;
  /** A whole object's body, or a delta's instructions. */
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

interface Resolved {
  offset: number | null;
  oid: string;
  type: PackObjectType;
  body: Buffer;
}

function objectId(type: PackObjectType, body: Buffer): string {
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}

/**
 * Reads one pack, checks its trailer and resolves its deltas. Returns its commits, trees and blobs by id
 * (tags are read and dropped: a page has none). Throws `PackError` for anything malformed or over a cap.
 */
export async function readPack(
  input: AsyncIterable<Uint8Array> | Uint8Array,
  options: { bases?: BaseReader; limits?: Partial<PackLimits> } = {},
): Promise<Map<string, PackObject>> {
  const limits = { ...PACK_LIMITS, ...options.limits };
  const src = new Input(input, limits.maxPackBytes);
  let held = 0;
  const hold = (bytes: number) => {
    held += bytes;
    if (held > limits.maxTotalBytes) {
      throw new PackError(`the pack's objects add up to more than ${limits.maxTotalBytes / 1024 / 1024} MB`);
    }
  };

  const header = await src.take(12);
  if (header.toString('latin1', 0, 4) !== 'PACK') throw new PackError('not a packfile');
  const version = header.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`packfile version ${version} is not supported`);
  const count = header.readUInt32BE(8);
  if (count > limits.maxObjects) throw new PackError(`a pack can hold at most ${limits.maxObjects} objects`);

  const entries: Entry[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = src.offset;
    let byte = await src.byte();
    const code = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = await src.byte();
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (size > limits.maxObjectBytes) {
        throw new PackError(`an object is larger than ${limits.maxObjectBytes / 1024 / 1024} MB`);
      }
    }
    const entry: Entry = { offset, type: null, data: Buffer.alloc(0) };
    if (code === OFS_DELTA) {
      byte = await src.byte();
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = await src.byte();
        back = (back + 1) * 128 + (byte & 0x7f);
        if (back > offset) break;
      }
      if (back <= 0 || back > offset) throw new PackError('a delta names a base outside the pack');
      entry.baseOffset = offset - back;
    } else if (code === REF_DELTA) {
      entry.baseOid = (await src.take(20)).toString('hex');
    } else if (TYPE_NAMES[code]) {
      entry.type = TYPE_NAMES[code];
    } else {
      throw new PackError(`an object has the unknown type ${code}`);
    }
    entry.data = await src.inflate(size, limits.maxObjectBytes);
    hold(entry.data.length);
    entries.push(entry);
  }
  const expected = src.digest();
  const trailer = (await src.need(20)).subarray(0, 20);
  src.consume(20, false);
  if (!trailer.equals(expected)) throw new PackError("the pack's checksum does not match");

  const out = new Map<string, PackObject>();
  const byOffset = new Map<number, number[]>();
  const byOid = new Map<string, number[]>();
  const queue: Resolved[] = [];
  let unresolved = 0;
  for (const [i, entry] of entries.entries()) {
    if (entry.type) {
      queue.push({ offset: entry.offset, oid: objectId(entry.type, entry.data), type: entry.type, body: entry.data });
    } else if (entry.baseOffset !== undefined) {
      unresolved += 1;
      byOffset.set(entry.baseOffset, [...(byOffset.get(entry.baseOffset) ?? []), i]);
    } else {
      unresolved += 1;
      byOid.set(entry.baseOid!, [...(byOid.get(entry.baseOid!) ?? []), i]);
    }
  }

  /** Each object made, then every delta waiting for it, until none is left that can be made. */
  const drain = () => {
    while (queue.length) {
      const object = queue.pop()!;
      if (object.offset !== null && object.type !== 'tag')
        out.set(object.oid, { type: object.type, body: object.body });
      const waiting = [
        ...(object.offset !== null ? (byOffset.get(object.offset) ?? []) : []),
        ...(byOid.get(object.oid) ?? []),
      ];
      if (object.offset !== null) byOffset.delete(object.offset);
      byOid.delete(object.oid);
      for (const i of waiting) {
        const delta = entries[i];
        const body = applyDelta(object.body, delta.data, limits.maxObjectBytes);
        hold(body.length);
        unresolved -= 1;
        queue.push({ offset: delta.offset, oid: objectId(object.type, body), type: object.type, body });
      }
    }
  };
  drain();
  // A thin pack's bases are on the server. Each round can make objects that other deltas name, so repeat.
  while (unresolved > 0 && byOid.size > 0 && options.bases) {
    const found = await options.bases([...byOid.keys()]);
    let added = 0;
    for (const [oid, object] of found) {
      if (!byOid.has(oid) || objectId(object.type, object.body) !== oid) continue;
      queue.push({ offset: null, oid, ...object });
      added += 1;
    }
    if (added === 0) break;
    drain();
  }
  if (unresolved > 0) {
    const missing = [...byOid.keys()][0];
    throw new PackError(missing ? `the pack has a delta against ${missing}, which is not here` : 'a delta has no base');
  }
  return out;
}

/** A delta's instructions (gitformat-pack(5), "Deltified representation") applied to its base. */
export function applyDelta(base: Buffer, delta: Buffer, max = Infinity): Buffer {
  let at = 0;
  const size = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= delta.length) throw new PackError('a delta is cut short');
      const byte = delta[at++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
      if (shift > 35) throw new PackError('a delta has a bad size');
    }
  };
  if (size() !== base.length) throw new PackError("a delta's base is not the size it says");
  const length = size();
  if (length > max) throw new PackError(`an object is larger than ${max / 1024 / 1024} MB`);
  const out = Buffer.allocUnsafe(length);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++];
    if (op & 0x80) {
      let offset = 0;
      let count = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (at >= delta.length) throw new PackError('a delta is cut short');
          offset += delta[at++] * 2 ** (8 * bit);
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (1 << (4 + bit))) {
          if (at >= delta.length) throw new PackError('a delta is cut short');
          count += delta[at++] * 2 ** (8 * bit);
        }
      }
      if (count === 0) count = 0x10000;
      if (offset + count > base.length || written + count > length) throw new PackError('a delta copies out of bounds');
      base.copy(out, written, offset, offset + count);
      written += count;
    } else if (op) {
      if (at + op > delta.length || written + op > length) throw new PackError('a delta inserts out of bounds');
      delta.copy(out, written, at, at + op);
      at += op;
      written += op;
    } else {
      throw new PackError('a delta has a reserved instruction');
    }
  }
  if (written !== length) throw new PackError('a delta makes an object of the wrong size');
  return out;
}
