#!/bin/sh
# Clio Coder installer: a private Node.js runtime plus the npm package, in your
# home directory, with no root and no system Node.
#
#   curl -fsSL https://coder.iowarp.ai/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/iowarp/clio-coder/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version 0.6.0
#
# What it does, in order:
#   1. Detects OS, CPU and C library (glibc version or musl).
#   2. Picks a Node.js build that runs there: the official nodejs.org tarball on
#      macOS and on glibc >= 2.28, the unofficial glibc-2.17 build on older x64
#      Linux (RHEL/CentOS 7 class clusters), and a musl build on Alpine.
#   3. Verifies SHASUMS256.txt for every download, and its OpenPGP signature
#      against the Node.js release keys when gpgv or gpg is present. A mismatch
#      stops the install.
#   4. Unpacks Node under the install root and installs @iowarp/clio-coder with
#      that Node's own npm into a versioned prefix next to it.
#   5. Writes a small launcher (default ~/.local/bin/clio-coder) that runs the
#      managed Node on the managed package, replacing it atomically and keeping
#      the previous version for --rollback.
#
# Shell startup files are edited only with --modify-path. Proxies are honored
# through https_proxy/http_proxy (curl, wget and npm all read them).
#
# The whole body lives in functions and main is called on the last line, so a
# truncated download parses as an incomplete script and runs nothing.
set -eu

PACKAGE="@iowarp/clio-coder"
# Mirrors package.json engines.node; tests/contracts/install-script.test.ts
# keeps the two in sync. A requested Node older than this is refused.
NODE_MIN="22.19.0"
# The newest LTS major that CI runs (the `ci (24)` job in .github/workflows/ci.yml).
NODE_DEFAULT_MAJOR="24"
NODE_OFFICIAL_BASE="https://nodejs.org/dist"
NODE_UNOFFICIAL_BASE="https://unofficial-builds.nodejs.org/download/release"
# The Node.js release team's active signing keys, published by the project
# outside nodejs.org, so a compromised download host cannot also swap the keys.
NODE_KEYRING_URL="https://github.com/nodejs/release-keys/raw/HEAD/gpg-only-active-keys/pubring.kbx"
LAUNCHER_MARK="# clio-coder-installer launcher"
MANIFEST_KIND="clio-coder-installer"
# Unpacked Node is about 210 MB and one package prefix about 460 MB, half of it
# the optional Claude Agent SDK binary (--include-claude-sdk opts in). Refuse early
# rather than die half way through on a quota.
MIN_FREE_KB=750000

usage() {
	cat <<'USAGE'
Usage: install.sh [options]

Install Clio Coder with a private Node.js runtime. No root, no system Node.

Options:
  --version <spec>      Clio Coder version: an exact version such as 0.6.0 or a
                        dist-tag. Default: the --channel. Env: CLIO_CODER_VERSION
  --channel <name>      latest (default), beta or dev. Env: CLIO_CODER_CHANNEL
  --package <file.tgz>  Install a local `npm pack` tarball instead of the
                        registry package. Env: CLIO_CODER_PACKAGE
  --node-version <v>    Node.js major (24) or exact version (24.11.1).
                        Default: the newest 24.x. Env: CLIO_CODER_NODE_VERSION
  --node-tarball <f>    Use a local Node.js tarball (airgapped sites). Its
                        SHASUMS256.txt must sit next to it, or be named by
                        CLIO_CODER_NODE_SHASUMS. Env: CLIO_CODER_NODE_TARBALL
  --refresh-runtime     Download Node again even if the wanted one is present.
  --install-dir <dir>   Install root. Env: CLIO_CODER_INSTALL_DIR
                        Default: $XDG_DATA_HOME/clio-coder-install on Linux
                        (~/.local/share/clio-coder-install), ~/Library/Application
                        Support/clio-coder/install on macOS, or
                        $CLIO_CODER_HOME/install when CLIO_CODER_HOME is set.
  --bin-dir <dir>       Where the clio-coder launcher goes. Default ~/.local/bin.
                        Env: CLIO_CODER_BIN_DIR
  --include-claude-sdk  Include the optional Claude Agent SDK (about 224 MB).
                        Default: skip it; Clio offers to fetch it on first use.
  --omit-optional       Accepted for compatibility; skipping is already default.
  --no-modify-path      Keep shell startup files unchanged (default).
  --modify-path         Append a PATH line for the bin dir to your shell's
                        startup file. Without it, the installer only prints one.
  --no-auto-update      Disable background updates. Env: CLIO_CODER_AUTO_UPDATE=0
  --auto-update         Enable background updates (unpinned native installs only).
  --rollback            Point the launcher back at the previous installed version.
  --no-post-install     Skip `clio-coder upgrade --post-install` after installing.
  --gui                 Also set up the desktop app (Linux: starts at login and
                        appears in the app menu; under WSL also in the Windows
                        Start Menu). Env: CLIO_CODER_INSTALL_GUI=1
  --no-gui              Skip the desktop app. Default: ask on a terminal, skip
                        otherwise. Env: CLIO_CODER_INSTALL_GUI=0
  --force               Replace a clio-coder launcher this installer did not write.
  --dry-run             Print the plan; download and change nothing.
  -h, --help            Show this help.

Environment for restricted networks:
  CLIO_CODER_NODE_MIRROR             Base URL (https:// or file://) laid out
                                     like https://nodejs.org/dist
  CLIO_CODER_NODE_UNOFFICIAL_MIRROR  Same, for unofficial-builds.nodejs.org
  CLIO_CODER_NODE_KEYRING            Local copy of the Node.js release keyring
  CLIO_CODER_REQUIRE_SIGNATURE=1     Fail unless the OpenPGP signature verifies
  CLIO_CODER_NODE_BUILD              Force a build: linux-x64, linux-arm64,
                                     linux-x64-glibc-217, linux-x64-musl,
                                     linux-arm64-musl, darwin-x64, darwin-arm64
  npm_config_registry                npm registry mirror for the package

Remove everything later with:
  clio-coder uninstall --remove-binary
USAGE
}

log() { printf '[install] %s\n' "$*"; }
ok() { printf '[install] ok: %s\n' "$*"; }
warn() { printf '[install] warning: %s\n' "$*" >&2; }
fail() {
	printf '[install] error: %s\n' "$*" >&2
	exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

expand_tilde() {
	case "$1" in
		"~") printf '%s\n' "$HOME" ;;
		"~/"*) printf '%s/%s\n' "$HOME" "${1#"~/"}" ;;
		*) printf '%s\n' "$1" ;;
	esac
}

# Absolute path without requiring it to exist.
absolute_path() {
	case "$1" in
		/*) printf '%s\n' "$1" ;;
		*) printf '%s/%s\n' "$PWD" "$1" ;;
	esac
}

# Paths are written into a JSON manifest and a shell launcher without an
# escaping layer, so the characters that would need one are refused instead.
check_plain_path() {
	case "$2" in
		*'"'* | *'\'* | *'$'* | *'`'*) fail "$1 contains a quote, backslash, \$ or backtick, which this installer does not support: $2" ;;
	esac
	case "$2" in
		*"
"*) fail "$1 contains a newline: $2" ;;
	esac
}

# Succeeds when dotted numeric version $1 >= $2.
version_ge() {
	awk -v a="$1" -v b="$2" 'BEGIN {
		na = split(a, x, "."); nb = split(b, y, ".")
		for (i = 1; i <= 3; i++) {
			p = (i <= na) ? x[i] + 0 : 0; q = (i <= nb) ? y[i] + 0 : 0
			if (p > q) exit 0
			if (p < q) exit 1
		}
		exit 0
	}'
}

single_line() {
	[ "$(printf '%s\n' "$1" | wc -l | tr -d ' ')" = 1 ]
}

# Exact semver, or an npm dist-tag. Everything else is refused before it can
# reach npm: a spec like `npm:evil@1`, `>=1`, `../x`, `file:...`, or a value
# with whitespace would install a different package or be read as a range or URL.
validate_version() {
	spec="$1"
	case "$spec" in
		v[0-9]*) spec="${spec#v}" ;;
	esac
	if single_line "$spec" && printf '%s\n' "$spec" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
		printf '%s\n' "$spec"
		return 0
	fi
	if single_line "$spec" && printf '%s\n' "$spec" | grep -Eq '^[a-z][a-z0-9-]{0,31}$'; then
		printf '%s\n' "$spec"
		return 0
	fi
	fail "invalid --version '$1'; use an exact version such as 0.6.0 or a dist-tag such as beta"
}

refuse_sudo() {
	# Under sudo, $HOME is root's or a root-owned copy of yours, and the launcher
	# would land where your own shell never looks.
	if [ "$(id -u 2>/dev/null || echo 1)" = 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] &&
		[ -z "${CLIO_CODER_INSTALL_ALLOW_SUDO:-}" ]; then
		fail "do not run this installer with sudo; it installs into your home directory. Rerun the same command without sudo, or set CLIO_CODER_INSTALL_ALLOW_SUDO=1 to install for root on purpose."
	fi
}

pick_downloader() {
	if have curl; then
		downloader=curl
	elif have wget; then
		downloader=wget
	else
		fail "neither curl nor wget was found; install one, or fetch Node and the package by hand and pass --node-tarball and --package"
	fi
}

# download <url> <file>. file:// URLs are copied, so an airgapped mirror on a
# shared filesystem needs no web server.
download() {
	case "$1" in
		file://*)
			cp -- "${1#file://}" "$2" 2>/dev/null
			return
			;;
	esac
	if [ "$downloader" = curl ]; then
		case "$1" in
			https://*) curl -fsSL --proto '=https' --retry 3 --connect-timeout 20 -o "$2" "$1" ;;
			*) curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1" ;;
		esac
	else
		wget -q --tries=3 --timeout=20 -O "$2" "$1"
	fi
}

sha256_of() {
	if have sha256sum; then
		sha256sum "$1" | awk '{print $1}'
	elif have shasum; then
		shasum -a 256 "$1" | awk '{print $1}'
	elif have openssl; then
		openssl dgst -sha256 "$1" | awk '{print $NF}'
	else
		fail "no SHA-256 tool found (sha256sum, shasum or openssl); one is needed to verify downloads"
	fi
}

detect_platform() {
	case "$(uname -s 2>/dev/null || echo unknown)" in
		Linux) os=linux ;;
		Darwin) os=darwin ;;
		MINGW* | MSYS* | CYGWIN*) fail "this installer targets Linux and macOS; on Windows, run in PowerShell: irm https://coder.iowarp.ai/install.ps1 | iex" ;;
		*) fail "unsupported operating system: $(uname -s 2>/dev/null || echo unknown). Supported: Linux and macOS." ;;
	esac
	case "$(uname -m 2>/dev/null || echo unknown)" in
		x86_64 | amd64) arch=x64 ;;
		aarch64 | arm64) arch=arm64 ;;
		*) fail "unsupported CPU: $(uname -m). Supported: x86_64 and arm64. Install Node $NODE_MIN or newer yourself (conda-forge builds more CPUs), then: npm install -g $PACKAGE" ;;
	esac
	# An x64 shell under Rosetta on Apple silicon should still get native Node.
	if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
		arch=arm64
	fi
	libc=""
	glibc=""
	[ "$os" = linux ] || return 0
	# Ask glibc first: only glibc answers GNU_LIBC_VERSION, while a glibc host
	# can also carry the musl loader (Debian's musl package installs
	# /lib/ld-musl-*.so.1) and must still get a glibc Node.
	glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')" || glibc=""
	if [ -n "$glibc" ]; then
		libc=glibc
		return 0
	fi
	if ls /lib/ld-musl-*.so.1 >/dev/null 2>&1 || (ldd --version 2>&1 | grep -qi musl); then
		libc=musl
		return 0
	fi
	libc=glibc
	glibc="$(ldd --version 2>&1 | head -n 1 | grep -Eo '[0-9]+\.[0-9]+' | tail -n 1)" || glibc=""
	[ -n "$glibc" ] || fail "could not determine the glibc version (getconf GNU_LIBC_VERSION and ldd --version both failed); set CLIO_CODER_NODE_BUILD to pick a Node build"
}

# Sets node_build (the tarball's platform part), node_index_key (its name in
# index.tab), node_official and node_base.
select_node_build() {
	if [ -n "${CLIO_CODER_NODE_BUILD:-}" ]; then
		node_build="$CLIO_CODER_NODE_BUILD"
	elif [ "$os" = darwin ]; then
		node_build="darwin-$arch"
	elif [ "$libc" = musl ]; then
		node_build="linux-$arch-musl"
	elif version_ge "$glibc" 2.28; then
		node_build="linux-$arch"
	elif [ "$arch" = x64 ] && version_ge "$glibc" 2.17; then
		node_build="linux-x64-glibc-217"
	elif [ "$arch" = arm64 ]; then
		fail "glibc $glibc is older than 2.28, which official arm64 Node.js builds need, and no older-glibc arm64 build exists. Use conda-forge nodejs (conda create -n node -c conda-forge 'nodejs>=22'), then run npm install -g $PACKAGE with that Node."
	else
		fail "glibc $glibc is older than 2.17, the oldest any Node.js 22+ build supports"
	fi
	node_official=1
	case "$node_build" in
		darwin-x64 | darwin-arm64) node_index_key="osx-${node_build#darwin-}-tar" ;;
		linux-x64 | linux-arm64 | linux-x64-musl) node_index_key="$node_build" ;;
		linux-x64-glibc-217 | linux-arm64-musl)
			node_index_key="$node_build"
			node_official=0
			;;
		*) fail "unknown Node build '$node_build'; see --help for CLIO_CODER_NODE_BUILD values" ;;
	esac
	if [ "$node_official" = 1 ]; then
		node_base="${CLIO_CODER_NODE_MIRROR:-$NODE_OFFICIAL_BASE}"
	else
		node_base="${CLIO_CODER_NODE_UNOFFICIAL_MIRROR:-$NODE_UNOFFICIAL_BASE}"
	fi
	node_base="${node_base%/}"
}

# Resolve a major (24) to the newest release that ships this build. An exact
# version passes through.
resolve_node_version() {
	wanted="${1#v}"
	if printf '%s\n' "$wanted" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
		printf '%s\n' "$wanted"
		return 0
	fi
	printf '%s\n' "$wanted" | grep -Eq '^[0-9]+$' || fail "invalid Node version '$1'; use a major such as 24 or an exact version such as 24.11.1"
	download "$node_base/index.tab" "$work/index.tab" ||
		fail "could not read $node_base/index.tab; check the network or proxy (https_proxy), or set CLIO_CODER_NODE_MIRROR"
	resolved="$(awk -F '\t' -v prefix="v$wanted." -v key="$node_index_key" '
		NR > 1 && index($1, prefix) == 1 {
			n = split($3, files, ",")
			for (i = 1; i <= n; i++) if (files[i] == key) { print substr($1, 2); exit }
		}' "$work/index.tab")"
	[ -n "$resolved" ] || fail "no Node.js $wanted.x release at $node_base ships a $node_build build"
	printf '%s\n' "$resolved"
}

# Check the OpenPGP signature on SHASUMS256.txt.asc. Prints the path of the
# signed checksum list, or nothing when the signature could not be checked.
# A bad signature stops the install.
verify_signature() {
	if have gpgv; then
		gpg_tool=gpgv
	elif have gpg; then
		gpg_tool=gpg
	else
		warn "neither gpgv nor gpg is installed; SHASUMS256.txt signature not checked"
		return 0
	fi
	keyring="${CLIO_CODER_NODE_KEYRING:-}"
	if [ -z "$keyring" ]; then
		keyring="$work/pubring.kbx"
		if ! download "$NODE_KEYRING_URL" "$keyring"; then
			warn "could not fetch the Node.js release keys from $NODE_KEYRING_URL; signature not checked"
			return 0
		fi
	fi
	# A private GNUPGHOME keeps this away from your own keyrings and trust db.
	GNUPGHOME="$work/gnupg"
	export GNUPGHOME
	mkdir -p "$GNUPGHOME"
	chmod 700 "$GNUPGHOME"
	if [ "$gpg_tool" = gpgv ]; then
		gpgv --status-fd 1 --keyring "$keyring" --output "$work/SHASUMS256.verified" "$1" >"$work/gpg.status" 2>"$work/gpg.err" || true
	else
		gpg --batch --no-default-keyring --keyring "$keyring" --status-fd 1 --output "$work/SHASUMS256.verified" --decrypt "$1" >"$work/gpg.status" 2>"$work/gpg.err" || true
	fi
	if grep -q '^\[GNUPG:\] BADSIG' "$work/gpg.status"; then
		fail "the OpenPGP signature on SHASUMS256.txt is BAD; refusing to install. The download or mirror may have been tampered with."
	fi
	if grep -q '^\[GNUPG:\] VALIDSIG' "$work/gpg.status" && [ -s "$work/SHASUMS256.verified" ]; then
		printf '%s\n' "$work/SHASUMS256.verified"
		return 0
	fi
	warn "could not check the SHASUMS256.txt signature with $gpg_tool ($(head -n 1 "$work/gpg.err" 2>/dev/null)); relying on the checksum file fetched over HTTPS"
}

# Fetch, verify and unpack Node into $runtime_dir.
install_node_runtime() {
	tarball_name="node-v$node_version-$node_build.tar.$compression"
	if [ -n "${CLIO_CODER_NODE_TARBALL:-}" ]; then
		[ -f "$CLIO_CODER_NODE_TARBALL" ] || fail "--node-tarball $CLIO_CODER_NODE_TARBALL does not exist"
		cp -- "$CLIO_CODER_NODE_TARBALL" "$work/$tarball_name"
		sums="${CLIO_CODER_NODE_SHASUMS:-$(dirname "$CLIO_CODER_NODE_TARBALL")/SHASUMS256.txt}"
		[ -f "$sums" ] || fail "no SHASUMS256.txt next to $CLIO_CODER_NODE_TARBALL; copy it from the same release directory or set CLIO_CODER_NODE_SHASUMS"
		cp -- "$sums" "$work/SHASUMS256.txt"
		if [ -f "$sums.asc" ]; then cp -- "$sums.asc" "$work/SHASUMS256.txt.asc"; fi
	else
		log "downloading $node_base/v$node_version/$tarball_name"
		if ! download "$node_base/v$node_version/$tarball_name" "$work/$tarball_name" && [ "$compression" = xz ] && have gzip; then
			# A partial mirror often carries only one of the two archives.
			compression=gz
			tarball_name="node-v$node_version-$node_build.tar.gz"
			log "no .tar.xz there; trying $tarball_name"
			download "$node_base/v$node_version/$tarball_name" "$work/$tarball_name" || tarball_name=""
		fi
		[ -n "$tarball_name" ] && [ -s "$work/$tarball_name" ] ||
			fail "download failed: $node_base/v$node_version/node-v$node_version-$node_build.tar.* (network, proxy, or a missing build; CLIO_CODER_NODE_MIRROR selects a mirror)"
		download "$node_base/v$node_version/SHASUMS256.txt" "$work/SHASUMS256.txt" ||
			fail "could not download SHASUMS256.txt for Node v$node_version; refusing to install an unverified runtime"
		if [ "$node_official" = 1 ]; then
			download "$node_base/v$node_version/SHASUMS256.txt.asc" "$work/SHASUMS256.txt.asc" || rm -f "$work/SHASUMS256.txt.asc"
		fi
	fi

	sums_file="$work/SHASUMS256.txt"
	signed=0
	if [ -f "$work/SHASUMS256.txt.asc" ]; then
		verified="$(verify_signature "$work/SHASUMS256.txt.asc")"
		if [ -n "$verified" ]; then
			sums_file="$verified"
			signed=1
			ok "SHASUMS256.txt signature verified against the Node.js release keys"
		fi
	elif [ "$node_official" = 0 ]; then
		log "unofficial-builds publishes no signature; verifying the checksum only"
	fi
	if [ "$signed" = 0 ] && [ "${CLIO_CODER_REQUIRE_SIGNATURE:-}" = 1 ]; then
		fail "CLIO_CODER_REQUIRE_SIGNATURE=1, but no verified signature covers SHASUMS256.txt"
	fi

	expected="$(awk -v f="$tarball_name" '$2 == f {print $1}' "$sums_file")"
	[ -n "$expected" ] || fail "$tarball_name is not listed in SHASUMS256.txt; refusing to install it"
	actual="$(sha256_of "$work/$tarball_name")"
	[ "$expected" = "$actual" ] || fail "checksum mismatch for $tarball_name (expected $expected, got $actual); refusing to install it"
	ok "checksum verified for $tarball_name"

	unpack="$install_root/runtime/.staging.$$"
	rm -rf "$unpack"
	mkdir -p "$unpack"
	if [ "$compression" = xz ]; then
		xz -dc "$work/$tarball_name" | tar -xf - -C "$unpack" || fail "could not unpack $tarball_name into $unpack (disk full or over quota?)"
	else
		gzip -dc "$work/$tarball_name" | tar -xf - -C "$unpack" || fail "could not unpack $tarball_name into $unpack (disk full or over quota?)"
	fi
	[ -x "$unpack/node-v$node_version-$node_build/bin/node" ] || fail "$tarball_name did not contain bin/node"
	if [ -e "$runtime_dir" ]; then runtime_dir="$runtime_dir-$$"; node_bin="$runtime_dir/bin/node"; fi
	mv "$unpack/node-v$node_version-$node_build" "$runtime_dir"
	rm -rf "$unpack"
}

check_node_runs() {
	if ! ran="$("$node_bin" -e 'process.stdout.write(process.versions.node)' 2>"$work/node.err")"; then
		detail="$(head -n 3 "$work/node.err")"
		hint=""
		case "$detail" in
			*GLIBC* | *libstdc* | *CXXABI*) hint=" This build needs a newer C or C++ runtime than this system has; on x64, CLIO_CODER_NODE_BUILD=linux-x64-glibc-217 selects the older-glibc build." ;;
		esac
		if [ "$libc" = musl ]; then hint=" musl builds need libstdc++ and libgcc (apk add libstdc++)."; fi
		fail "the managed Node at $node_bin does not run: $detail.$hint"
	fi
	version_ge "$ran" "$NODE_MIN" || fail "Node $ran is older than Clio Coder's floor $NODE_MIN"
	ok "Node v$ran runs ($node_build)"
}

# Free space in KB on the filesystem holding directory $1.
free_kb() {
	df -Pk "$1" 2>/dev/null | awk 'NR == 2 {print $4}'
}

check_writable_dir() {
	probe="$2"
	while [ ! -e "$probe" ]; do
		probe="$(dirname "$probe")"
	done
	[ -d "$probe" ] || fail "$1 parent $probe is not a directory"
	[ -w "$probe" ] || fail "$probe is not writable by $(id -un 2>/dev/null || echo "this user") (a read-only home, or the wrong owner); this installer never uses sudo. Choose another location with $3."
}

manifest_field() {
	[ -f "$install_root/install.json" ] || return 0
	sed -n "s/^[[:space:]]*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" "$install_root/install.json" | head -n 1
}

# write_manifest <node> <nodeVersion> <nodeBuild> <current> <previous>
write_manifest() {
	tmp="$install_root/.install.json.$$"
	cat >"$tmp" <<JSON
{
	"schema": 1,
	"kind": "$MANIFEST_KIND",
	"node": "$1",
	"nodeVersion": "$2",
	"nodeBuild": "$3",
	"current": "$4",
	"previous": "$5",
	"launcher": "$launcher",
	"channel": "$channel",
	"installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
	mv -f "$tmp" "$install_root/install.json"
}

launcher_is_ours() {
	[ -f "$launcher" ] && [ ! -L "$launcher" ] && grep -q "^$LAUNCHER_MARK" "$launcher" 2>/dev/null
}

check_existing_launcher() {
	[ -e "$launcher" ] || [ -L "$launcher" ] || return 0
	launcher_is_ours && return 0
	if [ -L "$launcher" ]; then
		target="$(readlink "$launcher")"
		case "$target" in
			/*) checkout_entry="$target" ;;
			*) checkout_entry="$bin_dir/$target" ;;
		esac
		case "$checkout_entry" in
			*/dist/cli/index.js)
				checkout_root="${checkout_entry%/dist/cli/index.js}"
				if [ -e "$checkout_root/.git" ] && [ -f "$checkout_root/src/cli/index.ts" ]; then
					[ "$force" = 1 ] || fail "source checkout detected at $checkout_root. Keep using that checkout: cd \"$checkout_root\" && pnpm run install:local. Switch this launcher to the managed release: rerun this installer with --force (the checkout is kept). Choose --bin-dir for a separate launcher."
				fi
				;;
		esac
		case "$target" in
			*lib/node_modules/@iowarp/clio-coder/*)
				warn "replacing $launcher, a link into an npm install of Clio Coder ($target)"
				warn "that npm copy stays on disk; remove it with the npm that installed it: npm uninstall -g --prefix <that prefix> $PACKAGE"
				return 0
				;;
		esac
		[ "$force" = 1 ] || fail "refusing to replace $launcher; it points to $target (a source-checkout launcher, perhaps). Rerun with --force to replace it, or choose another --bin-dir."
		warn "replacing clio-coder symlink that points outside this install: $launcher -> $target"
		return 0
	fi
	[ "$force" = 1 ] || fail "refusing to overwrite $launcher, which this installer did not write; move it aside, choose another --bin-dir, or rerun with --force"
	warn "replacing $launcher (--force)"
}

# Stage the launcher next to its final name, then rename it over the old one,
# so a concurrent `clio-coder` never reads half a file.
write_launcher() {
	mkdir -p "$bin_dir" || fail "could not create $bin_dir"
	tmp="$bin_dir/.clio-coder.$$"
	cat >"$tmp" <<LAUNCHER
#!/bin/sh
$LAUNCHER_MARK
# Written by Clio Coder's install.sh and rewritten by \`clio-coder upgrade\`.
# Remove it with \`clio-coder uninstall --remove-binary\`. Manifest: $install_root/install.json
exec "$1" "$2" "\$@"
LAUNCHER
	chmod 755 "$tmp"
	mv -f "$tmp" "$launcher"
}


path_contains_dir() {
	case ":${PATH:-}:" in
		*":$1:"*) return 0 ;;
	esac
	return 1
}

shell_rc_file() {
	case "$(basename "${SHELL:-sh}")" in
		zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
		bash) printf '%s\n' "$HOME/.bashrc" ;;
		fish) printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ;;
		*) printf '%s\n' "$HOME/.profile" ;;
	esac
}

path_line() {
	case "$(basename "${SHELL:-sh}")" in
		fish) printf 'fish_add_path "%s"\n' "$bin_dir" ;;
		*) printf 'export PATH="%s:$PATH"\n' "$bin_dir" ;;
	esac
}

report_path() {
	if path_contains_dir "$bin_dir"; then
		return 0
	fi
	rc="$(shell_rc_file)"
	if [ "$modify_path" = 1 ] && [ "$dry_run" = 0 ]; then
		if [ -f "$rc" ] && grep -q '# added by clio-coder install.sh' "$rc"; then
			ok "$rc already has the clio-coder PATH line"
		else
			mkdir -p "$(dirname "$rc")"
			printf '\n# added by clio-coder install.sh\n%s\n' "$(path_line)" >>"$rc"
			ok "added $bin_dir to PATH in $rc; open a new shell, or run: $(path_line)"
		fi
		return 0
	fi
	warn "$bin_dir is not on PATH. Add it for this shell, and to $rc to keep it:"
	printf '  %s\n' "$(path_line)" >&2
	warn "or rerun the installer with --modify-path to append that line for you"
}

warn_about_shadowing_clio() {
	found="$(command -v clio-coder 2>/dev/null || true)"
	[ -n "$found" ] || return 0
	[ "$found" = "$launcher" ] && return 0
	warn "another clio-coder is on your PATH at $found and shadows $launcher"
	warn "check it with: $found --version; remove it or put $bin_dir earlier on PATH, then run: hash -r"
}

print_next_steps() {
	printf 'Run: clio-coder\n'
	printf 'Desktop app: clio-coder gui\n'
}

# The desktop app is the GUI's background service: one `gui background install` adds the login
# service, the app-menu entry and, under WSL, the Windows Start Menu shortcut. It needs Linux
# with a systemd user session, so other platforms keep the `clio-coder gui` hint only.
offer_gui() {
	[ "$install_gui" != 0 ] || return 0
	if [ "$(uname -s 2>/dev/null)" != Linux ]; then
		# Asked for by name, it gets an answer; the default stays quiet where there is nothing to offer.
		if [ "$install_gui" = 1 ]; then warn "the desktop app runs as a login service on Linux only; start it here with: clio-coder gui"; fi
		return 0
	fi
	if [ "$install_gui" = ask ]; then
		# curl | sh leaves stdin on the pipe; the question goes to the terminal or is not asked.
		[ -t 1 ] && { : </dev/tty; } 2>/dev/null || return 0
	fi
	if [ "$install_gui" = ask ] && "$node_bin" "$entry" gui background status </dev/null 2>/dev/null | grep -q '"status": "installed"'; then
		return 0
	fi
	if [ "$install_gui" = ask ]; then
		printf '[install] Add the Clio Coder desktop app? It starts at login and appears in your app menu. [Y/n] '
		answer=""
		read -r answer </dev/tty || answer=n
		case "$answer" in "" | [Yy]*) ;; *) return 0 ;; esac
	fi
	# The command's report is JSON for scripts; the installer states the outcome in its own words.
	if "$node_bin" "$entry" gui background install --handover </dev/null >"$work/gui.out"; then
		if sed -n '/"windows"/,/}/p' "$work/gui.out" | grep -q '"status": "installed"'; then
			ok "desktop app installed; open Clio Coder from the Windows Start Menu or your app menu, or run: clio-coder gui"
		else
			ok "desktop app installed; it starts at login and is in your app menu as Clio Coder, or run: clio-coder gui"
		fi
		log "the desktop app uses Clio Coder's saved credentials; save a key that lives only in your shell with: clio-coder auth login <target>"
	else
		warn "the desktop app was not set up. Retry with: clio-coder doctor --fix (verified service handover waits until active work finishes)"
	fi
}

default_install_root() {
	if [ -n "${CLIO_CODER_INSTALL_DIR:-}" ]; then
		printf '%s\n' "$CLIO_CODER_INSTALL_DIR"
	elif [ -n "${CLIO_CODER_HOME:-}" ]; then
		printf '%s/install\n' "${CLIO_CODER_HOME%/}"
	elif [ "$(uname -s 2>/dev/null)" = Darwin ]; then
		printf '%s/Library/Application Support/clio-coder/install\n' "$HOME"
	else
		# A sibling of the data root ($XDG_DATA_HOME/clio-coder), never inside it:
		# `clio-coder reset` and `uninstall --keep-config` delete the data root and
		# must not delete the Node that runs them.
		printf '%s/clio-coder-install\n' "${XDG_DATA_HOME:-$HOME/.local/share}"
	fi
}

acquire_install_lock() {
	mkdir -p "$install_root"
	if ! mkdir "$install_root/.install-lock" 2>/dev/null; then
		fail "installation locked at $install_root/.install-lock (owner $(cat "$install_root/.install-lock/pid" 2>/dev/null || true)). If that process has exited, remove only that lock directory and retry."
	fi
	lock_owned=1
	printf '%s\n' "$$" >"$install_root/.install-lock/pid"
	trap cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
}

do_rollback() {
	[ -f "$install_root/install.json" ] || fail "no installer manifest at $install_root/install.json; nothing to roll back"
	node_path="$(manifest_field node)"
	current="$(manifest_field current)"
	helper="$current/lib/node_modules/@iowarp/clio-coder/scripts/native-install.cjs"
	if [ ! -f "$helper" ]; then
		previous="$(manifest_field previous)"
		[ -n "$previous" ] && [ -f "$previous/lib/node_modules/@iowarp/clio-coder/dist/cli/index.js" ] || fail "no complete previous install"
		if [ "$dry_run" = 1 ]; then log "would point $launcher at $previous"; return 0; fi
		acquire_install_lock
		"$node_path" "$previous/lib/node_modules/@iowarp/clio-coder/dist/cli/index.js" --version </dev/null || fail "previous install does not run"
		write_launcher "$node_path" "$previous/lib/node_modules/@iowarp/clio-coder/dist/cli/index.js"
		write_manifest "$node_path" "$(manifest_field nodeVersion)" "$(manifest_field nodeBuild)" "$previous" "$current"
		ok "legacy rollback complete"
		return 0
	fi
	if [ "$dry_run" = 1 ]; then log "would roll back $install_root"; return 0; fi
	acquire_install_lock
	"$node_path" "$helper" rollback "$install_root" </dev/null
}

cleanup() {
	if [ "${lock_owned:-0}" = 1 ]; then rm -rf "$install_root/.install-lock"; fi
	if [ -n "${work:-}" ]; then rm -rf "$work"; fi
	if [ -n "${install_root:-}" ]; then rm -rf "$install_root/runtime/.staging.$$" "$install_root/versions/.staging.$$"; fi
	return 0
}

main() {
	version_spec="${CLIO_CODER_VERSION:-}"
	channel="${CLIO_CODER_CHANNEL:-latest}"
	package_file="${CLIO_CODER_PACKAGE:-}"
	node_wanted="${CLIO_CODER_NODE_VERSION:-$NODE_DEFAULT_MAJOR}"
	install_root_arg=""
	bin_dir_arg="${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}"
	omit_optional=1
	modify_path="${CLIO_CODER_MODIFY_PATH:-0}"
	auto_update="${CLIO_CODER_AUTO_UPDATE:-preserve}"
	lock_owned=0
	rollback=0
	post_install=1
	install_gui="${CLIO_CODER_INSTALL_GUI:-ask}"
	refresh_runtime=0
	force=0
	dry_run=0
	work=""

	while [ $# -gt 0 ]; do
		case "$1" in
			--version | --channel | --package | --node-version | --node-tarball | --install-dir | --bin-dir)
				[ $# -ge 2 ] || fail "$1 needs a value"
				case "$1" in
					--version) version_spec="$2" ;;
					--channel) channel="$2" ;;
					--package) package_file="$2" ;;
					--node-version) node_wanted="$2" ;;
					--node-tarball) CLIO_CODER_NODE_TARBALL="$2" ;;
					--install-dir) install_root_arg="$2" ;;
					--bin-dir) bin_dir_arg="$2" ;;
				esac
				shift
				;;
			--version=*) version_spec="${1#--version=}" ;;
			--channel=*) channel="${1#--channel=}" ;;
			--package=*) package_file="${1#--package=}" ;;
			--node-version=*) node_wanted="${1#--node-version=}" ;;
			--node-tarball=*) CLIO_CODER_NODE_TARBALL="${1#--node-tarball=}" ;;
			--install-dir=*) install_root_arg="${1#--install-dir=}" ;;
			--bin-dir=*) bin_dir_arg="${1#--bin-dir=}" ;;
			--include-claude-sdk) omit_optional=0 ;;
			--omit-optional) : ;;
			--modify-path) modify_path=1 ;;
			--no-modify-path) modify_path=0 ;;
			--no-auto-update) auto_update=0 ;;
			--auto-update) auto_update=1 ;;
			--rollback) rollback=1 ;;
			--no-post-install) post_install=0 ;;
			--gui) install_gui=1 ;;
			--no-gui) install_gui=0 ;;
			--refresh-runtime) refresh_runtime=1 ;;
			--force | -f) force=1 ;;
			--dry-run) dry_run=1 ;;
			--help | -h)
				usage
				exit 0
				;;
			*) fail "unknown option: $1 (see --help)" ;;
		esac
		shift
	done

	case "$channel" in
		latest | beta | dev) ;;
		*) fail "--channel must be latest, beta or dev, got '$channel'" ;;
	esac
	case "$install_gui" in
		0 | 1 | ask) ;;
		*) fail "CLIO_CODER_INSTALL_GUI must be 1 or 0, got '$install_gui'" ;;
	esac
	if [ -n "$version_spec" ]; then
		version="$(validate_version "$version_spec")"
	else
		version="$channel"
	fi
	case "$version" in latest | beta | dev) channel="$version" ;; esac

	refuse_sudo
	[ -n "${HOME:-}" ] || fail "HOME is not set"
	[ -n "$install_root_arg" ] || install_root_arg="$(default_install_root)"
	install_root="$(absolute_path "$(expand_tilde "$install_root_arg")")"
	install_root="${install_root%/}"
	bin_dir="$(absolute_path "$(expand_tilde "$bin_dir_arg")")"
	bin_dir="${bin_dir%/}"
	launcher="$bin_dir/clio-coder"
	check_plain_path "install dir" "$install_root"
	check_plain_path "bin dir" "$bin_dir"

	if [ "$rollback" = 1 ]; then
		do_rollback
		return 0
	fi

	detect_platform
	select_node_build
	if [ -n "${CLIO_CODER_NODE_TARBALL:-}" ]; then
		CLIO_CODER_NODE_TARBALL="$(absolute_path "$(expand_tilde "$CLIO_CODER_NODE_TARBALL")")"
		tar_base="$(basename "$CLIO_CODER_NODE_TARBALL")"
		node_wanted="$(printf '%s\n' "$tar_base" | sed -n 's/^node-v\([0-9][0-9.]*\)-.*\.tar\.[gx]z$/\1/p')"
		tar_build="$(printf '%s\n' "$tar_base" | sed -n 's/^node-v[0-9.]*-\(.*\)\.tar\.[gx]z$/\1/p')"
		{ [ -n "$node_wanted" ] && [ -n "$tar_build" ]; } || fail "--node-tarball must keep its release file name, such as node-v24.11.1-linux-x64.tar.xz"
		node_build="$tar_build"
		case "$tar_base" in
			*.xz) compression=xz ;;
			*) compression=gz ;;
		esac
	elif have xz; then
		compression=xz
	else
		compression=gz
	fi
	if [ -n "$package_file" ]; then
		package_file="$(absolute_path "$(expand_tilde "$package_file")")"
		[ -f "$package_file" ] || fail "--package $package_file does not exist"
		spec="$package_file"
	else
		spec="$PACKAGE@$version"
	fi
	npm_extra="--include=optional"
	if [ "$omit_optional" = 1 ]; then npm_extra="--omit=optional"; fi

	log "platform:     $os-$arch${libc:+ ($libc${glibc:+ $glibc})}"
	log "node build:   $node_build from $node_base"
	log "package:      $spec"
	log "install root: $install_root"
	log "launcher:     $launcher"

	if [ "$dry_run" = 1 ]; then
		case "$node_wanted" in
			*.*.*) log "would install Node v${node_wanted#v}" ;;
			*) log "would install the newest Node v${node_wanted#v}.x that ships $node_build" ;;
		esac
		log "would run that Node's npm: npm install --prefix $install_root/versions/<version>/lib${npm_extra:+ $npm_extra} $spec"
		log "would write $launcher and $install_root/install.json, then run: $launcher upgrade --post-install"
		check_existing_launcher
		report_path
		ok "dry run complete; nothing was downloaded or changed"
		return 0
	fi

	have tar || fail "tar was not found; it is needed to unpack Node.js"
	if [ "$compression" = xz ]; then
		have xz || fail "xz was not found; it is needed for a .tar.xz Node tarball (a .tar.gz works without it)"
	else
		have gzip || fail "neither xz nor gzip was found; one is needed to unpack Node.js"
	fi
	pick_downloader
	check_writable_dir "install dir" "$install_root" "--install-dir or CLIO_CODER_INSTALL_DIR"
	check_writable_dir "bin dir" "$bin_dir" "--bin-dir or CLIO_CODER_BIN_DIR"
	check_existing_launcher
	acquire_install_lock
	if [ -z "$version_spec" ] && [ -z "$package_file" ]; then
		recorded_pin="$(manifest_field versionPin)"
		if [ -n "$recorded_pin" ]; then version_spec="$(validate_version "$recorded_pin")"; spec="$PACKAGE@$version_spec"; fi
	fi
	if [ ! -f "$install_root/install.json" ] && [ ! -f "$install_root/.installer-owner" ]; then
		[ ! -e "$install_root/runtime" ] && [ ! -e "$install_root/versions" ] || fail "refusing to claim existing runtime/versions directories without installer ownership"
	fi
	printf '%s\n' "$MANIFEST_KIND" >"$install_root/.installer-owner"
	mkdir -p "$install_root/runtime" "$install_root/versions" || fail "could not create $install_root"
	available="$(free_kb "$install_root")"
	case "$available" in
		'' | *[!0-9]*) ;;
		*)
			if [ "$available" -lt "$MIN_FREE_KB" ]; then
				fail "only $((available / 1024)) MB free under $install_root; Clio Coder and its runtime need about $((MIN_FREE_KB / 1024)) MB. Free space, or choose --install-dir on a larger filesystem."
			fi
			;;
	esac
	work="$(mktemp -d "$install_root/.work.XXXXXX")" || fail "could not create a work directory under $install_root"
	trap cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM

	node_version="$(resolve_node_version "$node_wanted")"
	version_ge "$node_version" "$NODE_MIN" || fail "Node $node_version is older than Clio Coder's floor $NODE_MIN; pick $NODE_DEFAULT_MAJOR or newer"
	runtime_dir="$install_root/runtime/node-v$node_version-$node_build"
	node_bin="$runtime_dir/bin/node"
	if [ "$refresh_runtime" = 0 ] && [ -x "$node_bin" ] && "$node_bin" --version >/dev/null 2>&1; then
		ok "reusing Node v$node_version at $runtime_dir"
	else
		install_node_runtime
	fi
	check_node_runs

	npm_cli="$runtime_dir/lib/node_modules/npm/bin/npm-cli.js"
	[ -f "$npm_cli" ] || fail "the Node runtime at $runtime_dir has no bundled npm"
	# All versions remain available to sessions that still lazily import their old code.
	previous="$(manifest_field current)"
	{ [ -n "$previous" ] && [ -d "$previous" ]; } || previous=""
	# Active sessions may still lazily read any prior package or runtime.
	staging="$install_root/versions/.staging.$$"
	rm -rf "$staging"
	log "installing $spec with the npm bundled in Node v$node_version"
	# A project install into <prefix>/lib lands the package at the same
	# lib/node_modules/@iowarp/clio-coder path a global install uses, and unlike
	# `install -g` (npm 11) it honors --omit=optional.
	# stdin is closed because under `curl | sh` it carries the rest of this
	# script, and a child that reads it would eat the installer.
	mkdir -p "$staging/lib"
	# shellcheck disable=SC2086 # npm_extra is one flag or nothing.
	if ! PATH="$runtime_dir/bin:$PATH" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
		"$node_bin" "$npm_cli" install --prefix "$staging/lib" --no-save --loglevel=error $npm_extra "$spec" </dev/null; then
		fail "npm could not install $spec. Common causes: no route to the registry (set https_proxy, or npm_config_registry for a mirror), an unknown version, or a full disk under $install_root."
	fi
	pkg_dir="$staging/lib/node_modules/@iowarp/clio-coder"
	installed_version="$("$node_bin" -e 'const p=require(process.argv[1]);if(p.name!=="@iowarp/clio-coder")process.exit(1);process.stdout.write(p.version)' "$pkg_dir/package.json" 2>/dev/null)" ||
		fail "npm finished, but $pkg_dir is not an @iowarp/clio-coder package"
	final_prefix="$install_root/versions/$installed_version"
	if [ -e "$final_prefix" ]; then final_prefix="$final_prefix-$(date -u +%Y%m%d%H%M%S)"; fi
	mv "$staging" "$final_prefix"
	entry="$final_prefix/lib/node_modules/@iowarp/clio-coder/dist/cli/index.js"
	[ -f "$entry" ] || fail "the installed package has no dist/cli/index.js"
	ok "installed $PACKAGE $installed_version"

	helper="$final_prefix/lib/node_modules/@iowarp/clio-coder/scripts/native-install.cjs"
	if version_ge "${installed_version%%-*}" "0.6.0"; then
		[ -f "$helper" ] || fail "candidate has no managed lifecycle helper; previous install remains active. Run: clio-coder doctor --fix"
		pin=""
		case "$version_spec" in [0-9]* | v[0-9]*) pin="$installed_version" ;; esac
		if [ -n "$package_file" ]; then pin="$installed_version"; fi
		"$node_bin" "$helper" activate "$install_root" "$node_bin" "$node_version" "$node_build" "$final_prefix" "$launcher" "$channel" "$pin" "$auto_update" "$post_install" </dev/null ||
			fail "candidate checks failed; previous install remains active. Run: clio-coder doctor --fix"
	else
		"$node_bin" "$entry" --version </dev/null || fail "candidate does not run; previous install remains active. Run: clio-coder doctor --fix"
		if [ -d "$install_root/launchers" ]; then fail "refusing to replace a lifecycle-capable install with a legacy package; use rollback"; fi
		write_launcher "$node_bin" "$entry"
		write_manifest "$node_bin" "$node_version" "$node_build" "$final_prefix" "$previous"
		warn "Installed legacy $installed_version. Managed CLI upgrade/uninstall and background updates require 0.6.0; update by rerunning this installer. Automatic post-install was skipped; run doctor --fix explicitly for diagnostics."
	fi
	if [ "$post_install" = 1 ] && version_ge "${installed_version%%-*}" "0.6.0"; then
		"$node_bin" "$entry" upgrade --post-install </dev/null || fail "package is installed, but local migrations/initialization need attention; run: $launcher upgrade --post-install. Previous binary remains available via --rollback."
	fi
	if version_ge "${installed_version%%-*}" "0.6.0"; then offer_gui; fi
	report_path
	warn_about_shadowing_clio
	print_next_steps
}

main "$@"
