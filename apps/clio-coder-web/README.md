# Clio Coder web

The S1 checkout application serves a local toolchain inventory, pinned installation
with streamed progress, and vendored-tool removal. The CLI, TUI, and ACP continue
to run independently. The packaged `clio-coder web` command belongs to R1.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter @iowarp/clio-coder-web build
pnpm --filter @iowarp/clio-coder-web start
```

Open the full loopback URL printed by the server, then choose **Toolchain**.
`--port 4317` selects a port; the default is an ephemeral port. Ctrl+C or SIGTERM
closes the listener and both domain workers. Starting without a client build
prints the build command and exits with failure.

To try the complete installation flow without touching your Clio installation:

```sh
pnpm --filter @iowarp/clio-coder-web start --fixture
```

Fixture mode creates a fresh temporary Clio home, clears PATH in the workers,
and substitutes a fabricated Herdr binary and license. Install Herdr, watch the
progress, and remove its vendored copy. Yazi and Croc remain visible, but fixture
mode refuses their downloads. The temporary home is removed on graceful shutdown.

For client development, run these in two terminals after the first build:

```sh
pnpm --filter @iowarp/clio-coder-web dev:server
pnpm --filter @iowarp/clio-coder-web dev:client
```

The server uses port 4317 and Vite uses port 4318. Open the printed launch link
with its port changed to 4318, retaining the token fragment. The Vite proxy
rewrites its own development Origin to the backend Origin; unrelated origins
remain subject to the backend's rejection.

```sh
pnpm --filter @iowarp/clio-coder-web verify
pnpm --filter @iowarp/clio-coder-web openapi
pnpm run test:web
```

`verify` checks server and browser TypeScript, root Biome rules, the app's Node
tests, and the Vite build. Tests prohibit uninjected fetches and use isolated
homes. OpenAPI generation uses the same route table as the handlers and typed
client; tests reject semantic drift in the checked-in JSON.

The server binds only `127.0.0.1`. A random 256-bit token is printed in the URL
fragment, moved into the tab's session storage, and removed from the address bar.
API requests require bearer authentication; EventSource uses the same token in
its query because it cannot set an Authorization header. Host and Origin are
checked; static files have realpath containment and a content security policy.
The toolchain adapter admits only registry download/document URLs before calling
its fetcher; upstream redirects follow the root installer's download behavior,
and the domain verifies all asset and document checksums. Process creation enters
`server/process-policy.ts`; source imports enter the explicit Clio shims and
worker-only adapters. These are code-level controls; Node permission-mode
evaluation is S9.

Operations and idempotency keys live for this server epoch. At most 256 completed
snapshots are retained in completion order, while active operations are retained.
An evicted operation's key still maps to its original id, preventing a duplicate
mutation within the epoch; its snapshot returns 404. Progress is bounded to 256
entries and 64 KiB. Installs and removals have no cancel control because the
underlying domain APIs cannot interrupt their synchronous work. Worker deadlines
return an unavailable problem without pretending that synchronous work stopped.

SSE retains at most 4,096 envelopes and 8 MiB, supports cursor replay and resync,
and closes a slow connection after its queued bytes exceed a full replay plus a
512 KiB live burst. The S1 client refetches operation snapshots on progress and
uses revisions to keep a late response from replacing a newer terminal record.
Sessions will add their own projection buffer/replay rules in S3.

See [SPRINT.md](SPRINT.md) for canonical status,
[the S1 implementation handoff](notes/2026-09-11-S1.md) for acceptance evidence,
and [the S1 closeout](notes/2026-09-11-S1-closeout.md) for the approved CI checker
update and final verification. S1 is complete; S2 is the next slice.
