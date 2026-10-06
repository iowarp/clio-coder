#!/usr/bin/env bash
set -euo pipefail

# Deploy a checked, committed website snapshot without cutting a product release.
site_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(dirname -- "$site_dir")
clio_site_scratch=$(mktemp -d)
trap 'rm -rf -- "$clio_site_scratch"' EXIT

git -C "$repo_dir" diff --exit-code HEAD -- site
if [[ -n $(git -C "$repo_dir" ls-files --others --exclude-standard -- site) ]]; then
  printf '%s\n' 'Commit all site sources before deployment.' >&2
  exit 1
fi
clio_site_revision=$(git -C "$repo_dir" rev-parse HEAD)
node "$site_dir/deployment-check.mjs"
python3 "$site_dir/sync-docs.py" --check
git -C "$repo_dir" archive --format=tar "$clio_site_revision" site | tar -xf - -C "$clio_site_scratch"
mkdir -p "$clio_site_scratch/site/installer-assets"
for name in install.sh install.ps1 install.cmd; do
  source="scripts/installer-bootstrap/$name"
  if [[ "$name" == install.cmd ]]; then source="scripts/$name"; fi
  git -C "$repo_dir" show "$clio_site_revision:$source" > "$clio_site_scratch/site/installer-assets/$name"
done
node "$clio_site_scratch/site/build.mjs" --out "$clio_site_scratch/public" --revision "$clio_site_revision"
python3 "$clio_site_scratch/site/check.py" "$clio_site_scratch/public"

# Save source and the running image before replacing this one Compose service.
ssh -o BatchMode=yes -o ConnectTimeout=8 blade bash -s -- "$clio_site_revision" <<'REMOTE'
set -euo pipefail
revision=$1
project="$HOME/webhosting/clio-coder-site"
backup="$HOME/webhosting/clio-coder-site-backups/$revision"
mkdir -p "$project" "$backup"
if docker inspect clio-coder-site >/dev/null 2>&1; then
  running_image=$(docker inspect --format '{{.Image}}' clio-coder-site)
  rollback_tag="clio-coder-site:rollback-$revision"
  if docker image inspect "$running_image" >/dev/null 2>&1; then
    docker image tag "$running_image" "$rollback_tag"
  else
    # Image pruning can remove the record while the container still serves its
    # immutable filesystem. Capture that filesystem without pausing the site.
    docker commit --no-pause clio-coder-site "$rollback_tag" >/dev/null
  fi
  docker image inspect --format '{{.Id}}' "$rollback_tag" > "$backup/image-id"
fi
tar -czf "$backup/source.tar.gz" -C "$project" .
REMOTE
rsync -az --delete "$clio_site_scratch/site/" blade:webhosting/clio-coder-site/
ssh -o BatchMode=yes -o ConnectTimeout=8 blade bash -s -- "$clio_site_revision" <<'REMOTE'
set -euo pipefail
revision=$1
project="$HOME/webhosting/clio-coder-site"
backup="$HOME/webhosting/clio-coder-site-backups/$revision"
cd "$project"
export CLIO_SITE_REVISION="$revision"
compose=(docker compose -f compose.yml -f compose.blade.yml)
rollback() {
  trap - ERR
  printf '%s\n' 'Website verification failed; restoring the previous site.' >&2
  if [[ -f "$backup/image-id" ]]; then
    tar -xzf "$backup/source.tar.gz" -C "$project"
    docker image tag "$(cat "$backup/image-id")" clio-coder-site:local
    "${compose[@]}" up -d --no-build --wait --wait-timeout 60 site
  fi
  exit 1
}
trap rollback ERR
"${compose[@]}" config --quiet
"${compose[@]}" build --quiet site
# Validate the new configuration while the previous website is still running.
docker run --rm --entrypoint nginx clio-coder-site:local -t
"${compose[@]}" up -d --no-build --wait --wait-timeout 60 site
docker exec clio-coder-site nginx -t
curl --fail --silent --show-error -H 'Host: coder.iowarp.ai' -o /dev/null -w 'Clio Coder origin HTTP %{http_code}\n' http://127.0.0.1:8096/
curl --fail --silent --show-error -I http://127.0.0.1:8096/ | tr -d '\r' | grep -F "X-Clio-Site-Revision: $revision"
printf 'Deployed website commit %s; rollback retained at %s\n' "$revision" "$backup"
REMOTE
