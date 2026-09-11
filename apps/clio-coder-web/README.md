# Clio Coder web

The checkout application serves a local toolchain inventory, pinned installation
with streamed progress, vendored-tool removal, a trace explorer, documentation search, and workspace
sessions backed by supervised Clio ACP children. The CLI, TUI, and ACP continue
to run independently. The packaged `clio-coder web` command belongs to R1.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter @iowarp/clio-coder-web build
pnpm --filter @iowarp/clio-coder-web start
```

Open the full loopback URL printed by the server, then choose **Toolchain** or
**Traces**, or choose **Sessions** to open a workspace by absolute path, start a
conversation, or load a saved session. Up to four sessions can be open at once.
Permission cards offer one-time allow or reject. Unanswered cards escalate after
45 seconds and cancel the turn after 10 minutes. Session controls include cancel,
labels, safe settings, autonomy, target probes, and confirmed deletion of closed
sessions; fleet activity and evidence-ready facts stream alongside the conversation. Trace history includes server-side filters and pagination, run details,
phase timelines, event payloads, gates, processes, receipts, and live tails. Trace
reads use your configured Clio state directory; a missing database shows an empty
state. Receipt summaries omit large payload fields until you request the full receipt.
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
tests, the Vite build, and the Chrome/Axe browser smoke. Tests prohibit uninjected fetches and use isolated
homes. OpenAPI generation uses the same route table as the handlers and typed
client; tests reject semantic drift in the checked-in JSON.

`pnpm --filter @iowarp/clio-coder-web smoke:browser` uses Chrome at
`/usr/bin/google-chrome`; pass `--chrome=/absolute/path` to override it. The smoke
runs against isolated app/ACP fixtures at 1600, 1050, and 390 px, blocks external
requests, checks accessibility and page overflow, and writes its report and
screenshots to `dist/smoke/`. It requires a current client build. The application
has light/dark themes, a keyboard-accessible mobile navigation dialog, and a
shared safe Markdown, code, and diagram renderer; [DESIGN.md](DESIGN.md) records
the retained rules. Fonts are served locally.

The server binds only `127.0.0.1`. A random 256-bit token is printed in the URL
fragment, moved into the tab's session storage, and removed from the address bar.
API requests require bearer authentication; EventSource uses the same token in
its query because it cannot set an Authorization header. Host and Origin are
checked; static files have realpath containment and a content security policy.
Choose **Docs** for the shipped reference tree and local search. Markdown page
links stay inside the app; blueprints are available when `docs/html/` exists in
the package (normally a source checkout). Blueprint pages run in a sandboxed
origin and cannot read the app token. The documentation index refreshes on server
restart. Unavailable source references are shown as text with an explanation.

Chat Markdown is rendered as React elements: raw HTML stays text, images are not
fetched, and only HTTP, HTTPS, and mailto links are active. Prism produces token
trees; strict Mermaid output is sanitized before SVG mounting. The CSP permits
inline styles for those diagrams while scripts, connections, and fonts remain
same-origin.
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
Session deltas use a shared revision buffer so a late snapshot cannot duplicate
or erase newer streamed text. Text items are bounded to 64 KiB, the visible
timeline to 2 MiB / 2,048 items, and turn summaries to 128. Permissions retain 32
cards and fleet activity 128 facts; pending client deltas share the 8 MiB / 4,096
entry bound. The server retains 16 closed session snapshots plus active sessions.

Recent workspaces and child ownership records live under `<state>/web/`.
On restart, only a recorded ACP child with a matching birth token and a proven
dead owner can be terminated. Other live servers sharing the state directory
retain their children. Reconciliation never edits Clio session ledgers.

`pnpm --filter @iowarp/clio-coder-web test:acp-real` drives the built CLI against
a local OpenAI-compatible fixture in a scratch home. It includes durable session
load/replay and records real child RSS/boot measurements. It is separate from the
network-disabled default test lane.

See [SPRINT.md](SPRINT.md) for canonical status,
[the S1 implementation handoff](notes/2026-09-11-S1.md) for acceptance evidence,
and [the S1 closeout](notes/2026-09-11-S1-closeout.md) for the approved CI checker
update and final verification. [S2 evidence](notes/2026-09-11-S2.md) records trace
coverage and browser checks. [S3 evidence](notes/2026-09-11-S3.md) records session
and process-lifecycle verification. [S4 evidence](notes/2026-09-11-S4.md) records
permission/control verification and measured reconnect behavior. [S5 evidence](notes/2026-09-11-S5.md)
records renderer, design, and browser accessibility verification. [S6 evidence](notes/2026-09-11-S6.md)
records documentation, link and blueprint checks. S1-S6 are complete; S7a adds
read-only layered settings and customization inspection.
