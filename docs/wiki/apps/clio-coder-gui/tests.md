---
title: "Apps clio coder gui tests"
summary: "The GUI test suite splits into pure-logic node:test files that exercise client decision models and HTTP-harness integration tests that drive the ACP fixture child, plus the JSON-RPC fixture subprocess that simulates the engine."
sources:
  - "apps/clio-coder-gui/client/chat/composer-model.ts"
  - "apps/clio-coder-gui/client/chat/turns.ts"
  - "apps/clio-coder-gui/client/chat/diff-model.ts"
  - "apps/clio-coder-gui/server/services/artifact-window.ts"
  - "apps/clio-coder-gui/tests/fixtures/acp-fixture-child.mjs"
tests:
  - "apps/clio-coder-gui/tests/chat-composer.test.ts"
  - "apps/clio-coder-gui/tests/chat-turns.test.ts"
  - "apps/clio-coder-gui/tests/chat-tools.test.ts"
  - "apps/clio-coder-gui/tests/artifact-window.test.ts"
invariants:
  - "A client decision model stays free of React, CSS and the API client so its logic runs under plain node:test."
  - "The browser may only name an artifact the server itself served inside the current snapshot."
  - "A new GUI test file must be added to the package.json `test` script or it runs only under `test:full`."
validate:
  - "pnpm run test:gui"
---

# Apps clio coder gui tests

`apps/clio-coder-gui/tests` is the test suite for the GUI application. The GUI package declares no
DOM test environment (`apps/clio-coder-gui/package.json`), so the suite splits into two layers that
share the `node:test` runner but prove different things.

The **pure-logic layer** targets the client "decision model" files: TypeScript modules that hold the
GUI's behavior as pure functions and plain stores, with no React, stylesheet, or API-client import.
The anchor test files for this layer are `apps/clio-coder-gui/tests/chat-composer.test.ts`, `apps/clio-coder-gui/tests/chat-turns.test.ts`,
`apps/clio-coder-gui/tests/chat-tools.test.ts`, `apps/clio-coder-gui/tests/chat-approval.test.ts`, and `apps/clio-coder-gui/tests/chat-shell.test.ts`. The
`apps/clio-coder-gui/tests/markdown.test.tsx` file is the one exception that touches the renderer: it uses React's
`renderToStaticMarkup` from `react-dom/server` to serialize components to HTML strings, which lets
it run under `node:test` without a browser or a DOM.

The **HTTP-integration layer** drives the real Hono server (`apps/clio-coder-gui/server/app.ts`) through the in-process
harness in `apps/clio-coder-gui/tests/harness/app.ts`. That harness spins up a scratch home, a `Supervisor`, and a
`WorkerHost`, then points the supervisor at the fake engine subprocess
`apps/clio-coder-gui/tests/fixtures/acp-fixture-child.mjs`. `apps/clio-coder-gui/tests/artifact-window.test.ts` belongs to this layer: it
exercises both the `ArtifactWindow` service directly and its effect on real HTTP routes.

`pnpm run test:gui` is the entry point. It runs `pnpm --filter @iowarp/clio-coder-gui test`, which
lists the pure-logic and integration test files by name (the `test` script in
`apps/clio-coder-gui/package.json`). `pnpm run test:gui:full` runs every `tests/*.test.ts(x)` file,
including ones not named in the `test` script. The root `ci` script runs `test:gui` after `check:gui`
(typecheck and lint).

## What owns the pure-logic layer

Each pure test file pairs with one or more model files it imports. The models are the source of
truth; the test file imports only the symbols under test.

| Test file | Model files it imports | Core decision it locks down |
| --- | --- | --- |
| `apps/clio-coder-gui/tests/chat-composer.test.ts` | `apps/clio-coder-gui/client/chat/composer-model.ts`, `apps/clio-coder-gui/client/interaction/keybindings.ts` | Draft store, submit intent, Enter policy, queue projection, message actions, outcome footer |
| `apps/clio-coder-gui/tests/chat-turns.test.ts` | `apps/clio-coder-gui/client/chat/turns.ts`, `apps/clio-coder-gui/client/chat/activity.ts`, `apps/clio-coder-gui/client/chat/health.ts`, `apps/clio-coder-gui/client/chat/live-status.ts`, `apps/clio-coder-gui/client/chat/route.ts` | Turn grouping, activity summary, live-status machine, health reduction |
| `apps/clio-coder-gui/tests/chat-tools.test.ts` | `apps/clio-coder-gui/client/chat/diff-model.ts`, `apps/clio-coder-gui/client/chat/tool-presentation.ts` | Diff parsing and the diff panel provenance, tool card presentation |
| `apps/clio-coder-gui/tests/chat-approval.test.ts` | `apps/clio-coder-gui/client/chat/approval-model.ts`, `apps/clio-coder-gui/client/chat/fleet-facts.ts` | Approval timing, decision classification, gated preview, fleet-run folding |
| `apps/clio-coder-gui/tests/chat-shell.test.ts` | `apps/clio-coder-gui/client/chat/chat-turn.ts`, `apps/clio-coder-gui/client/chat/turns.ts`, `apps/clio-coder-gui/client/interaction/commands.ts` | Conversation view helpers and the command palette catalog |
| `apps/clio-coder-gui/tests/markdown.test.tsx` | `apps/clio-coder-gui/client/render/Markdown.tsx`, `apps/clio-coder-gui/client/render/markdown-model.ts` | Markdown sanitization, incremental lexing, code blocks, tables and diagrams |

The model files themselves are the implementation. For example, `apps/clio-coder-gui/client/chat/composer-model.ts`
exports `DraftStore`, `submitIntent`, `composerKeyAction`, `projectQueue`, and `turnOutcome`, and its
file header states the discipline: "Nothing here imports React, a stylesheet or the API client,
which is what lets `apps/clio-coder-gui/tests/chat-composer.test.ts` run it under plain node:test." `apps/clio-coder-gui/client/chat/turns.ts`
holds `groupTurns`, the conversation projection that groups a flat `TimelineItem` list into turns and
interleaves prose, reasoning, and activity runs. `apps/clio-coder-gui/client/chat/diff-model.ts` holds `parseDiff`,
`diffPanel`, `synthesizeProposedDiff`, and `collapsePlan`.

## How the composer decision flows from a caller

The composer is the cleanest example of a wrapper component calling into a pure model.
`apps/clio-coder-gui/client/chat/Composer.tsx` is the declarative wiring; every branch is a call into
`apps/clio-coder-gui/client/chat/composer-model.ts`.

`Composer.tsx` builds a `situation` object from its props and query state (`sessionState`,
`turnRunning`, `sending`, `steering`) and passes it, along with the draft from `draftStore(sessionId)`,
to `submitIntent`. `submitIntent` in `composer-model.ts` is the single decision point:

- It returns `{ kind: "blocked", reason }` when the previous send is still on the wire, the session
  is not open, the draft is whitespace, or the text exceeds a bound.
- When a turn is running and steering is announced, it returns `{ kind: "steer", mode, ... }`,
  choosing the mode from `draft.mode` if the engine announced it, else falling back to
  `situation.steering.modes[0]`.
- Otherwise it returns `{ kind: "prompt", ... }`.

`Composer.tsx` then reads `intent.kind` to pick the label from `submitLabel`, to set the submit
button's `title` and `disabled` state, and to decide whether to show a "blocked" notice. The actual
HTTP call is a `useMutation` (`send.mutate`) that branches on `intent.kind`: a `prompt` calls
`routes.turn`, a `steer` calls `routes.steerSession`. The idempotency key for both is the draft's
`key`, which the `DraftStore` mints and rotates according to its own rules.

This is the pattern the tests enforce: `apps/clio-coder-gui/tests/chat-composer.test.ts` calls `submitIntent(draft,
situation)` directly with synthetic `Draft` and `situation` objects and asserts the exact shape of
the returned intent, without any React render. The test `a running turn steers instead of blocking,
in the mode the operator chose` passes `situation({ turnRunning: true })` and asserts the intent is
`{ kind: "steer", mode: "end-of-turn", ... }`.

## The turn grouping and referential-identity contract

`apps/clio-coder-gui/client/chat/turns.ts` exposes `groupTurns(timeline, statuses, previous)`. Its documented purpose is
the referential-identity contract: a turn whose items are element-wise identical to the previous
grouping keeps its object identity, and the whole array keeps its identity when no turn changed.
This is what lets a settled turn stop re-rendering while a later turn streams.

The tests in `apps/clio-coder-gui/tests/chat-turns.test.ts` pin this down precisely. The test `groupTurns keeps the
identity of every settled turn across 200 streamed deltas` iterates 200 deltas, rebuilding the
grouping each time with `groupTurns(timeline, rows, previous)`, and asserts:

- A settled turn object keeps its identity: `assert.equal(turn, held, ...)` where `held` was stored
  the first time that turn became settled.
- Re-grouping an unchanged timeline returns the previous array: `assert.equal(groupTurns(timeline,
  rows, next), next)`.
- Exactly 200 rebuilds occurred, one per delta, and all 10 turns end settled.

`groupTurns` decides settled-ness with `isSettled`: a replayed turn is always settled; a live turn is
settled once its `Turn` row reports a terminal status, and a live turn with no row yet is open.
`sameTurnView` is the memo comparator for a turn view; the test `sameTurnView shields a settled turn
from the clock and from a permission elsewhere` asserts that a settled turn compares equal across
differing `pendingPermissionId` and `nowMs`, while a live turn does not.

## How data flows through the artifact window and its routes

The HTTP layer is a different shape. `apps/clio-coder-gui/server/services/artifact-window.ts` exports the `ArtifactWindow`
class, the single place the GUI decides whether a browser may name a durable artifact. The file header
states the boundary: the browser "may only echo one the server itself served, inside the bounded
snapshot the server is currently showing."

Two upstream HTTP routes feed the window and draw from it:

- `apps/clio-coder-gui/server/http/routes-evidence.ts` calls `artifacts.page("evidence", query.cursor, ids)` after
  serving a listing, and calls `artifacts.admit("evidence", params.id)` for a detail read. It calls
  `artifacts.admitAny(RUN_KINDS, params.runId)` before starting a build or verify operation, so a
  refused reference never creates an operation row.
- `apps/clio-coder-gui/server/http/routes-fleet.ts` mirrors this for fleet roots and dispatch runs, with separate
  `"run"` and `"dispatch"` families so that showing both listings on one page does not let whichever
  resolved second unlink the other's receipts.

`ArtifactWindow` keeps one `Set` per family in `#windows`. `serve` replaces the family wholesale;
`extend` adds ids and evicts oldest-first at `MAX_SERVED_ARTIFACT_IDS`; `page` chooses between the two
based on whether the caller cursored. `admit` returns the id when it is in the current window,
throwing `ArtifactNotServedError` (a 403, not a 404) with a reason of `"no-window"`,
`"outside-window"`, or `"malformed"` otherwise. The reason `"no-window"` and `"outside-window"` are
distinct is that a bare 404 would blur together "the host never served this" with "it aged out."

`apps/clio-coder-gui/tests/artifact-window.test.ts` exercises both the class directly and the routes through the
harness. The direct test `the window refuses malformed, unserved and aged-out references before any
lookup` feeds hostile ids (`"../../etc/passwd"`, `"--force"`, `"a".repeat(129)`, `42`, `null`) and
asserts each throws with `reason: "malformed"`; it then distinguishes `"no-window"` from
`"outside-window"` by serving a window and asking about an id outside it. The harness test `a run id
reaches no child process until a fleet listing has served it` posts to
`/api/workspaces/:id/receipts/:runId/verify` before any fleet listing and asserts the 403, that no
CLI child started, and that no operation row was created.

## The ACP fixture child

`apps/clio-coder-gui/tests/fixtures/acp-fixture-child.mjs` is a fake engine subprocess that speaks JSON-RPC over
stdin/stdout, driven by the scenario in `CLIO_CODER_WEB_FIXTURE_SCENARIO`. The harness in
`apps/clio-coder-gui/tests/harness/app.ts` sets that variable and points `CLIO_CODER_WEB_CLI` at the fixture file.

The fixture's `handle(frame)` method is a large switch over the ACP method. It implements:

- `initialize`: returns `agentCapabilities` and, for the `markdown`/`steer` scenarios, a steering
  surface and optional settings/targets/commands capabilities under `_meta`. It asserts the client
  opted into exactly 11 event kinds, otherwise it throws `event_opt_in`.
- `session/new` and `session/load`: return session modes and, for `session/load`, replay two chunks
  tagged with `"clio-coder/replay": { turn: 1 }`.
- `session/prompt`: the heart of the fixture. It selects a `turnScenario` from the prompt text and
  the scenario (e.g. `[approval]` → `"permission"`, `[stream]` → `"loop"`, `[workload ...]` →
  `"workload"`), then streams the appropriate response. For the default path it streams thought
  chunks, an unknown `sessionUpdate` kind (`future_unknown_kind`) to test tolerance, and text
  chunks. It returns `{ stopReason, _meta: { "clio-coder/usage": usage } }`.
- `session/request_permission` (via the `permission` helper): sends a `session/update` tool call,
  then a `session/request_permission` request with `allow`/`reject` options, awaits the GUI's answer,
  and settles the write with either an applied diff or the `REFUSED_TEXT` from `src/tools/registry.ts`.
- `_clio-coder/session/steer`, `_clio-coder/session/queue`, `_clio-coder/session/queue_clear`,
  `_clio-coder/session/interrupt`, and `_clio-coder/dispatch/steer`: the steering surface, with the
  queues held in module-level state.
- `session/cancel` and `session/close`: set `cancelled` and resolve any held live-run or permission
  promises.

The `heldWorker` and `fleet` helpers emit `_clio-coder/event` frames with kinds like
`dispatch.enqueued`, `dispatch.started`, `safety.loopBlocked`, and `accountability.evidenceReady`,
which the GUI's fleet strip and health summary reduce. The fixture deliberately sends a
`future.unknownKind` event that is "not in `ACP_TO_WEB_EVENT`" so that "a newer engine's kind must be
dropped, not kill the session."

The workload scenario uses `apps/clio-coder-gui/tests/fixtures/stream-workload.mjs`, whose `streamWorkload` emits a
6.7 KB Markdown answer in 5-character chunks with a pace tick every four chunks, interleaved with
tool calls (the seventh call fails). This is the rendering workload `apps/clio-coder-gui/scripts/perf-workload.ts`
measures, kept so the numbers stay comparable with the budgets in `DESIGN.md`.

## Enforced boundaries and lifecycle ordering

**Draft identity.** `DraftStore` mints one idempotency key per draft and only rotates it when the
text or mode changes after a send has been marked submitted. The test `the idempotency key survives
typing and a retry, and moves only when the draft is cleared` asserts the key is unchanged across
`write` calls that grow the text, and only changes on `clear()`. This is what stops a double send
from becoming two turns.

**Network isolation.** `apps/clio-coder-gui/tests/harness/no-network.ts` replaces `globalThis.fetch` with a thrower that
rejects "Uninjected network access is forbidden in the web test suite." Every GUI test runs with
`--import ./tests/harness/no-network.ts`, so any code path that calls `fetch` without an injected
implementation fails loudly rather than touching a real network.

**Artifact admission precedes side effects.** In `routes-evidence.ts` the `evidenceBuild` and
`receiptVerify` routes call `artifacts.admitAny(RUN_KINDS, params.runId)` *before* calling
`evidence.execute`. The comment says "Admission precedes the operation so a refused reference never
creates a row." `apps/clio-coder-gui/tests/artifact-window.test.ts` asserts this: after a 403 on a refused run id,
`h.cli.activeCount` is 0 and `h.operations.activeCount` is 0.

**Window narrows on refresh, never widens.** `serve` replaces the family's window wholesale, and
`page` calls `serve` when there is no cursor. The harness test `evidence detail admits only what the
listing showed, and a refusal is not a not-found` refreshes with `limit=3` and asserts the previously
served `evidence-030` now returns 403 while the fresh first id `evidence-039` returns 200.

## Extension seams

**Adding a pure-logic test target.** The seam is the model file. To test new composer behavior, you
add the function to `apps/clio-coder-gui/client/chat/composer-model.ts` (keeping it free of React/CSS/API imports) and
add cases to `apps/clio-coder-gui/tests/chat-composer.test.ts` that call it directly with synthetic inputs. The file
header of each model states this discipline, and a second reacher that imports React into the model
would break the pattern.

**Adding a new GUI test file.** The `test` script in `apps/clio-coder-gui/package.json` lists test
files by name. A new file is only run by `pnpm run test:gui` if it is added to that list; otherwise
it runs only under `test:gui:full`, whose `test:full` script globs `tests/*.test.ts` and
`tests/*.test.tsx`. The root `ci` script calls `test:gui`, not `test:gui:full`, so a new file is
invisible to CI unless it is also added to the whitelist.

**Adding a fixture scenario.** To exercise a new engine behavior, extend the `session/prompt`
switch in `apps/clio-coder-gui/tests/fixtures/acp-fixture-child.mjs` to emit the appropriate `session/update` or
`_clio-coder/event` frames, and add a scenario name to `CLIO_CODER_WEB_FIXTURE_SCENARIO`. The
`harness()` function in `apps/clio-coder-gui/tests/harness/app.ts` forwards `options.scenario` into that environment
variable.

**Adding an artifact family.** To let a new listing reference its own durable artifacts, add the
kind to `ARTIFACT_KINDS` in `apps/clio-coder-gui/server/services/artifact-window.ts`, then wire `artifacts.page(kind,
cursor, ids)` into the listing route and `artifacts.admit(kind, id)` into the detail route, the way
`routes-evidence.ts` and `routes-fleet.ts` do.

## Named focused tests and their cases

**`chat-composer.test.ts`** locks the submit policy. Key cases: `a running turn steers instead of
blocking, in the mode the operator chose` (asserts `kind: "steer"` with the chosen mode); `a chosen
mode the engine did not announce falls back to one it did` (mode coercion); `the composer refuses
past the engine's own bounds rather than spending a round trip` (asserts the 32,000-character and
16,384-byte limits); and `a multibyte steer is measured in bytes, the unit the engine bounds`
(é repeated to the byte cap blocks, proving byte counting, not character counting).

**`chat-turns.test.ts`** locks the turn grouping and identity. Key cases: `groupTurns interleaves
prose, reasoning and runs of activity` (asserts the segment shape `["response", ["activity", 2],
"response", ["activity", 3]]`); `groupTurns keeps the identity of every settled turn across 200
streamed deltas` (identity preservation); and `the live status machine reaches all nine states from
one realistic sequence` (asserts all nine `LiveState` values are reachable and each glyph is a
single codepoint).

**`chat-tools.test.ts`** locks the diff panel. Key cases: `the engine's line-numbered diff format is
parsed as changes, not as context` (distinguishes the Clio numbered format from unified); `a refused
write arrives as failed and still shows what was refused` (provenance `"rejected"` keyed off the
`"was not approved"` sentence, not the status); and `a failed write that was never refused is not
reported as a rejection` (provenance `"unverified"` for an `EACCES` error).

**`chat-approval.test.ts`** locks approval timing and fleet folding. Key cases: `escalation is
derived from the clock, not from the delta, and the declared window is the promised one` (escalates
one millisecond past `ESCALATION_SECONDS` with no delta); and `five events about one run fold into
one row that carries every reported value` (folds `enqueued`/`started`/`progress`/`completed` into
one run row).

**`chat-shell.test.ts`** locks the conversation view. Key cases: `appCommands offers no session rows
when the operator is not in a conversation` and `every palette destination is a path this app
actually routes` (reads `client/main.tsx` and asserts every palette destination is a real route).

**`markdown.test.tsx`** locks the renderer. Key cases: `links are live only for http, https, and
mailto` (`safeHref` returns null for `javascript:`, `data:`, `file:`, relative paths, and a 3,000-char
path); `hostile Markdown never becomes markup, a live unsafe link, or a fetched image` (asserts no
`<script>`, no `<img>`, and unsafe links become `md-link--blocked`); and `a settled boundary follows
a blank line outside fences and never splits a list continuation`.

**`artifact-window.test.ts`** locks the server-side admission. Key cases: `the window refuses
malformed, unserved and aged-out references before any lookup` (asserts the three refusal reasons);
`evidence detail admits only what the listing showed, and a refusal is not a not-found` (asserts
403 with `code: "unauthorized"`); and `every evidence link the paginated page still renders stays
admitted, even while the next page is in flight` (uses a `@tanstack/react-query`
`InfiniteQueryObserver` to simulate pagination and asserts `followable()` is empty at every moment).

## Things to watch when editing

- **The `test` script is a whitelist.** `pnpm run test:gui` runs exactly the files named in
  `apps/clio-coder-gui/package.json` `scripts.test`. A new test file that is not added there runs
  only under `test:gui:full`, so a regression placed in a new file is guarded by nothing in CI.
  The root `ci` script calls `test:gui`, not `test:gui:full`.

- **Keep the model files pure.** The whole point of the pure-logic layer is that
  `tests/chat-*.test.ts` runs under plain `node:test` with no DOM. If you add a React, CSS, or
  API-client import to a model file like `composer-model.ts` or `turns.ts`, the import itself
  evaluates React/stylesheet machinery and the test can no longer run under node. The model file
  headers state this discipline; a second reacher that breaks it is the seam the pattern defends.

- **Do not relax the artifact window to accumulate.** `serve` replaces the family's window
  wholesale rather than merging, and `extend` evicts oldest-first at `MAX_SERVED_ARTIFACT_IDS`.
  Changing `serve` to union with the existing set would let a browser reference an artifact the
  server stopped showing several refreshes ago, defeating the "only echo what was served" contract.

- **The fixture is the engine contract.** `acp-fixture-child.mjs` emits frames shaped to match
  `src/engine/acp/server.ts` (e.g. settled frames mirror `content` + `rawOutput`, refusals are worded
  by `src/tools/registry.ts`). If the engine changes the wire format, the fixture and the tests
  that depend on its exact sentences (e.g. `REFUSED_TEXT`, `APPLIED_DIFF`) change together; a test
  asserting on a sentence the fixture no longer emits will fail.

- **Network is a wall, not a gate.** `apps/clio-coder-gui/tests/harness/no-network.ts` throws on every `fetch` call.
  Code under test must take an injected fetch or the test fails. This is intentional: a GUI test
  that silently touches a real network would make the suite flaky and the assertions meaningless.

<!-- clio-coder:wiki unresolved sources: tests/chat-composer.test.ts, tests/chat-turns.test.ts, tests/chat-tools.test.ts, tests/chat-approval.test.ts, tests/chat-shell.test.ts, tests/markdown.test.tsx, tests/harness/app.ts, tests/fixtures/acp-fixture-child.mjs, tests/artifact-window.test.ts, tests/*.test.ts(x), tests/fixtures/stream-workload.mjs, scripts/perf-workload.ts, tests/harness/no-network.ts, tests/*.test.ts, tests/*.test.tsx, tests/chat-*.test.ts -->
