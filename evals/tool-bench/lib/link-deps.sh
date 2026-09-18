#!/bin/sh
# Runner step for the tool-bench suites. The eval runner copies the checkout
# into a temp workspace, and the suite leaves src and node_modules out of that
# copy. CLIO_CODER_ENTRY is the --clio-coder-entry path (the candidate build),
# and the checkout that holds it supplies both through symlinks. The driver's
# relative import of ../../../src therefore reaches the candidate's source,
# Node resolves it to the same real paths on every task so the tsx transform
# cache stays warm, and the per-task copy stays small. A workspace that
# already has either entry keeps it.
set -eu
if [ -z "${CLIO_CODER_ENTRY:-}" ]; then
	echo "tool-bench: CLIO_CODER_ENTRY is unset; run through clio-coder eval run" >&2
	exit 2
fi
root="$(cd "$(dirname "$CLIO_CODER_ENTRY")/../.." && pwd)"
if [ ! -d "$root/node_modules/tsx" ] || [ ! -f "$root/src/tools/agent-tools.ts" ]; then
	echo "tool-bench: $root is not a Clio Coder checkout with node_modules; pass --clio-coder-entry <checkout>/dist/cli/index.js" >&2
	exit 2
fi
for name in src node_modules; do
	if [ ! -e "$name" ]; then
		ln -s "$root/$name" "$name"
	fi
done
