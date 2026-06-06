#!/usr/bin/env bash
# Activate a marketplace skill by linking (or copying) it into a Clio runtime
# discovery root. This is the only bridge from skills/ (catalog) to runtime.
#
#   skills/install.sh <name> [--user|--project] [--copy] [--force]
#   skills/install.sh --all  [--user|--project] [--copy] [--force]
#
# Default: project scope, live symlink into <repo>/.clio/skills/<name>.
# --user : link into the Clio config skills dir (available in every project).
# --copy : materialize a frozen copy and stamp installed-at (for distribution).
# --force: replace an existing target.
#
# Only ever writes under .clio/skills or the Clio user config skills dir, both
# of which are gitignored / outside the repo.
set -euo pipefail

CATALOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CATALOG_DIR/.." && pwd)"

scope="project"
mode="link"
force="0"
names=()

for arg in "$@"; do
	case "$arg" in
		--user) scope="user" ;;
		--project) scope="project" ;;
		--copy) mode="copy" ;;
		--link) mode="link" ;;
		--force) force="1" ;;
		--all) names=("__ALL__") ;;
		-h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		--*) echo "install.sh: unknown flag $arg" >&2; exit 2 ;;
		*) names+=("$arg") ;;
	esac
done

if [ "${#names[@]}" -eq 0 ]; then
	echo "install.sh: name required (or --all). Try --help." >&2
	exit 2
fi

# Mirror src/core/xdg.ts so install targets match Clio's discovery roots.
resolve_user_skills_dir() {
	if [ -n "${CLIO_HOME:-}" ]; then echo "$CLIO_HOME/skills"; return; fi
	if [ -n "${CLIO_CONFIG_DIR:-}" ]; then echo "$CLIO_CONFIG_DIR/skills"; return; fi
	case "$(uname -s)" in
		Darwin) echo "$HOME/Library/Application Support/clio/skills" ;;
		*) echo "${XDG_CONFIG_HOME:-$HOME/.config}/clio/skills" ;;
	esac
}

if [ "$scope" = "user" ]; then
	TARGET_ROOT="$(resolve_user_skills_dir)"
else
	TARGET_ROOT="$REPO_ROOT/.clio/skills"
fi
mkdir -p "$TARGET_ROOT"

install_one() {
	local name="$1"
	local src="$CATALOG_DIR/$name"
	local dst="$TARGET_ROOT/$name"
	if [ ! -f "$src/SKILL.md" ]; then
		echo "install.sh: no skill named '$name' in catalog" >&2
		return 1
	fi
	if [ -e "$dst" ] || [ -L "$dst" ]; then
		if [ "$force" != "1" ]; then
			echo "skip $name: $dst exists (use --force to replace)"
			return 0
		fi
		rm -rf "$dst"
	fi
	if [ "$mode" = "copy" ]; then
		cp -R "$src" "$dst"
		local ts
		ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		if ! grep -q '^installed-at:' "$dst/SKILL.md"; then
			awk -v ts="$ts" 'NR==1 && $0=="---"{print; print "installed-at: " ts; next} {print}' \
				"$dst/SKILL.md" >"$dst/SKILL.md.tmp" && mv "$dst/SKILL.md.tmp" "$dst/SKILL.md"
		fi
		echo "copied $name -> $dst (installed-at $ts)"
	else
		ln -s "$src" "$dst"
		echo "linked $name -> $dst"
	fi
}

targets=()
if [ "${names[0]}" = "__ALL__" ]; then
	for d in "$CATALOG_DIR"/*/; do
		[ -f "$d/SKILL.md" ] && targets+=("$(basename "$d")")
	done
else
	targets=("${names[@]}")
fi

rc=0
for n in "${targets[@]}"; do
	install_one "$n" || rc=1
done

echo "---"
echo "scope=$scope mode=$mode root=$TARGET_ROOT"
echo "verify: clio skills list   (or: clio skills inspect <name>)"
exit "$rc"
