#!/usr/bin/env bash
# Clio Coder bootstrap installer: npm-backed, no sudo, no shell profile edits.
#
#   curl -fsSL https://raw.githubusercontent.com/iowarp/clio-coder/main/scripts/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --version 0.4.7 --prefix "$HOME/.local"
#
# npm remains the package authority: this script only picks a user-writable
# prefix, validates the prerequisites, runs one `npm install -g`, and prints
# the launcher path with the next commands. Source checkouts use
# scripts/install-local.sh instead.
#
# The whole body lives in main() and is invoked on the last line, so a
# truncated download parses as an incomplete function and runs nothing.
set -Eeuo pipefail

PACKAGE="@iowarp/clio-coder"
# Mirrors package.json engines.node; tests/contracts/install-script.test.ts
# keeps the two in sync.
NODE_MIN="22.19.0"
DEFAULT_PREFIX="$HOME/.local"

usage() {
	cat <<'USAGE'
Usage: install.sh [--version <latest|tag|X.Y.Z|vX.Y.Z>] [--prefix <dir>] [--omit-optional] [--force] [--dry-run]

Install Clio Coder from npm into a user-writable prefix without sudo.

Options:
  --version <spec>   Package version: latest (default), an npm dist-tag such as
                     next, or an exact version such as 0.4.7 or v0.4.7.
                     Also read from CLIO_CODER_VERSION.
  --prefix <dir>     npm prefix; the launcher lands in <dir>/bin/clio-coder.
                     Default: $HOME/.local. Also read from CLIO_CODER_NPM_PREFIX.
                     To reuse npm's own global prefix: --prefix "$(npm prefix -g)"
  --omit-optional    Skip the optional Claude Agent SDK (large platform binary).
  --force            Replace a clio-coder symlink at <prefix>/bin that points
                     outside this npm install (a source-checkout launcher, say).
                     A regular file there is never replaced.
  --dry-run          Print the plan and the exact npm command; change nothing.
  -h, --help         Show this help.

The installer never edits shell startup files and never touches existing Clio
projects or credentials. It runs Clio’s own post-install migrations. Remove the package later with:
  npm uninstall -g --prefix <dir> @iowarp/clio-coder
USAGE
}

log() { printf '[install] %s\n' "$*"; }
ok() { printf '[install] ok: %s\n' "$*"; }
warn() { printf '[install] warning: %s\n' "$*" >&2; }
fail() { printf '[install] error: %s\n' "$*" >&2; exit 1; }

expand_tilde() {
	case "$1" in
		"~") printf '%s\n' "$HOME" ;;
		"~/"*) printf '%s/%s\n' "$HOME" "${1#"~/"}" ;;
		*) printf '%s\n' "$1" ;;
	esac
}

# Absolute path with `.`/`..` and the directory part's symlinks resolved. Pure
# shell so it works before Node is known to exist and on macOS without
# `readlink -f`. The final component is left as is (it may not exist yet).
absolute_path() {
	local dir base
	case "$1" in
		/*) dir="$(dirname "$1")" ;;
		*) dir="$PWD/$(dirname "$1")" ;;
	esac
	base="$(basename "$1")"
	if [[ -d "$dir" ]]; then
		dir="$(cd "$dir" && pwd -P)"
	fi
	if [[ "$base" == "." ]]; then
		printf '%s\n' "$dir"
	else
		printf '%s/%s\n' "${dir%/}" "$base"
	fi
}

# Every symlink resolved, or nothing when the chain dangles.
resolve_path() {
	local current="$1" target hops=0
	while [[ -L "$current" ]]; do
		target="$(readlink "$current")" || return 1
		case "$target" in
			/*) current="$target" ;;
			*) current="$(dirname "$current")/$target" ;;
		esac
		hops=$((hops + 1))
		[[ $hops -gt 40 ]] && return 1
	done
	[[ -e "$current" ]] || return 1
	if [[ -d "$current" ]]; then
		(cd "$current" && pwd -P)
	else
		printf '%s/%s\n' "$(cd "$(dirname "$current")" && pwd -P)" "$(basename "$current")"
	fi
}

# Exact semver, or an npm dist-tag. Everything else is refused before it can
# reach npm: a spec like `npm:evil@1`, `>=1`, `../x`, `file:...`, or a value
# with whitespace would either install a different package or be parsed as a
# range or URL. A leading `v` is accepted and stripped because git tags carry it.
validate_version() {
	local spec="$1"
	case "$spec" in
		v[0-9]*) spec="${spec#v}" ;;
	esac
	if [[ "$spec" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
		printf '%s\n' "$spec"
		return 0
	fi
	if [[ "$spec" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
		printf '%s\n' "$spec"
		return 0
	fi
	fail "invalid --version '$1'; use latest, a dist-tag such as next, or an exact version such as 0.4.7"
}

node_version_ok() {
	local have="$1" IFS=.
	local -a h=() m=()
	read -r -a h <<<"$have"
	read -r -a m <<<"$NODE_MIN"
	local i
	for i in 0 1 2; do
		local hv="${h[$i]:-0}" mv="${m[$i]:-0}"
		[[ "$hv" =~ ^[0-9]+$ ]] || return 1
		((10#$hv > 10#$mv)) && return 0
		((10#$hv < 10#$mv)) && return 1
	done
	return 0
}

check_prerequisites() {
	case "$(uname -s 2>/dev/null || true)" in
		MINGW*|MSYS*|CYGWIN*)
			fail "this installer targets Linux and macOS; on Windows run: npm install -g $PACKAGE"
			;;
	esac
	command -v node >/dev/null 2>&1 \
		|| fail "Node.js was not found on PATH. Install Node $NODE_MIN or newer from https://nodejs.org (or with nvm/fnm), then rerun this installer."
	local raw
	raw="$(node --version 2>/dev/null </dev/null || true)"
	local have="${raw#v}"
	[[ -n "$have" ]] || fail "node --version printed nothing; the node on PATH ($(command -v node)) looks broken"
	node_version_ok "$have" \
		|| fail "Node $raw is too old; Clio Coder needs >=$NODE_MIN. Upgrade Node (https://nodejs.org, nvm, or fnm) and rerun."
	ok "Node $raw satisfies >=$NODE_MIN"
	command -v npm >/dev/null 2>&1 \
		|| fail "npm was not found on PATH even though node is at $(command -v node). Install Node from https://nodejs.org (it bundles npm) or run: corepack enable npm"
	ok "npm $(npm --version 2>/dev/null </dev/null || echo '?') at $(command -v npm)"
}

# Whether the launcher already at $launcher belongs to this npm install, so a
# reinstall or version change is allowed to replace it.
launcher_owned_by_install() {
	local resolved resolved_package_dir
	resolved="$(resolve_path "$launcher" 2>/dev/null || true)"
	resolved_package_dir="$(resolve_path "$package_dir" 2>/dev/null || true)"
	[[ -n "$resolved" && -n "$resolved_package_dir" && "$resolved" == "$resolved_package_dir"/* ]]
}

check_existing_launcher() {
	[[ -e "$launcher" || -L "$launcher" ]] || return 0
	if [[ -L "$launcher" ]]; then
		if launcher_owned_by_install; then
			log "existing $launcher belongs to this npm prefix; npm will refresh it"
			return 0
		fi
		local existing_target
		existing_target="$(resolve_path "$launcher" 2>/dev/null || readlink "$launcher")"
		if [[ $force -eq 1 ]]; then
			warn "replacing clio-coder symlink that points outside this install: $launcher -> $existing_target"
			if [[ $dry_run -ne 1 ]]; then
				previous_link="$(readlink "$launcher")"
				rm -f "$launcher"
			fi
			return 0
		fi
		fail "refusing to replace $launcher; it points to $existing_target (a source-checkout launcher, perhaps). Rerun with --force to replace it, or choose another --prefix."
	fi
	fail "refusing to overwrite the non-symlink file at $launcher; move it aside or choose another --prefix"
}

check_prefix_writable() {
	local probe="$prefix"
	while [[ ! -e "$probe" ]]; do
		probe="$(dirname "$probe")"
	done
	[[ -d "$probe" ]] || fail "prefix parent $probe is not a directory"
	[[ -w "$probe" ]] || fail "$probe is not writable by $(id -un 2>/dev/null || echo "this user"); this installer never uses sudo. Pick a user-writable --prefix such as $DEFAULT_PREFIX."
}

path_contains_dir() {
	local wanted entry
	wanted="$(resolve_path "$1" 2>/dev/null || printf '%s\n' "$1")"
	local -a entries=()
	IFS=':' read -r -a entries <<<"${PATH:-}"
	for entry in "${entries[@]}"; do
		[[ -z "$entry" ]] && continue
		[[ -d "$entry" ]] || continue
		[[ "$(cd "$entry" && pwd -P)" == "$wanted" ]] && return 0
	done
	return 1
}

warn_about_shadowing_clio() {
	local path_clio resolved_path_clio resolved_launcher
	path_clio="$(command -v clio-coder 2>/dev/null || true)"
	[[ -z "$path_clio" ]] && return 0
	[[ "$path_clio" == "$launcher" ]] && return 0
	resolved_path_clio="$(resolve_path "$path_clio" 2>/dev/null || true)"
	resolved_launcher="$(resolve_path "$launcher" 2>/dev/null || true)"
	[[ -n "$resolved_path_clio" && "$resolved_path_clio" == "$resolved_launcher" ]] && return 0
	warn "another clio-coder is on your PATH at $path_clio"
	warn "it shadows the launcher this install writes at $launcher"
	warn "check it with: $path_clio --version"
	warn "remove that install or put $bin_dir earlier on PATH, then run: hash -r"
}

report_path() {
	if path_contains_dir "$bin_dir"; then
		ok "$bin_dir is on PATH"
	else
		warn "$bin_dir is not on PATH; this installer does not edit shell startup files"
		printf '[install] add it for this shell (and to your shell profile if you want it to stick):\n  export PATH=%q:"$PATH"\n' "$bin_dir" >&2
	fi
}

run_post_install() {
	local help
	help="$("$launcher" --help 2>/dev/null </dev/null || true)"
	if ! grep -Eq '^ *clio-coder upgrade' <<<"$help"; then
		log "installed version has no upgrade command; skipping post-install checks"
		return 0
	fi
	log "running: $launcher upgrade --post-install"
	if "$launcher" upgrade --post-install </dev/null; then
		return 0
	fi
	warn "post-install checks did not finish; the package is installed. Run: $launcher doctor --fix"
}

# The next steps promise only what the installed CLI actually lists. An older
# published version has no web command, and a tutorial that names one would
# send the operator to an error.
print_next_steps() {
	local help web_help="" web_listed=0 background_listed=0 launcher_command
	printf -v launcher_command '%q' "$launcher"
	help="$("$launcher" --help 2>/dev/null </dev/null || true)"
	if grep -Eq '^ *clio-coder web( |$)' <<<"$help"; then
		web_listed=1
		# The background subcommand is documented one level down.
		web_help="$("$launcher" web --help 2>/dev/null </dev/null || true)"
	fi
	grep -Eq 'clio-coder web background install' <<<"$help$web_help" && background_listed=1

	printf '\nInstalled: %s\n' "$launcher"
	cat <<NEXT

Verify this exact install, then configure a model target:
  $launcher_command --version
  $launcher_command doctor
  clio-coder configure

Terminal (interactive TUI):
  clio-coder
NEXT
	if [[ $web_listed -eq 1 ]]; then
		cat <<NEXT

Browser app (local, opens once you ask):
  clio-coder web --open
NEXT
		if [[ $background_listed -eq 1 && "$(uname -s 2>/dev/null || true)" == "Linux" ]]; then
			cat <<NEXT

Optional on Linux: keep it available in the background and install it as a PWA:
  clio-coder web background install --open
NEXT
		fi
	else
		cat <<NEXT

The browser app ships with a newer Clio Coder release.
This version has no 'clio-coder web' command; check later with: clio-coder --help
NEXT
	fi
	cat <<NEXT

If this shell still finds an old clio-coder, run \`hash -r\` (Bash) or \`rehash\` (Zsh).
NEXT
}

restore_previous_launcher() {
	local status=$?
	if [[ $status -ne 0 && -n "${previous_link:-}" && ! -e "$launcher" && ! -L "$launcher" ]]; then
		ln -s -- "$previous_link" "$launcher" || warn "could not restore the previous launcher: $launcher -> $previous_link"
	fi
	return "$status"
}

main() {
	previous_link=""
	trap restore_previous_launcher EXIT
	local version_spec="${CLIO_CODER_VERSION:-latest}"
	local prefix_arg="${CLIO_CODER_NPM_PREFIX:-$DEFAULT_PREFIX}"
	local omit_optional=0
	force=0
	dry_run=0

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--version)
				[[ $# -ge 2 ]] || fail "--version needs a value"
				version_spec="$2"
				shift
				;;
			--version=*) version_spec="${1#--version=}" ;;
			--prefix)
				[[ $# -ge 2 ]] || fail "--prefix needs a value"
				prefix_arg="$2"
				shift
				;;
			--prefix=*) prefix_arg="${1#--prefix=}" ;;
			--omit-optional) omit_optional=1 ;;
			--force|-f) force=1 ;;
			--dry-run) dry_run=1 ;;
			--help|-h)
				usage
				exit 0
				;;
			*) fail "unknown option: $1 (see --help)" ;;
		esac
		shift
	done

	local version
	version="$(validate_version "$version_spec")"
	[[ -n "$prefix_arg" ]] || fail "--prefix needs a value"
	prefix="$(absolute_path "$(expand_tilde "$prefix_arg")")"
	bin_dir="$prefix/bin"
	launcher="$bin_dir/clio-coder"
	package_dir="$prefix/lib/node_modules/@iowarp/clio-coder"
	local spec="$PACKAGE@$version"

	check_prerequisites

	log "package:  $spec"
	log "prefix:   $prefix"
	log "launcher: $launcher"
	[[ $dry_run -eq 1 ]] && log "dry run: no files will be changed"

	check_prefix_writable
	check_existing_launcher

	local -a npm_args=(install -g --prefix "$prefix")
	[[ $omit_optional -eq 1 ]] && npm_args+=(--omit=optional)
	npm_args+=("$spec")

	if [[ $dry_run -eq 1 ]]; then
		printf '[install] would run: npm'
		printf ' %q' "${npm_args[@]}"
		printf '\n'
		log "would then run: $launcher upgrade --post-install"
		report_path
		warn_about_shadowing_clio
		ok "dry run complete"
		return 0
	fi

	mkdir -p "$bin_dir" || fail "could not create $bin_dir"
	log "running: npm ${npm_args[*]}"
	# stdin is redirected because under `curl | bash` it carries this script,
	# and a child that reads it would eat the rest of the installer.
	if ! npm "${npm_args[@]}" </dev/null; then
		printf '[install] error: npm install failed for %s\n' "$spec" >&2
		printf '[install] common causes: no network, an unknown version (see https://www.npmjs.com/package/%s?activeTab=versions),\n' "$PACKAGE" >&2
		printf '[install] or a permission error under %s. This installer never uses sudo; choose a user-writable --prefix.\n' "$prefix" >&2
		exit 1
	fi
	[[ -e "$launcher" ]] || fail "npm finished but $launcher is missing; inspect the npm output above"
	ok "installed $spec"

	local version_output
	version_output="$("$launcher" --version 2>/dev/null </dev/null || true)"
	if [[ -n "$version_output" ]]; then
		ok "$version_output"
	else
		warn "launcher did not report a version; run: $launcher --version"
	fi

	report_path
	warn_about_shadowing_clio
	run_post_install
	print_next_steps
}

main "$@"
