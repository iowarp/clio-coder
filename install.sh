#!/bin/sh
# The site delegates to the released installer so a site redeploy is never an upgrade prerequisite.
main() {
	set -eu
	url=https://github.com/iowarp/clio-coder/releases/latest/download/install.sh
	file=$(mktemp "${TMPDIR:-/tmp}/clio-coder-install.XXXXXXXX")
	trap 'rm -f "$file"' EXIT HUP INT TERM
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$url" -o "$file"
	else
		wget -q "$url" -O "$file"
	fi
	sh "$file" "$@"
}
main "$@"
