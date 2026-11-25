#!/usr/bin/env bash
# Deploys HEAD to production with no gap in service, as acceptodds does (DEPLOY.md, "Recipe").
#
# Builds the images and runs the migrations while the old app still serves, so a migration must keep the running
# code working (add, don't rename or drop in the same deploy). Then starts a new app container beside the old one,
# waits until Docker calls it healthy and Traefik routes to it, and only then stops and removes the old one: plain
# `up -d app` would recreate it in place, leaving Traefik nothing to route to until the new one passes its check.
# The background services (ingest, worker, ssh) are recreated on the new image after, and the edge cache purged.
#
# Run it from a clean worktree of the commit, with `.env.production` copied in. SKIP_BUILD=1 swaps to images already
# built for HEAD (or for $GIT_COMMIT, set by hand, to roll back). STAGING=1 deploys staging the same way, with
# `.env.staging`, no dump and no edge-cache purge (DEPLOY.md, "Staging").
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${STAGING:-}" ]]; then
  project=potentialpaper-staging
  env_file=.env.staging
  compose() {
    docker compose -p $project -f docker-compose.prod.yml -f docker-compose.staging.yml --env-file $env_file "$@"
  }
  SKIP_DUMP=1
else
  project=potentialpaper
  env_file=.env.production
  compose() { docker compose -f docker-compose.prod.yml --env-file $env_file "$@"; }
fi
TRAEFIK_SERVICE=http://127.0.0.1:8080/api/http/services/$project@docker

test -f $env_file || { echo "copy $env_file here first" >&2; exit 1; }
if [[ -z "${GIT_COMMIT:-}" ]]; then
  test -z "$(git status --porcelain)" || { echo "commit first: the image is tagged with HEAD" >&2; exit 1; }
  GIT_COMMIT=$(git rev-parse --short HEAD)
fi
export GIT_COMMIT
echo "deploying $GIT_COMMIT"

if [[ -z "${SKIP_BUILD:-}" ]]; then
  compose --profile tools build
fi
compose up -d postgres
# A dump before migrating (DEPLOY.md), the newest three kept. SKIP_DUMP=1 when the deploy has no migration.
if [[ -z "${SKIP_DUMP:-}" ]]; then
  dump=~/backups/potentialpaper-$(date +%F-%H%M).dump
  echo "dumping the database to $dump"
  docker exec potentialpaper-postgres-1 pg_dump -U potentialpaper -Fc potentialpaper > "$dump.part"
  mv "$dump.part" "$dump"
  ls -t ~/backups/potentialpaper-*.dump | tail -n +4 | xargs -r rm --
fi
compose --profile tools run --rm tools

old=$(compose ps -q app)
count=$(echo "$old" | grep -c . || true)
echo "old app containers: $count"

compose up -d --no-deps --no-recreate --scale app=$(( count + 1 )) app
new=$(comm -13 <(echo "$old" | sort) <(compose ps -q app | sort))
[[ -n "$new" ]] || { echo "no new app container started" >&2; exit 1; }

ips=()
for id in $new; do
  status=starting
  for _ in $(seq 1 90); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$id")
    [[ $status == healthy ]] && break
    [[ $status == unhealthy ]] && break
    sleep 2
  done
  if [[ $status != healthy ]]; then
    echo "$id is $status; removing it, the old container keeps serving" >&2
    docker logs --tail 30 "$id" >&2 || true
    docker rm -f "$id" >/dev/null
    exit 1
  fi
  ips+=("$(docker inspect -f '{{(index .NetworkSettings.Networks "web").IPAddress}}' "$id")")
done

missing=1
for _ in $(seq 1 30); do
  up=$(curl -s "$TRAEFIK_SERVICE" | python3 -c '
import json, sys
status = json.load(sys.stdin).get("serverStatus", {})
print(" ".join(u for u, s in status.items() if s == "UP"))' || true)
  missing=0
  for ip in "${ips[@]}"; do [[ " $up " == *" http://$ip:3000 "* ]] || missing=1; done
  [[ $missing == 0 ]] && break
  sleep 1
done
if [[ $missing != 0 ]]; then
  echo "Traefik does not route to the new container; removing it, the old one keeps serving" >&2
  docker rm -f $new >/dev/null
  exit 1
fi

if [[ -n "$old" ]]; then
  # Drain first: the old containers' /healthz answers 503, Traefik's own check (every 2 s) stops routing to them,
  # and the requests they have get a few seconds to finish. Stopping one Traefik still routes to fails a request.
  old_ips=()
  for id in $old; do
    docker exec "$id" touch /tmp/draining
    old_ips+=("$(docker inspect -f '{{(index .NetworkSettings.Networks "web").IPAddress}}' "$id")")
  done
  for _ in $(seq 1 30); do
    up=$(curl -s "$TRAEFIK_SERVICE" | python3 -c '
import json, sys
status = json.load(sys.stdin).get("serverStatus", {})
print(" ".join(u for u, s in status.items() if s == "UP"))' || true)
    routed=0
    for ip in "${old_ips[@]}"; do [[ " $up " == *" http://$ip:3000 "* ]] && routed=1; done
    [[ $routed == 0 ]] && break
    sleep 1
  done
  [[ $routed == 0 ]] || echo "Traefik still routes to an old container after 30 s; stopping it anyway" >&2
  sleep 5
  docker stop -t 30 $old >/dev/null
  docker rm $old >/dev/null
fi

if [[ -n "${STAGING:-}" ]]; then
  compose --profile tools up -d --no-deps worker
else
  compose --profile tools up -d --no-deps ingest worker ssh
  scripts/purge-edge-cache.sh
fi
echo "live: $(compose ps --format '{{.Name}} {{.Image}} {{.Status}}' app)"
