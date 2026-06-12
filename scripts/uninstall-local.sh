#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

usage() {
	cat <<'USAGE'
Usage: scripts/uninstall-local.sh [--dry-run] [--force] [--keep-state] [--keep-settings-auth]
                                  [--preserve-settings-auth <dir>] [--accept-bin-target <path>]

Uninstall the deterministic local source symlink created by install-local.sh.
By default, --force removes the symlink plus Clio config/data/cache. Use --keep-state
for binary-only removal, or --keep-settings-auth to restore only active settings.yaml
and credentials.yaml after removing all other Clio state.

Options:
  --dry-run                     Print planned removals without changing files. Does not require --force.
  --force, -f                   Required for non-dry-run uninstall.
  --keep-state                  Remove only the local symlink; leave config/data/cache unchanged.
  --keep-settings-auth          Preserve only active settings.yaml and credentials.yaml in the config dir.
  --preserve-settings-auth DIR  Copy active settings.yaml and credentials.yaml to DIR, then restore them.
  --accept-bin-target PATH      Also allow removing a clio symlink that points at PATH or below PATH.
  --bin-dir DIR                 Override the bin dir instead of CLIO_BIN_DIR/$HOME/.local/bin.
  -h, --help                    Show this help.
USAGE
}

log() { printf '[uninstall-local] %s\n' "$*"; }
ok() { printf '[uninstall-local] ok: %s\n' "$*"; }
warn() { printf '[uninstall-local] warning: %s\n' "$*" >&2; }
fail() { printf '[uninstall-local] error: %s\n' "$*" >&2; exit 1; }

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

path_is_under() {
	local parent child
	parent="$(normalize_path "$1")"
	child="$(normalize_path "$2")"
	[[ "$parent" != "/" && ("$child" == "$parent" || "$child" == "$parent"/*) ]]
}

# `clio paths --json` (the built dist in this checkout) is the single source
# of truth for directory resolution. The embedded fallback below exists only
# for a broken or missing dist and must mirror src/core/xdg.ts.
resolve_clio_dirs() {
	local cli_entry="$repo_root/dist/cli/index.js"
	if [[ -f "$cli_entry" ]]; then
		local from_cli
		if from_cli="$(node "$cli_entry" paths --json 2>/dev/null | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
	try {
		const dirs = JSON.parse(raw);
		if (
			typeof dirs.config === "string" &&
			typeof dirs.data === "string" &&
			typeof dirs.state === "string" &&
			typeof dirs.cache === "string"
		) {
			console.log(dirs.config);
			console.log(dirs.data);
			console.log(dirs.state);
			console.log(dirs.cache);
			return;
		}
	} catch {}
	process.exit(1);
});
')" && [[ -n "$from_cli" ]]; then
			printf '%s
' "$from_cli"
			return
		fi
		warn "dist CLI did not answer 'paths --json'; using the embedded fallback resolution"
	fi
	node - <<'NODE'
const os = require("node:os");
const path = require("node:path");
const env = (key) => {
	const value = process.env[key]?.trim();
	return value && value.length > 0 ? value : null;
};
const home = os.homedir();
const clioHome = env("CLIO_HOME");
function defaults() {
	if (process.platform === "win32") {
		const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
		const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
		return {
			config: path.join(appData, "clio", "config"),
			data: path.join(appData, "clio", "data"),
			state: path.join(localAppData, "clio", "state"),
			cache: path.join(localAppData, "clio", "cache"),
		};
	}
	if (process.platform === "darwin") {
		const app = path.join(home, "Library", "Application Support", "clio");
		return {
			config: path.join(app, "config"),
			data: path.join(app, "data"),
			state: path.join(app, "state"),
			cache: path.join(home, "Library", "Caches", "clio"),
		};
	}
	return {
		config: path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "clio"),
		data: path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "clio"),
		state: path.join(process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "clio"),
		cache: path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "clio"),
	};
}
const fallback = defaults();
const config = env("CLIO_CONFIG_DIR") ?? (clioHome ? path.join(clioHome, "config") : fallback.config);
const data = env("CLIO_DATA_DIR") ?? (clioHome ? path.join(clioHome, "data") : fallback.data);
const state = env("CLIO_STATE_DIR") ?? (clioHome ? path.join(clioHome, "state") : fallback.state);
const cache = env("CLIO_CACHE_DIR") ?? (clioHome ? path.join(clioHome, "cache") : fallback.cache);
console.log(config);
console.log(data);
console.log(state);
console.log(cache);
NODE
}

safe_rm_rf() {
	local label raw_dir dir
	label="$1"
	raw_dir="$2"
	dir="$(normalize_path "$raw_dir")"
	if [[ -z "$dir" || "$dir" == "/" || "$dir" == "$HOME" ]]; then
		fail "refusing to remove unsafe $label path: $dir"
	fi
	if [[ $dry_run -eq 1 ]]; then
		log "would remove $label: $dir"
		return
	fi
	if [[ -e "$dir" || -L "$dir" ]]; then
		rm -rf -- "$dir"
		ok "removed $label: $dir"
	else
		ok "$label absent: $dir"
	fi
}

add_remove_dir() {
	local candidate existing i
	candidate="$(normalize_path "$1")"
	for existing in "${remove_dirs[@]}"; do
		if path_is_under "$existing" "$candidate"; then
			return
		fi
	done
	for i in "${!remove_dirs[@]}"; do
		existing="${remove_dirs[$i]}"
		if path_is_under "$candidate" "$existing"; then
			unset 'remove_dirs[$i]'
		fi
	done
	remove_dirs+=("$candidate")
}

remove_local_link() {
	if [[ ! -e "$link_path" && ! -L "$link_path" ]]; then
		ok "local clio link absent: $link_path"
		return
	fi
	if [[ ! -L "$link_path" ]]; then
		warn "leaving non-symlink in place: $link_path"
		return
	fi

	local raw_target resolved_target allowed accepted
	raw_target="$(readlink "$link_path")"
	if [[ "$raw_target" = /* ]]; then
		resolved_target="$(normalize_path "$raw_target")"
	else
		resolved_target="$(normalize_path "$bin_dir/$raw_target")"
	fi

	allowed=0
	if path_is_under "$repo_root" "$resolved_target"; then
		allowed=1
	else
		for accepted in "${accepted_bin_targets[@]}"; do
			if path_is_under "$accepted" "$resolved_target"; then
				allowed=1
				break
			fi
		done
	fi

	if [[ $allowed -ne 1 ]]; then
		warn "leaving clio symlink because it points outside this repo: $link_path -> $resolved_target"
		warn "pass --accept-bin-target <path> only if that target is safe to unlink"
		return
	fi

	if [[ $dry_run -eq 1 ]]; then
		log "would remove symlink: $link_path -> $resolved_target"
	else
		rm -f -- "$link_path"
		ok "removed symlink: $link_path"
	fi
}

copy_settings_auth() {
	if [[ $keep_settings_auth -ne 1 || $keep_state -ne 0 ]]; then
		return 0
	fi
	if [[ -n "$preserve_dir" ]]; then
		stage_dir="$(normalize_path "$(expand_tilde "$preserve_dir")")"
		for clio_dir in "$config_dir" "$data_dir" "$state_dir" "$cache_dir"; do
			if path_is_under "$clio_dir" "$stage_dir"; then
				fail "preserve directory must not be inside Clio state: $stage_dir"
			fi
		done
	else
		stage_dir=""
	fi

	if [[ $dry_run -eq 1 ]]; then
		log "would preserve only active settings.yaml and credentials.yaml"
		if [[ -n "$stage_dir" ]]; then
			log "would copy preserved files to: $stage_dir"
		fi
		return 0
	fi

	if [[ -z "$stage_dir" ]]; then
		stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/clio-settings-auth.XXXXXX")"
		temporary_stage=1
	else
		mkdir -p "$stage_dir"
	fi

	if [[ -f "$settings_path" ]]; then
		install -m 0644 "$settings_path" "$stage_dir/settings.yaml"
		preserved_settings=1
		ok "preserved active settings.yaml"
	fi
	if [[ -f "$credentials_path" ]]; then
		install -m 0600 "$credentials_path" "$stage_dir/credentials.yaml"
		preserved_credentials=1
		ok "preserved active credentials.yaml"
	fi
}

restore_settings_auth() {
	if [[ $keep_settings_auth -ne 1 || $keep_state -ne 0 ]]; then
		return 0
	fi
	if [[ $dry_run -eq 1 ]]; then
		log "would restore preserved settings.yaml and credentials.yaml only"
		return
	fi
	if [[ $preserved_settings -eq 1 || $preserved_credentials -eq 1 ]]; then
		mkdir -p "$config_dir"
	fi
	if [[ $preserved_settings -eq 1 ]]; then
		install -m 0644 "$stage_dir/settings.yaml" "$settings_path"
		ok "restored active settings.yaml"
	fi
	if [[ $preserved_credentials -eq 1 ]]; then
		install -m 0600 "$stage_dir/credentials.yaml" "$credentials_path"
		ok "restored active credentials.yaml"
	fi
	if [[ $temporary_stage -eq 1 ]]; then
		rm -rf -- "$stage_dir"
	fi
}

dry_run=0
force=0
keep_state=0
keep_settings_auth=0
preserve_dir=""
bin_dir_override=""
accepted_bin_targets=()

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dry-run) dry_run=1 ;;
		--force|-f) force=1 ;;
		--keep-state) keep_state=1 ;;
		--keep-settings-auth) keep_settings_auth=1 ;;
		--preserve-settings-auth)
			shift
			[[ $# -gt 0 ]] || fail "--preserve-settings-auth requires a directory"
			preserve_dir="$1"
			keep_settings_auth=1
			;;
		--preserve-settings-auth=*)
			preserve_dir="${1#--preserve-settings-auth=}"
			keep_settings_auth=1
			;;
		--accept-bin-target)
			shift
			[[ $# -gt 0 ]] || fail "--accept-bin-target requires a path"
			accepted_bin_targets+=("$(normalize_path "$(expand_tilde "$1")")")
			;;
		--accept-bin-target=*)
			accepted_bin_targets+=("$(normalize_path "$(expand_tilde "${1#--accept-bin-target=}")")")
			;;
		--bin-dir)
			shift
			[[ $# -gt 0 ]] || fail "--bin-dir requires a directory"
			bin_dir_override="$1"
			;;
		--bin-dir=*) bin_dir_override="${1#--bin-dir=}" ;;
		--help|-h) usage; exit 0 ;;
		*) fail "unknown option: $1" ;;
	esac
	shift
done

if [[ $dry_run -eq 0 && $force -eq 0 ]]; then
	fail "non-dry-run uninstall requires --force"
fi
if [[ $keep_state -eq 1 && $keep_settings_auth -eq 1 ]]; then
	warn "--keep-settings-auth has no effect with --keep-state"
fi

need_cmd node
need_cmd install

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
if [[ -n "$bin_dir_override" ]]; then
	bin_dir="$(expand_tilde "$bin_dir_override")"
else
	bin_dir="$(expand_tilde "${CLIO_BIN_DIR:-$HOME/.local/bin}")"
fi
link_path="$bin_dir/clio"

mapfile -t resolved_dirs < <(resolve_clio_dirs)
config_dir="$(normalize_path "${resolved_dirs[0]}")"
data_dir="$(normalize_path "${resolved_dirs[1]}")"
state_dir="$(normalize_path "${resolved_dirs[2]}")"
cache_dir="$(normalize_path "${resolved_dirs[3]}")"
settings_path="$config_dir/settings.yaml"
credentials_path="$config_dir/credentials.yaml"

stage_dir=""
temporary_stage=0
preserved_settings=0
preserved_credentials=0
remove_dirs=()

log "source root: $repo_root"
log "link path:   $link_path"
log "config dir:  $config_dir"
log "data dir:    $data_dir"
log "state dir:   $state_dir"
log "cache dir:   $cache_dir"
[[ $dry_run -eq 1 ]] && log "dry run: no files will be changed"

remove_local_link

if [[ $keep_state -eq 1 ]]; then
	ok "leaving Clio config/data/cache unchanged (--keep-state)"
else
	copy_settings_auth
	add_remove_dir "$config_dir"
	add_remove_dir "$data_dir"
	add_remove_dir "$state_dir"
	add_remove_dir "$cache_dir"
	for dir in "${remove_dirs[@]}"; do
		safe_rm_rf "state" "$dir"
	done
	restore_settings_auth
fi

if [[ $dry_run -eq 1 ]]; then
	ok "dry run complete"
else
	ok "local uninstall complete"
fi

cat <<'NEXT'

After changing shell-visible links, run:
  hash -r        # Bash
  rehash         # Zsh
NEXT
