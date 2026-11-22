# Deploying

**The site is not in production yet.** papers.potentialhedge.com has no real users, so downtime, a failed
deploy or a reset database costs nothing. Deploy straight from `main` on this host, with no staging step, no
maintenance window and no rollback plan. Just fix forward. This changes once the owner says we have launched.

## Recipe

Run from the repo root on this host, with `main` checked out and committed (the image is tagged with HEAD's
commit, so uncommitted changes would ship under the wrong name). The shared checkout can hold other sessions'
uncommitted work, which `COPY . .` would ship, so a clean worktree is safer: `git worktree add --detach
../papertrail-deploy-<commit> <commit>`, copy `.env.production` into it (it's gitignored), and run the recipe there.
The compose project name is fixed (`potentialpaper`), so it drives the same containers.

```sh
git checkout main && git pull --ff-only
export GIT_COMMIT=$(git rev-parse --short HEAD)
dc() { docker compose -f docker-compose.prod.yml --env-file .env.production "$@"; }

dc --profile tools build          # app and tools images; without --profile tools, migrations go stale
dc up -d postgres
dc run --rm tools                 # migrations (npm run db:migrate)
dc up -d app
dc --profile tools up -d ingest worker ssh  # PDF ingest, the outbox consumers and git over SSH, on the new image
scripts/purge-edge-cache.sh       # required, see below
```

Check it: `docker inspect potentialpaper-app-1 --format '{{.Config.Image}}'` names the new commit, and
https://papers.potentialhedge.com loads.

## Why each step is there

- **Migrations run as their own step**, never at app start. `dc run --rm tools npm run <script>` runs any
  other script against production the same way.
- **The edge-cache purge is not optional.** Cloudflare caches whole pages. They name the old build's scripts,
  which the new container no longer serves, so cached pages break until the cache is purged.

## Git LFS

PDFs and pictures in page repos are Git LFS pointers (DESIGN.md §4.3), served by the app at each clone address's
`info/lfs/` (`src/server/git/lfs.ts`). Nothing to run for it: downloads go straight to R2's public addresses, and
uploads are `PUT`s of at most 40 MB through Cloudflare (whose limit is 100 MB) to the app.

**Once, when deploying the move to it** (migration `0023_lfs_objects`): straight after `dc up -d app`, run
`dc run --rm tools npm run pages:migrate-lfs` (a system commit per page; until a page is moved, edits to it are
refused), then `scripts/purge-edge-cache.sh`. `-- --dry-run` lists what it would change. It is safe to run again.

## PDF ingest

The `ingest` service runs `npm run pdfs:ingest -- --watch` from the tools image (which has poppler): every
minute it runs each stage that is missing or out of date (text and emails of page 1, cover) on every PDF a page
points at, recording results in `pdf_documents`. `dc logs -f ingest` shows its progress. For a one-off rerun,
`dc run --rm tools npm run pdfs:ingest -- --stage emails --force` or `-- --sha <sha256>`; `-- --help` lists the
rest. It needs the `R2_*` keys for covers.

## Outbox consumers

The `worker` service runs `npm run consumers:work` (`scripts/consumer-worker.ts`, `src/server/consumers/`) from the
tools image: every consumer of `page_events` (DESIGN.md §4.9) catches up, then waits for a commit's `NOTIFY
page_events` or 15 seconds. Each keeps its cursor in `consumer_cursors`; `last_error` there names a page that
stopped one (it retries every minute). `dc logs -f worker` shows progress. To start one over, which clears what it
holds and replays every event: `dc run --rm tools npm run consumers:rebuild -- <name>` (no name lists them).

The consumers are:

- **`search`** (`src/server/search-index.ts`) fills `search_docs` (migration `0028_search_docs`) from each file
  type's indexer, which `in:page` and `in:reviews` searches read. The first deploy with it replays every page's
  events from zero; that is expected, and the home page's plain search (titles and abstracts) works meanwhile.
  After changing an indexer in `src/server/pages/schemas.ts`, rebuild it: `consumers:rebuild -- search`.
- **`reviews`** (`src/server/review-projection.ts`) projects the `reviews/<source>/<submission>/` files bots commit
  into `submissions`, `submission_notes` and the venues' forms, which the Submissions panel reads. A page with no
  review files loses any rows it had, so on the first deploy with it, run the review import (below) right away;
  until it and the worker are through, some pages show no submissions.

### Importing OpenReview reviews

Imports run outside the platform, from the `potentialpaper-tools` repo, through the import API
(`/agent/imports`, `src/server/api/imports.ts`), as the `openreview` bot. Give the tool a token once:
`dc --profile tools run --rm tools npm run bots:token -- openreview "import tool"` (printed once; revoke it as any
token). Then, from a machine with the scrape, `PP_URL=https://papers.potentialhedge.com PP_TOKEN=… npm run
import-reviews -- <scrape.sqlite> ICLR.cc/2027/Conference "ICLR 2027" [--from <forum id>]` commits each submission's
files as the bot, one commit per submission that changed (with `IMPORT_RATE_LIMIT`, not the people's limit).
Re-running commits only what changed, so a stopped run is resumed by running it again. Once the worker has caught up
after a big import, reclaim space: `REPACK (CONCURRENTLY)` (Postgres 19) or `VACUUM (ANALYZE)` on `page_objects`,
`page_revisions`, `page_events`, `search_docs`, `submission_notes`.

In dev the worker is the transient user unit `papertrail-worker` (log `data/worker.log`), started beside
`papertrail-dev`: `systemd-run --user --unit=papertrail-worker --working-directory=$PWD --setenv=PATH=$PATH
bash -c 'node_modules/.bin/tsx scripts/consumer-worker.ts > data/worker.log 2>&1'`. Restart it after changing
consumer code (`systemctl --user stop papertrail-worker`, then the command again).

## Bots and their grants

A bot is an account with `is_bot`; what it may write is rows in `bot_grants` (DESIGN.md §10), checked on every
commit and push like everyone's roles (`src/server/pages/rules.ts`). Migration `0027_bot_grants` makes our own
importer, the bot `openreview`, and grants it `reviews/openreview/**`. Grant or take back others by script:
`dc run --rm tools npm run bots:grant -- <handle> 'reviews/<source>/**' --by <admin handle> [--create]`
(`--revoke` takes it back; no arguments lists every grant).

## Plugins' identity keys

Plugins with the `identity` permission get tokens the site signs (ES256), which their backends verify at
`/.well-known/jwks.json` (DESIGN.md §10, data for plugins D). The first key is made in Postgres (`identity_keys`) on
first use; nothing to set up. To rotate: `dc run --rm tools npm run identity:keys -- rotate`, wait ten minutes (the
JWKS is cached five, tokens live five), then `… identity:keys -- retire <old kid>`. Readers' ids at each plugin
(`sub`) are an HMAC keyed by `PLUGIN_SUBJECT_SECRET`, or `BETTER_AUTH_SECRET` without it: changing that secret changes
them all, so set `PLUGIN_SUBJECT_SECRET` once before launch if `BETTER_AUTH_SECRET` may ever rotate.

## Git over SSH

**Not set up in production yet: Benedict decides the name and the port (below).** Until then leave `ssh` out of
`up -d ingest ssh`; it refuses to start without its host key anyway.

The `ssh` service runs `npm run git:ssh` (`scripts/git-ssh.ts`, `src/server/git/ssh.ts`) from the tools image, as
its own process: user `git`, public keys from `ssh_keys` only, nothing runs but `git-upload-pack` and
`git-receive-pack`. It listens on 2222 in its container and is published on the host as `GIT_SSH_PUBLISH` (default
2222). After a push it asks the app to refresh the paper's pages (`APP_INTERNAL_URL=http://app:3000`, a request to
`/api/internal/revalidate` signed with a key derived from `BETTER_AUTH_SECRET`), and purges the edge as the app does.
Limits (in `SSH_LIMITS`): 100 connections at once, 10 per address, 30 new ones per address then one every 2 s, 10
key attempts a connection, 20 s to sign in, 10 minutes a connection, 4 git commands at once per account, and every
command counts against the account's API bucket.

**DNS.** Cloudflare doesn't proxy SSH on our plan, so git needs a DNS-only (grey-cloud) name pointing at this host,
e.g. an A record `git.papers` → `77.244.248.196` in `potentialhedge.com`. It shows the origin's address, which
the proxied names hide; Traefik admits only Cloudflare's addresses on 80/443, so the web stays behind the edge.

**Port.** The host's own sshd holds 22. The options:

1. **2222 (recommended to start).** `GIT_SSH_PUBLISH=2222`,
   `GIT_SSH_URL=ssh://git@git.papers.potentialhedge.com:2222`. Nothing on the host changes. Addresses need the
   `ssh://` form with the port, or a `Host` entry with `Port 2222` in `~/.ssh/config` for the short form. Some
   networks block ports other than 22 and 443.
2. **22 for git, the host's sshd moved** (to another port, or to Tailscale only, since we deploy over Tailscale
   anyway). `GIT_SSH_PUBLISH=22`, `GIT_SSH_URL=ssh://git@git.papers.potentialhedge.com`, and the short form
   `git@git.papers.potentialhedge.com:abs/1706.03762.git` works, as on GitHub. Risk: locking ourselves out while
   moving sshd; do it from a Tailscale session with the new port tested before the old one closes.
3. **22 on a second IPv4 address** for the git name only, if the provider sells one: GitHub's shape with no change to
   the host's sshd, at a monthly cost.

Starting on 2222 and moving to 22 later only changes `GIT_SSH_PUBLISH` and `GIT_SSH_URL`; the host key stays (a
client sees `[host]:2222` and `host` as different entries, and is asked once more, with the same fingerprint).
Whatever port: open it in the provider's firewall (Docker's published ports go around `ufw`). Docker keeps the
client's address on published ports (iptables, not the userland proxy), which the per-address limits rely on.

**Host key.** Made once, on the host, and kept: clients remember it, and a changed key makes every one of them
refuse to connect with a warning about an attack. Back the file up with `.env.production`.

```sh
mkdir -p secrets && ssh-keygen -t ed25519 -N '' -C git.papers.potentialhedge.com -f secrets/ssh_host_ed25519_key
ssh-keygen -lf secrets/ssh_host_ed25519_key.pub   # the fingerprint: put it in docs/git.md
```

The compose file mounts `secrets/ssh_host_ed25519_key` read-only at `/run/secrets/ssh_host_key`
(`GIT_SSH_HOST_KEY_FILE`); `GIT_SSH_HOST_KEY` with the key's text also works. The service logs the fingerprint it
serves at start (`dc logs ssh`). Check it from outside: `ssh -T -p 2222 git@git.papers.potentialhedge.com` prints
"Hi <handle>! You've authenticated, …" once a key is on your profile.

## User content

Demos and the web editor's webviews are served from `ppusercontent.com`, a domain of its own so they share no
site with the app (`src/lib/demos.ts`): each demo at `<snapshot>.ppusercontent.com`, each webview (the preview,
the PDF viewer) at `<uuid>.ppusercontent.com`. `proxy.ts` answers every subdomain: a demo's files on a demo's
host, VS Code's webview pages on any other, and a 404 for everything else. The domain itself serves only the plugin SDK (`/sdk/`).
Set up 2026-11-16, outside this repo:

- **Cloudflare zone** `ppusercontent.com` (account `c5c3512236b6994f91a383719eeb05be`, Free plan): proxied
  A records `*` and the apex (added 2026-11-17, for the SDK) → `77.244.248.196`, SSL Full (strict), Always Use HTTPS, TLS 1.2 minimum. Universal SSL
  covers `*.ppusercontent.com`, one level only, so names stay one label deep.
- **Origin certificate:** a Cloudflare Origin CA certificate for `ppusercontent.com` and `*.ppusercontent.com`
  (valid to 2041-11-12) in `~/proxy/certs/ppusercontent.com.{pem,key}`, loaded by Traefik from
  `~/proxy/certs/dynamic/ppusercontent-com.yml`. The key was made on this host and never left it.
- **Traefik:** the `-demos` router in `docker-compose.prod.yml` (`HostRegexp` on the domain and its subdomains).

To move to another domain: `NEXT_PUBLIC_CONTENT_ORIGIN` (built into the app, so a rebuild) and
`CONTENT_HOST_PATTERN` (Traefik) in `.env.production`, and the same three steps for the new zone.

Demo files are in R2, through the `R2_*` keys in `.env.production`: an account token limited to objects in
`papertrail-pdfs` (id `3b0d7789…`, minted 2026-11-07). Without the keys, attaching a demo fails rather than
storing it on the container's disk. A page's rendered HTML names its demos' addresses, so after moving the
domain run `dc run --rm tools npm run pages:rebuild`.

## Postgres 19

Production runs `postgres:19.0` since 2026-11-22, on the volume `pgdata19` mounted at `/var/lib/postgresql` (since
18 the image keeps data in `/var/lib/postgresql/<major>/docker`, so not `.../data`), with
`autovacuum_max_parallel_workers=2`. It started empty: the move was also the reset below. Postgres 16's volume,
`potentialpaper_pgdata`, is kept unmounted, and its last dump is `~/backups/potentialpaper/prod-pg16-20261122.dump`.
Remove both once nothing from them is missed.

Dev runs `postgres:19rc2` (`docker-compose.dev.yml`). Checked on dev: `max_locks_per_transaction` is 128 by default
now (enough), and nothing uses JIT (off by default now).

## When it goes wrong

Read `dc logs -f app`, fix the problem, commit and run the recipe again. If the database is beyond saving,
resetting it is fine for now. The last reset, on 2026-11-22:

1. Stop `app ingest worker ssh`; dump everything (`pg_dump -Fc`), and separately the data of `pdf_documents` and
   `lfs_objects`, which hold every stored PDF's address, size and ingest results (text, emails, cover). Nothing
   else in them points at other tables but `lfs_objects.account_id`.
2. Start Postgres on a new, empty volume (or `dc down -v`), run the recipe from `dc run --rm tools`, and
   `pg_restore --data-only --disable-triggers` those two tables; set `lfs_objects.account_id` to null.
3. Give the `openreview` bot a token (`bots:token`) and run the imports from `potentialpaper-tools` against
   `http://app:3000` on the compose network: `~/backups/potentialpaper/reimport-2026-11-22.sh` on this host does it
   all, as the user unit `pp-reimport` (log `reimport.log` next to it). PDFs in R2 are named by their SHA-256, so
   `attach-pdfs` attaches the ones R2 has without uploading them again, and the ingest has nothing to redo.
4. Restart the acceptodds map's copy with `--force` (`~/projects/potentialpaper-acceptodds-map`), since the site's
   signals went with the database, then `scripts/purge-edge-cache.sh`.
