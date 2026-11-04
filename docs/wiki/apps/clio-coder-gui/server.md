---
title: "GUI server"
summary: "How the local GUI server starts, owns its domain worker threads, child processes, and path completion, and how the background launcher reuses it. Read this before changing server startup, worker dispatch, ACP child lifecycle, or background install behavior."
sources:
  - "apps/clio-coder-gui/server/main.ts"
  - "apps/clio-coder-gui/server/worker/host.ts"
  - "apps/clio-coder-gui/server/process-policy.ts"
  - "apps/clio-coder-gui/server/acp/client.ts"
  - "apps/clio-coder-gui/server/acp/supervisor.ts"
  - "apps/clio-coder-gui/server/services/path-complete.ts"
  - "apps/clio-coder-gui/server/launcher/background.ts"
symbols:
  - "main"
  - "inspectGuiBackground"
  - "WorkerHost"
  - "startDomainWorker"
  - "startAcpChild"
  - "resolveClioCommand"
  - "runClioCommand"
  - "Supervisor"
  - "AcpClient"
  - "detectPathHost"
  - "parsePathInput"
  - "toServerPath"
  - "preferBackground"
  - "installBackground"
tests:
  - "apps/clio-coder-gui/tests/worker-rpc.test.ts"
invariants:
  - "The worker host admits at most 64 queued calls; a call beyond that is rejected with an unavailable problem, as the HTTP read test asserts with status 503 and Retry-After 1."
  - "Mutating (ops) work runs on a single lane, so ops calls are serialized; reads run on up to a bounded number of lanes."
  - "A queued call's deadline budget starts when it is posted to a ready lane, not when it is enqueued; only the queue wait is bounded at 30 seconds."
  - "Every application-owned worker or child process is created through startDomainWorker or the child spawn helpers in process-policy.ts."
  - "A child signal is sent only when the recorded birth token still matches the live process."
validate:
  - "pnpm run test:file -- apps/clio-coder-gui/tests/worker-rpc.test.ts"
---

# GUI server

The GUI server is the local Node process behind the browser app. A reader needs this page when changing how the server starts, how it hands reads and mutations to worker threads, how it spawns the Clio CLI and ACP agent children, how path completion maps typed paths, or how the background (systemd user) launcher reuses a running server.

This page covers the server entry, the worker host, the process-policy helpers, the ACP client and supervisor, path completion, and the background launcher. The client side is documented in [client](client.md), and server tests are described in [tests](tests.md).

## Entry and composition

`apps/clio-coder-gui/server/main.ts` exports `main`. It reads server options with `serverOptions`, then branches on the first argument:

- `managed-background` and `background` route to `background` in `apps/clio-coder-gui/server/launcher/background.ts`.
- `launcher` routes to `launcher` in `apps/clio-coder-gui/server/launcher/install.ts`.
- Otherwise `main` starts a server.

For a server start, `main` first tries to reuse a background app when `values.reuse` is not `"never"`. With `"required"` it calls `tryStartBackground`; otherwise `preferBackground`. A reused app is printed as a URL and the process returns. With `"required"` and no background app, `main` throws. Only after that does it construct the server.

The server is composed in `main` in this order:

1. `new WorkerHost("reads", ...)` and `new WorkerHost("ops", ...)`, both sharing the same settings and environment.
2. An `EventHub`, an `OperationRegistry`, and an `AppFiles` rooted at the state directory (a scratch directory when `--fixture` is set).
3. A `WorkspaceService`, then a `Supervisor`, which calls `supervisor.reconcile()` before the server listens. If reconciliation fails, the supervisor and both worker hosts are shut down and the error is rethrown.
4. Service instances (`SessionService`, `CliRunner`, `SettingsService`, `SetupService`, and the rest) passed to `createApp`.

Listening uses `createAdaptorServer` bound to `127.0.0.1`. A persistent background app tries `listenPorts(port)` in order and moves to the next candidate on `EADDRINUSE`. A private server only uses its requested port. Shutdown (`close`) stops the idle timer, removes the signal handlers, closes the server, and then shuts down the supervisor, CLI runner, setup service and both worker hosts before removing any scratch directory and writing a final lifecycle log line.

`inspectGuiBackground` calls `inspectBackground` from `apps/clio-coder-gui/server/launcher/background.ts` with the state directory under `gui/background`.

## Worker host

`apps/clio-coder-gui/server/worker/host.ts` defines `WorkerHost`. The class exists because read adapters are synchronous and import the root `src/**` tree, so a single thread would serialize every read. The file's own comment describes the trade-off.

Key parameters and limits, as read in the source:

- Read lanes: `READ_LANES` is `max(2, min(4, availableParallelism() - 1))`. The `reads` kind uses `max(1, settings.readLanes ?? READ_LANES)` lanes. The `ops` kind is fixed to one lane.
- Queue: a call is rejected with an `unavailable` problem when the host is closed or when `pending.size >= 64`.
- Budget: the default deadline is 10 000 ms for reads and 900 000 ms for ops. Fixture reads can override the read budget with `readDeadlineMs`.
- Queue wait: a queued call is armed with `max(budgetMs, QUEUE_WAIT_MS)`, where `QUEUE_WAIT_MS` is 30 000 ms.

Dispatch and start:

- `call` records a pending entry with an id and posts it through `dispatch` once a lane is free.
- `lane()` returns an idle lane if one exists. Otherwise it spawns a new lane when below the limit and returns `undefined`, so the waiting call is picked up by the next dispatch when the warmed lane is ready.
- `start(lane)` runs only once the lane has sent its `ready` message. It sets `started`, re-arms the timer with the call's own budget, rebases `deadlineMs`, and posts the call to the worker.

Expiry and failure:

- If the timer fires before a call starts, the call is rejected, its lane is freed, and it is removed from the queue. If it already started, it is marked expired and the caller gets an error while the worker keeps running the synchronous work.
- A worker `error` or `exit` removes the lane. Only the call that lane was executing fails with "Domain worker exited"; queued calls are re-dispatched on a fresh lane.
- `close` rejects everything pending with "Server is stopping." Ready lanes receive `{ shutdown: true }` and get up to 3 seconds to acknowledge before termination. Unready lanes are terminated directly.

Focused tests in `apps/clio-coder-gui/tests/worker-rpc.test.ts`:

- "65 concurrent HTTP reads overflow the 64-call queue with a retryable problem" uses `harness({ readDelayMs: 20 })`, sends 65 requests to `/api/toolchain/tools`, and asserts at least one 503 with code `unavailable` and `Retry-After: 1`, plus exactly 64 successes.
- "expired synchronous read is discarded, keeps capacity until completion, and later reads work" uses `readDelayMs: 100` and a 15 ms deadline. It asserts the rejection message matches `exceeded its deadline`, `pendingCount` stays 1 until the work completes, and a later call succeeds.
- "worker exit fails pending reads and the next call restarts the worker" sets `crashRead: true` and asserts `worker exited`, then clears the flag and asserts the next call succeeds.
- "warm read lanes overlap" uses `readLanes: 2` and two 120 ms reads, asserting `laneCount` is 2 and the second pair finishes in under 240 ms.
- "a queued read spends its deadline on its own work" uses `readLanes: 1` with a 300 ms adapter and a queued call with a 400 ms deadline, asserting it succeeds.
- "HTTP read deadline returns an unavailable problem while the adapter completes" uses `readDeadlineMs: 20` through the harness and asserts a 503 with `unavailable`.

Callers: `main` constructs the hosts; `WorkspaceService`, `SettingsService`, `SetupService`, `ToolchainService`, `TraceService`, and the other services in `server/services/` receive a host and call `host.call(method, params)`. `apps/clio-coder-gui/tests/harness/app.ts` (under `apps/clio-coder-gui/tests/harness/`) also constructs hosts for tests.

## Process policy

`apps/clio-coder-gui/server/process-policy.ts` is where application-owned processes are created. Its header comment says all application process and thread creation enters there.

- `startDomainWorker(kind, settings, env, compiledDirectory)` creates a `Worker`. In a bundled build it loads `reads-worker.js` or `ops-worker.js` from the compiled directory; otherwise it loads `apps/clio-coder-gui/server/worker/source-entry.mjs`. The worker receives `workerData` containing the settings and kind.
- `resolveClioCommand(env)` chooses the Clio CLI. `CLIO_CODER_WEB_CLI` must be an absolute path that resolves to a file; a `.js` or `.mjs` file runs under `process.execPath`. Otherwise it uses `dist/cli/index.js` from the package root, then searches `PATH` for a `clio-coder` executable. If none is found it throws an `unavailable` problem.
- `startAcpChild(cwd, env)` spawns the CLI as `acp --cwd <cwd> --permission-timeout 605000` through `createStdioTransport`. The `cwd` is passed in already canonicalized by `WorkspaceService`.
- `runClioCommand(command, cwd, env)` validates that `cwd` is an existing canonical absolute directory, then spawns the CLI with `shell: false`. The child is detached on non-Windows platforms. It returns the child and a birth token from `processBirthToken`.
- `startConfigureChild(env)` spawns `configure --gui-host` with piped stdin.
- `signalRecordedChild` refuses to signal unless the pid is a safe positive integer, the birth token is not a `pid-` fallback, the live `processBirthToken` matches, and the process is alive. It then signals the process group on non-Windows.
- `stopClioCommand` checks `exitCode` and `signalCode` on the Node `ChildProcess` before signalling.

Callers: `Supervisor` and the ACP client path reach `startAcpChild`; `CliRunner` and the `runClioCommand` users reach the fixed-argv CLI helper; `TargetsService`, `SetupService` and related services use the spawn helpers. This page only verifies the helper definitions and the `Supervisor` constructor call sites in `main`, not every consumer.

## ACP client

`apps/clio-coder-gui/server/acp/client.ts` defines `AcpClient` and the capability reader used during initialization. The reader is intentionally lenient: the protocol version is the only hard gate, and each extension under `agentCapabilities._meta` is parsed with `optional`, which uses `Value.Clean` and `Value.Check` and returns `undefined` for anything that does not match. A missing or unparseable extension turns that feature off rather than failing the session.

`readCapabilities(result)` maps the agent's initialize result to an `AgentCapabilities` object. It sets `loadSession`, `mediatedTools`, `images`, `embeddedContext`, a `session` block from `sessionCapabilities` and the session extension, and one key per extension capability (settings, targets, steering, queue, shell, commands, tool progress, decision, events, board, branches, handoff, fleet, jobs, context, artifacts, extensions, aside, interviews, telemetry, library).

`AcpClient` has a constructor at `apps/clio-coder-gui/server/acp/client.ts` that accepts the transport from `startAcpChild` (see `createStdioTransport` in `apps/clio-coder-gui/server/clio/http-shims.ts`). The supervisor reads `entry.client.transport.closed`, `entry.client.capabilities.loadSession`, and `entry.client.pending`, so those fields are the interface the supervisor depends on.

## Supervisor

`apps/clio-coder-gui/server/acp/supervisor.ts` exports the `Supervisor` class. It owns one `Entry` per open session, each holding an `AcpClient`, an optional turn id, interview and worker state, and a parked or resting flag.

- The constructor takes the `WorkspaceService`, `AppFiles`, `EventHub`, the environment, a `turnCapacity` (default 4), optional permission timers, an optional `recover` callback that `main` supplies as `ops.call("sessions.recover", ...)`, and `parkAfterMs` (default `PARK_AFTER_MS`, 5 minutes).
- A 200 ms `setInterval` monitor is unref'd. For each non-closing entry it retires an entry whose transport has closed. It also parks an entry whose last activity is older than `parkAfterMs` and that passes `resting(entry)`.
- `resting` requires that the entry is bound, not already parking or closing, has no turn, no context command, no rebase, no drafting, no pending client calls, no live jobs, no worker work, `loadSession` capability, no configuration in progress, and a snapshot in state `open`.
- `busy` reports true while starts, opens, controls, loads, configuration, or reapers are in flight, or while any entry is busy. `main` uses `supervisor.busy` and `supervisor.restartSafe` to decide idle exit.
- `runningTurns` counts turns that hold a slot; a replayed or queued turn does not. `turnCapacity` limits concurrent turns across all sessions.
- `get` and `list` return structured clones of snapshots; `overview` returns a lighter projection.
- `constants` at the top of the file set timeouts: branch changes 60 seconds, asides 15 minutes, command replies 10 minutes, and the parked snapshot cap of 32 (`PARKED_KEPT`).

`main` calls `supervisor.reconcile()` before listening; the body of `reconcile` was not read for this page.

Coverage gap: the supervisor's turn lifecycle, the `invokeCommand` path, the permission and interview flows, and the resume-from-parked path (`waking`) were not traced. Only the monitor loop, the `resting` predicate, and the public accessors listed above were read.

## Path completion

`apps/clio-coder-gui/server/services/path-complete.ts` maps typed paths for the browser path box. It is pure except for `readdir` and `stat` through the `PathCompleteIo` interface.

- `detectPathHost(env, platform, osrelease)` reports `wsl` when `WSL_DISTRO_NAME` is set, or on Linux when the kernel release matches `microsoft`. The mount root is fixed at `/mnt` in this function.
- `toServerPath(text, host)` maps input to a server path. On a Windows host it resolves `~`, drive letters, and UNC shares. On POSIX it resolves `~`, absolute paths, and, inside WSL only, drive spellings (`C:\...` becomes `/mnt/c/...`) and `\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...` shares. A share of a different distro returns `null`, and a non-WSL POSIX host returns `null` for relative input.
- `parsePathInput(rawInput, host)` splits input into `parentDisplay`, `parentPath`, `partial`, a separator, and a case-sensitivity flag. Case folding is applied when the host is Windows, the input is Windows-styled, or the parent is under the drive mount.
- `commonNamePrefix(names, caseInsensitive)` returns the longest shared prefix, folding case when requested, and uses the first name's casing.
- `PATH_MATCH_LIMIT` is 50.

`WorkspaceService` in `apps/clio-coder-gui/server/services/workspaces.ts` owns the host detection and calls these functions: `complete` passes input to `completePath`, `open` uses `toServerPath` before checking that the result is absolute, and the folder picker maps Windows-spelled results back through `toServerPath` on a non-Windows host.

Focused tests: the search for `parsePathInput`, `toServerPath` and `detectPathHost` across `apps/clio-coder-gui` and `tests` found no direct test file, so the path rules here are source-only evidence.

## Background launcher

`apps/clio-coder-gui/server/launcher/background.ts` manages a Linux systemd user service that keeps the server running at a stable port.

- `preferBackground(directory, packageRoot, ..., platform, version, launch)` returns `absent` on non-Linux platforms and when no state exists. It returns `unavailable` when the state cannot be verified, when the recorded package root belongs to another installation (`sameInstallation` is false), or when starting the service fails. A running app is reported as `open` with its URL and the running version.
- `tryStartBackground` is the direct start used by `--reuse-background`.
- `installBackground(directory, proposed, control, ready, options)` requires Linux. It creates the state directory with mode 0700 and verifies it is canonical and owned by the current user. When an existing install belongs to a different package root, it requires `options.handover` and the same data roots, and refuses while the old app reports active work. It then writes the service unit, enables it, restarts it when the launch moved, waits for the server to report ready, and installs a desktop launcher.
- `backgroundStatus` reports the live port, which may be a fallback from the configured one, along with service state, readiness, idleness, desktop and Windows launcher state.
- `inspectBackground(directory, launch, fix)` can repair a moved launch or an absent desktop entry when `fix` is true.
- `desktopOwned` refuses to replace a desktop entry that does not match what this installation would write.

Focused tests: `apps/clio-coder-gui/tests/background.test.ts` references this module. Its individual cases were not read for this page. `apps/clio-coder-gui/tests/real/background-pwa.test.ts` is outside this package's scope and was not inspected.

Coverage gap: `apps/clio-coder-gui/server/launcher/windows.ts`, the Windows launcher and icon helpers, was not read beyond its export list, and `apps/clio-coder-gui/server/launcher/background.ts` below line 270 (repair and uninstall helpers) was not traced.

## Things to watch when editing

- Keep the ops host at one lane. Its ordering guarantee is the reason `WorkerHost` clamps the ops limit to 1.
- A new application process must go through `startDomainWorker` or one of the spawn helpers in `apps/clio-coder-gui/server/process-policy.ts`, so the birth-token and detached-group rules hold.
- The 64-call queue limit is asserted by the HTTP read test. Changing it changes the expected count in that test.
- `signalRecordedChild` refuses to signal a `pid-` fallback token. Do not weaken this check, because it prevents signalling a recycled pid.
- `readCapabilities` treats unparseable extensions as absent. A new capability needs a schema, a `optional(...)` entry, and a matching `ACP_*_META_KEY`, or the feature stays off silently.
