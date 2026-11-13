import { once } from 'node:events';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { Server, utils, type AuthContext, type Connection, type ServerChannel } from 'ssh2';
import type { Database } from '@/db';
import type { Account } from '@/db/schema';
import { findRepo, type GitAddress, parseGitAddress } from '../pages/clone';
import { consume, rateLimitConfig } from '../ratelimit';
import { findSshKey, fingerprintOf, touchSshKey } from '../ssh-keys';
import { pageReceiveTarget } from './page-push';
import { PktReader } from './pkt-line';
import { receivePackSession } from './receive-pack';
import { pageRepo } from './repo';
import { type GitService, parseSshCommand, parseSshPath } from './ssh-command';
import { protocolVersion, uploadPackSession } from './upload-pack';

/**
 * Git over SSH (DESIGN.md §4.6), as GitHub serves it: user `git`, public keys only (`ssh_keys`), and nothing
 * runs but `git-upload-pack '<path>'` and `git-receive-pack '<path>'`, which drive the same sessions as the
 * `git://` tests (`uploadPackSession`, `receivePackSession`) on the channel. No shell, pty, forwarding or
 * subsystems; a bare `ssh git@host` gets a greeting and exit status 1.
 *
 * Runs as its own process (`scripts/git-ssh.ts`, the `ssh` compose service), so a push refreshes the paper's
 * pages through the app (`refreshPaperPages` → `revalidateInApp`).
 */

export interface SshLimits {
  /** Connections open at once, in all. */
  maxConnections: number;
  /** Connections open at once from one address. */
  maxConnectionsPerIp: number;
  /** New connections from one address: a bucket of this many, refilled at `connectionsPerSecondPerIp`. */
  connectionBurstPerIp: number;
  connectionsPerSecondPerIp: number;
  /** Public-key requests (queries and signatures) one connection may make. */
  maxAuthAttempts: number;
  /** From connect to signed in. */
  authTimeoutMs: number;
  /** A connection's whole life, a clone or a push included. */
  maxConnectionMs: number;
  /** git commands running at once for one account. */
  maxSessionsPerAccount: number;
}

export const SSH_LIMITS: SshLimits = {
  maxConnections: 100,
  maxConnectionsPerIp: 10,
  connectionBurstPerIp: 30,
  connectionsPerSecondPerIp: 0.5,
  maxAuthAttempts: 10,
  authTimeoutMs: 20_000,
  maxConnectionMs: 10 * 60_000,
  maxSessionsPerAccount: 4,
};

export interface SshServerOptions {
  /** Private host keys, as files hold them (OpenSSH or PEM). */
  hostKeys: (Buffer | string)[];
  database: Database;
  limits?: Partial<SshLimits>;
  /** What the server logs: faults and refusals worth knowing about. */
  log?: (...args: unknown[]) => void;
}

const SITE = 'PotentialPaper';

/** A token bucket per address, in memory: one process takes every connection. */
class ConnectionBuckets {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
  ) {}
  take(ip: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(ip) ?? { tokens: this.burst, at: now };
    bucket.tokens = Math.min(this.burst, bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond);
    bucket.at = now;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(ip, bucket);
    if (this.buckets.size > 10_000) this.prune(now);
    return allowed;
  }
  /** Drops full buckets, which are the same as none. */
  private prune(now: number) {
    for (const [ip, b] of this.buckets) {
      if (b.tokens + ((now - b.at) / 1000) * this.perSecond >= this.burst) this.buckets.delete(ip);
    }
  }
}

/** The SHA256 fingerprint of a host key, as `ssh-keygen -lf` and a client's first-connection prompt print it. */
export function hostKeyFingerprint(privateKey: Buffer | string): string {
  const key = utils.parseKey(privateKey);
  if (key instanceof Error) throw key;
  const parsed = Array.isArray(key) ? key[0] : key;
  return `${parsed.type} ${fingerprintOf(parsed.getPublicSSH())}`;
}

/** Makes the server; `listen` on what it returns. Also the integration tests' entry point. */
export function createSshServer(options: SshServerOptions): NetServer {
  const limits = { ...SSH_LIMITS, ...options.limits };
  const log = options.log ?? ((...args: unknown[]) => console.error('git ssh:', ...args));
  const sessions = new Map<string, number>();
  const ssh = new Server({ hostKeys: options.hostKeys, ident: SITE }, (client, info) =>
    handleClient(client, info.ip, { ...options, limits, log }, sessions, () =>
      clearTimeout(signIn.get(`${info.ip}|${info.port}`)),
    ),
  );
  ssh.maxConnections = limits.maxConnections;
  ssh.on('error', (err: Error) => log('server', err));
  const buckets = new ConnectionBuckets(limits.connectionBurstPerIp, limits.connectionsPerSecondPerIp);
  const perIp = new Map<string, number>();
  /** Each connection's deadline to sign in, by address and port (what ssh2 tells the handler about a client). */
  const signIn = new Map<string, NodeJS.Timeout>();

  // Our own listener, so a connection over the limits is dropped before any SSH work is done for it.
  return createServer((socket: Socket) => {
    const ip = socket.remoteAddress ?? 'unknown';
    const open = perIp.get(ip) ?? 0;
    if (open >= limits.maxConnectionsPerIp || !buckets.take(ip)) {
      socket.destroy();
      return;
    }
    perIp.set(ip, open + 1);
    socket.once('close', () => {
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    });
    socket.on('error', () => {});
    // A connection lives at most this long, whatever it's doing.
    const lifetime = setTimeout(() => socket.destroy(), limits.maxConnectionMs);
    lifetime.unref();
    // And it has this long to sign in, the handshake included, so a silent one doesn't hold a place.
    const id = `${ip}|${socket.remotePort}`;
    const deadline = setTimeout(() => socket.destroy(), limits.authTimeoutMs);
    deadline.unref();
    signIn.set(id, deadline);
    socket.once('close', () => {
      clearTimeout(lifetime);
      clearTimeout(deadline);
      signIn.delete(id);
    });
    ssh.injectSocket(socket);
  });
}

interface Context extends SshServerOptions {
  limits: SshLimits;
  log: (...args: unknown[]) => void;
}

function handleClient(
  client: Connection,
  ip: string,
  ctx: Context,
  sessions: Map<string, number>,
  signedIn: () => void,
) {
  let account: Account | null = null;
  let attempts = 0;

  client.on('error', () => {
    // A client hanging up mid-handshake is normal.
  });

  client.on('authentication', (auth: AuthContext) => {
    attempts += 1;
    if (attempts > ctx.limits.maxAuthAttempts) {
      auth.reject();
      client.end();
      return;
    }
    // GitHub's shape: one user, `git`, and the key says who you are.
    if (auth.method !== 'publickey' || auth.username !== 'git') {
      auth.reject(['publickey']);
      return;
    }
    void (async () => {
      const found = await findSshKey(auth.key.data, ctx.database);
      if (!found) return auth.reject(['publickey']);
      // Without a signature the client only asks whether the key would do.
      if (!auth.signature || !auth.blob) return auth.accept();
      const key = utils.parseKey(found.key.publicKey);
      if (key instanceof Error || Array.isArray(key) || key.verify(auth.blob, auth.signature, auth.hashAlgo) !== true) {
        return auth.reject(['publickey']);
      }
      account = found.account;
      await touchSshKey(found.key.id, ctx.database);
      auth.accept();
    })().catch((err) => {
      ctx.log('authentication', ip, err);
      auth.reject(['publickey']);
    });
  });

  client.on('ready', signedIn);

  client.on('session', (accept) => {
    const session = accept();
    let gitProtocol: string | null = null;
    let started = false;
    session.on('env', (ok, no, info) => {
      // Git sends `GIT_PROTOCOL=version=2` (SendEnv) to ask for protocol v2; nothing else is taken.
      if (info.key === 'GIT_PROTOCOL' && info.val.length <= 256) {
        gitProtocol = info.val;
        ok?.();
      } else no?.();
    });
    session.on('pty', (_ok, no) => no?.());
    session.on('x11', (_ok, no) => no?.());
    session.on('auth-agent', (_ok, no) => no?.());
    session.on('subsystem', (_ok, no) => no?.());
    session.on('sftp', (_ok, no) => no?.());
    session.on('shell', (ok, no) => {
      if (started || !account) return no?.();
      started = true;
      const channel = ok();
      finish(channel, 1, `Hi ${account.handle}! You've authenticated, but ${SITE} does not provide shell access.`);
    });
    session.on('exec', (ok, no, info) => {
      if (started || !account) return no?.();
      started = true;
      const channel = ok();
      void runGit(channel, info.command, gitProtocol, account, ctx, sessions).catch((err) => {
        ctx.log('exec', ip, info.command.slice(0, 200), err);
        finish(channel, 1, 'ERROR: Something went wrong on the server. Try again later.');
      });
    });
  });

  // No forwarding of any kind.
  client.on('tcpip', (_ok, no) => no());
  client.on('openssh.streamlocal', (_ok, no) => no());
  client.on('request', (_ok, no) => no?.());
}

/** Ends a command: a message on stderr, which git prints as is (or after `remote:`), and its exit status. */
function finish(channel: ServerChannel, status: number, message?: string) {
  try {
    if (message) channel.stderr.write(`${message}\n`);
    channel.exit(status);
    channel.end();
  } catch {
    // The client is gone.
  }
}

/** The page an address names, following the redirect `findRepo` gives for another address of the same page. */
async function resolve(address: GitAddress, database: Database) {
  let found = await findRepo(address, database);
  for (let hops = 0; found.kind === 'redirect' && hops < 2; hops++) {
    // `to` is the canonical clone address, with the same service at its end.
    const next = parseGitAddress(found.to);
    if (!next) return null;
    found = await findRepo(next, database);
  }
  return found.kind === 'repo' ? found : null;
}

async function runGit(
  channel: ServerChannel,
  command: string,
  gitProtocol: string | null,
  account: Account,
  ctx: Context,
  sessions: Map<string, number>,
): Promise<void> {
  const parsed = parseSshCommand(command);
  if (!parsed) {
    return finish(
      channel,
      128,
      `ERROR: Invalid command: ${JSON.stringify(command.slice(0, 100))}\n  ${SITE} serves git only: git clone, fetch and push.`,
    );
  }
  const address = parseSshPath(parsed.path, parsed.service);
  if (!address) {
    return finish(
      channel,
      1,
      `ERROR: '${parsed.path.slice(0, 200)}' is not a page's address. A page's is its own path, as in git@<host>:abs/1706.03762.git`,
    );
  }
  const open = sessions.get(account.id) ?? 0;
  if (open >= ctx.limits.maxSessionsPerAccount) {
    return finish(channel, 1, 'ERROR: Too many git commands at once for this account. Try again in a moment.');
  }
  sessions.set(account.id, open + 1);
  try {
    await serve(channel, parsed.service, address, gitProtocol, account, ctx);
  } finally {
    const n = (sessions.get(account.id) ?? 1) - 1;
    if (n <= 0) sessions.delete(account.id);
    else sessions.set(account.id, n);
  }
}

async function serve(
  channel: ServerChannel,
  service: GitService,
  address: GitAddress,
  gitProtocol: string | null,
  account: Account,
  ctx: Context,
): Promise<void> {
  // The same bucket as the account's API requests and HTTPS pushes.
  const rate = await consume(`account:${account.id}`, rateLimitConfig());
  if (!rate.allowed) {
    return finish(
      channel,
      1,
      `ERROR: Too many requests for this account. Try again in ${rate.retryAfterSeconds} seconds.`,
    );
  }
  const repo = await resolve(address, ctx.database);
  if (!repo) {
    return finish(
      channel,
      1,
      `ERROR: No page repository at ${address.scheme}/${address.raw}. A page has one once someone has edited it on the site.`,
    );
  }

  let output: AsyncGenerator<Buffer>;
  const reader = new PktReader(channel);
  if (service === 'git-upload-pack') {
    output = uploadPackSession(pageRepo(ctx.database, repo.paperId), reader, protocolVersion(gitProtocol));
  } else {
    // As `authenticateGitPush`: a person needs a confirmed address; a bot account is let through.
    if (!account.isBot && !account.verifiedAt) {
      return finish(channel, 1, 'ERROR: Confirm an institutional email address before you push.');
    }
    const target = pageReceiveTarget(ctx.database, repo, { kind: 'account', accountId: account.id, isAdmin: false });
    // Git has no push in protocol v2; a client asking for it gets v0, as from git's own receive-pack.
    output = receivePackSession(target, reader, protocolVersion(gitProtocol) === 1 ? 1 : 0);
  }

  let gone = false;
  channel.once('close', () => (gone = true));
  try {
    for await (const chunk of output) {
      if (gone) break;
      if (!channel.write(chunk)) await Promise.race([once(channel, 'drain'), once(channel, 'close')]);
    }
  } catch (err) {
    // The client has been told (`ERR`, the error band or `remote:` lines); this is for the logs.
    ctx.log(service, `${address.scheme}/${address.raw}`, err);
    return finish(channel, 1);
  }
  finish(channel, 0);
}
