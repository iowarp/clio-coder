---
title: "Graphical application test suite"
summary: "Describes the tests under apps/clio-coder-gui/tests: the scripted ACP fixture child, the harnesses that launch the server against it or against the real built CLI, and the focused client and server tests. Read this to pick the right harness or to add a case."
sources:
  - "apps/clio-coder-gui/tests/fixtures/acp-fixture-child.mjs"
  - "apps/clio-coder-gui/tests/harness/process-server.ts"
  - "apps/clio-coder-gui/tests/harness/app.ts"
  - "apps/clio-coder-gui/tests/harness/real-acp.ts"
symbols:
  - "processServer"
  - "harness"
  - "realAcpHome"
  - "realCli"
tests:
  - "apps/clio-coder-gui/tests/chat-approval.test.ts"
  - "apps/clio-coder-gui/tests/chat-turns.test.ts"
  - "apps/clio-coder-gui/tests/markdown.test.tsx"
  - "apps/clio-coder-gui/tests/background.test.ts"
  - "apps/clio-coder-gui/tests/real/acp.test.ts"
invariants:
  - "The ACP fixture child speaks newline-delimited JSON-RPC on stdio and selects its behavior from CLIO_CODER_WEB_FIXTURE_SCENARIO, defaulting to text when the variable is unset."
  - "In the fixture child, a permission request resolves to an executed write only when the client answers with optionId allow; any other optionId yields a refused write result with status failed and isError true."
  - "processServer launches server/main.ts with the fixture child as CLIO_CODER_WEB_CLI unless the supplied environment already sets CLIO_CODER_WEB_CLI."
  - "realAcpHome points CLIO_CODER_WEB_CLI at the built CLI entry and the real-ACP test expects an orchestrator-attributed text reply, Hello from the real Clio CLI., from the OpenAI-compatible fixture provider; this requires a prior build."
validate:
  - "pnpm run test:file apps/clio-coder-gui/tests/chat-approval.test.ts"
  - "pnpm run test:file apps/clio-coder-gui/tests/chat-turns.test.ts"
---

# Graphical application test suite

This directory holds the tests for the optional graphical application under `apps/clio-coder-gui`. Most files are focused unit tests of client view models (turn grouping, approval timing, markdown rendering, background launcher configuration). A smaller set exercises the server end to end. Those server tests start the server in a child process and talk to a scripted stand-in for the ACP agent, or, in one case, to the real built CLI. A reader needs this page to choose between the two harnesses, to understand the fixture's scenario switch, or to add a case that depends on the scripted agent.

## Layout

- `apps/clio-coder-gui/tests/fixtures/` holds `apps/clio-coder-gui/tests/fixtures/acp-fixture-child.mjs`, the scripted ACP child, which is the only fixture inspected in depth for this page. The same folder contains other helper children and seed modules (for example `apps/clio-coder-gui/tests/fixtures/stream-workload.mjs`, which the fixture child imports, and `apps/clio-coder-gui/tests/fixtures/cli-command-child.mjs`). Those were not read for this page.
- `apps/clio-coder-gui/tests/harness/` holds the helpers that construct or launch the server. `apps/clio-coder-gui/tests/harness/app.ts` builds the server in process, `apps/clio-coder-gui/tests/harness/process-server.ts` spawns it as a child process, and `apps/clio-coder-gui/tests/harness/real-acp.ts` prepares a scratch home and a fixture provider for the real CLI. Other harness modules (for example `server.ts`, `apps/clio-coder-gui/tests/harness/scratch-home.ts`, and the other seeder modules) were not read for this page; `apps/clio-coder-gui/tests/harness/real-acp.ts` imports `scratchHome` from `apps/clio-coder-gui/tests/harness/scratch-home.ts` and the provider helpers from the repository-level `tests/harness/openai-compat-fixture.ts`.
- `apps/clio-coder-gui/tests/real/` holds end-to-end tests that need the built CLI. `apps/clio-coder-gui/tests/real/acp.test.ts` is inspected here; the other file in that folder was not.
- The top-level files in `apps/clio-coder-gui/tests/` are focused tests. They import client modules under `client/` and server modules under `server/` directly.

## The ACP fixture child

`apps/clio-coder-gui/tests/fixtures/acp-fixture-child.mjs` is a Node script that the server's ACP supervisor runs in place of the real agent. It reads one JSON-RPC frame per line from stdin through `readline` and writes frames to stdout through `send`, which prefixes `jsonrpc: "2.0"`. Its `handle` function dispatches on the frame's method, and it answers requests with a result or, when a branch throws, with a JSON-RPC error whose message is `Fixture refused request`.

The scenario is read once at startup:

```js
const scenario = process.env.CLIO_CODER_WEB_FIXTURE_SCENARIO ?? "text";
```

Scenario names are compared as string literals inside the file. The prompt handler branches on `scenario` and on prompt text. Examples inspected:

- `"permission-mismatch"` changes the `rawInput` of the permission request so that it no longer matches the tool call.
- `"crash"` calls `process.exit(9)` on the first prompt.
- `"slow"` keeps the process alive with an interval and ignores stdin close. Other scenarios exit when stdin closes.
- `"markdown"` routes prompts containing `[approval]`, `[plan]`, `[stream]`, or `[workload` to separate turn behaviors.
- `"tool"` and `"tool-progress-no-content"` emit tool-call updates.
- `"session_limit"` and `"session_cwd_mismatch"` throw from the session handler, which produces a refusal response.

Prompt prefixes `/council `, `/tasks `, `/skill `, and `/context recover ` are also handled before the generic path.

Usage is returned in `_meta["clio-coder/usage"]` as `quantities`. Each quantity carries a `fact` (`measured` with a value, or `unknown` with a reason) and a `display` string, which is the shape the client read model consumes.

### Permission round trip

The `permission()` function in the fixture models a gated write:

1. It emits a `tool_call` update with `title: "write"`, `kind: "edit"`, `status: "pending"`, and `rawInput: { path: "fixture.txt", content: "approved" }`.
2. It registers a resolver in the `pending` map under a `permission-<uuid>` id and sends `session/request_permission` with two options: `allow` (`allow_once`) and `reject` (`reject_once`).
3. The stdin handler resolves the pending entry when the client replies with a matching id, through `pending.get(frame.id)?.(frame.result)`.
4. `executed` is true only when `result?.outcome?.optionId === "allow"`. When `CLIO_CODER_WEB_FIXTURE_LOG` is set, the fixture appends `{ permission, toolExecuted }` to that file.
5. It then sends a settled `tool_call_update` built by `settledWrite`. On execution the status is `completed`, the content text is `Wrote 8 bytes to fixture.txt`, and `rawOutput.result.details.diff` is the constant `APPLIED_DIFF`. On refusal the status is `failed`, `rawOutput.isError` is true, and the text is the constant `REFUSED_TEXT`.
6. Unless the turn was cancelled, it emits `Tool executed.` or `Permission rejected.`.

`planPermission()` follows the same pattern for a plan-scale dispatch, with a fixed `PLAN_HASH` and two tasks (`scout` and `writer`).

The fixture's reply handling matches only by id. Any `optionId` other than `allow` counts as a refusal, so a client that answers `reject` and a client that answers with an unknown id that is still resolved both produce the refused branch.

## Harnesses

### `harness()` in `apps/clio-coder-gui/tests/harness/app.ts`

`harness(settings, options)` builds the server in process. It creates a scratch home, two `WorkerHost` instances (`reads` and `ops`, both with `fixture: true`), an `EventHub`, an `OperationRegistry`, an `AppFiles` store under the scratch home, a `WorkspaceService`, and a `Supervisor`. The supervisor environment sets `CLIO_CODER_WEB_CLI` to the fixture child, `CLIO_CODER_WEB_FIXTURE_SCENARIO` to `options.scenario ?? "text"`, and `CLIO_CODER_WEB_FIXTURE_LOG` to `acp.jsonl` inside the scratch home. It then calls `supervisor.reconcile()` and passes the services to `createApp` with the fixed token `test-token` and origin `http://127.0.0.1:4317`, unless `options.origin` is supplied.

The returned `request` method calls `app.request` with a bearer header carrying a client credential: the first request exchanges the harness's launch token as a browser window does, and later requests reuse that credential. The `post` helper adds a JSON body and an `Idempotency-Key`, generated with `crypto.randomUUID()` unless a key is passed. `client(label, resume)` exchanges again and returns a second client, its credential with its own `request` and `post`, for tests of attribution and session control; `exchange(label, resume)` returns the raw credential or null when the listener refuses. The `options.permissionTimers` argument is forwarded to the `Supervisor` and is the hook the permission timing tests use. `close()` shuts down the supervisor, the CLI runner, and setup, then closes both workers and removes the scratch home.

`terminal(operations, id, timeoutMs)` in the same file polls an operation until its status leaves `queued` and `running`, and throws after the timeout. `json(response, schema)` parses a response body through the server's `parse` validator.

### `processServer()` in `apps/clio-coder-gui/tests/harness/process-server.ts`

`processServer(env)` spawns `node --import tsx` on `apps/clio-coder-gui/server/main.ts`, with the working directory set to the app root. It sets `CLIO_CODER_WEB_CLI` to the fixture child unless the supplied environment already defines it. It waits up to 15 seconds for stdout to match `http://127.0.0.1:<port>/#token=...`, reads the token from the URL fragment, and returns `child`, `url`, `pid`, `request`, `post`, and `close`. A startup failure rejects with the captured stderr, and an early exit rejects as well. `close(signal)` sends the signal (`SIGTERM` by default) and waits for the exit event.

The file's own inline comments name the child process and fixture usage only as the code does; the scenario used by a given test is controlled through the environment passed in.

Tests that need the real process boundary, such as `apps/clio-coder-gui/tests/kill-parent.test.ts` and `apps/clio-coder-gui/tests/idle-exit.test.ts`, use this harness. The `slow` scenario keeps the child alive, so those tests can observe shutdown. Their assertions were not read for this page; the consumers were identified by searching for imports of this harness.

### `realAcpHome()` in `apps/clio-coder-gui/tests/harness/real-acp.ts`

`realCli` resolves to the built CLI entry, the compiled `src/cli/index.ts` under the repository's `dist` build output, computed relative to the harness file with `new URL("../../../../dist/cli/index.js", import.meta.url)`. `realAcpHome()` creates a scratch home and starts an OpenAI-compatible fixture provider through `startOpenAICompatFixture` from the repository-level `tests/harness/openai-compat-fixture.ts`. The provider is configured to stream the chunks `Hello `, `from the `, `real Clio `, and `CLI.` at 100 ms intervals.

The function builds an environment that includes the scratch home variables, `CLIO_CODER_WEB_CLI` set to the built CLI, a test OpenAI key, and `CLIO_CODER_REQUIRE_HOME_PREFIX` set to `1`. It spawns the built CLI with `doctor --fix` in the scratch home and rejects if the process exits non-zero, including its stderr in the error. It then calls `seedOpenAICompatToolOrchestrator` to point the orchestrator at the provider. On any failure it closes the provider and the home before rethrowing. The returned object provides `home`, `env`, `provider`, and `close()`.

If the built CLI is absent, the `doctor --fix` spawn fails with an error event, which rejects the initialization promise. The real-ACP test therefore fails before its assertions, and it requires a prior build of the CLI.

### The real-ACP test in `apps/clio-coder-gui/tests/real/acp.test.ts`

The test combines `realAcpHome()` with `processServer(fixture.env)`. It drives the flow through the HTTP surface:

1. It opens a workspace with `POST /api/workspaces` for the scratch home path and parses the response with `routes.openWorkspace.response`.
2. It opens three sessions in a loop with `POST /api/workspaces/<id>/sessions`. After each open it reads the `children` state file through `AppFiles` and records each child's RSS from `/proc/<pid>/status`, printed with `t.diagnostic`.
3. It posts the turn `"Say hello briefly without tools."` to the first session, expecting status `202`, then polls the session snapshot up to 300 times at 100 ms while the last turn is `running`.
4. It asserts that the last turn is `succeeded`, that the concatenated text timeline equals `"Hello from the real Clio CLI."`, that some timeline item carries orchestrator provenance, and that the provider received at least one request.
5. It asserts that the last turn's usage has exactly the keys `cacheRead`, `cacheWrite`, `costUsd`, `input`, `output`, and `reasoning`.
6. It closes the session, checks session history for an ended row, reloads the session and asserts that the replayed prompt and a replay-origin text item are present, then exercises settings `PATCH`, targets and a probe, autonomy, rename, a `409` on an open-session delete, and a delete after close.
7. It finally asserts that the `children` state has two entries, with the comment "temporary control child is fully reaped".

Those last steps extend beyond the turn flow, and the test's own assertions are the authority for them. This is the only test in the directory that runs the built CLI against the real provider path.

## Focused tests

These tests import client modules directly and do not start the server. Each case below was read.

- `apps/clio-coder-gui/tests/chat-turns.test.ts`, test `groupTurns interleaves prose, reasoning and runs of activity`: passes a timeline of user, text, tool, thought and notice items through `groupTurns` and asserts the segment sequence `response, activity(2), response, activity(2)`. It also asserts that a `thought` between two tool calls is grouped into the following activity run, in wire order. A second test, `reasoning with no call beside it keeps its own disclosure`, asserts that an unpaired thought becomes its own `reasoning` segment.
- `apps/clio-coder-gui/tests/chat-turns.test.ts`, test `groupTurns orders turns by first appearance and settles a replayed turn without a status row`: uses replayed items with `origin: "replay"` and asserts the ordering of turns and their settled state.
- `apps/clio-coder-gui/tests/chat-approval.test.ts`, test `escalation is derived from the clock, not from the delta, and the declared window is the promised one`: computes `deriveApprovalTimings` from `requestedAt` and the declared escalation window. It asserts that a time one millisecond past the window is escalated, that the banner eyebrow changes accordingly, and that early timings report the waited and remaining seconds.
- `apps/clio-coder-gui/tests/chat-approval.test.ts`, test `a server that already said escalated wins even when this clock disagrees`: asserts that `status: "escalated"` from the server sets `escalated` even when the local clock is before the window.
- `apps/clio-coder-gui/tests/chat-approval.test.ts`, test `the budget expires exactly at expiresAt and the remaining countdown never goes negative`: asserts `expired` is false one millisecond before `expiresAt` and true after it, with the remaining count clamped at zero.
- `apps/clio-coder-gui/tests/chat-approval.test.ts`, test `the classification is labelled from the agent's own facts and never re-derived from the tool name`: asserts the chips `Workspace`, `writes content`, `reaches this workspace` for a workspace-tier edit decision, and that an empty reversibility copy falls back to the enum label `reversible only in part`.
- `apps/clio-coder-gui/tests/chat-composer.test.ts`, test `the idempotency key survives typing and a retry, and moves only when the draft is cleared`: uses a `DraftStore` with an injected key generator. It asserts that typing does not mint a new key, that emptying the field does not either, that `clear()` mints a new key, and that a retry fill after clearing re-uses that new key. The stated reason is that a new key on each keystroke would let a double send create two turns.
- `apps/clio-coder-gui/tests/chat-composer.test.ts`, test `the store notifies only on a real change, so a no-op keystroke does not re-render`: asserts that writing the same text and choosing the same steer mode produce one notification each, and that an unsubscribed store does not notify.
- `apps/clio-coder-gui/tests/markdown.test.tsx`, test `links are live only for http, https, and mailto`: asserts `safeHref` accepts `https:`, `http:`, and `mailto:` and returns `null` for `javascript:`, `data:`, `vbscript:`, `file:`, relative paths, and an over-long URL.
- `apps/clio-coder-gui/tests/background.test.ts`, test `background setup preserves its stable identity, starts explicitly, and removes only verified owned files`: exercises `backgroundStatus`, `tryStartBackground`, and `installBackground` with a stub `controlService` that reports `active` and `enabled` once `enable` has been called. It asserts that `tryStartBackground` returns `undefined` when nothing is installed, that the install result does not contain the config token, that the background directory is created with mode `0700` and the config file with mode `0600`, and that the unit file equals `backgroundUnit(config, directory)` and does not include the token. The test uses a temporary root and removes it on teardown.
- `apps/clio-coder-gui/tests/real/acp.test.ts`: described in the section on the real-ACP test above.

The directory also contains focused server tests that use these harnesses, including `apps/clio-coder-gui/tests/kill-parent.test.ts`, `apps/clio-coder-gui/tests/idle-exit.test.ts`, `apps/clio-coder-gui/tests/gateway-acp.test.ts`, `apps/clio-coder-gui/tests/acp-tolerance.test.ts`, and `apps/clio-coder-gui/tests/pwa.test.ts`. Their assertions were not read for this page.

## Things to watch when editing

- The fixture's scenario names are string literals scattered through its handlers. Adding a scenario means adding a branch and, for permission flows, extending `permission()`. A scenario name that no branch checks falls through to the default text behavior.
- The `slow` scenario changes exit behavior: stdin close does not exit the process. Tests that depend on child exit timing should use `slow` only when they need a child that outlives stdin.
- The fixture matches the permission reply by id only, and it treats any `optionId` other than `allow` as a refusal.
- `realAcpHome()` requires the built CLI. Running the real-ACP test before a build fails at the `doctor --fix` spawn, before the turn assertions.
- The `harness()` helper uses fixed values: token `test-token` and origin `http://127.0.0.1:4317`. Tests that compare URLs must use these values unless they pass `options.origin`.

