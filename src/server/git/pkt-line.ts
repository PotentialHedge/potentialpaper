/**
 * Git's pkt-line framing (gitprotocol-common(5)), with no transport: bytes in, bytes out. Every smart
 * protocol speaks it, over HTTP (one request at a time) and over SSH (one long byte stream) alike.
 *
 * A packet is four hex digits giving its whole length, then that many bytes less four. Lengths 0, 1 and 2
 * are the special packets: flush (end of a message), delim (end of a section, protocol v2) and
 * response-end (v2, stateless transports only).
 */

/** The longest packet, length prefix included. */
export const MAX_PKT_LENGTH = 65520;
/** The most data one packet can carry. */
export const MAX_PKT_DATA = MAX_PKT_LENGTH - 4;

export const FLUSH = Buffer.from('0000');
export const DELIM = Buffer.from('0001');
export const RESPONSE_END = Buffer.from('0002');

export type Pkt = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export class PktError extends Error {}

/** One data packet. A string is written as UTF-8; text lines should end in `\n`, as git writes them. */
export function pkt(data: string | Buffer): Buffer {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  if (bytes.length > MAX_PKT_DATA) throw new PktError(`a packet holds at most ${MAX_PKT_DATA} bytes`);
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
}

/** Text packets, one per line (each given without its `\n`), then a flush. */
export function pktLines(lines: readonly string[]): Buffer {
  return Buffer.concat([...lines.map((line) => pkt(`${line}\n`)), FLUSH]);
}

/** The text of a data packet, without the `\n` git puts at the end of text lines. */
export function pktText(p: Pkt): string | null {
  if (p.kind !== 'data') return null;
  const text = p.data.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** Side-band channels (gitprotocol-pack(5)). */
export const BAND_DATA = 1;
export const BAND_PROGRESS = 2;
export const BAND_ERROR = 3;

/**
 * Bytes sent on one side-band channel, cut into as many packets as they need. `side-band-64k` (v0) and
 * every v2 packfile allow 65515 bytes after the band byte.
 */
export function* sideband(band: number, data: Buffer): Generator<Buffer> {
  const room = MAX_PKT_DATA - 1;
  for (let at = 0; at < data.length; at += room) {
    yield pkt(Buffer.concat([Buffer.from([band]), data.subarray(at, at + room)]));
  }
}

/**
 * Reads packets off a byte stream, which may split them anywhere: an SSH channel, a request body, or one
 * buffer. `read()` answers `null` at a clean end of input and throws on a packet cut short or malformed.
 */
export class PktReader {
  private buffered: Buffer = Buffer.alloc(0);
  private readonly source: AsyncIterator<Uint8Array>;
  private ended = false;

  constructor(input: AsyncIterable<Uint8Array> | Uint8Array) {
    const iterable: AsyncIterable<Uint8Array> =
      input instanceof Uint8Array
        ? (async function* () {
            yield input;
          })()
        : input;
    this.source = iterable[Symbol.asyncIterator]();
  }

  /** Waits until `n` bytes are buffered; false if the input ends first. */
  private async fill(n: number): Promise<boolean> {
    while (this.buffered.length < n) {
      if (this.ended) return false;
      const next = await this.source.next();
      if (next.done) {
        this.ended = true;
        return false;
      }
      this.buffered = this.buffered.length ? Buffer.concat([this.buffered, next.value]) : Buffer.from(next.value);
    }
    return true;
  }

  async read(): Promise<Pkt | null> {
    if (!(await this.fill(4))) {
      if (this.buffered.length) throw new PktError('the input ends inside a packet length');
      return null;
    }
    const prefix = this.buffered.toString('latin1', 0, 4);
    if (!/^[0-9a-f]{4}$/i.test(prefix)) throw new PktError(`bad packet length ${JSON.stringify(prefix)}`);
    const length = parseInt(prefix, 16);
    if (length < 4) {
      this.buffered = this.buffered.subarray(4);
      return { kind: length === 0 ? 'flush' : length === 1 ? 'delim' : length === 2 ? 'response-end' : bad(length) };
    }
    if (length > MAX_PKT_LENGTH) throw new PktError(`packet too long (${length})`);
    if (!(await this.fill(length))) throw new PktError('the input ends inside a packet');
    const data = Buffer.from(this.buffered.subarray(4, length));
    this.buffered = this.buffered.subarray(length);
    return { kind: 'data', data };
  }

  /**
   * Text lines up to the next flush or delim (which it consumes and returns as `end`). `null` if the input
   * ended before anything was read, the usual way a client says it is done.
   */
  async readSection(): Promise<{ lines: string[]; end: 'flush' | 'delim' } | null> {
    const lines: string[] = [];
    for (;;) {
      const p = await this.read();
      if (!p) {
        if (lines.length) throw new PktError('the input ends inside a message');
        return null;
      }
      if (p.kind === 'flush' || p.kind === 'delim') return { lines, end: p.kind };
      if (p.kind === 'response-end') throw new PktError('unexpected response-end packet');
      lines.push(pktText(p)!);
    }
  }
}

function bad(length: number): never {
  throw new PktError(`reserved packet length ${length}`);
}

/** Every packet in a buffer, for tests and short messages. */
export async function readAllPkts(bytes: Uint8Array): Promise<Pkt[]> {
  const reader = new PktReader(bytes);
  const out: Pkt[] = [];
  for (let p = await reader.read(); p; p = await reader.read()) out.push(p);
  return out;
}
