# Changelog

All notable changes to Clio Coder are tracked here. Format loosely follows
Keep a Changelog.

## Unreleased

### Added

- Added the Clio extension package model with filesystem install state, user/project scopes, enable/disable/remove behavior, discovery diagnostics, and package resource roots for skills and prompt templates.
- Added `clio extensions ...` CLI commands plus `/extensions` in the TUI for installed extension visibility.
- Added Clio share archives (`kind: "clio-share-archive"`, `formatVersion: 1`) for project context, prompts, skills, settings fragments, and extension bundles.
- Added `clio share export|import|inspect` plus `clio export` / `clio import` aliases and `/share export|import` TUI flows with dry-run conflict reporting.
- Redesigned the welcome dashboard around a CLIO coding-engine view with project familiarity, confidence, active capabilities, user preferences, extension counts, and level/progression status.

### Tests

- Added focused extension tests for install state, project/user precedence, malformed packages, and extension-backed resource loading.
- Added share archive tests for round trips, version mismatch warnings, dry-run conflicts, forced imports, and corrupted archive handling.

## 0.1.6 - 2026-05-04

Clio Coder 0.1.6 is a focused pi-coding-agent parity cut. It starts the
missing Phase 16 automation surface with a real text print mode while keeping
the implementation native to Clio's endpoint-first runtime, prompt compiler,
session, safety, receipt, and audit architecture.

### Added

- Added top-level `clio --print` / `clio -p` for one non-interactive
  orchestrator turn. The command runs through the same configured Clio
  orchestrator target and prompt compiler as the TUI, then prints only the
  assistant text to stdout.
- Added stdin plus argv prompt composition for print mode, matching the
  practical pi-coding-agent `-p` workflow for shell pipelines.
- Added a stdout guard for print-mode plumbing so startup chatter, usage, and
  diagnostics are routed to stderr while stdout remains script-friendly.

### Changed

- Reserved `--mode json` and `--mode rpc` behind explicit errors instead of
  silently treating them as ordinary subcommands. JSONL and RPC execution
  remain the next Phase 16 slices.

### Tests

- Added unit coverage for print-mode argument parsing, initial-message
  composition, and stdout guarding.
- Added end-to-end CLI coverage with a local OpenAI-compatible SSE fixture for
  `--print`, stdin merge, empty prompt errors, and reserved JSON mode.

## 0.1.5 - 2026-05-03

Clio Coder's first public alpha release. This release is intended for
developers and research-software teams who want to test a terminal-first
coding agent on real repositories while keeping human review, explicit tool
permissions, receipts, and audit trails in the loop. It is experimental:
interfaces may change, rough edges remain, and source install is still the
recommended path.

### Product highlights

- Interactive terminal UI for repository work, including a workspace
  dashboard, slash commands, model switching, receipts, cost and usage
  inspection, hotkeys, session navigation, and persistent chat state.
- Target-first model configuration for local servers, cloud APIs, and
  CLI-backed assistants. Targets can be probed, listed, selected, and routed
  separately for chat and worker agents.
- Built-in coding agents for scouting, planning, review, implementation,
  debugging, regression scouting, benchmarking, memory curation, evolution
  planning, and scientific validation.
- Persistent sessions with resume, fork, compact, replay, `/new`, and
  branch-aware navigation. `clio init` and `/init` create a checked-in
  `CLIO.md` project guide and local fingerprint state.
- Workspace orientation through the welcome dashboard and `workspace_context`
  tool, plus codewiki indexing and lookup tools for entry points and symbols.
- Safety modes for default, advise, and super workflows. Privileged actions
  require explicit confirmation, protected artifacts are tracked, and
  finish-contract advisories flag completion claims without recent validation
  evidence.
- Receipts and audit logs for run metadata, usage, tool activity, mode
  changes, aborts, and session lifecycle events.
- Evidence and eval workflows for building inspectable evidence corpora from
  runs, sessions, receipts, audit rows, and eval results, then comparing
  baseline and candidate runs.
- Scoped memory records that must be approved and evidence-linked before they
  are injected into prompts under a fixed budget.
- TUI hardening for long tool output, thinking blocks, usage accounting,
  model selection, popup framing, and terminal-width-sensitive rendering.

### Added

- Added `clio init` and `/init` to bootstrap `CLIO.md` plus local
  `.clio/state.json` fingerprint state.
- Added CLIO.md parsing, serialization, project fingerprinting, and session
  lifecycle state refresh for project context.
- Added codewiki indexing and lookup tools for repository entry points and
  symbols.
- Added clearer `/cost` accounting for fresh input, cached prefix reads,
  output, reasoning, model requests, and processed totals.
- Added a redesigned `/model` popup with summary counts, stable model
  metadata columns, filtering, selected-row details, and terminal-width
  guards.
- Added CLIO-branded popup frames across the interactive overlays.

### Changed

- Project context injection now loads `CLIO.md` only. `CLAUDE.md`,
  `AGENTS.md`, `GEMINI.md`, and `CODEX.md` are read during `/init` and folded
  into `CLIO.md`; they are no longer walked and merged on every turn.
- Model capability resolution now follows the selected wire model instead of
  assuming the endpoint default.
- Session replay caps oversized retained content so resumed sessions do not
  resend unbounded historical payloads.
- Local usage accounting now exposes provider-reported cached prefix reads
  without treating them as hidden conversation history.
- Tool and thinking rendering now keeps long, streaming, and structured
  output readable in the chat panel.

### Alpha notes

- The recommended install path is still from source using the GitHub release
  tag. npm distribution is planned but not yet available under
  `@iowarp/clio-coder`.
- Clio Coder can execute tools in your repository. Review privileged actions,
  use safety modes intentionally, and do not treat the assistant as an
  unattended production operator.
- Model behavior depends on the target you configure. Quality, tool calling,
  reasoning, context length, and usage reporting vary by target.
- The full release gate is `npm run ci`, covering typecheck, lint, unit,
  integration, boundary, build, and end-to-end tests.

## 0.1.4 — 2026-04-30

The v0.1 evolution-plane release. v0.1.4 lands the components registry
(M1), typed change manifests (M2), the deterministic evidence corpus
builder (M3), the middleware domain with tool-surface enforcement (M4),
protected-artifact safety logic and persistence (M5), the advisory
finish-contract check (M6), the local eval runner with baseline and
candidate comparison (M7), the long-term memory domain with bounded
prompt injection (M8), eight new specialist agent recipes (M9), and a
scientific-validation pack covering HPC and scientific repositories
(M10). The same gated memory section reaches both interactive turns and
worker subprocesses, so `clio run` and the chat-loop see identical
lessons. A workspace-orientation pass surfaces cwd, project type,
branch, dirty flag, and recent commits in the welcome dashboard and
exposes the same snapshot to agents through a new `workspace_context`
tool. Engine fidelity gains pi-parity compaction, anchored context
accounting, a status-indicator domain, and a richer chat-loop replay
path. No breaking changes. No settings migration required. Sessions,
receipts, and audit JSONL written by v0.1.3 remain readable.

### Added — components

- `clio components` lists read-only harness components with stable
  ids, SHA-256 content hashes, authority, reload class, and owner
  metadata. `clio components --json` emits a stable snapshot envelope.
- `clio components snapshot --out <path>` writes that envelope to
  disk. `clio components diff --from <snapshot-a.json> --to
  <snapshot-b.json>` compares two snapshots and summarizes added,
  removed, changed, and unchanged components.
- The scanner inventories prompt fragments, agent recipes, tool
  implementations and helpers, runtime descriptors, safety rule
  packs, config and session and receipt schemas, context files, doc
  specs, and memory.

### Added — evolve

- `clio evolve manifest init|validate|summarize` creates, validates,
  and summarizes typed change manifests for auditable harness
  improvement proposals.
- Manifest validation enforces version 1, required iteration id, base
  git sha, and per-change rollback plan, requires at least one
  component id or changed file per change, requires predicted
  regressions for high-authority changes, and admits empty evidence
  refs only for the first exploratory iteration.

### Added — evidence

- `clio evidence build --run <runId>`, `clio evidence build --session
  <sessionId>`, `clio evidence build --eval <evalId>`, `clio evidence
  inspect <evidenceId>`, and `clio evidence list` create and inspect
  deterministic evidence artifacts from dispatch run ledger, receipt,
  session, audit, and eval data.
- Evidence artifacts link available session entries and audit JSONL
  rows into `transcript.md`, `audit-linked.jsonl`,
  `tool-events.jsonl`, `overview.json`, and `findings.json` without
  requiring model calls.
- Findings are tagged with the closed evidence taxonomy
  (`auth-failure`, `blocked-tool`, `build-failure`,
  `context-overflow`, `cwd-missing`, `destructive-cleanup`,
  `missing-dependency`, `no-validation`, `protected-artifact`,
  `provider-transient`, `proxy-validation`, `test-failure`,
  `timeout`, `tool-loop`, `wrong-runtime`, plus link-quality tags).

### Added — eval

- `clio eval run --task-file <tasks.yaml> --repeat <n>` runs
  repo-local YAML eval tasks through explicit setup and verifier
  subprocess commands, persists local eval result artifacts under
  `<dataDir>/evals/<evalId>.json`, and `clio eval report <evalId>`
  summarizes pass/fail counts, token and cost totals, wall time, and
  failure classes.
- Eval runs build deterministic evidence artifacts under the existing
  evidence store, link the generated evidence id back into each eval
  result, and can be rebuilt with `clio evidence build --eval
  <evalId>`.
- `clio eval compare <baselineEvalId> <candidateEvalId>` compares
  persisted eval artifacts by `taskId` plus `repeatIndex`, reporting
  matched, added, missing, regression, improvement, unchanged,
  failure-class, token, cost, wall-time, and pass-rate deltas.

### Added — memory

- `clio memory list`, `clio memory propose --from-evidence
  <evidenceId>`, `clio memory approve <memoryId>`, `clio memory
  reject <memoryId>`, and `clio memory prune --stale` manage scoped,
  approved, evidence-linked local memory records under the XDG data
  directory without model calls.
- Interactive turns inject a compact, deterministic memory section
  into the system prompt when approved, evidence-linked, in-scope
  memory is available. The section is hard-capped at 5 records and
  ~400 tokens, only selects approved memory with at least one
  evidence ref and no recorded regressions, and is omitted entirely
  when no memory applies. Backed by a new dedicated `memory.dynamic`
  prompt fragment so the section never grows unbounded.
- The memory store is bounded at 500 records. Approved records become
  stale after 180 days without verification; unapproved records
  become stale after 30 days.

### Added — middleware

- A pure middleware domain ships with declarative built-in rule
  metadata and a deterministic no-op hook runner for future policy
  wiring. Eleven hooks (`before_model`, `after_model`, `before_tool`,
  `after_tool`, `before_finish`, `after_finish`, `on_blocked_tool`,
  `on_retry`, `on_compaction`, `on_dispatch_start`,
  `on_dispatch_end`) and six effect kinds (`inject_reminder`,
  `annotate_tool_result`, `block_tool`, `protect_path`,
  `require_validation`, `record_memory_candidate`) are admitted.
- Interactive tool execution invokes middleware `before_tool` and
  `after_tool` hooks around admitted tool runs without changing tool
  behavior.
- Dispatch carries a worker-safe declarative middleware snapshot into
  worker runs so native worker tools replay no-op middleware hooks
  from data instead of loading middleware code dynamically.

### Added — safety / protected artifacts

- Pure protected-artifact safety logic ships for deterministic
  protection state updates, validation command detection, and
  conservative destructive command classification.
- Protected artifact protection events are persisted as session
  entries and exported into deterministic evidence artifacts,
  including `protected-artifacts.json`.

### Added — finish-contract

- Interactive turns run an advisory finish-contract check that warns
  when an assistant completion claim has no recent validation
  evidence or explicit limitation. Recorded in evidence and consumed
  through the middleware `before_finish` and `after_finish` hooks.

### Added — workspace orientation

- `src/domains/workspace/` ships three pure probes: a git probe (branch,
  dirty flag, remote URL, recent commits) with scratch-repo tests, a
  project-type detector that reads manifest files, and a `probeWorkspace`
  aggregator that returns a stable snapshot.
- The session domain captures a workspace snapshot at session bind so
  resume and fork replay see the same orientation the first turn saw.
- A new `workspace_context` tool exposes that snapshot to the model in
  one call. Prompts that previously fabricated workspace facts or
  hand-rolled `.git/HEAD` reads now invoke the tool once and finish in
  roughly five seconds with correct facts.
- The interactive welcome dashboard renders a workspace panel showing
  cwd, project type, branch, dirty flag, and remote URL. Idle context
  usage shows `idle` with a dim bar before the first user turn instead
  of a stale percent.
- Mode prompt fragments and `MODE_MATRIX` enumerate the new tool so it
  is visible in `default`, `advise`, and `super` modes; the
  action-classifier admits it; and the boundary test
  `tests/boundaries/mode-fragments-tool-truth.test.ts` enforces parity.

### Added — agents

- Eight new built-in agent recipes ship under
  `src/domains/agents/builtins/`: `memory-curator` (advise) drafts
  candidate memory records from evidence, `debugger` (advise)
  produces root-cause analysis with failure class and recommended
  component changes, `regression-scout` (advise) maps risk surfaces
  and targeted negative tests, `middleware-author` (advise) drafts
  declarative middleware rules with test cases, `attributor`
  (advise) produces per-change keep/rollback recommendations from
  baseline and candidate evals, `evolver` (advise) drafts a
  `change_manifest.json` and minimal implementation plan,
  `benchmark-runner` (default) executes eval suites and summarizes
  failure classes and budget notes, and `scientific-validator`
  (advise) drafts validation contracts from a scientific task and
  artifact list.
- Built-in recipe enumeration is regression-tested; new recipes are
  picked up by `clio components` automatically.

### Added — scientific-validation

- A scientific-validation pack ships as a docs/spec at
  `docs/specs/scientific-validation.md` plus three declarative
  middleware rules in `src/domains/middleware/rules.ts`:
  `science.no-existence-only-validation` reminds agents that file
  existence does not validate scientific artifacts;
  `science.preserve-checkpoints` marks validated checkpoint and
  restart artifacts as protected against destructive cleanup; and
  `science.unit-vs-scheduler-validation` distinguishes local unit
  validation from scheduler-backed validation (`sbatch`, `srun`,
  `qsub`, `flux run`).
- The spec covers the YAML validation contract format, supported
  artifact families (HDF5, NetCDF, Zarr, FITS, CSV, Parquet, VTK,
  ParaView output, Slurm output, MPI rank-sensitive tests, checkpoint
  files, simulation restart artifacts, plots), and the three
  declarative rule intents.

### Added — dispatch / worker memory

- `DispatchRequest` and `JobSpec` now carry an optional
  `memorySection?: string` field. `dispatch.buildSystemPrompt`
  prepends the section to whichever base prompt wins
  (`req.systemPrompt` or `recipe.body`) with a blank-line separator;
  an empty section is a no-op.
- `cli/run.ts` loads memory records via `loadMemoryRecordsSync`,
  calls `buildMemoryPromptSection`, and passes the resulting string
  through `DispatchRequest.memorySection`. Workers see the same
  gated memory the chat-loop sees, with the same scope and budget
  defaults. The worker isolation invariant is unchanged because no
  new `src/domains/**` import enters `src/worker/**`.

### Changed — providers and runtimes

- A unified `llamacpp` runtime replaces the four surface-specific
  variants in the configure menu. The unified descriptor defaults to
  `/v1/chat/completions`, the universal surface for any modern `--jinja`
  llama-server build. The legacy ids (`llamacpp-anthropic`,
  `llamacpp-completion`, `llamacpp-embed`, `llamacpp-rerank`, and
  `lemonade-anthropic`) stay registered for back-compat with existing
  `settings.yaml` but are marked hidden. The Local HTTP menu drops from
  eleven entries to seven (`openai-compat`, `lemonade`, `llamacpp`,
  `lmstudio-native`, `ollama-native`, `sglang`, `vllm`). Power users can
  still see hidden ids with `clio configure --list --all`.
- `clio doctor` warns on every endpoint pinned to a legacy hidden alias
  and rewrites `runtime: llamacpp-completion` to `runtime: llamacpp`
  when `--fix` is on. The other legacy ids encode intent the unified
  descriptor does not preserve, so they get a warn-only manual hint.
- `RuntimeDescriptor` gains a `hidden` flag; `ProbeResult` gains
  `chatApiFamily` and a `ProbeSurfaceMap` so composite local descriptors
  record which inference surfaces they probed and which they will use
  for chat. `listProviderSupportEntries` accepts a new
  `ListProviderSupportOptions` so `clio configure --list --all` can
  surface hidden aliases.

### Changed — interactive TUI

- The `/model` picker scales between 60 and 120 columns based on
  `terminal.columns` so descriptions no longer truncate mid-word on wide
  terminals. The picker also suppresses the `auth=not-required` badge
  for local-tier endpoints where it is always redundant.
- Idle context usage shows `idle` with a dim bar when no user traffic
  has occurred, matching the welcome-dashboard contract.
- Pressing Esc while a modal overlay is open now closes the overlay
  instead of falling through to cancel the active run. Previously the
  inline cancel path stole the keystroke and required a second press,
  and in some flows the super-mode overlay's orphaned state silently
  elevated the session. Ctrl+C is unchanged.
- The thinking preview clips to terminal width instead of wrapping into
  the rail prefix, fixing layout drift on narrow terminals.
- Every subcommand accepts `--help` consistently. `clio components list`
  is now an explicit alias of `clio components`. `clio agents --help`,
  `clio components --help`, `clio upgrade --help`, and `clio run --help`
  all print full usage instead of defaulting to top-level help.

### Changed — engine parity

- Compaction now mirrors pi `prepareCompaction`: split-turn compaction
  summarizes pre and turn-prefix separately through a turn-prefix prompt
  template; iterative compaction respects the prior `compactionSummary`
  as a lower bound so prior summaries are never re-fed to the
  summarizer; and after compact, `agent.state.messages` is rebuilt via
  `buildReplayAgentMessagesFromTurns(deps.readSessionEntries())` to
  preserve the kept suffix, mirroring pi `_runAutoCompaction`'s
  `agent.replaceMessages(buildSessionContext().messages)`. Overflow
  recovery prunes the failed assistant before compact and re-prompts
  with the same user request.
- Context accounting moves to `src/domains/session/context-accounting.ts`
  with a provider-bound `estimateAgentContextTokens` that anchors on the
  last assistant usage and guards with `max(projection, anchored)`. The
  welcome dashboard percent now derives from live agent state instead of
  cumulative billing tokens. `extractReasoningTokens` handles the
  scattered provider shapes (`reasoningTokens`,
  `output_tokens_details.reasoning_tokens`,
  `completion_tokens_details`).
- A new `src/interactive/status/` controller adds a phase state machine,
  watchdog tiering, and an overlay frame stack for tool, retry, compact,
  and dispatch states. The footer and chat panels surface the agent verb
  plus a turn summary line. Safety audits alarmable status transitions
  (`stuck`, `tool_blocked`, `retrying`, `cancelled`).
- Rich assistant payload persistence carries content blocks, usage, api,
  provider, model, and `responseId`. Provider-shaped replay reconstructs
  `AgentMessages` from session entries with full content shape preserved.
  Ctrl+T thinking visibility now applies across the entire transcript
  instead of toggling only the most recent block. Reasoning tokens
  surface only when usage payloads expose them.

### Changed

- Tool registry middleware hooks enforce generic tool-surface
  effects: `block_tool` stops an admitted call before execution, and
  `annotate_tool_result` appends deterministic middleware
  annotations to tool results. Built-in middleware remains no-op
  until future policy domains produce effects.
- Tool registry middleware hooks honor `protect_path` effects in
  in-memory protected-artifact state, pass validation command
  metadata to middleware, and block protected artifact writes or
  destructive bash commands before tool execution.
- Protected artifact state is rehydrated from session entries on
  interactive startup and session switches so protection survives
  resume, tree branch selection, and fresh-session resets.
- Memory operations share a single record clone helper instead of
  two near duplicates, and memory drops the unused domain-module
  wrapper (manifest, contract, extension) that no consumer
  registered. Consumers import directly from
  `src/domains/memory/index.ts`.

### Fixed

- Worker subprocesses register the Clio API providers
  (`lmstudio-native`, `ollama-native`) before any agent run, so `clio
  run` against a local-server target no longer fails with `No API
  provider registered for api: lmstudio-native`.
- `workspace_context` is reachable end-to-end. `MODE_MATRIX` for
  `default`, `advise`, and `super` enumerates the tool, the
  action-classifier admits it, and prompts that previously fabricated
  workspace facts now invoke the tool once and answer from real data.
- Cancelling a write through the super-mode confirmation overlay now
  blocks the same write through bash redirection, `tee`, `cp`, and `mv`.
  `extractCommandWriteTargets` parses shell write-targets out of bash
  commands; the action-classifier feeds each through the same
  `writePathClass` gate the write tool uses; `damage-control-rules.yaml`
  gains belt-and-suspenders kill switches for shell redirect or `tee`
  into `/etc`, `/usr`, `/var` (excluding `/var/tmp`), `/bin`, and
  `/sbin`. The active agent run is hard-stopped on super-mode cancel so
  pi-agent-core does not auto-continue past the parked-call rejection.
- The bash subprocess abort grace measures elapsed time on a monotonic
  clock so the SIGTERM-to-SIGKILL escalation no longer drifts under
  wall-clock adjustments.
- A dead `providers-overlay.diag.ts` (224 LOC of TUI-mocking code that
  violated the project's "don't mock pi-tui" rule, never bundled by
  tsup, never referenced) is removed.

### Notes

- Pi SDK pin remains at `0.70.x` (current lock: `0.70.2`). Engine
  boundary, worker isolation, and domain independence invariants
  unchanged.
- Default safety mode remains `default`; `advise` and `super` modes
  unchanged from v0.1.3.
- v0.1.x runtime tier is still `native` only; `sdk` and `cli` tiers
  remain scaffolded and rejected by dispatch until v0.2.
- Memory is intentionally not domain-modulated. The chat-loop and the
  worker dispatch path are the two consumers of
  `buildMemoryPromptSection`.
- Middleware effects honored by the tool registry this slice are
  `block_tool`, `annotate_tool_result`, and `protect_path`.
  `record_memory_candidate` is declarative metadata only; future slices
  wire memory candidate emission through the `memory-curator` agent
  recipe.
- Test counts at tag time: 944 unit, integration, and boundary tests
  green; 53 e2e tests green. Lint covers 477 source files.

## 0.1.3 — 2026-04-27

Polish release on top of v0.1.2. Four user-visible TUI improvements
(live tool output, bash echo, Ctrl+T thinking, footer git branch),
local-runtime hardening for LM Studio and Ollama, CLIO.md as the
canonical project instruction file, identity alignment with IOWarp's
CLIO ecosystem of agentic science, self-development mode hardening,
two CI substrate fixes, and a clean-clone smoke job to catch
dev-env-only test passes before the next tag. No breaking changes.
No settings migration required. Sessions, receipts, and audit JSONL
written by v0.1.2 remain readable.

### Added — interactive TUI

- Live tool output. `tool_execution_update` events stream into the
  expanded tool block as they arrive, with a dim `(running...)`
  marker that disappears on `tool_execution_end`. Long-running
  `bash`, `grep`, and shell commands no longer leave the block empty
  until exit. Capped at 12 visible lines with `... N more lines
  hidden` overflow; latest output is preserved.
- Bash command echo. Successful `bash` results render
  `$ <full-command>` on its own line under the rail before the
  output, matching what you would see in a real terminal. Errors
  stay on the standard red-rail path so the failure signal is not
  diluted.
- `Ctrl+T` toggles the most recent assistant turn's thinking block
  between a one-line dim preview and the full rail-prefixed body.
  Symmetric with the existing `Ctrl+O` tool-segment toggle.
  Registered as `clio.thinking.expand` (default `ctrl+t`); rebindable
  via `settings.yaml` and surfaced in `/hotkeys`.
- Footer git-branch slot. The status footer reads `branch:<name>`
  when launched from inside a git repository. Resolves once at boot
  via a new `src/utils/git.ts` helper with a 1s timeout and a null
  fallback for non-repos, missing `git`, or timeouts. No live
  refresh in v0.1.x; cwd changes during a session leave the slot
  stale until the next boot.

### Added — project context loading

- CLIO.md is the canonical project instruction file and is
  auto-loaded by walking from the working directory upward. The
  loader merges CLAUDE.md, AGENTS.md, CODEX.md, and GEMINI.md into
  the same compiled prompt, with CLIO.md winning on conflicts.
  `--no-context-files` (alias `-nc`) still skips the entire chain.

### Added — local runtimes and discovery

- `clio targets convert <id> --runtime <runtimeId>` rewrites an
  existing endpoint's runtime in place. Use it to migrate
  `openai-compat` targets pointing at LM Studio or Ollama onto
  their native runtimes without re-entering credentials.
- `clio doctor` fingerprints `openai-compat` URLs and warns when
  the URL responds as LM Studio or Ollama, suggesting the convert
  command.
- `clio configure` and `clio targets add` detect native local
  servers on the entered URL and offer to switch the runtime to the
  native counterpart at setup time.
- Native local-server residency and routing become the default for
  detected local targets, replacing the prior generic openai-compat
  path.

### Added — self-development mode

- `clio --dev` requires a project-level `CLIO-dev.md` rule pack to
  activate. Resolution checks `<repoRoot>/CLIO-dev.md` first, then
  `<clioConfigDir>/CLIO-dev.md` (the XDG fallback respects
  `CLIO_HOME` and `CLIO_CONFIG_DIR` for dev sandboxing). Missing
  files fail boot with an explanatory stderr message naming the
  expected paths.
- On activation against a protected branch (`main`, `master`,
  `trunk`, or detached HEAD), `clio --dev` prompts for a slug and
  runs `git switch -c selfdev/YYYY-MM-DD-<slug>` before any engine
  write. Cancellation or git failure surfaces as exit 1 instead of
  silently editing the protected branch.

### Changed — local runtimes

- `lmstudio-native` evicts non-target loaded models before each
  prompt (within a 60-second cache) so the active model owns VRAM
  and does not spill into system RAM.
- `lmstudio-native` passes `verbose: false` to the LM Studio SDK by
  default so the runtime no longer prints upstream JIT-load progress
  lines on every prompt. Set `CLIO_RUNTIME_VERBOSE=1` to restore the
  verbose stream.
- `ollama-native` pins the active model with `keep_alive: -1`. The
  chat-loop hot-swap path fires a one-shot `keep_alive: 0` sweep
  against other resident models so the prior pinned weights release.
- `llamacpp-completion` and `llamacpp-anthropic` probes report a
  diagnostic note when the configured wire model id does not match
  the server's single loaded model.

### Changed — identity

- Clio Coder is positioned as the coding agent inside IOWarp's CLIO
  ecosystem of agentic science, targeting HPC and scientific-
  software developers across the NSF-funded IOWarp project. The
  system prompt fragment, CLIO.md identity section, README,
  package.json description and keywords, CLI help text, orchestrator
  banner subtitle, and chat-loop fallback identity all reflect the
  new positioning. Architecture, engine boundaries, runtime
  selection, and test surfaces are unchanged.

### Changed — packaging and docs

- `package.json` `files` no longer references AGENTS.md, STATUS.md,
  or GOVERNANCE.md (the files were never shipped). CLIO.md is
  published instead.
- README.md and CONTRIBUTING.md document CLIO.md instead of
  AGENTS.md.

### Changed — safety rule packs

- `damage-control-rules.yaml` is restructured under schema v2 as a
  named `packs[]` list (`base`, `dev`, `super`). Historic kill-
  switches stay under `base` (always-on); the dev pack carries every
  regex previously inlined in the bash guard. The bash guard reads
  the dev pack only when self-dev mode is active, so the base pack
  is the sole source of truth in normal operation.

### Changed — CI

- The runner installs `fd-find` on `ubuntu-latest` so slash-
  autocomplete `@path` completion is exercised on every push.
- A new `clean-clone-smoke` job runs the full gate against a fresh
  shallow checkout with no npm cache, catching dev-tree-only test
  passes before tagging instead of after.

### Fixed

- Slash-autocomplete `@path` completion resolves `fd` or `fdfind`
  from PATH instead of hardcoding `fd`. Fixes the autocomplete on CI
  and on Debian/Ubuntu users who installed the `fd-find` apt
  package.
- `clio --dev` accepts `CLIO_DEV_ALLOW_PROTECTED_BRANCH=1` as a
  boot-time opt-out for the protected-branch guard. Mirrors the
  existing `CLIO_DEV_ALLOW_ENGINE_WRITES=1` pattern; the per-write
  guard remains in force.
- `clio doctor --json` returns `{ok, fix, findings}`; `clio targets
  --json` returns `{targets: [...]}`. Both are now stable JSON
  envelopes with room for forward-compatible top-level fields.
- The streaming partial path coerces non-text `partialResult`
  envelopes through `previewResult` instead of `String(...)`. Tools
  that emit non-text partials (e.g. Task partials carrying
  `{ elapsedTimeSeconds, taskId }`) no longer render as
  `[object Object]` under the rail.

### Notes

- Pi SDK pin remains at `0.70.x` (current lock: `0.70.2`). Engine
  boundary, worker isolation, and domain independence invariants
  unchanged.
- Default safety mode remains `default`; `advise` and `super` modes
  unchanged from v0.1.2.
- v0.1.x runtime tier is still `native` only; `sdk` and `cli` tiers
  remain scaffolded and rejected by dispatch until v0.2.

## 0.1.2 — 2026-04-25

### Added

- Interactive chat now retries transient provider and stream failures using
  session retry settings. Retry boundaries, cancellation, exhaustion, and
  recovery are visible in the transcript and persisted for resume/fork replay.
- Tool and bash transcript lines now show clearer running/success/error status
  with bash command previews and elapsed time in live and replayed transcripts.
  Tool segments collapse by default with per-tool sublines, and `Ctrl+O`
  toggles full-output expansion through the keybindings manager.
- Edit-tool results render a unified diff preview alongside the structured
  tool-execution block.
- Settings overlay exposes retry controls (`retry.enabled`, `retry.maxRetries`,
  `retry.baseDelayMs`, `retry.maxDelayMs`) so users can tune retry behavior
  without hand-editing `settings.yaml`.
- The interactive TUI now opens with a Clio Coder dashboard showing target,
  model registry, context, latency, and worker-profile status. Interactive
  startup no longer prints a separate legacy banner above the dashboard.
- `/hotkeys` supports row selection, a read-only keybinding detail panel, and
  legacy-terminal warnings when user bindings require CSI-u support.
- Editor prompt rails reflect the active mode: default uses the terminal
  foreground, advise uses amber, super uses red.
- Slash-command autocomplete: typing `/` opens a filtered dropdown of every
  built-in command, and Tab accepts the selected entry.
- `/resume` picker now shows a one-line conversation preview, message count,
  and relative time per session.
- Prompt assembly auto-loads project context files (`AGENTS.md`, `CODEX.md`,
  `CLAUDE.md`) walking from the working directory upward; pass
  `--no-context-files` (alias `-nc`) to disable.
- Run receipts now carry per-tool stats (loops, errors, blocked attempts,
  parallel batches) emitted by worker telemetry hooks.
- `clio targets --json` exposes `detectedReasoning` and
  `reasoningCandidateModelId` so the `/thinking` probe state is observable
  from the CLI.
- Compaction summaries persist `triggerReason` and `tokensAfter` in the
  session entry stream, leaving a queryable trail for every `/compact`.
- Audit JSONL is now a five-arm discriminated union over `kind`: `tool_call`,
  `mode_change`, `abort` (sources `dispatch_abort`, `dispatch_drain`,
  `stream_cancel`), `session_park`, `session_resume`. Safety subscribes on
  start, unhooks on stop, and fsyncs every row. Integration coverage lives
  in `tests/integration/audit-{mode-transitions,run-aborts,session-lifecycle}.test.ts`.
- `tools.web_fetch` honors the abort signal end-to-end; bash abort coverage
  now includes a success-then-abort guard.

### Changed

- Slash-command help and autocomplete present only canonical commands:
  `/model`, `/quit`, and `/receipts [verify <runId>]` replace duplicate
  spellings such as `/models`, `/exit`, and `/receipt verify <runId>`.
- Provider catalog and cloud defaults realign with `pi-ai` 0.70.2; the
  `@mariozechner/pi-*` line is pinned to 0.70.x with a current lock at 0.70.2.
- Worker tool-call path validates once and threads telemetry hooks so the
  agent loop, dispatch board, and receipts share one source of truth.
- Mode fragments must now enumerate the matrix tool set; a new regression
  test pins per-mode tool resolution and toggle re-resolution so future drift
  between `MODE_MATRIX` and the chat-loop fails fast.

### Fixed

- Retrying a transient failure continues from the existing user turn instead
  of duplicating it in model context.
- Cancelling an interactive run cancels any pending retry countdown and
  forwards abort signals into bash tool subprocesses.
- The last failed assistant message is pruned from live model context on
  every terminal exit of the retry chain so live state matches what
  `/resume` and `/fork` rebuild from the persisted transcript.
- A retryable error thrown from `agent.prompt` persists the original error
  as a visible failed assistant entry instead of surfacing only as a
  `[retry]` status line.
- Bash subprocess abort escalates to `SIGKILL` after a 5-second `SIGTERM`
  grace period so commands that trap or ignore `SIGTERM` no longer hang
  the chat-loop.
- Bash commands that exceed the 2 MB output cap report
  `command output exceeded N bytes` instead of a generic `SIGTERM`
  termination.
- `/resume`, `/fork`, and `/new` abort an in-flight agent run before
  reseating context so a pending retry-chain `agent.continue()` cannot race
  the new session's messages.
- Retry status lines render byte-identically in the live transcript and
  after `/resume` by sharing a single formatter.
- Streamed responses that emitted partial text before failing render both
  the partial output and the terminal error indicator together.
- Failed turns with empty usage no longer write zero-token rows to the
  observability ledger.
- User-facing product labels consistently say Clio Coder instead of mixing
  lowercase command-name branding into headers, prompts, and status text.
- Provider hot-swap on a same-endpoint model switch now updates the live
  agent without rebuilding the chat-loop, and stale model state is hardened
  on every swap surface.
- `lmstudio-native` preserves reasoning content, drops `<think>` tags, and
  forces `toolUse` on tool calls so `/thinking` and `clio run` behave on
  LM Studio backends.
- `openai-compat` tool schemas and reasoning probe align so `/thinking`
  and `clio run` work against local llama.cpp / vLLM / SGLang servers.
- Dismissing the Alt+S super-mode overlay emits a `request_cancelled`
  `mode_change` audit row instead of dropping the transition silently.

## 0.1.1 — 2026-04-24

### Added

- Interactive prompt compilation now loads project context files from the
  current working directory upward. `AGENTS.md` and `CODEX.md` are injected in
  deterministic parent-to-child order when present.

### Fixed

- Session resume, fork, and tree-switch replay now read the rich session entry
  stream instead of only legacy user/assistant turns, so compaction summaries,
  branch summaries, bash/tool entries, custom display entries, system notes,
  and checkpoints are visible when present.
- Interactive tool calls and results are now written as durable session entries
  so tool work remains visible after resume and fork.
- Resuming a session whose JSONL tail is metadata no longer resets the next
  turn parent to `null`; the interactive loop now derives the resumed leaf
  from the persisted tree.
- CLI-backed subprocess runtimes now dispatch through the native worker entry
  instead of running inline in the orchestrator process.
- Out-of-tree SDK runtime plugins now pass runtime descriptor validation and
  rehydrate correctly inside native worker subprocesses.
- `/receipt verify <runId>` now verifies a SHA-256 integrity field against the
  persisted run ledger entry instead of accepting schema-valid receipt JSON.
- Dispatch heartbeats now promote stale/dead worker states into run state and
  the live dispatch board instead of leaving silent workers marked running.
- `npm run check:boundaries` now exists for the boundary command documented in
  contributor guidance.

## 0.1.0-exp — 2026-04-24

First public release. Experimental. Expect moving surfaces; pin the tag if
you need a stable target.

### What ships

- **Interactive TUI.** Terminal chat with target and model controls, session
  navigation, resume/fork, markdown-rendered replies, configurable
  keybindings, a searchable resume picker, scoped-model cycling, a
  live-updating dispatch board, and receipts/cost overlays.
- **CLI lifecycle.** `clio`, `clio configure`, `clio targets`, `clio models`,
  `clio auth`, `clio doctor`, `clio reset`, `clio uninstall`, `clio agents`,
  `clio run`, `clio upgrade`, `clio --version`.
- **Target-first configuration.** Local HTTP engines, cloud APIs,
  OAuth/subscription runtimes, and CLI-backed runtimes all live in
  `targets[]`; `orchestrator` and `workers` point at those ids. Known and
  discovered models are surfaced through `clio models` and the TUI model
  selector.
- **Runtime coverage.** Native subprocess worker; protocol adapters for
  openai-compat, llamacpp, Ollama, vLLM, SGLang, LM Studio, Lemonade;
  cloud adapters for Anthropic, OpenAI, Google, Groq, Mistral, OpenRouter,
  Bedrock; OAuth path for openai-codex (ChatGPT Plus/Pro via Codex);
  CLI-backed runtimes for Codex CLI, Claude Code CLI, Gemini CLI, Copilot
  CLI, OpenCode CLI; and a Claude Agent SDK worker path.
- **Seven builtin agents.** `scout`, `planner`, `researcher`, `reviewer`,
  `delegate`, `context-builder`, `worker`. Plain Markdown specs with
  frontmatter in `src/domains/agents/builtins/`.
- **Dispatch and workers.** `clio run` spawns OS-isolated worker
  subprocesses with NDJSON IPC and heartbeats. Named worker profiles
  let the interactive session fan out across multiple runtimes.
- **Self-development mode.** Hot-reload and restart-required signals for
  developers editing Clio from inside Clio, with shell environment isolation
  and tool guards.
- **Receipts and audit.** Every run writes a receipt under
  `<dataDir>/receipts/<runId>.json` with token counts and USD cost.
- **Safety model.** Three modes (`default`, `advise`, `super`) gate tool
  visibility at the registry. Hardcoded Bash kill-switches live in
  `damage-control-rules.yaml`.
- **State layout.** XDG-aware, with `CLIO_HOME` plus `CLIO_CONFIG_DIR` /
  `CLIO_DATA_DIR` / `CLIO_CACHE_DIR` overrides for sandboxed installs.

### Known limits

- Windows is best-effort until a later release.
- The self-dev harness is a developer convenience, not a polished public
  surface.
- Some runtime slots (remote fan-out, broader MCP) are scaffolded but not
  admitted by dispatch yet.

### Verification

- `npm run ci` gates typecheck, lint, unit/integration/boundary tests,
  production build, and e2e spawn + pty tests.
