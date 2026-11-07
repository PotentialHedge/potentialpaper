#!/usr/bin/env bash
# Empties Cloudflare's cache of this site's host, which leaves the rest of the zone alone. Run after a deploy.
set -euo pipefail
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  # The env file reads the variable before setting it, which `set -u` would stop.
  set +u
  # shellcheck source=/dev/null
  source ~/.config/cloudflare/env
  set -u
fi
: "${CLOUDFLARE_API_TOKEN:?no Cloudflare token: see ~/.config/cloudflare/env}"
host=${1:-papers.potentialhedge.com}
zone=${CLOUDFLARE_ZONE_ID:-b55a62f4aca6fc00040b49f67641d6de}
response=$(curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$zone/purge_cache" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
  --data "{\"hosts\":[\"$host\"]}")
if ! grep -q '"success":true' <<<"$response"; then
  echo "purge failed: $response" >&2
  exit 1
fi
echo "purged $host"
