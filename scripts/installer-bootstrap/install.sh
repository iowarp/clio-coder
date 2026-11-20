#!/bin/sh
# The site delegates to released assets, so each release owns installer behavior
# and this script only chooses which release's installer to run.
main() {
	set -eu
	channel=${CLIO_CODER_CHANNEL:-latest}
	version=${CLIO_CODER_VERSION:-}
	next=
	for argument in "$@"; do
		if [ "$next" = channel ]; then channel=$argument; next=; continue; fi
		if [ "$next" = version ]; then version=$argument; next=; continue; fi
		case "$argument" in
			--channel) next=channel ;;
			--channel=*) channel=${argument#--channel=} ;;
			--version) next=version ;;
			--version=*) version=${argument#--version=} ;;
		esac
	done
	case "$version" in latest | beta | dev) channel=$version ;; esac
	# Both downloads live in a private directory: a name derived from a mktemp file sits in a shared directory where
	# another local user can plant a link at it first. The script works inside it by relative names and runs the
	# installer through a descriptor opened there, so renaming or swapping the directory's entry in a temp directory
	# others may write cannot change what runs. The installer itself runs in the caller's directory, where relative
	# --package, --node-tarball and --install-dir paths mean what the caller meant. Between mktemp and cd another user who
	# can write the temp directory could swap the entry, so the directory reached must be this user's, closed to others
	# and empty, as a fresh mktemp directory is (a link to one of this user's own private directories is not).
	# The downloader is resolved here, in the caller's directory, because a relative PATH entry such as ./bin names it
	# only from there; command -v may print that relative path, so it is made absolute before the cd below.
	downloader=$(command -v curl 2>/dev/null) || downloader=$(command -v wget 2>/dev/null) || downloader=
	case $downloader in /*) ;; ?*) downloader=$PWD/$downloader ;; *) downloader=wget ;; esac
	dir=$(mktemp -d "${TMPDIR:-/tmp}/clio-coder-install.XXXXXXXX")
	trap 'rm -rf "$dir"' EXIT HUP INT TERM
	cd -P "$dir"
	private=no
	case $(ls -ld .) in
		drwx------[!+]*) if [ -O . ] && [ -z "$(ls -A .)" ]; then private=yes; fi ;;
	esac
	if [ "$private" != yes ]; then
		echo "clio-coder install: $dir is not a private directory of this user; refusing to continue" >&2
		exit 1
	fi
	get() {
		case $downloader in */curl) "$downloader" -fsSL "$1" -o "$2" ;; *) "$downloader" -q "$1" -O "$2" ;; esac
	}
	url=https://github.com/iowarp/clio-coder/releases/latest/download/install.sh
	case "$channel" in
		beta | dev)
			# Snapshots have no GitHub release. The beta installer resolves all three
			# channels itself; a missing beta tag falls back to the stable asset.
			if get https://registry.npmjs.org/@iowarp/clio-coder/beta ./channel; then
				rc=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' ./channel | head -n 1)
				if printf '%s\n' "$rc" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$'; then
					url="https://github.com/iowarp/clio-coder/releases/download/v$rc/install.sh"
				fi
			fi
			;;
	esac
	if ! get "$url" ./install.sh; then get https://github.com/iowarp/clio-coder/releases/latest/download/install.sh ./install.sh; fi
	exec 3<./install.sh
	cd - >/dev/null
	# A rerun without an exact version follows the channel and clears a pin, so the
	# default hosted upgrade names its channel. An exact version or --package pins.
	if [ -z "$version" ]; then set -- "$@" --version "$channel"; fi
	sh /dev/fd/3 "$@"
}
# A group runs only once its closing brace arrived, so a truncated download runs nothing.
{ main "$@"; }
