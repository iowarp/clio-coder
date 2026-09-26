---
title: "Apps clio coder gui server"
summary: "The loopback Node.js backend that supervises ACP sessions, runs the Clio CLI, offloads blocking work to worker threads, and persists state for the Clio Coder GUI."
sources:
  - "apps/clio-coder-gui/server/main.ts"
  - "apps/clio-coder-gui/server/app.ts"
  - "apps/clio-coder-gui/server/acp/supervisor.ts"
  - "apps/clio-coder-gui/server/process-policy.ts"
  - "apps/clio-coder-gui/server/worker/host.ts"
  - "apps/clio-coder-gui/server/launcher/background.ts"
  - "apps/clio-coder-gui/server/services/targets-cli.ts"
  - "apps/clio-coder-gui/server/services/cli-runner.ts"
  - "apps/clio-coder-gui/server/clio/adapters/settings-controls.ts"
  - "apps/clio-coder-gui/server/state/files.ts"
  - "apps/clio-coder-gui/server/network-policy.ts"
tests:
  - "apps/clio-coder-gui/tests/boundaries.test.ts"
  - "apps/clio-coder-gui/tests/worker-rpc.test.ts"
  - "apps/clio-coder-gui/tests/process-policy.test.ts"
  - "apps/clio-coder-gui/tests/targets-http.test.ts"
  - "apps/clio-coder-gui/tests/background.test.ts"
invariants:
  - "Only server/process-policy.ts may spawn child processes or start worker threads; only server/local-server.ts may import node:http."
  - "Root src/** is reachable from the GUI server only through the allowlisted seam server/clio/http-shims.ts or the allowlisted adapters in server/clio/adapters/**."
  - "Blocking reads run on at most four read lanes; mutations run on exactly one ops lane so writes stay strictly serial."
  - "The HTTP listener binds 127.0.0.1 and rejects any request whose Host or Origin differs from that loopback listener."
  - "Every ACP child is recorded in a durable ownership file and can be reaped by a later process that proves the owner is dead."
  - "CLI argv is drawn from a closed command table; no generic command or extra-argument escape hatch exists."
validate:
  - "pnpm --filter @iowarp/clio-coder-gui test"
---

# Apps clio coder gui server

`apps/clio-coder-gui/server` is the Node.js backend for the Clio Coder GUI. It serves a loopback HTTP API under a bearer token, supervises one child process per open AI session over the ACP protocol, runs the Clio CLI as subprocesses for target and routing operations, offloads blocking reads and mutations to worker threads, and persists recent workspaces and ACP ownership records with a Lamport bakery lock. The frontend client is a separate concern; this directory owns the request surface, the process lifecycle, and the bridge into the root `src/**` engine.

## Entry point and composition

The process enters through `main()` in `apps/clio-coder-gui/server/main.ts`. It first parses `process.argv` with `serverOptions` from `apps/clio-coder-gui/server/options.ts`, which validates `--port`, `--token`, `--persistent`, `--idle-exit`, and `--reuse-background` and refuses incompatible combinations. Three launch modes branch before any HTTP server exists:

- `background` subcommand dynamically imports `apps/clio-coder-gui/server/launcher/background.ts` and installs a systemd user service.
- `launcher` subcommand dynamically imports `apps/clio-coder-gui/server/launcher/install.ts` to write a desktop entry.
- otherwise, the server runs in the foreground.

The foreground path constructs the collaborators in `main()`: two `WorkerHost` instances (`reads` and `ops`), an `EventHub`, an `OperationRegistry`, an `AppFiles` state store, a `WorkspaceService`, and a `Supervisor`. It then calls `createApp` from `apps/clio-coder-gui/server/app.ts` to build a Hono application and hands it to `serve` from `@hono/node-server`, bound to hostname `127.0.0.1` and the requested port. `main()` installs an `IdleExit` timer, a `request` listener that holds the idle counter for each response, and `SIGINT`/`SIGTERM` handlers that call `close()`, which tears down the supervisor, CLI runner, and worker lanes.

`serverOptions` also enforces that `--persistent` cannot be combined with `--port`, `--token`, `--idle-exit`, `--fixture`, or `--open`; a persistent background app takes all of those from its configuration file.

## The HTTP app

`createApp` in `apps/clio-coder-gui/server/app.ts` wires the request surface. It applies the `auth` middleware from `apps/clio-coder-gui/server/http/auth.ts` to every path, a 64 KiB `bodyLimit` to `/api/*`, and a `problemResponse` error handler. The middleware checks three things before any route runs: the `Host` header must equal the configured loopback origin, the `Origin` header (if present) must match, and every `/api/*` request must carry the bearer token via `Authorization` or, on streaming routes, a `token` query parameter. Token comparison uses `timingSafeEqual`. Security headers from `apps/clio-coder-gui/server/http/security-headers.ts` are set on the request and re-asserted on the settled response so a downstream handler cannot weaken them.

Each route is registered with the `register` helper in `apps/clio-coder-gui/server/http/validate.ts`, which validates query, body, and params against the TypeBox schemas in `apps/clio-coder-gui/contracts/routes.ts`. On non-GET requests it additionally requires an `Idempotency-Key` header and an `application/json` content type, and it stamps `Date`, `X-Clio-Epoch`, and `X-Clio-Seq` response headers from the `EventHub`. The helper does not emit events itself; handlers that mutate state call `hub.publish` directly. The full route table is in `routes.ts`: `/api/meta`, `/api/openapi.json`, `/api/events` (SSE), `/api/workspaces`, `/api/workspaces/:id/targets`, `/api/sessions`, `/api/sessions/:id/turns`, and dozens more. A catch-all at the end returns 405 for a known route with the wrong method and 404 otherwise.

The SSE endpoint, implemented in `apps/clio-coder-gui/server/http/sse.ts`, subscribes to the `EventHub` and writes events as Server-Sent Events. It supports a `Last-Event-ID` or `?after=` cursor for replay, a 15-second heartbeat, and a queue cap of 8 MiB plus 512 KiB per subscriber; exceeding it aborts the stream.

## Worker architecture

`WorkerHost` in `apps/clio-coder-gui/server/worker/host.ts` owns the threads that touch the root engine. Reads and mutations are separated by design: the constructor accepts a `WorkerKind` of `"reads"` or `"ops"`, and the lane limit is `Math.max(2, Math.min(4, availableParallelism() - 1))` for reads but exactly 1 for ops, because "Mutations stay strictly serial: one ops lane is the ordering guarantee." A single read lane made every read a head-of-line queue, so a 25-second interop walk blocked docs, traces, and settings; lanes are spawned on demand up to the bound.

`WorkerHost.call()` rejects when the pending queue reaches 64 (`"unavailable", "Domain worker queue is full or closed"`). Each call carries a deadline. The deadline accounting is deliberate: a queued call is armed with `Math.max(budgetMs, QUEUE_WAIT_MS)` so a wedged lane cannot hold a request open forever, but once the call is dispatched onto a lane the timer is re-based to the full budget. This means a call spends its deadline on its own work, not on the call ahead of it. When a lane worker errors or exits, the `fail` handler removes the lane, rejects only the active call with `"Domain worker exited"`, and re-dispatches the still-queued calls onto a fresh lane.

The worker entrypoints are `apps/clio-coder-gui/server/worker/reads-main.ts` and `apps/clio-coder-gui/server/worker/ops-main.ts`. Both call `restrictNetwork()` from `apps/clio-coder-gui/server/network-policy.ts`, which replaces `globalThis.fetch` with a function that throws and returns the original fetch for pinned tool downloads. They dispatch on `call.method` and dynamically import the adapter modules. The method-to-adapter mapping is declared in `apps/clio-coder-gui/server/worker/protocol.ts` under `Methods`; `reads-main.ts` handles `tools.list`, `docs.read`, `settings.read`, `traces.read`, `sessions.list`, and the like, while `ops-main.ts` handles `tools.install`, `tools.remove`, `library.plan/apply/release`, and `settings.write`.

## ACP supervision

The `Supervisor` in `apps/clio-coder-gui/server/acp/supervisor.ts` owns one child process per open session. `open(workspaceId, existingId)` resolves the workspace via `WorkspaceService`, spawns the child with `startAcpChild` from `apps/clio-coder-gui/server/process-policy.ts`, records the child in a `ChildrenFile`, creates an `AcpClient`, and wires notification and request handlers for `session/update`, `session/request_permission`, and the `_clio-coder/event` fleet events. The supervisor caps concurrency at `capacity` (default 4) and tracks `starting`, `opening`, `controls`, `loading`, and `reapers` in the `busy` getter.

A 200 ms `setInterval` monitor (`this.monitor`) scans entries and calls `retireDetached` when a client transport closes without an in-flight turn, so a crashed child is reaped even if no request is outstanding. `reconcile()` runs at startup and walks the `ChildrenFile`; for each row whose owner process is dead (`orphan`), it records an `unknown` session snapshot and schedules a `reap`, which signals `SIGTERM` and waits up to 2.5 seconds before escalating to `SIGKILL`.

`startTurn` begins a turn, `begin` publishes a `turn.started` event, and `finish`/`failTurn` publish `turn.finished`. The `update` handler projects ACP `session/update` frames into timeline items, clamping text with `boundedText` and treating tool-progress frames as replacements rather than appends. Unknown `sessionUpdate` kinds are logged and dropped rather than throwing, because a newer engine's frame should not kill a live session.

The `AcpClient` in `apps/clio-coder-gui/server/acp/client.ts` speaks JSON-RPC over a stdio transport. `initialize` sends `clientInfo` and `clientCapabilities` (including the `clio-coder/events` kinds and a `clio-coder/toolProgress` opt-in), and `readCapabilities` reads the agent's `agentCapabilities` leniently, treating any extension that fails to parse as off rather than as a failure. `prompt` uses a 24-hour timeout and projects the `stopReason` and usage.

## Process policy chokepoint

`apps/clio-coder-gui/server/process-policy.ts` is the single chokepoint for every child process and worker thread the app creates. The boundary test `apps/clio-coder-gui/tests/boundaries.test.ts` fails any production file that imports `node:child_process`, `node:worker_threads`, or the `createStdioTransport` ACP transport outside this module. The exported functions are:

- `startDomainWorker(kind, settings, env, compiledDirectory)` — creates a `node:worker_threads.Worker` from `reads-worker.js` or `ops-worker.js` (or the source entry in dev).
- `startAcpChild(cwd, env)` — resolves the Clio command and returns a stdio transport running `acp --cwd <path> --permission-timeout 605000`.
- `resolveClioCommand(env)` — honors `CLIO_CODER_WEB_CLI`, then `dist/cli/index.js` in the checkout, then `clio-coder` on `PATH`.
- `runClioCommand(command, cwd, env)` — spawns the CLI with `detached: true` on POSIX so the child owns a process group.
- `stopClioCommand(child, birthToken, signal)` — signals the child or its process group, rechecking the birth token.
- `childRunning(pid)` — on Linux reads `/proc/<pid>/stat` to distinguish a zombie from a live process.
- `openBrowser(url, env)` — spawns `xdg-open` or `open` with a 10-second kill timer.
- `controlService(action, unit, unitFile, env)` — runs `systemctl --user` with a 20-second kill timer and a 64 KiB output cap.

`browserCommand` refuses to open anything other than a loopback `http://127.0.0.1:<port>` URL and throws on Windows until a native launcher is verified.

## CLI runner and target service

`CliRunner` in `apps/clio-coder-gui/server/services/cli-runner.ts` runs the Clio CLI as a subprocess. It caps concurrency at 4 jobs, applies a 60-second timeout, streams stdout and stderr with byte caps (8 MiB for stdout, 256 KiB for stderr), and escalates `SIGTERM` to `SIGKILL` after 1 second. The argv comes from `commandPlan` in `apps/clio-coder-gui/server/cli-commands.ts`, a closed switch statement that maps a `CliCommand` schema to a fixed argv array. There is no generic command or extra-argument escape hatch; an unknown `kind` throws a validation problem.

`TargetsService` in `apps/clio-coder-gui/server/services/targets-cli.ts` composes `CliRunner` with the `OperationRegistry`. `list` calls `targets.list` and passes the result through `projectTargets`, which sanitizes the inventory: `safeUrl` strips credentials, query, and hash from URLs; `text` truncates to 256 characters; and the rows are capped at 200. `mutate` and `add` create operations whose `fingerprint` is a SHA-256 of the canonicalized input, giving idempotency. `runtimes` and `routing` read the runtime inventory and offline model bindings.

## Background service

`apps/clio-coder-gui/server/launcher/background.ts` manages a systemd user service for the persistent GUI. `installBackground` verifies the target directory is private (`0o700`), canonical (not a symlink), and owned by the current user, then atomically writes a configuration file, a systemd unit, and an ownership manifest into a staging directory before renaming it into place. The manifest hashes the config and unit so a later `owned` check can prove no one has modified the files. `backgroundStatus`, `startBackground`, `stopBackground`, `uninstallBackground`, and `tryStartBackground` all re-verify ownership before acting. `serviceState` compares the `FragmentPath` returned by `systemctl show` to the expected unit file, refusing to touch a service that a different package claims.

## State persistence

`AppFiles` in `apps/clio-coder-gui/server/state/files.ts` stores `workspaces.json` and `children.json` under the state directory with a Lamport bakery lock. `update` publishes a token with `choosing: true`, reads the peers to assign a ticket, publishes again with `choosing: false`, and waits for every earlier `(ticket, id)` pair to finish, polling every 10 ms with a 5-second deadline. Dead owners are detected with `ownerDead`, which checks `processAlive` and the process birth token, and their lock files are unlinked. The actual write is atomic: a temporary file is written and renamed over the target.

`ChildrenFile` in `apps/clio-coder-gui/server/acp/children-file.ts` wraps `AppFiles` with the ACP ownership row. `orphan` is true when the owner process is dead, and `reap` rechecks both the owner and child birth tokens immediately before each signal so a reused PID cannot be killed.

## Events and operations

`EventHub` in `apps/clio-coder-gui/server/services/event-hub.ts` keeps an in-memory ring of 4096 events or 8 MiB, whichever fills first, with a monotonically increasing `seq` and a process-wide `epoch`. `connect` subscribes and replays in one synchronous step so no event can fall between them; a cursor from a different epoch or an evicted sequence triggers a `resync` control event.

`OperationRegistry` in `apps/clio-coder-gui/server/services/operations.ts` tracks long-running operations with idempotency. `create` builds a key from `[kind, scope, key]` and a fingerprint from the canonicalized input; a second create with the same key but a different fingerprint is a conflict. Operations run on a microtask, and progress lines are capped at 256 or 64 KiB per operation. Terminal operations are retained up to 256 or 16 MiB, then evicted oldest-first.

## Settings adapters

`readSettingsControls` and `writeSettingControl` in `apps/clio-coder-gui/server/clio/adapters/settings-controls.ts` are the only way the GUI reads and writes settings. They sit on top of the engine's `SETTING_CONTROLS` registry and the layered settings store. The file declares a `HIDDEN` list of paths the browser must not show, a `READ_ONLY` list with reasons (file paths and terminal-only settings), a `NOTES` map of ACP-specific caveats, and a `CONFIRM` map of destructive settings that require an explicit confirmation. Writes land in the user layer only, and a write that the engine rejects with a higher-precedence conflict is reported as a conflict problem.

## Boundaries and security

`apps/clio-coder-gui/tests/boundaries.test.ts` is the enforcement point. It parses every production TypeScript file in the GUI app and fails on:

- a direct import of `node:http`, `node:child_process`, or `node:worker_threads` outside the pinned modules;
- a root `src/**` import that is not `apps/clio-coder-gui/server/clio/http-shims.ts` (with only the allowlisted symbols) or an `server/clio/adapters/**` module (from the allowlist);
- a test dependency outside the fixture-enabled worker entrypoints;
- a blocking adapter import outside a worker entry.

`apps/clio-coder-gui/server/clio/http-shims.ts` re-exports a fixed set of symbols from root `src/**` — `resolvePackageRoot`, `processAlive`, `processBirthToken`, `resolveClioDirs`, `getVersionInfo`, and the ACP transport and error classes — and is the only seam through which the GUI touches the engine.

## Extension points

- **New HTTP route**: define the schema in `apps/clio-coder-gui/contracts/routes.ts`, then register it in `createApp` in `apps/clio-coder-gui/server/app.ts`. The `register` helper validates the input and emits an SSE event.
- **New worker method**: add a key to `Methods` in `apps/clio-coder-gui/server/worker/protocol.ts`, then handle it in `reads-main.ts` or `ops-main.ts` and import the adapter. The adapter must be reachable only through the allowlist in `boundaries.test.ts`.
- **New settings control policy**: edit the `HIDDEN`, `READ_ONLY`, `NOTES`, or `CONFIRM` lists in `apps/clio-coder-gui/server/clio/adapters/settings-controls.ts`. The paths come from the engine's `SETTING_CONTROLS`, so a leaf added to the schema appears in the browser automatically unless explicitly hidden.
- **New CLI command**: add a `kind` to the `CliCommand` union in `apps/clio-coder-gui/server/cli-commands.ts` and a case to `commandPlan`. This is the only place a CLI argv may be invented; there is no generic escape hatch.
- **New background operation**: add a subcommand in `background()` in `apps/clio-coder-gui/server/launcher/background.ts`, calling the existing `installBackground`, `backgroundStatus`, `startBackground`, etc.

## Focused tests

- `apps/clio-coder-gui/tests/boundaries.test.ts` — parses the entire GUI source tree and asserts no direct socket, process, or worker access outside the chokepoints and no root import outside the seams.
- `apps/clio-coder-gui/tests/worker-rpc.test.ts` — asserts that 65 concurrent reads overflow the 64-call queue with a retryable 503; that an expired synchronous read keeps capacity until completion; that a crashed worker fails pending reads and restarts; that two warm lanes overlap two 120 ms reads; and that a queued read spends its deadline on its own work.
- `apps/clio-coder-gui/tests/process-policy.test.ts` — asserts that the pinned fetcher refuses URLs outside the allowlist before the injected fetcher is called; that static assets refuse a symlink escape; and that the checkout launcher binds loopback, serves authenticated meta, and exits on SIGTERM.
- `apps/clio-coder-gui/tests/targets-http.test.ts` — exercises real CLI `use`/`remove` through the HTTP surface, verifies idempotent operation keys, redaction of secrets, and probe cancellation that reaps the child.
- `apps/clio-coder-gui/tests/background.test.ts` — installs a background service in a temp directory, verifies the stable port and token survive re-install, refuses a foreign port change, and proves that uninstall removes only files whose ownership matches the manifest hash.

## Things to watch when editing

- **Chokepoint rules are enforced by `boundaries.test.ts`.** Adding a `spawn`, a `Worker`, or a `request` outside the pinned modules fails CI. Route new process creation through `process-policy.ts` and new network access through the pinned downloader.
- **The Lamport bakery lock in `AppFiles` is not a mutex.** It serializes updates by ticket, and a 5-second deadline throws `"Web state is busy"` when the lock is held too long. Adding a new durable file means adding a new `name` to the `read`/`update` methods and the lock directory layout.
- **Worker deadline accounting is deliberately non- FIFO.** A call spends its deadline on its own work, not on the wait. Changing the `arm` or `dispatch` logic in `WorkerHost` can reintroduce the head-of-line blocking that lanes were added to fix.
- **`restrictNetwork` replaces `globalThis.fetch`.** Any adapter that needs network access must receive the saved fetch from `restrictNetwork` and route through the pinned downloader; a bare `fetch` call in a worker throws.
- **CLI argv is closed.** `commandPlan` is the only place an argv array is invented. Adding a new CLI invocation means adding a new `kind` to the `CliCommand` union and a new case to the switch; there is no way to pass through arbitrary arguments.
- **The background service is ownership-gated.** `owned` verifies the manifest hash of the config and unit. Editing the unit file or config after install makes every subsequent operation throw until the hashes are recomputed.
- **`exactOptionalPropertyTypes` is on** in the root `tsconfig.json`. When building objects for ACP or settings, pass optional fields with `...(x !== undefined ? { x } : {})`, never `x: undefined`.

<!-- clio-coder:wiki unresolved sources: src/** -->
