#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

usage() {
	cat <<'USAGE'
Usage: scripts/install-local.sh [--skip-deps] [--no-build] [--dry-run] [--force]

Install Clio Coder from this source checkout by placing a deterministic symlink at:
  ${CLIO_BIN_DIR:-$HOME/.local/bin}/clio
After linking, the script runs the installed CLI's structure repair
(node dist/cli/index.js doctor --fix) so a fresh install passes plain clio doctor.

Options:
  --skip-deps    Do not run npm ci, even if node_modules looks stale or missing.
  --no-build     Do not run npm run build; require an existing dist/cli/index.js.
  --dry-run      Print planned actions without changing files.
  --force        Replace an existing clio symlink even if it points outside this repo.
  -h, --help     Show this help.
USAGE
}

log() { printf '[install-local] %s\n' "$*"; }
ok() { printf '[install-local] ok: %s\n' "$*"; }
warn() { printf '[install-local] warning: %s\n' "$*" >&2; }
fail() { printf '[install-local] error: %s\n' "$*" >&2; exit 1; }

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

expand_tilde() {
	case "$1" in
		"~") printf '%s\n' "$HOME" ;;
		"~/"*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
		*) printf '%s\n' "$1" ;;
	esac
}

normalize_path() {
	node - "$1" <<'NODE'
const path = require("node:path");
console.log(path.resolve(process.argv[2]));
NODE
}

path_is_under_repo() {
	local candidate normalized_repo
	candidate="$(normalize_path "$1")"
	normalized_repo="$(normalize_path "$repo_root")"
	[[ "$candidate" == "$normalized_repo" || "$candidate" == "$normalized_repo"/* ]]
}

path_contains_dir() {
	local wanted entry normalized_entry
	wanted="$(normalize_path "$1")"
	IFS=':' read -r -a path_entries <<< "${PATH:-}"
	for entry in "${path_entries[@]}"; do
		[[ -z "$entry" ]] && continue
		normalized_entry="$(normalize_path "$entry")"
		[[ "$normalized_entry" == "$wanted" ]] && return 0
	done
	return 1
}

verify_node_engine() {
	node - <<'NODE'
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const range = String(pkg.engines?.node ?? "").trim();
const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range);
if (!match) {
	console.error(`[install-local] error: unsupported package engines.node range: ${range || "<missing>"}`);
	process.exit(1);
}
const required = match.slice(1).map(Number);
const current = process.versions.node.split(".").map(Number);
const ok = current[0] > required[0]
	|| (current[0] === required[0] && current[1] > required[1])
	|| (current[0] === required[0] && current[1] === required[1] && current[2] >= required[2]);
if (!ok) {
	console.error(`[install-local] error: Node ${process.version} does not satisfy ${range}`);
	process.exit(1);
}
console.log(`[install-local] ok: Node ${process.version} satisfies ${range}`);
NODE
}

deps_are_acceptable() {
	[[ -d node_modules && -f package-lock.json && -f node_modules/.package-lock.json ]] || return 1
	npm ls --depth=0 --silent >/dev/null 2>&1
}

print_next_steps() {
	cat <<'NEXT'

Next: configure a model target, then start Clio:
  clio configure --id <id> --runtime <runtime> --url <url> --model <model> --set-orchestrator --set-fleet-default
  clio

If this shell still tries an old clio path, run `hash -r` (Bash) or `rehash` (Zsh), then try again.
NEXT
}

skip_deps=0
no_build=0
dry_run=0
force=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--skip-deps) skip_deps=1 ;;
		--no-build) no_build=1 ;;
		--dry-run) dry_run=1 ;;
		--force|-f) force=1 ;;
		--help|-h) usage; exit 0 ;;
		*) fail "unknown option: $1" ;;
	esac
	shift
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
cd "$repo_root"

need_cmd node
need_cmd npm
verify_node_engine

bin_dir="$(expand_tilde "${CLIO_BIN_DIR:-$HOME/.local/bin}")"
cli_target="$repo_root/dist/cli/index.js"
link_path="$bin_dir/clio"

log "source root: $repo_root"
log "bin dir:     $bin_dir"
log "link path:   $link_path"
log "target:      $cli_target"

if [[ $dry_run -eq 1 ]]; then
	log "dry run: no files will be changed"
fi

if [[ $skip_deps -eq 1 ]]; then
	log "skipping dependency install (--skip-deps)"
elif deps_are_acceptable; then
	ok "node_modules satisfies package-lock according to npm ls"
else
	if [[ $dry_run -eq 1 ]]; then
		log "would run: npm ci"
	else
		log "running: npm ci"
		npm ci
	fi
fi

if [[ $no_build -eq 1 ]]; then
	log "skipping build (--no-build)"
else
	if [[ $dry_run -eq 1 ]]; then
		log "would run: npm run build"
	else
		log "running: npm run build"
		npm run build
	fi
fi

if [[ $dry_run -eq 0 ]]; then
	[[ -f "$cli_target" ]] || fail "missing built CLI: $cli_target (run npm run build or omit --no-build)"
	chmod +x "$cli_target"
	[[ -x "$cli_target" ]] || fail "built CLI is not executable: $cli_target"
	mkdir -p "$bin_dir"
else
	log "would verify executable: $cli_target"
	log "would create bin dir if needed: $bin_dir"
fi

if [[ -e "$link_path" || -L "$link_path" ]]; then
	if [[ -L "$link_path" ]]; then
		raw_target="$(readlink "$link_path")"
		if [[ "$raw_target" = /* ]]; then
			existing_target="$(normalize_path "$raw_target")"
		else
			existing_target="$(normalize_path "$bin_dir/$raw_target")"
		fi
		current_target="$(normalize_path "$cli_target")"
		if [[ "$existing_target" == "$current_target" ]]; then
			ok "existing clio symlink already points at this checkout"
		elif path_is_under_repo "$existing_target"; then
			log "existing clio symlink points inside this repo; it will be replaced"
		elif [[ $force -eq 1 ]]; then
			warn "replacing clio symlink that points outside this repo: $existing_target"
		else
			fail "refusing to replace $link_path; it points to $existing_target (use --force if this is intentional)"
		fi
	else
		fail "refusing to overwrite non-symlink at $link_path"
	fi
fi

if [[ $dry_run -eq 1 ]]; then
	log "would link: $link_path -> $cli_target"
else
	ln -sfn "$cli_target" "$link_path"
	ok "linked $link_path -> $cli_target"
	version_output="$($link_path --version 2>/dev/null || true)"
	if [[ -n "$version_output" ]]; then
		ok "$version_output"
	else
		warn "installed link did not return a version; run: $link_path --version"
	fi
fi

if path_contains_dir "$bin_dir"; then
	ok "$bin_dir is on PATH"
else
	warn "$bin_dir is not on PATH"
	printf '[install-local] add it for this shell with:\n  export PATH="%s:$PATH"\n' "$bin_dir" >&2
fi

if [[ $dry_run -eq 1 ]]; then
	log "would run: node $cli_target doctor --fix"
	ok "dry run complete"
	print_next_steps
	exit 0
fi

log "running: node $cli_target doctor --fix"
node "$cli_target" doctor --fix || fail "doctor --fix could not bring the install to green; inspect the output above"

print_next_steps
