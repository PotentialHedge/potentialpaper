import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { utils } from 'ssh2';
import { getDb, getPool } from '@/db';
import { createSshServer, hostKeyFingerprint } from '@/server/git/ssh';

/**
 * The SSH server for git (`server/git/ssh.ts`), as its own process: `npm run git:ssh`.
 *
 *   GIT_SSH_PORT           where it listens (default 2222)
 *   GIT_SSH_HOST           the address it binds (default 127.0.0.1; the compose service sets 0.0.0.0)
 *   GIT_SSH_HOST_KEY       the private host key itself (OpenSSH or PEM; `\n` may stand for line breaks), or
 *   GIT_SSH_HOST_KEY_FILE  a file holding it (default data/ssh_host_ed25519_key)
 *   APP_INTERNAL_URL       the app, which refreshes a paper's pages after a push (http://app:3000 in compose)
 *
 * Production needs a key that stays the same (clients remember it, and warn loudly when it changes), so there it
 * refuses to start without one. In dev a missing key file is made.
 */

const DEV_KEY_FILE = 'data/ssh_host_ed25519_key';

function hostKey(): string {
  const inline = process.env.GIT_SSH_HOST_KEY;
  if (inline) return inline.includes('\n') ? inline : inline.replace(/\\n/g, '\n');
  const file = process.env.GIT_SSH_HOST_KEY_FILE || DEV_KEY_FILE;
  if (existsSync(file)) return readFileSync(file, 'utf8');
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `no host key: set GIT_SSH_HOST_KEY or GIT_SSH_HOST_KEY_FILE (${file} does not exist); see DEPLOY.md`,
    );
  }
  const pair = utils.generateKeyPairSync('ed25519');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, pair.private, { mode: 0o600 });
  console.log(`made a dev host key in ${file}`);
  return pair.private;
}

function main() {
  const key = hostKey();
  const port = Number(process.env.GIT_SSH_PORT || 2222);
  const host = process.env.GIT_SSH_HOST || '127.0.0.1';
  const server = createSshServer({ hostKeys: [key], database: getDb() });
  server.listen(port, host, () => {
    console.log(`git over SSH on ${host}:${port}, host key ${hostKeyFingerprint(key)}`);
    if (!process.env.APP_INTERNAL_URL) console.log("APP_INTERNAL_URL is unset: pushes will not refresh Next's copies");
  });
  // No new connections; open ones get up to 10 seconds to finish (Docker's stop waits as long), then it goes.
  const stop = () => {
    server.close(
      () =>
        void getPool()
          .end()
          .finally(() => process.exit(0)),
    );
    setTimeout(() => process.exit(0), 9000);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
