#!/usr/bin/env bash
#
# Install Clio-Coder git hooks into the current clone.
#
# Copies (not symlinks) scripts/git-hooks/* into the repo's hooks directory so
# the hook works across worktrees and survives `git gc`. Re-run this script to
# refresh the hooks after a pull.
#
# Invoked by: `npm run hooks:install`
#

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
hooks_src="$repo_root/scripts/git-hooks"
hooks_dst="$(git -C "$repo_root" rev-parse --git-path hooks)"

if [ ! -d "$hooks_src" ]; then
  echo "install-hooks: missing $hooks_src" >&2
  exit 1
fi

mkdir -p "$hooks_dst"

installed=()
for src in "$hooks_src"/*; do
  [ -f "$src" ] || continue
  name="$(basename "$src")"
  dst="$hooks_dst/$name"
  cp "$src" "$dst"
  chmod +x "$dst"
  installed+=("$name")
done

if [ "${#installed[@]}" -eq 0 ]; then
  echo "install-hooks: no hooks found in $hooks_src" >&2
  exit 1
fi

echo "install-hooks: installed ${installed[*]} into $hooks_dst"
echo "install-hooks: uninstall with 'rm $hooks_dst/${installed[0]}'"
