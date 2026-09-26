---
title: "Tests extended"
summary: "The tests/extended suite: how the full end-to-end behavior of the TUI, compaction lifecycle, library import/browser, dispatch board, configure wizard, and rendering invariants is exercised under pnpm run test:full, and the isolation harness they share."
sources:
  - "src/interactive/dispatch-board.ts"
  - "src/interactive/overlays/library.ts"
  - "src/interactive/welcome-dashboard.ts"
  - "src/domains/session/compaction/compact.ts"
  - "src/domains/interop/import.ts"
  - "src/cli/configure-onboarding.ts"
  - "src/entry/orchestrator.ts"
  - "src/interactive/chat-panel.ts"
  - "src/interactive/renderers/tool-execution.ts"
  - "src/interactive/renderers/worker-entry.ts"
  - "tests/harness/scratch-env.ts"
symbols:
  - "createDispatchBoardStore"
  - "createDispatchBoardView"
  - "openLibraryOverlay"
  - "buildLibraryRows"
  - "createWelcomeDashboard"
  - "createBootWelcome"
  - "compact"
  - "captureSkillContext"
  - "planLibraryImport"
  - "applyLibraryImport"
  - "runOnboardingWizard"
  - "createProductionAutoCompact"
  - "createChatPanel"
  - "renderToolSubline"
  - "renderWorkerEntryLines"
  - "isolateClioEnv"
tests:
  - "tests/extended/rendering-invariants.test.ts"
  - "tests/extended/compaction-controls.test.ts"
  - "tests/extended/compaction-skill-checkpoint.test.ts"
  - "tests/extended/configure-sections.test.ts"
  - "tests/extended/library-import.test.ts"
  - "tests/extended/welcome-boot-header.test.ts"
  - "tests/extended/library-browser.test.ts"
  - "tests/extended/dispatch-board.test.ts"
invariants:
  - "Library import plans retain a staged source until apply or release, and nothing is written before the plan is reviewed."
  - "Compaction cancellation aborts the summary stream, publishes no checkpoint, and retains the reported usage under the originating session."
  - "The welcome dashboard never serves a project-context read for a different directory and strips control sequences from all rendered text."
  - "No rendered line ever exceeds the viewport width in the launchpad, session header, or footer."
validate:
  - "pnpm run test:full"
---

# Tests extended

## What this suite covers

`tests/extended/**` is the end-to-end half of the test suite. It drives real production
entry points — the chat loop, the observability projection, the library overlay, the configure
wizard — through scripted input and scripted model responses, and asserts on the bytes that come
back on screen or on disk. It is not run by `pnpm run test` (which runs contracts, a smoke set,
and two boot handoffs). It runs with [`pnpm run test:full`](https://github.com/iowarp/clio-coder/blob/main/package.json),
which `package.json` defines as:

```
node --import tsx --import ./tests/harness/tmp-root.ts --test \
  tests/contracts/*.test.ts tests/extended/*.test.ts tests/smoke/*.test.ts tests/extended-smoke/*.test.ts
```

The `--import ./tests/harness/tmp-root.ts` prelude (`tests/harness/tmp-root.ts`) creates one scratch
root per test run under the system temp dir (named `clio-coder-tests-*`), repoints `TMPDIR` at it so
every `mkdtemp` call lands inside it, deletes shell `FORCE_COLOR`/`NO_COLOR`/theme vars for a
deterministic palette, and defaults `CLIO_CODER_HOME` under the run root when unset; it removes the
root at exit and sweeps stale roots from crashed runs. The eight files this page documents are:

| File | Subject |
| --- | --- |
| `tests/extended/rendering-invariants.test.ts` | Transcript rendering: tool previews, worker cards, agent invocations |
| `tests/extended/compaction-controls.test.ts` | Production compaction lifecycle: cancellation, routing, usage |
| `tests/extended/compaction-skill-checkpoint.test.ts` | Compaction with skill context checkpoints |
| `tests/extended/configure-sections.test.ts` | The `configure` wizard and onboarding |
| `tests/extended/library-import.test.ts` | Importing foreign plugin packages |
| `tests/extended/welcome-boot-header.test.ts` | The launchpad / boot welcome header |
| `tests/extended/library-browser.test.ts` | The Library overlay browser |
| `tests/extended/dispatch-board.test.ts` | The dispatch board over the observability projection |

## Isolation and harness foundation

Every test that touches Clio state runs inside a throwaway home. [`isolateClioEnv`](../../../tests/harness/scratch-env.ts)
in `tests/harness/scratch-env.ts` `mkdtemp`s a scratch directory, points `CLIO_CODER_HOME` and the
five `CLIO_CODER_*_DIR` vars at it, and calls `resetXdgCache()` so in-process `src/` code re-resolves
the scratch dirs. It returns a `restore()` that undoes every env change, removes the scratch, and
resets the cache again.

Two properties of this module are load-bearing for the extended suite. First, the in-process
isolation window is a **process-wide critical section**, not a per-test one. The module header
explains that under `--experimental-test-isolation=none` a single process runs every file, and
Node's own runner can interleave two files' `beforeEach`/`afterEach` hooks; `acquireEnvLock()`
chains the windows so no two isolated-env regions overlap in wall-clock time regardless of
scheduling (issue #84 referenced the interop consent/state clobbering). Second, `isolateClioEnv`
takes a full `process.env` snapshot, so a test that mutates env (e.g. `PATH` in
`tests/extended/library-import.test.ts` for a fake `git` binary) is restored byte-for-byte.

The other harness pieces the extended tests lean on live in `tests/harness/`:

- `tests/harness/receipt.ts` provides `fixtureEnvelope` and `fixtureReceiptDraft`, the synthetic
  run receipt + integrity envelope the dispatch and compaction tests sign.
- `tests/harness/compaction-summary.ts` provides `syntheticCompactionSummary`, a well-formed
  compaction checkpoint the faux summarizer returns.
- `tests/harness/library-plan-fixture.ts` provides `libraryPlanFixture` and `libraryApplyFixture`,
  the review/outcome payloads the Library overlay test injects.

`tests/extended/configure-sections.test.ts` does **not** use `isolateClioEnv`; it builds its own
`isolatedEnv()` that creates a fresh `~/.config/clio-coder/settings.yaml` tree under `tmpdir()` and
restores it by directory removal, because it spawns the CLI as a child process rather than
importing `src/` in-process.

## How the suites drive the code

The extended tests separate three layers: the **production object under test**, the **scripted
model/network layer**, and the **scripted operator layer**.

**Scripted model layer.** `tests/extended/compaction-controls.test.ts` installs a faux provider
via `registerEngineFauxProvider` from `src/engine/api-registry.ts`, returning `syntheticCompactionSummary`
responses. A `literalUsage` variant registers a real `registerEngineApiProvider` stream that preserves
supplied wire usage facts (including missing/zero fields) instead of letting faux estimate and
overwrite them. The test records every outgoing call in a `calls` array, asserting `model`, `baseUrl`,
`apiKey`, `headers`, `capacity`, and `signal`.

**Scripted operator layer.** The TUI is driven by calling the real submit controller or overlay
options, not by writing to a terminal. In `tests/extended/welcome-boot-header.test.ts` the real
`createInteractivePresentation` is built with a fake `TUI` whose `requestRender` just counts
frames, and a real `ClioEditor` over a stub `TuiMainScreen`. The submit path is driven through
`createEditorSubmitController(...).submitEditorText("...")`. In `tests/extended/library-browser.test.ts`
the overlay is driven through the list overlay's own option surface: `openLibraryOverlay` is given
an `openList` that captures `ListOverlayOptions`, and the test calls `tab.items()`, `onSelect`,
`actions[key]`, and `globalActions[key]` directly — described in the file as "closer to the operator's
keystroke than reaching into the view would be, and it does not need a terminal". The `press()`
harness helper maps a key to the captured option surface.

**Event-bus drive.** `tests/extended/dispatch-board.test.ts` does not call the projection's fold
directly. It builds a `createSafeEventBus()`, a `createObservabilityProjection(bus, ...)`, and a
`createDispatchBoardStore(projection)`, then emits `BusChannels.DispatchEnqueued`, `DispatchStarted`,
`DispatchProgress`, `DispatchCompleted`, `DispatchFailed`, and `AccountabilityEvidenceReady` and
awaits `projection.subscribe` callbacks. The test asserts the bus has exactly one listener per
channel (`bus.listeners(channel).length === 1`), proving the projection is the single fold.

## Dispatch board

`tests/extended/dispatch-board.test.ts` exercises `createDispatchBoardStore` and
`createDispatchBoardView` from `src/interactive/dispatch-board.ts` against the observability
projection in `src/domains/observability/projection.ts`.

The store is a thin projection of the observability snapshot: `rows()` reverses and sorts
`current.runs` by `STATUS_ORDER` then by finish/start time, maps each run through `toRow`, and
`activeRows()` filters out terminal statuses. `reconcile()` calls `projection.reconcileRuns()` and
refreshes `current`. The test's `setup()` builds the store from `createObservabilityProjection`,
and a `nextPublication()` helper waits for the projection's next coalesced publication (skipping
the immediate snapshot that `subscribe` delivers).

The test verifies, among other things:

- **One fold**: each of the six dispatch/evidence channels has exactly one listener, and that
  listener is the projection. `board.unsubscribe()` removes the board's subscription without
  stopping the shared projection, so a later `DispatchEnqueued` still lands in the projection but
  not in the detached board.
- **Field preservation**: every board field (`runId`, `agentAudience`, `requestOrigin`, `runtimeKind`,
  `gate`, `council`, `endpoint`, `rerouteCount`, `contextWindow`, `phase`, `receiptId`, `hostVerification`,
  `failoverHops`, `elapsedMs`, tokens, cost, `costProvenance`, `outcomeDetail`) survives through the
  projection. Snapshots are immutable: mutating `prior.runs[0]`'s action does not change a later
  snapshot.
- **Capacity bounds**: `MAX_PROJECTION_RUNS` caps the settled history, but active dispatches are
  retained beyond the limit (`board.rows().length === MAX_PROJECTION_RUNS + 1`), and a settled run
  ages out only once later runs fill the window. Pending retries beyond history capacity are also
  retained, and their canceled settlement is bounded.
- **Trust/quality separation**: the "dispatch quality presentation" block writes real receipts to
  `clioStateDir()` via `withReceiptIntegrity` + `inspectRunReceiptTrustStatus`, then asserts that
  execution success and receipt quality (`pass`/`fail`/`unknown`/`ungrounded`) are stated
  separately across `renderToolSubline`, `formatTaskIslandLines`, the dispatch board card,
  `renderWorkerEntryLines`, the `monitor` tool, and `buildEvidence`. Shadow runs (audience `shadow`)
  are inspectable but presented only as compact helper activity.

## Compaction lifecycle

Two files cover compaction. `tests/extended/compaction-controls.test.ts` runs the **production**
auto-compact callback `createProductionAutoCompact` from `src/entry/orchestrator.ts`, wired into a
real `createChatLoop` and `createTurnContext`. `tests/extended/compaction-skill-checkpoint.test.ts`
exercises the lower-level `compact` + `captureSkillContext` + `verifiedSkillContextCheckpoint` from
`src/domains/session/compaction/compact.ts`.

In `compaction-controls.test.ts`, the `production ${mode} cancellation` test runs for `manual`,
`auto`, `overflow`, `acp`, `reset`, and `dispose`. It installs the faux provider, builds a chat loop
and an application controller, and triggers compaction. Inside the model response callback it
captures the cancellation (via ACP `session/cancel`, `loop.resetForSession`, `loop.dispose`, or an
ESC keypress) and asserts:

- The chat stream has not started and `turnPreparation().phase === "compacting"`.
- Cancellation reaches the actual summary provider signal (`f.calls.at(-1)?.signal?.aborted`).
- No checkpoint is published (`submitted` stays empty; `f.entries()` equals `before`).
- The out-of-turn usage row is still written with `callOutcome: "aborted"` and the reported token
  total, while `foregroundStreamUsage()` returns `{}`.

Other focused cases:

- **Model routing**: a configured dedicated summary model (`summary-target/summary`) routes through
  its own `baseUrl`, `apiKey`, and headers, is attributed in the ledger and the persisted
  `compactionSummary` entry, and consumes endpoint capacity (`capacity[key] === 1`).
- **Invalid routes**: unknown model patterns (including ANSI-injected and glob patterns), and
  dedicated routes that are unavailable, external, worker-only, no-chat, no-output, or missing
  auth, are rejected before auth or inference with `context.compaction.model` in the error.
- **Prompt override**: the configured `systemPrompt` file is read at call time; missing/empty/
  oversized/directory/invalid-utf8 paths are rejected without exposing contents, and an oversized
  configured filename is bounded in the error.
- **Failure accounting**: stream errors release endpoint capacity, persist no checkpoint, but retain
  the failed call's spending under its originating session; aborted, errored, and unobserved usage
  are kept distinct in `summarizeFailedCompactionUsage`; a split compaction's second failure retains
  both calls; and an append failure is surfaced without a speculative second accounting write.
- **Malformed summaries**: a normally stopped but malformed history (missing sections, fenced, or
  `### Risks`-instead-of-`### Blocked`) is refused without publishing a checkpoint, while completed
  model spending is still recorded.

In `compaction-skill-checkpoint.test.ts`, the fixtures build a session history containing a skill
activation (`kind: "skillActivation"`) and the surrounding request/assistant/tool_call/tool_result
entries. The test asserts that `captureSkillContext` + `compact` preserve skill context across a
compaction checkpoint, using `verifiedSkillContextCheckpoint` from `src/domains/session/entries.ts`
to check the checkpoint's integrity.

## Library import

`tests/extended/library-import.test.ts` exercises `planLibraryImport`, `applyLibraryImport`, and
`releaseLibraryImport` from `src/domains/interop/import.ts`. The seam is plan/apply/release: a plan
retains the fetched source until apply or release, and apply re-projects the source, refuses drift,
publishes through the library install seam with foreign trust, then reports publication, validation,
and runtime admission as three separate facts.

The test builds fixture packages in a vendor directory: `claudeBundle()` (a Claude Code plugin with
skills, agents, commands, hooks, an `.mcp.json` with a secret token, and an executable script),
and native `plugin.json` packages. Focused cases:

- **Format detection and normalization**: a Claude-only package is detected as `claude-code`, its
  skills/prompts/agents are converted, `hooks/hooks.json` and `.mcp.json` are listed unsupported,
  the fixture executable "scripts/run.sh" is omitted, and foreign trust (`trust: "foreign"`, gate
  `integrations.projectResources.trustProjectImports`) survives installation. The source directory is
  never rewritten (a `snapshot()` before/after is `deepStrictEqual`).
- **Stale-source refusal**: `applyLibraryImport` re-projects the source and refuses drift — editing a
  skill, the hidden manifest, or an omitted runtime file after review is refused with "Source changed
  after review" and nothing is published.
- **Prerequisites**: vendor dependencies and agent skill bindings are prerequisites, not omissions. A
  package with `dependencies: ["helper-lib"]` is blocked until a foreign `helper-lib` package is
  imported; a native package with the same id never satisfies a vendor dependency (no spoofing);
  pinned version constraints and non-portable identifiers are rejected.
- **Path safety**: escaping manifest paths, symlinked packages, and executables are refused or
  omitted; a skill referencing an omitted companion script by basename is refused.
- **GitHub transport**: a GitHub tree URL stages a clone via the catalog transport; cancel, refusal,
  and apply all release the staged source; a fake `git` binary is placed on `PATH` (env is restored by
  `isolateClioEnv`).
- **CLI route**: the `clio-coder library import` command with `--dry-run --json` omits reviewed bytes
  (no `do-not-copy` secret), requires `--yes` to publish, and exits 2 on an invalid `--format`.
- **Independence of ownership**: the first test asserts that Materio, foreign recipe imports, and
  real harness runtimes stay independently owned across reloads — `installPlugin`/`disablePlugin`/
  `enablePlugin`/`removePlugin` on one origin never changes `runtime.activeGeneration` or the
  frozen extension registry.

## Library browser

`tests/extended/library-browser.test.ts` exercises `openLibraryOverlay` from
`src/interactive/overlays/library.ts` and the model/review helpers from `src/interactive/overlays/library-model.ts`
and `src/interactive/overlays/library-review.ts`. The overlay reads and reviews; it never writes —
every managed change goes through a plan the operator sees first, and the outcome separates the
write, the resources, and the session refresh.

The harness injects a `LibraryLifecyclePort` whose `plan`/`apply`/`release` return
`libraryPlanFixture`/`libraryApplyFixture`, and captures the `ListOverlayOptions` that
`openLibraryOverlay` hands the list overlay. Focused cases:

- **Projection facts**: origin, format, trust, and availability stay separate — a remote package in
  Claude format is "Remote", not a local Claude install; mode and scope survive a narrow terminal;
  core and loose recipes offer no package lifecycle actions and say why; an unavailable recipe gets
  no `use` action and states the reason.
- **Category separation**: Browse lists install targets (`pkg:plugin:materio`), Installed lists
  copies (`copy:plugin:materio@user`), and a recipe category lists resources; a bundle in a recipe
  category is found through catalog hints without being called loaded; a damaged copy stays reachable
  in its own category.
- **Review lifecycle**: pressing `r` on an installed copy opens a review; cancelling writes nothing
  and releases staging; accepting applies the plan once and reports the session refresh separately.
  A refused install (missing requirements) is reported before a review opens, and the second `i`
  reviews the requirements with it; a refused plan is released rather than left staged.
- **Close-under-review**: closing the browser while a plan is open releases the staged source and
  does not write; `hide()` releases the plan it left open.
- **Keyboard routing**: after an arrow key changes the category, actions act on the new category's
  rows; only the keys the selected row accepts are advertised in the hint.

## Welcome dashboard

`tests/extended/welcome-boot-header.test.ts` exercises `createWelcomeDashboard` and
`createBootWelcome` from `src/interactive/welcome-dashboard.ts`. The launchpad is fifteen rows and
the collapsed session header is one row, at every width in `WIDTHS` (8–200) and every state in
`GEOMETRY_CASES`, and no rendered line ever exceeds its width (checked with `visibleWidth`).

Focused invariants:

- **Route honesty**: a healthy route shows the route without a latency number; a failing route
  carries its reason and the action names the repair surface; a configured-but-unprobed target is
  neither ready nor unavailable; an unprobed target must not claim readiness; a route with no model
  is "no model", not ready.
- **Priority**: route faults outrank project-context guidance.
- **Off-render context read**: `render` never calls the context reader on its own call stack — the
  read is scheduled once via `scheduleRefresh`, and a reader that throws never becomes `ok` or
  `none`. A failure never renews the trust window (`WELCOME_PROJECT_CONTEXT_TTL_MS`), and a stale
  value stops being asserted once the failure streak outlives the trust window. A reading is never
  served for a different directory (the read is per-cwd). The collapsed header spends nothing on
  facts it does not show, and `dispose` stops a pending refresh.
- **Untrusted text**: hostile provider reasons and cwd/branch values cannot style, clear, or retitle
  the terminal — OSC introducers, clear-screen, cursor-move, BEL, and NUL are all stripped, and
  wide Unicode survives sanitation.
- **Boot welcome**: `createBootWelcome` renders the full welcome footprint (logo, tagline,
  permissions) at 15 rows without "Starting Clio" or false readiness glyphs, and shows the effective
  autonomy and submit key.

## Configure wizard

`tests/extended/configure-sections.test.ts` exercises `runConfigureCommand` from `src/cli/configure.ts`
and `runOnboardingWizard` from `src/cli/configure-onboarding.ts`. It drives the wizard over a
scripted TTY: `fakeTty` is a `PassThrough` stream, and `runWizard` feeds scripted `ScriptStep`s
(`DOWN`, `ENTER`, `ESC`, `CLEAR_LINE`, `CTRL_C`) through it. It also stands up real local HTTP
servers (`modelServer`, `ollamaServer`, `litellmServer`) to exercise runtime discovery, and fakes
agent runtimes on `PATH` (`fakeAgentOnPath`, `fakeAntigravityOnPath`).

The tests assert `SETTINGS_SECTIONS` navigation, that sections are isolated by `captureConfigure`,
that an unconfigured home (`unconfiguredEnv`) reaches the wizard, and that `stepsDownToRuntime`
drives the wizard down to runtime selection. `plainText` strips terminal sequences for assertions.

## Rendering invariants

`tests/extended/rendering-invariants.test.ts` exercises the transcript renderers:
`renderToolSubline`, `renderToolPreview`, `renderToolExecution`, `renderBashTranscriptExecution`
from `src/interactive/renderers/tool-execution.ts`; `renderWorkerEntryLines` from
`src/interactive/renderers/worker-entry.ts`; and `createChatPanel` from `src/interactive/chat-panel.ts`.

Focused invariants:

- **Stream order**: reasoning, prose, and tools stay in stream order across `message_start`/
  `thinking_delta`/`text_delta`/`message_end` and tool events.
- **Tool classes**: each tool class gets a gutter glyph (`GLYPH.toolHeader`, `classMutate`,
  `classExecute`, `classNetwork`, `workerAgent`, `classInteraction`, `classExternal`), running rows
  are progressive, settled rows are past tense, and the operation names what it acts on.
- **Failed edits**: a failed mutation keeps the text that did not match; a failed edit's error is
  stated once, in its body, beside the unmatched text.
- **Command fidelity**: a bash row states the command it ran (not a `cd` into the workspace),
  keeps every character in the full body (a lone `&` included), states a timeout only when hit, and
  cuts long commands with the ellipsis glyph, never three dots.
- **Skill load/refusal**: a skill load states its identity, who asked, and what it is for; a refused
  skill load is stated as plainly as a load from the refusal in its details (each refusal kind maps
  to a one-line reason); an explicit `/skill` prompt leads with the command in the accent token.
- **Worker cards**: a running worker shows its live action in Standard and its history only in
  Detailed; a settled card lists calls oldest first in past tense; repeated calls are counted; a
  run of one repeated call is stated once; the running clock stays on the live line at every width.
- **Dispatch grouping**: a card under a dispatch call becomes the run's row (no task, no tally, no
  body); a shadow helper the model dispatched states its task once; a fan-out keeps one tally row
  over stacked cards with quality on each card; a council round groups under one header; a failover
  names the attempt in the card header and rail row.
- **Width bounds**: wrapped facts break between facts, never inside one, on rows, cards, and
  receipts; a path outside the workspace that must be cut keeps its file name on the first line and
  repeats in full beneath it; a refusal is stated once, on the blocked row's tail, not again as the
  body's first line.

## Things to watch when editing

- **The extended suite shares one process.** `isolateClioEnv` holds a process-wide env lock, so any
  new extended test that mutates `process.env` or Clio state must call it in `beforeEach` and
  `restore()` in `afterEach`; a test that leaves the window open clobbers every concurrently
  scheduled file (the #84 gap). `tests/extended/configure-sections.test.ts` is the exception — it
  spawns the CLI as a child and uses its own `isolatedEnv()`.
- **`test:full` needs a build.** `pretest:full` runs `test -f dist/cli/index.js && test -f
  dist/metafile-esm.json || pnpm run build`, and two tests (`library-import.test.ts`,
  `compaction-controls.test.ts`) `spawnSync` `dist/cli/index.js`. Editing the CLI requires a rebuild
  before `pnpm run test:full` passes.
- **The projection is the single fold.** `tests/extended/dispatch-board.test.ts` asserts exactly one
  listener per dispatch channel. Adding a second direct subscriber to those channels in production
  code will fail the test; route new dispatch data through the observability projection instead.
- **Library import is review-first.** `applyLibraryImport` re-projects and re-fingerprints the source
  on apply. Changes that publish before a review, or that rewrite the vendor source, break the
  drift-refusal and "vendor source is never rewritten" assertions.
- **Compaction cancellation must not leak.** The production compaction test asserts that a canceled
  compaction publishes no checkpoint and no pending user turn, yet retains the reported usage under
  the originating session. Any code path that appends a `compactionSummary` or a user turn on the
  cancel path will fail the `production ${mode} cancellation` test.
- **Welcome header reads are off the render stack.** The dashboard schedules its project-context read
  once via `scheduleRefresh`; `render` must never call the reader synchronously. A failure must not
  renew the trust window or be served for a different cwd.
- **Rendering width is a hard bound.** `visibleWidth(line) <= width` is asserted at every width in
  `WIDTHS` (8–200) across launchpad, session header, and footer. Truncation must use the ellipsis
  glyph and keep facts unsplit; dropping the `…` marker or wrapping inside a fact breaks the
  invariants.

<!-- clio-coder:wiki unresolved sources: tests/extended/**, scripts/run.sh -->
