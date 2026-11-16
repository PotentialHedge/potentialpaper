# Deploying

**The site is not in production yet.** papers.potentialhedge.com has no real users, so downtime, a failed
deploy or a reset database costs nothing. Deploy straight from `main` on this host, with no staging step, no
maintenance window and no rollback plan. Just fix forward. This changes once the owner says we have launched.

## Recipe

Run from the repo root on this host, with `main` checked out and committed (the image is tagged with HEAD's
commit, so uncommitted changes would ship under the wrong name):

```sh
git checkout main && git pull --ff-only
export GIT_COMMIT=$(git rev-parse --short HEAD)
dc() { docker compose -f docker-compose.prod.yml --env-file .env.production "$@"; }

dc --profile tools build          # app and tools images; without --profile tools, migrations go stale
dc up -d postgres
dc run --rm tools                 # migrations (npm run db:migrate)
dc up -d app
dc --profile tools up -d ingest ssh  # the PDF ingest pipeline and git over SSH, on the new image
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
host, VS Code's webview pages on any other, and a 404 for everything else; nothing is served at the domain itself.
Set up 2026-11-16, outside this repo:

- **Cloudflare zone** `ppusercontent.com` (account `c5c3512236b6994f91a383719eeb05be`, Free plan): a proxied
  wildcard A record `*` → `77.244.248.196`, SSL Full (strict), Always Use HTTPS, TLS 1.2 minimum. Universal SSL
  covers `*.ppusercontent.com`, one level only, so names stay one label deep.
- **Origin certificate:** a Cloudflare Origin CA certificate for `ppusercontent.com` and `*.ppusercontent.com`
  (valid to 2041-11-12) in `~/proxy/certs/ppusercontent.com.{pem,key}`, loaded by Traefik from
  `~/proxy/certs/dynamic/ppusercontent-com.yml`. The key was made on this host and never left it.
- **Traefik:** the `-demos` router in `docker-compose.prod.yml` (`HostRegexp` on the domain's subdomains).

To move to another domain: `NEXT_PUBLIC_CONTENT_ORIGIN` (built into the app, so a rebuild) and
`CONTENT_HOST_PATTERN` (Traefik) in `.env.production`, and the same three steps for the new zone.

Demo files are in R2, through the `R2_*` keys in `.env.production`: an account token limited to objects in
`papertrail-pdfs` (id `3b0d7789…`, minted 2026-11-07). Without the keys, attaching a demo fails rather than
storing it on the container's disk. A page's rendered HTML names its demos' addresses, so after moving the
domain run `dc run --rm tools npm run pages:rebuild`.

## When it goes wrong

Read `dc logs -f app`, fix the problem, commit and run the recipe again. If the database is beyond saving,
resetting it is fine for now: `dc down -v` deletes the volume, and the next `up` and migrate start fresh. You'd
have to re-import papers afterwards (the `papers:*` scripts in `package.json`). The last reset, on
2026-11-07, was scripted in `~/backups/reimport.sh` on this host: it mounts the scrapes into the tools
container and runs the imports in order.
