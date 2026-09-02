# Clio trace viewer

A small, local-only, read-only web view over Clio's durable trace mirror. It
uses Node's HTTP and SQLite APIs plus a no-build browser client; no framework,
bundler, WebSocket, or network dependency is involved.

From a source checkout:

```sh
clio-coder trace ui --db /path/to/trace.sqlite
# or
npm run trace:ui -- --db /path/to/trace.sqlite --port 4600
```

The server binds only to `127.0.0.1`. It accepts GET/HEAD, opens the database
with SQLite's read-only flag, refuses unknown schema versions, and serves the
rowid-cursor polling contract from `docs/architecture/trace-store.md`. The browser polls a
running run every 500 ms; finished history uses the same API and reducer.

The viewer reads `trace.sqlite` plus two read-only sidecars beside it in the
same state directory: `receipts/<runId>.json` and `evidence-index.json`, which
carry the post-run provenance the mirror does not hold. A database copied away
from its state directory simply has neither, and the receipt panel says so. The
viewer never writes or archives a run, mutates a sidecar, signals a process,
contacts an external service, or binds to a remote interface. `apps/` is
intentionally absent from the published npm artifact, so the launcher is a
source-checkout development surface.
