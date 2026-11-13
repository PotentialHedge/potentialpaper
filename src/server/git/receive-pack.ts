import { ApiError, type ApiErrorCode } from '../api/errors';
import type { RefUpdate } from '../pages/receive';
import { type PackObject, PackError, readPack } from './pack-reader';
import { BAND_DATA, BAND_PROGRESS, FLUSH, pkt, PktError, type PktReader, sideband } from './pkt-line';
import type { GitRepo } from './repo';
import { AGENT, type ProtocolVersion } from './upload-pack';

export type { RefUpdate };

/**
 * git-receive-pack, the server side of `git push` (gitprotocol-pack(5), "Pushing data to a server"), over
 * any transport, as `upload-pack.ts` is for fetches: packets in through a `PktReader`, bytes out as an async
 * generator. Over HTTP the advertisement answers `GET info/refs?service=git-receive-pack` and one POST
 * carries the commands and the pack (`receivePackRequest`); over SSH one stream carries both
 * (`receivePackSession`).
 *
 * A page has one ref, `refs/heads/main`, and it can only move forward: deletes, tags and other branches are
 * refused per ref. What a move has to be is decided by `target.update` (for a page, `receiveCommits`), whose
 * refusals go back as `remote:` lines (side-band 2) and an `ng` in the status report. Git has no push in
 * protocol v2, so a client asking for it gets v0, as from git's own receive-pack.
 */

const MAIN = 'refs/heads/main';
const ZERO_OID = '0'.repeat(40);
const OID = /^[0-9a-f]{40}$/;

/**
 * `delete-refs` is left out, so git refuses a delete before it sends it; `push-options` and `push-cert` too,
 * since a page reads neither. `atomic` holds trivially for one ref, but is offered so `--atomic` works.
 */
const CAPABILITIES = ['report-status', 'side-band-64k', 'quiet', 'atomic', 'ofs-delta', 'object-format=sha1', AGENT];

/** Where a push goes: its repo (the advertised head, and the bases a thin pack leaves out) and its one ref. */
export interface ReceiveTarget {
  repo: GitRepo;
  /**
   * Moves `refs/heads/main`, or throws to refuse. An `ApiError`'s message is shown to the pusher as is
   * (each of its lines a `remote:` line); anything else is reported as an internal error and rethrown once
   * the client has been told. May return lines to show on success.
   */
  update(update: RefUpdate, objects: ReadonlyMap<string, PackObject>): Promise<string[] | void>;
}

/** The refs and capabilities, which the client reads before it decides what to send. */
export async function receivePackAdvertisement(repo: GitRepo, version: ProtocolVersion): Promise<Buffer> {
  const head = await repo.head();
  const caps = CAPABILITIES.join(' ');
  return Buffer.concat([
    ...(version === 1 ? [pkt('version 1\n')] : []),
    head ? pkt(`${head} ${MAIN}\0${caps}\n`) : pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`),
    FLUSH,
  ]);
}

/** The advertisement, then one push: what runs on a stream such as an SSH channel. */
export async function* receivePackSession(
  target: ReceiveTarget,
  input: PktReader,
  version: ProtocolVersion,
): AsyncGenerator<Buffer> {
  yield await receivePackAdvertisement(target.repo, version);
  yield* receivePackRequest(target, input);
}

interface Command {
  old: string;
  new: string;
  ref: string;
  /** Why it is refused: the `ng` reason, and what to tell the pusher. */
  refused?: { reason: string; message?: string };
}

/** Short reasons for `ng`, which git shows in brackets after the ref. */
const REASONS: Partial<Record<ApiErrorCode, string>> = {
  fetch_first: 'fetch first',
  not_fast_forward: 'non-fast-forward',
  wrong_identity: 'wrong author identity',
  forbidden: 'not allowed',
  not_verified: 'not allowed',
  rate_limited: 'too many commits, try later',
  page_busy: 'page busy, try again',
  paper_merged: 'page merged',
};

/**
 * One push: the commands, then (unless every command is a delete) the pack, then the status report. The
 * pack is read even when every command is refused, so a stream stays in step.
 */
export async function* receivePackRequest(target: ReceiveTarget, input: PktReader): AsyncGenerator<Buffer> {
  let section: Awaited<ReturnType<PktReader['readSection']>>;
  try {
    section = await input.readSection();
  } catch (err) {
    if (err instanceof PktError) {
      yield pkt(`ERR ${err.message}\n`);
      return;
    }
    throw err;
  }
  // A client with nothing to update sends a flush, or hangs up.
  if (!section || section.lines.length === 0) return;

  const caps = new Set<string>();
  const commands: Command[] = [];
  for (const [i, line] of section.lines.entries()) {
    const [text, capText] = i === 0 ? splitCaps(line) : [line, ''];
    if (i === 0) for (const cap of capText.split(' ').filter(Boolean)) caps.add(cap);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (!match) {
      const what = text.startsWith('shallow ') ? 'shallow clones cannot push; clone the whole page' : 'bad command';
      yield pkt(`ERR ${what}\n`);
      return;
    }
    commands.push({ old: match[1], new: match[2], ref: match[3] });
  }
  const sidebanded = caps.has('side-band-64k');
  const reporting = caps.has('report-status');
  const messages: string[] = [];

  for (const command of commands) command.refused = refusal(command, commands);
  let unpack = 'ok';
  let objects: ReadonlyMap<string, PackObject> = new Map();
  if (commands.some((c) => c.new !== ZERO_OID)) {
    try {
      objects = await readPack(input.rest(), { bases: (oids) => target.repo.read(oids) });
    } catch (err) {
      if (!(err instanceof PackError || err instanceof PktError)) throw err;
      unpack = err.message;
      messages.push(`The pack could not be read: ${err.message}`);
      for (const command of commands) command.refused ??= { reason: 'unpacker error' };
    }
  }
  if (caps.has('atomic') && commands.some((c) => c.refused)) {
    for (const command of commands) command.refused ??= { reason: 'atomic push failed' };
  }

  let fault: unknown = null;
  for (const command of commands) {
    if (command.refused) {
      if (command.refused.message) messages.push(command.refused.message);
      continue;
    }
    try {
      const shown = await target.update(
        { old: command.old === ZERO_OID ? null : command.old, new: command.new },
        objects,
      );
      if (shown && !caps.has('quiet')) messages.push(...shown);
    } catch (err) {
      if (err instanceof ApiError) {
        command.refused = { reason: REASONS[err.code] ?? 'refused' };
        messages.push(err.message);
      } else {
        command.refused = { reason: 'internal error' };
        messages.push('Something went wrong on the server; nothing was changed. Try again later.');
        fault = err;
      }
    }
  }

  if (sidebanded && messages.length) {
    const text = messages.flatMap((m) => m.split('\n')).join('\n');
    yield Buffer.concat([...sideband(BAND_PROGRESS, Buffer.from(`${text}\n`))]);
  }
  if (reporting) {
    const report = Buffer.concat([
      pkt(`unpack ${unpack}\n`),
      ...commands.map((c) => pkt(c.refused ? `ng ${c.ref} ${c.refused.reason}\n` : `ok ${c.ref}\n`)),
      FLUSH,
    ]);
    yield sidebanded ? Buffer.concat([...sideband(BAND_DATA, report)]) : report;
  }
  if (sidebanded) yield FLUSH;
  if (fault) throw fault;
}

function splitCaps(line: string): [string, string] {
  const nul = line.indexOf('\0');
  return nul === -1 ? [line, ''] : [line.slice(0, nul), line.slice(nul + 1)];
}

/** Why a command is refused before its commits are looked at, if it is. */
function refusal(command: Command, all: readonly Command[]): Command['refused'] {
  const { ref } = command;
  if (ref.startsWith('refs/tags/')) {
    return { reason: 'pages have no tags', message: `${ref}: a page has no tags; push main only.` };
  }
  if (ref !== MAIN) {
    return {
      reason: 'only main',
      message: `${ref}: a page has one branch, main; push to it (git push origin HEAD:main).`,
    };
  }
  if (command.new === ZERO_OID) return { reason: 'cannot delete', message: "main can't be deleted." };
  if (!OID.test(command.new) || all.filter((c) => c.ref === ref).length > 1) return { reason: 'bad command' };
  return undefined;
}
