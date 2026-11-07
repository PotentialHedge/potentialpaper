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
scripts/purge-edge-cache.sh       # required, see below
```

Check it: `docker inspect potentialpaper-app-1 --format '{{.Config.Image}}'` names the new commit, and
https://papers.potentialhedge.com loads.

## Why each step is there

- **Migrations run as their own step**, never at app start. `dc run --rm tools npm run <script>` runs any
  other script against production the same way.
- **The edge-cache purge is not optional.** Cloudflare caches whole pages. They name the old build's scripts,
  which the new container no longer serves, so cached pages break until the cache is purged.

## Demos

Demos are served from `papers-content.potentialhedge.com`: a proxied A record (added 2026-11-07) in the `potentialhedge.com` zone,
pointing at this host, with the Traefik router in `docker-compose.prod.yml`. `.env.production` needs the `R2_*`
keys (see `.env.production.example`), or attaching a demo fails, rather than storing it on the container's
disk, which the next deploy would wipe.

## When it goes wrong

Read `dc logs -f app`, fix the problem, commit and run the recipe again. If the database is beyond saving,
resetting it is fine for now: `dc down -v` deletes the volume, and the next `up` and migrate start fresh. You'd
have to re-import papers afterwards (the `papers:*` scripts in `package.json`). The last reset, on
2026-11-07, was scripted in `~/backups/reimport.sh` on this host: it mounts the scrapes into the tools
container and runs the imports in order.
