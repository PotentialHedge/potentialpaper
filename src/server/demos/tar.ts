/**
 * Reads the regular files out of a tar archive, as GitHub's tarballs are: ustar, with pax headers for long
 * names. Links, devices and folders are skipped, so nothing in an archive can point outside it. It reads
 * as the archive arrives, and keeps only the files `keep` wants, so a large repo costs only what is kept.
 */

export interface TarFile {
  path: string;
  bytes: Buffer;
}

const BLOCK = 512;

function text(block: Buffer, from: number, length: number): string {
  const field = block.subarray(from, from + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function octal(block: Buffer, from: number, length: number): number {
  const field = text(block, from, length).trim();
  if (!/^[0-7]*$/.test(field)) throw new Error('not a tar archive');
  return field === '' ? 0 : parseInt(field, 8);
}

/** The `path` record of a pax header, which overrides the next entry's name. */
function paxPath(body: Buffer): string | null {
  let path: string | null = null;
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(body.subarray(at, space).toString('ascii'));
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = body.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (record.slice(0, equals) === 'path') path = record.slice(equals + 1);
    at += length;
  }
  return path;
}

/** Headers whose body is metadata, read whole whatever `keep` says. */
const META_TYPES = new Set(['x', 'L', 'g']);
const MAX_META_BYTES = 1024 * 1024;

export class TarReader {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** The entry whose body is being read, or `null` between entries. */
  private entry: { type: string; path: string; size: number; padded: number; keep: boolean } | null = null;
  private nextPath: string | null = null;
  private done = false;
  readonly files: TarFile[] = [];

  constructor(private readonly keep: (path: string) => boolean = () => true) {}

  private take(length: number): Buffer {
    const all = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
    const taken = all.subarray(0, length);
    const rest = all.subarray(length);
    this.pending = rest.length > 0 ? [rest] : [];
    this.pendingBytes = rest.length;
    return taken;
  }

  /** Drops what an unkept entry's body has arrived so far, so it never piles up. */
  private skip(length: number): number {
    const dropped = Math.min(length, this.pendingBytes);
    this.take(dropped);
    return dropped;
  }

  push(chunk: Buffer): void {
    if (this.done) return;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    for (;;) {
      if (!this.entry) {
        if (this.pendingBytes < BLOCK) return;
        const header = this.take(BLOCK);
        if (header.every((byte) => byte === 0)) {
          this.done = true;
          return;
        }
        const size = octal(header, 124, 12);
        const type = String.fromCharCode(header[156] || 0x30);
        const prefix = text(header, 345, 155);
        const path = this.nextPath ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
        if (!META_TYPES.has(type)) this.nextPath = null;
        if (META_TYPES.has(type) && size > MAX_META_BYTES) throw new Error('tar header too large');
        const regular = type === '0' || type === '7';
        const keep = META_TYPES.has(type) || (regular && this.keep(path));
        this.entry = { type, path, size, padded: Math.ceil(size / BLOCK) * BLOCK, keep };
      }
      const entry = this.entry;
      if (!entry.keep) {
        entry.padded -= this.skip(entry.padded);
        if (entry.padded > 0) return;
        this.entry = null;
        continue;
      }
      if (this.pendingBytes < entry.padded) return;
      const body = Buffer.from(this.take(entry.padded).subarray(0, entry.size));
      this.entry = null;
      if (entry.type === 'x') this.nextPath = paxPath(body);
      else if (entry.type === 'L') this.nextPath = text(body, 0, body.length);
      else if (entry.type !== 'g') this.files.push({ path: entry.path, bytes: body });
    }
  }
}

export function readTar(archive: Buffer, keep?: (path: string) => boolean): TarFile[] {
  const reader = new TarReader(keep);
  reader.push(archive);
  return reader.files;
}
