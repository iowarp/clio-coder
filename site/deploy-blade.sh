#!/usr/bin/env bash
set -euo pipefail

# Publish only this Compose project. DNS and tunnel routing are managed separately.
site_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
clio_site_scratch=$(mktemp -d)
trap 'rm -rf -- "$clio_site_scratch"' EXIT

node "$site_dir/build.mjs" --out "$clio_site_scratch/public"
python3 "$site_dir/check.py" "$clio_site_scratch/public"
ssh -o BatchMode=yes -o ConnectTimeout=8 blade 'mkdir -p ~/webhosting/clio-coder-site'
rsync -az --delete --exclude=public/ --exclude=source.tar.gz --exclude="*.bak" "$site_dir/" blade:webhosting/clio-coder-site/
ssh -o BatchMode=yes -o ConnectTimeout=8 blade '
  set -e
  cd ~/webhosting/clio-coder-site
  docker compose -f compose.yml -f compose.blade.yml config --quiet
  docker compose -f compose.yml -f compose.blade.yml build --quiet site
  docker compose -f compose.yml -f compose.blade.yml up -d --wait --wait-timeout 60 site
  docker exec clio-coder-site nginx -t
  curl --fail --silent --show-error -H "Host: coder.iowarp.ai" -o /dev/null -w "Clio Coder origin HTTP %{http_code}\n" http://127.0.0.1/
'
