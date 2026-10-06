#!/bin/sh
# The site delegates to released assets; pre-release users need the rc's installer
# before the first stable release carries the new channel and upgrade behavior.
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
	file=$(mktemp "${TMPDIR:-/tmp}/clio-coder-install.XXXXXXXX")
	trap 'rm -f "$file" "$file.channel"' EXIT HUP INT TERM
	get() {
		if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -q "$1" -O "$2"; fi
	}
	url=https://github.com/iowarp/clio-coder/releases/latest/download/install.sh
	case "$channel" in
		beta | dev)
			# Snapshots have no GitHub release. The beta installer resolves all three
			# channels itself; a missing beta tag falls back to the stable asset.
			if get https://registry.npmjs.org/@iowarp/clio-coder/beta "$file.channel"; then
				rc=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file.channel" | head -n 1)
				if printf '%s\n' "$rc" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$'; then
					url="https://github.com/iowarp/clio-coder/releases/download/v$rc/install.sh"
				fi
			fi
			;;
	esac
	if ! get "$url" "$file"; then get https://github.com/iowarp/clio-coder/releases/latest/download/install.sh "$file"; fi
	# Older released installers preserve a pin on a plain rerun. A channel spec
	# explicitly releases it, including the default hosted upgrade to latest.
	if [ -z "$version" ]; then set -- "$@" --version "$channel"; fi
	sh "$file" "$@"
}
main "$@"
