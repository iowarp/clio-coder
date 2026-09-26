---
title: "Command-line surfaces"
summary: "The argument-parsing and subcommand-dispatch entry point for every Clio Coder CLI surface, the configure wizard and target-selection flows, the headless main-agent runner, and the fleet authoring/execution and read-only run-viewer commands."
sources:
  - "src/cli/index.ts"
  - "src/cli/run.ts"
  - "src/cli/modes/print.ts"
  - "src/cli/configure.ts"
  - "src/cli/configure-onboarding.ts"
  - "src/cli/targets.ts"
  - "src/cli/fleet.ts"
  - "src/cli/fleet-view.ts"
  - "src/cli/usage.ts"
tests:
  - "tests/extended-smoke/cli-core.test.ts"
  - "tests/contracts/targets-use-unused-model.test.ts"
  - "tests/contracts/settings-target-wizard.test.ts"
  - "tests/boundaries/check-boundaries.ts"
invariants:
  - "Every subcommand is a literal dynamic import through the `COMMAND_HANDLERS` map in `src/cli/index.ts`, so a bare `clio-coder --version` pays for its own module graph and nothing else."
  - "`--api-key`, `--no-context-files`, `--no-skills`, and `--skill` are honored only by the `run` and `acp` subcommands; `--with-panes`/`--no-panes` are honored by no subcommand at all."
  - "The headless `clio-coder run` text mode keeps stdout the assistant's answer alone; the session id and any failure go to stderr."
  - "The configure onboarding wizard persists nothing until the operator chooses Save at the review step; every earlier answer lives only in the in-memory `Answers` object."
validate:
  - "node --import tsx tests/boundaries/check-boundaries.ts"
  - "pnpm test:file tests/extended-smoke/cli-core.test.ts"
---

# Command-line surfaces

## What this area does

The `src/cli` area is every command-line surface Clio Coder ships as the
`clio-coder` binary. It owns argument parsing, global-flag extraction, and the
subcommand dispatch table in `src/cli/index.ts`, then delegates to one module
per command: the interactive boot hand-off, the headless single-turn runner,
the configure wizard and target setup, target listing and role selection,
fleet authoring and execution, the read-only fleet run viewer, and the
cross-session usage analyzer. It does not own the domain logic those commands
drive; it parses, preflights, and hands control to the composition root and the
domain modules.

The area's central design decision is cold-start cost. `package.json` maps the
`clio-coder` bin to `dist/cli/index.js`, whose entry is `main` at
`src/cli/index.ts:168`. `main` sets `process.title`, sets the `AI_AGENT`
environment marker, parses only the top-level flags statically, and then routes
every subcommand through a literal dynamic `import(...)` inside the
`COMMAND_HANDLERS` map. The comment at `src/cli/index.ts:168` states this is the
"highest-value cut of the cold module-load tax," and the map doubles as the
command-recognition source used by the global value flags.

## Ownership and entry points

| Surface | Entry symbol | File |
|---------|--------------|------|
| Process entry + dispatch | `main` | `src/cli/index.ts:168` |
| Headless turn command | `runClioRun` | `src/cli/run.ts:309` |
| Headless main-agent runner | `runHeadlessMainAgent` | `src/cli/modes/print.ts:624` |
| Configure wizard + settings | `runConfigureCommand` | `src/cli/configure.ts:2281` |
| First-run onboarding steps | `runOnboardingWizard` | `src/cli/configure-onboarding.ts:974` |
| Target list/use/profile | `runTargetsCommand` | `src/cli/targets.ts:178` |
| Fleet authoring + execution | `runFleetCommand` | `src/cli/fleet.ts:829` |
| Fleet run viewer | `runFleetView` | `src/cli/fleet-view.ts:681` |
| Usage analyzer | `runUsageCommand` | `src/cli/usage.ts:303` |

The dispatch table `COMMAND_HANDLERS` (a `Map<string, CommandHandler>`) in
`src/cli/index.ts` holds one handler per subcommand; each handler is a closure
whose body is a literal `await import("./<name>.js")`. `extensions` and `ext`
share one handler; `export` and `import` share one. A `dev` prefix resolves to
the same handlers as the unprefixed names via a second `dispatch` call. Retired
names (`context-init`, `context-index`, `context-clear`) stay in the
`RETIRED_SUBCOMMANDS` set so the top-level value flags cannot swallow them as a
flag value and boot a different mode.

## How data and control flow

### Headless turn (`clio-coder run "<task>"`)

The full path is:

1. `main` in `src/cli/index.ts:168` extracts global flags (`--api-key`,
   `--no-context-files`, `--no-skills`, `--skill`, `--with-panes`,
   `--no-panes`, `--autonomy`, `--demo`) and dispatches `run`.
2. `run`'s handler calls `enableBootCompileCache`, then dynamically imports
   `src/cli/run.ts` and invokes `runClioRun(subArgs, bootOptions)`.
3. `runClioRun` (`src/cli/run.ts:309`) parses the run flags, arms `--timeout` as
   a coordinated-shutdown deadline, assembles the prompt from message tokens,
   piped stdin, and `@file` references, and runs a headless slash preflight that
   refuses interactive commands and answers display-only templates.
4. For the main-agent path it calls `takeOverStdout`, then `runClioCommand`
   (`src/cli/clio.ts`) with a `headless: { prompt, mode, jsonEvents, ... }`
   bundle. `runClioCommand` boots the orchestrator via `bootOrchestrator`
   (`src/entry/orchestrator.ts`), which loads the domain modules and resolves
   the model target.
5. The orchestrator calls `runHeadlessMainAgent` (`src/cli/modes/print.ts:624`)
   on the created chat loop. That function subscribes to `chat.onEvent`, folds
   tool outcomes and usage into a `HeadlessMainAgentReceiptStats`, submits the
   prompt, and seals a receipt into the run ledger through
   `recordHeadlessMainAgentReceipt`.

`runHeadlessMainAgent` is the wrapper that owns the run's accounting; the
`ChatLoop` it receives does the turn. The `HeadlessShutdownHooks` interface it
accepts defaults to the process termination coordinator, so `--timeout`, a
SIGTERM, and a normal settle all seal the same receipt through one path.

### Fleet run viewer (`clio-coder fleet view <runId>`)

`runFleetView` (`src/cli/fleet-view.ts:681`) is the read-only surface an
operator uses over SSH or inside a workers-view pane:

1. It parses `--follow`, `--watch`, `--all`, and four `--*`-dir overrides, then
   `applyViewDirs` pins the already-resolved layout into `process.env` before
   any read.
2. It computes `fleetInspectionScope(all)` so `--all` widens the inspection
   across projects; without it the view is scoped to this project.
3. For a run id it calls `resolveRunId` (exact ledger id first, then a unique
   prefix), then `loadRunViewModel`, which reads the ledger envelope, the run
   event journal at `<state>/runs/<runId>/events.ndjson`, and the sealed
   receipt. The transcript is capped at `TRANSCRIPT_LIMIT = 400`
   (`src/cli/fleet-view.ts:78`).
4. `renderRunView` is a pure function over `RunViewModel`; the snapshot path
   joins its lines onto stdout and exits.
5. With `--follow` (or `--watch <selection-file>`) the command enters an
   alternate-screen loop that re-reads the journal at `POLL_MS = 250`
   (`src/cli/fleet-view.ts:76`) until the terminal line lands, then stays open
   until `q`. The `--watch` loop re-reads the selection file each poll, so the
   TUI retargets this process through one atomic file write with no socket
   traffic.

A fleet root id (`fleet-<hex>`, prefixed by `FLEET_ROOT_PREFIX` at
`src/cli/fleet-view.ts:406`) is not a run: it renders the step index from the
durable record under `<state>/fleet-runs/<rootId>.json` instead, one line per
step naming the run id to view next.

### Target role selection (`clio-coder targets use <id>`)

`runTargetsCommand` (`src/cli/targets.ts:178`) routes the `use` subcommand to
`runUse`, which:

1. Parses the target id and the role flags (`--model`,
   `--orchestrator-model`, `--background-model`, `--fleet-model`,
   `--fleet-target`).
2. Calls `unusedSharedModelReason`, which refuses `--model` when the role flags
   select a specific role and name its own model — the focused test in
   `tests/contracts/targets-use-unused-model.test.ts` pins the exact message
   `--model 'dynamo/new' would not be used` and the remediation
   `--orchestrator-model 'dynamo/new'`.
3. Calls `useTargetInSettings` (`src/core/config.ts`) to mutate a draft copy of
   the settings, returning the roles it touched.
4. For each selected role, verifies the chosen model against the runtime's live
   inventory through `resolveSupportedWireModels`, refusing a model the target
   does not advertise (exit 1) and warning when it cannot verify offline.
5. Commits the draft with one `updateSettings` call, so a refusal cannot
   partially update another role.

### Configure onboarding (`clio-coder configure`)

`runConfigureCommand` (`src/cli/configure.ts:2281`) branches on TTY. On a
terminal with no targets it launches `runConfigLauncher`, which offers
Quick Connect, Settings, and Diagnostics. The first-run path instead runs
`runOnboardingWizard` (`src/cli/configure-onboarding.ts:974`).

The wizard is a list of steps (`STEPS` at `src/cli/configure-onboarding.ts:924`):
`category`, `runtime`, `target-id`, `credential`, `credential-value`, `url`,
`detected-runtime`, `model`, `thinking`, `context-window`,
`antigravity-colleague`, and `review`. Each step draws its prompt, erases it
once answered, and leaves one row on a lifecycle rail saying what was chosen.
Escape moves the cursor back one step and `writer.rewindTo(mark)` erases the
rail rows the step left behind, so the screen is the answers so far plus the
question at hand. Steps that do not apply (`applies(answers)` false) are skipped
in whichever direction the cursor is moving.

Nothing persists until `finish` runs: `applyAnswers` mutates a preview of
`readSettings()`, `validateSettings` throws a `SettingsValidationError` if the
preview is invalid, and only then does `updateSettings` write. The focused test
`tests/contracts/settings-target-wizard.test.ts` demonstrates this with
`ScriptedWizard` — a subclass of `TargetWizardSurface` that drives the same
select/text prompts — asserting that a cancel at the review step leaves
`readSettings()` unchanged and that a late probe cancel cannot save a target.

## Enforced boundaries and lifecycle ordering

### Global flag ownership

`BOOT_OPTION_COMMANDS` (`src/cli/index.ts:136`) is the set `{"run", "acp"}`.
`unhonoredBootFlag` (`src/cli/index.ts:140`) returns a refusal for the first
boot flag a subcommand cannot honor. The effect is that `--api-key K fleet run`
fails with a message naming the flag and the command, rather than running on
the configured key with no word said. `--with-panes`/`--no-panes`
(`PANES_FLAGS`) are refused for every subcommand because they apply only to the
interactive session.

### Headless stdout contract

`runHeadlessMainAgent` (`src/cli/modes/print.ts:624`) owns the stdout contract
for the main-agent path. In text mode the session id is written to stderr the
moment it exists (`writeTextSessionId`), and the final answer — either the
assistant's text or, for a terminating tool, the tool's result line — is the
only thing written to stdout. The comment states that printing mid-workflow
chatter instead would hand the operator a dangling "let me try..." for a turn
that succeeded. The focused test
`tests/extended-smoke/cli-core.test.ts` asserts this with `--json-events
terminal`, checking the event stream carries `session`, `turn_start`,
`agent_end`, and `turn_end` frames and that the receipt seals with `outcome:
"succeeded"`.

### Configure save-once rule

The onboarding wizard's `Answers` object is the only place an answer lives until
Save. The repo compiles with `exactOptionalPropertyTypes`, so each field is
explicitly `| undefined`; going back a step clears the answers that depended on
the one being changed by assigning `undefined`. The focused test
`tests/contracts/settings-target-wizard.test.ts` proves that a cancel at the
review step and a cancel during a probe both leave settings unchanged, and that
the "Add remains a draft until Save" assertion holds across the whole flow.

### Fleet run zero-side-effect preflight

`runFleetCommand` (`src/cli/fleet.ts:829`) for the `run` subcommand performs a
preflight that validates the fleet graph, resolves every step's target and
model, and rejects missing or unresolvable targets before any write or model
call. The help text in `fleet.ts` states the preflight is "zero side effects":
a validation failure exits 2 and touches nothing.

### Fleet view receipt integrity

`evidenceLine` in `src/cli/fleet-view.ts` authenticates the receipt against the
ledger envelope through `inspectRunReceiptTrustStatus` before any of its fields
are shown. A receipt that fails integrity contributes its failure reason and
nothing else; the task text and journal event details are sanitized and bounded
through `sanitizeBounded` because they cross the operator/worker trust seam.

## Extension seams

- **New CLI subcommand**: add an entry to `COMMAND_HANDLERS` in
  `src/cli/index.ts` whose body is a literal dynamic `import("./<name>.js")`.
  The literal form is load-bearing — the comment at the map states that
  "every dynamic import stays a literal so tsup can split command graphs" — and
  that adding a command in one place cannot leave a global flag free to swallow
  it as a value.

- **New configure wizard step**: add a `Step` object to the `STEPS` array at
  `src/cli/configure-onboarding.ts:924`. The step's `applies` closure decides
  whether it shows, and its `run` closure must return one of the `StepOutcome`
  values (`next`, `back`, `quit`, `cancel`, `credential`). The order in the
  array is the forward direction; going back rewinds the rail to the step's
  row.

- **New headless mode**: the headless runner is `src/cli/modes/print.ts`,
  alongside `json-stream.ts` and `jsonl.ts`. A new mode that needs the chat
  loop but different output (e.g. a different JSON projection) would live in
  this directory and be called from `src/cli/run.ts`.

- **New fleet view projection**: `loadRunViewModel` builds the
  `RunViewModel`, and `renderRunView` is the pure renderer. A new view (e.g. a
  combined transcript or a different column layout) adds a projection function
  over the same model, following the pattern of `renderWatchView` and
  `renderFleetRunView`.

- **New fleet inspection scope**: `fleetInspectionScope` (imported from
  `src/cli/fleet-project-scope.ts`) returns a scope object with `seesRun` and
  `seesRoot`. Widening or narrowing what `fleet view` and `fleet status` can see
  means changing that scope, which both the run resolver and the fleet-root
  resolver consume.

## Focused tests

- `tests/extended-smoke/cli-core.test.ts` spawns the built binary
  (`dist/cli/index.js`) against a mock OpenAI-compatible server. It asserts
  `--version` prints the package version, `--help` routes usage to stdout with
  exit 0, an unknown subcommand exits 2 with the error on stderr, `doctor
  --fix` creates a fresh home, `configure --runtime openai-compat` without
  `--id` exits 2, `configure` with `q` input exits 130, and a full
  `--json-events terminal` run seals a receipt with `outcome: "succeeded"` and
  `agentId: "main-agent"`. It also asserts the `targets use` role flags update
  only their own role and name only that role, and that rejecting an
  unadvertised model is atomic (no partial write).

- `tests/contracts/targets-use-unused-model.test.ts` calls `runTargetsCommand`
  and `useTargetInSettings` directly. It demonstrates that `--model` combined
  with `--fleet-target`/`--fleet-model` is refused with a message naming the
  flag that would be unused and the remediation, and that the same call works
  once `--model` is moved to `--orchestrator-model`.

- `tests/contracts/settings-target-wizard.test.ts` drives the wizard through a
  `ScriptedWizard` subclass of `TargetWizardSurface`. It demonstrates the
  save-once rule (cancel leaves settings unchanged), the late-probe-cancel
  guard (cancel during a probe cannot save), the text-prompt validation and
  back navigation, and that the settings overlay mounts Add and Edit as docked
  prompts.

- `tests/boundaries/check-boundaries.ts` is the import-boundary checker. Rule
  6 specifically governs the CLI: a CLI file may reach `src/interactive/**` and
  `src/engine/**` only through a seam declared in `STAGE0_SEAMS`. The declared
  seams for the CLI include `src/engine/tui-primitives.ts` (used by
  `src/cli/fleet-view.ts`), `src/interactive/slash-commands.ts` (used by
  `src/cli/run.ts`), and `src/engine/oauth.ts` (used by `configure` and
  `auth`).

## Things to watch when editing

- **The literal dynamic import is the code-splitting contract.** Changing a
  `COMMAND_HANDLERS` entry from a literal `import("./x.js")` to a variable or
  computed path breaks tsup's chunk splitting and defeats the cold-start design.
  The comment at the map in `src/cli/index.ts` states this explicitly.

- **`runHeadlessMainAgent` owns the receipt seal.** The seal is idempotent:
  `sealed` is set to the promise on first call, and both the turn's completion
  path and the coordinated-shutdown drain hook race to it. Reordering the seal
  or adding a second seal path will lose usage on interrupted runs. The comment
  at `src/cli/modes/print.ts:624` explains that the drain hook is registered
  after the composition root's chat drain hook so the stats folded are final.

- **The onboarding wizard's rail is a line-count contract.** `railWriter`
  counts lines that went through it and rewinds with a terminal erase sequence.
  A step that writes to the output stream without going through the
  `writer.stream` proxy breaks the rewind math, and the next back-navigation
  will leave stale text on screen.

- **`fleet view`'s import boundary is load-bearing.** The file imports
  `ProcessTerminal` and `TuiAltScreen` from `src/engine/tui-primitives.ts`,
  never from the `src/engine/tui.ts` barrel. The comment at the top of
  `src/cli/fleet-view.ts` states that an edge to the barrel breaks the Stage 0
  instant-shell chunk budget. Adding a TUI primitive import from the barrel
  will fail the boundary check.

- **The headless stdout contract is asserted by tests.** `tests/extended-smoke/cli-core.test.ts`
  checks the exact event stream and receipt fields for a `--json-events
  terminal` run. Changing the text-mode stdout behavior (e.g. printing the
  session id to stdout, or printing mid-workflow chatter) will break the test
  and the contract the comment at `src/cli/modes/print.ts:624` describes.

- **`targets use` validation is atomic by design.** The model validation loop
  in `runUse` (`src/cli/targets.ts`) checks every selected role against the
  runtime's live inventory before calling `updateSettings`. A failure in any
  role exits 1 and writes nothing. The focused test
  `tests/contracts/targets-use-unused-model.test.ts` asserts this atomicity
  with `strictEqual(readFileSync(path, "utf8"), before)`.

<!-- clio-coder:wiki unresolved sources: src/interactive/**, src/engine/** -->
