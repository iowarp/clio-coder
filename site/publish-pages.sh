#!/usr/bin/env bash
set -euo pipefail

# Build the checked, committed site and commit it to the local gh-pages branch.
# This script never pushes. The branch holds only the built website, so
# publishing it exposes nothing else from the repository.
site_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(dirname -- "$site_dir")
branch=gh-pages

if ! git -C "$repo_dir" diff --quiet HEAD -- site scripts/install.sh scripts/install.ps1; then
  printf '%s\n' 'Commit all site and installer changes before publishing.' >&2
  exit 1
fi
if [[ -n $(git -C "$repo_dir" ls-files --others --exclude-standard -- site scripts) ]]; then
  printf '%s\n' 'Commit all site sources before publishing.' >&2
  exit 1
fi
revision=$(git -C "$repo_dir" rev-parse HEAD)
scratch=$(mktemp -d)
trap 'git -C "$repo_dir" worktree remove --force "$scratch/branch" 2>/dev/null || true; rm -rf -- "$scratch"' EXIT

node "$site_dir/deployment-check.mjs"
python3 "$site_dir/sync-docs.py" --check
node "$site_dir/build.mjs" --out "$scratch/public" --revision "$revision"
python3 "$site_dir/check.py" "$scratch/public"

if git -C "$repo_dir" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git -C "$repo_dir" fetch --quiet origin "$branch:refs/remotes/origin/$branch"
fi
if git -C "$repo_dir" show-ref --verify --quiet "refs/heads/$branch"; then
  # GitHub can commit to the published branch itself (a CNAME written when the
  # custom domain is set), so build on the remote tip when it is ahead, and stop
  # rather than produce a push that could only be forced.
  if git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    if git -C "$repo_dir" merge-base --is-ancestor "$branch" "origin/$branch"; then
      git -C "$repo_dir" update-ref "refs/heads/$branch" "refs/remotes/origin/$branch"
    elif ! git -C "$repo_dir" merge-base --is-ancestor "origin/$branch" "$branch"; then
      printf 'Local %s and origin/%s have diverged; reconcile them before publishing.\n' "$branch" "$branch" >&2
      exit 1
    fi
  fi
  git -C "$repo_dir" worktree add --quiet "$scratch/branch" "$branch"
elif git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  git -C "$repo_dir" worktree add --quiet -b "$branch" "$scratch/branch" "origin/$branch"
else
  git -C "$repo_dir" worktree add --quiet --orphan -b "$branch" "$scratch/branch"
fi
# Dotfiles other than .nojekyll are nginx and builder leftovers, not site content.
# --checksum: a changed file with the same size and an mtime in the same second
# as the checkout would otherwise be skipped and stay stale on the branch.
rsync -a --checksum --delete --exclude='/.git' --exclude='/.clio-coder-*' "$scratch/public/" "$scratch/branch/"
git -C "$scratch/branch" add -A
if git -C "$scratch/branch" diff --cached --quiet; then
  printf '%s\n' 'The published branch already matches this build.'
  exit 0
fi
git -C "$scratch/branch" commit --quiet -m "deploy: website from ${revision:0:12}"
printf 'Committed %s to %s. Review it, then push the branch when authorized.\n' "$(git -C "$repo_dir" rev-parse --short "$branch")" "$branch"
