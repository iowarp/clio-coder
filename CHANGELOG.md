# Changelog

All notable changes to Clio Coder are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/), and versions follow
semantic versioning for a pre-1.0 project: minor versions may change
interfaces.

## 0.2.3 - 2026-06-11

Clio Coder 0.2.3 is a TUI command-surface sprint. It moves the interactive
experience away from transcript dumps and one-off command handlers toward a
small registry-backed command set, reusable full-screen overlays, and footer
notices that keep operational feedback out of the chat transcript.

The release also consolidates model targets, skills, settings, and
observability into single-purpose hubs. Several old slash commands are retired
because their behavior now lives in richer surfaces: `/targets`, `/skill`,
`/help`, and `/view`.

### Added

- Added a declarative slash-command registry. Command parsing, usage lines,
  autocomplete, and the command reference now derive from one spec with aliases,
  flags, positionals, subcommands, repeatable values, and command-owned value
  placeholders.
- Added the shared `ListOverlay` kit for grouped, filterable browse surfaces
  with Esc-clears-then-closes behavior, wrap-around selection, live footer
  hints, and optional markdown detail panes.
- Added full-screen overlays for `/help`, `/agents`, `/prompts`, and
  `/extensions`. `/help [query]` opens the Help Center pre-filtered, and
  `/prompts` can insert a selected prompt invocation into the editor.
- Added the `/targets` target hub with compact target rows, in-place details,
  active/health sorting, selected-row actions, serialized async auth/probe
  actions, and success-level footer notifications.
- Added the `/skill` Skills Hub with installed project/user groups, a live
  GitHub marketplace backed by the repository `skills/` tree, lazy SKILL.md
  detail loading, 24-hour disk caching, offline fallback to stale and pinned
  marketplace data, and in-place marketplace install.
- Added the `/settings` Settings Center with Safety, Orchestrator, Fleet,
  Budget, Compaction, Retry, and Terminal sections, a two-lane desktop layout,
  a stacked narrow layout, row descriptions, config paths, current values, and
  refresh-in-place behavior on config changes.
- Added `/view`, a full-screen observability viewer for run receipts, dispatch
  metadata and outputs, durable tool outputs, and compaction summaries. It has
  a grouped/filterable artifact list, a pager-style content pane, lazy
  token-fenced loading, cached markdown rendering, JSON pretty-printing under a
  10 MB cap, 50k-line truncation, selected-receipt verification, path notices,
  Tab focus switching, `/view <id-or-filter>`, and `/view verify <runId>`.
- Added sprint closure contract coverage that locks the exact v0.2.3 slash
  command registry and fails if a retired slash command returns.
- Added a loop guard for the interactive orchestrator. Verbatim-repeated tool
  calls are blocked at the registry admission seam with recovery feedback the
  model can act on, surfaced as footer warn notices over a new
  `safety.loopBlocked` bus event, and the turn is cancelled after three blocks.
  Workers keep their own in-process guard and are never observed twice.
- Added indentation-tolerant edit matching. When an exact and a normalized
  match both fail, a final stage matches line sequences ignoring leading
  whitespace, enforces uniqueness, and reindents the replacement to the file's
  own prefix.
- Added scratch offloading for truncated tool results. The full original
  output is written to `<dataDir>/scratch/<sessionId>/<toolCallId>.txt`, the
  truncation hint carries the path, and the model can read the remainder with
  offset and limit. Write failures degrade to plain truncation.
- Added a working middleware rule engine. Hook evaluation is a pure in-process
  fold over rule definitions that pair declarative rules with effect payloads
  and exact tool-name scoping, with a registration seam on the bundle and
  payload resolution by rule id when workers reconstitute snapshots. Zero
  builtin rules ship.

### Changed

- Replaced bracket-prefixed command output dialects with a themed single-line
  notice channel for info, success, warning, and error messages.
- Replaced hand-written overlay footer text with `buildHint`, including
  canonical key casing, browse/commit Esc verbs, and middle-first elision.
- Standardized user-facing vocabulary on "target" while leaving persisted ids
  under the existing endpoint-shaped settings fields.
- Changed `/targets` so Enter only expands/collapses details; target activation
  and auth/probe work happen through explicit selected-row keys.
- Changed `/skill` so Enter inserts `/skill:<name>` for task completion, while
  marketplace installation is an explicit selected-row action.
- Changed `/settings` to delete read-only rows for worker profiles, endpoint
  counts, and keybindings. Targets are managed in `/targets`, and keys are
  documented in `/help`.
- Changed observability workflows so the transcript remains compact and `/view`
  carries detailed inspection, verification, and backing-path lookup.
- Changed `/tree` Enter to switch to the highlighted turn id. The visible
  transcript and chat-loop replay are truncated through that turn, and the next
  append point follows the selected turn instead of the session id.

### Fixed

- Fixed `/tree` turn selection so rows are action-honest: turn rows now act on
  turn ids, not the current session id.
- Fixed `/tree` footer hints by removing delete actions that could never
  succeed from a turn-row overlay.
- Fixed `/tree` switch failures and unavailable-session handling to use typed
  footer notices instead of raw stderr.
- Fixed stale command references in user-facing docs so the post-sprint
  command set points users to `/skill`, `/targets`, `/help`, and `/view`.
- Fixed fuzzy-matched edits rewriting the whole file in normalized form.
  Smart quotes, unicode dashes, and trailing whitespace far from the edit site
  were silently mutated; matches now map back to original line spans and bytes
  outside the replaced spans are untouched.
- Fixed middleware snapshot contracts reporting every enabled matching rule as
  fired; `ruleIds` now lists exactly the rules that emitted effects.

### Removed

- Removed the `/status` slash command. Live status moved into footer/dashboard
  surfaces and command output notices.
- Removed the `/hotkeys` slash command and the static `SLASH_HOTKEYS` table.
  Key help now comes from `/help` and each overlay's live footer hint.
- Removed the `/skills` slash command. The Skills Hub is `/skill`; colon
  invocation aliases such as `/skill:<name>` and `/skills:<name>` remain.
- Removed `/connect` and `/disconnect` as standalone slash commands. Target
  auth actions now live on the selected row in `/targets`.
- Removed `/receipts` and its old overlay. Receipt browsing and verification
  live in `/view` and `/view verify <runId>`.

## 0.2.2 - 2026-06-11

Clio Coder 0.2.2 is the largest harness revision since the v0.2.0 community
alpha. It retires the CLI-subprocess runtime era: Clio now drives
HTTP/native/pi-ai-backed targets directly, and external coding agents
integrate through Agent Client Protocol (ACP) delegation instead of hidden
subprocess shims. The release also hardens skill activation, introduces a
curated skills catalog, and upgrades `CLIO.md` into a full project rulebook
that future sessions can rely on.

The local-inference hot path was rebuilt around prompt-prefix stability: one
compiled system prompt and one deterministic tool surface per session, bounded
tool results, single-threshold compaction, and per-call timing and cache
telemetry persisted in the session ledger. On a single-slot llama.cpp backend
this turns repeated full-prompt prefills into cache reads; the measured
first-turn gap on the same hardware dropped from roughly a minute to about a
second once the prefix is resident. Concurrent Clio processes are now safe on
one machine: live routing is session-owned, and the shared settings file is
written through field-level patches under an advisory lock.

### Added

- Added the Context Engine featuring context window resolution, per-model probe capabilities, unified character-based token accounting, per-turn context snapshots, and a persisted snapshot ledger.
- Added single-threshold context compaction with a cheap stale-observation masking pre-stage, LLM summary fallback when pressure remains above threshold, manual `/compact`, and overflow recovery.
- Added bounded tool-result handling with a 6KB source cap, an 8KB shaping backstop, 16KB summary-kind tool policies, continuation hints, and a 20KB `ask_user` policy.
- Added per-turn performance telemetry for assistant calls: TTFT, API duration, prompt-cache input/read/write counts, backend cache verdicts, and expected-cold reasons.
- Added session-owned live routing so multiple Clio processes can run against
  the same configuration safely. Each interactive or ACP process seeds its
  routing from `settings.yaml` at boot; routing changes (`/model`, `/settings`,
  Alt+L, Alt+J/K, Shift+Tab, `/thinking`, `/scoped-models`) apply to the
  session immediately and write through as defaults for future sessions, while
  external settings writes update defaults only and surface a divergence
  notice. Recently selected models moved to `state/recent-models.json` in the
  data dir (legacy `state.recentModels` migrates on first read), and saved
  settings writes go through field-level patches under an advisory file lock.
- Added a live measurement harness: `scripts/live-turns.mjs` drives the real
  TUI through tmux for reproducible multi-turn sessions, and
  `scripts/turn-report.mjs` renders per-call timing, token, and cache-verdict
  forensics from the session ledger.
- Added an event-driven `/context-view` overlay visualizer, a context meter, and compact footer telemetry.
- Added `clio acp`, a stdio Agent Client Protocol v1 server surface for ACP
  frontends. The server maps Clio chat events, tool-call updates, cancellation,
  usage metadata, cwd-aware session creation, and optional session close support
  into ACP-shaped JSON-RPC messages.
- Added ACP delegation support for configured agents. Dispatch can spawn an ACP
  peer, initialize a session, send the delegated task with Clio prompt context,
  mediate `session/request_permission` through Clio safety policy, stream mapped
  agent events, and record ACP session/usage metadata in receipts.
- Added contract and smoke coverage for ACP event mapping, permission mediation,
  stdio delegation, `clio acp` serving, strict ACP v1 initialize/update shapes,
  stop-reason normalization, and cancellation.
- Added richer skill compatibility and activation behavior: normalized skill
  loading, project/user compatibility roots for Agent Skills, Claude, Codex,
  OpenCode, and Copilot-style layouts, slash-command parity, runtime-option
  propagation to workers, and upgraded `read_skill` / `create_skill` tooling.
- Added a curated skills marketplace under `skills/` with the first wave of
  approved skills (`context-prime`, `context-handoff`, `clio-dev`, `clio-test`),
  an `install.sh` bridge that links a catalog skill into a runtime discovery
  root (`.clio/skills` or the user config skills dir), and a provenance
  frontmatter convention (`registry-id`, `source-url`, `version`, `audit`) that
  distinguishes maintainer-approved skills from local runtime skills. The
  catalog is not a discovery root, so nothing auto-loads; skills activate only
  on explicit install. `clio-test` documents the real v0.2.2 harness
  (contracts/smoke/boundaries) and the build/config hot-reload loops.
- Added custom-section support to `CLIO.md` parsing, serialization, bootstrap
  generation, and project-context rendering. `/init --generate` can now preserve
  compact architecture boundaries, workflow traps, retrieval strategy, generated
  artifact policy, and failure modes instead of flattening everything into six
  bullets.
- Added Clio-source-tree awareness to the prompt harness. When Clio is running
  inside her own repository, the model is told that TUI, skills, agents, tools,
  prompts, context/bootstrap, and harness changes are ordinary local source work
  when requested, while publishing, pushing, releases, PRs, and registry
  contribution still require explicit user intent.
- Added deterministic local source install and uninstall scripts. `npm run
  install:local` links `${CLIO_BIN_DIR:-$HOME/.local/bin}/clio` to the built
  checkout, and `npm run uninstall:local` removes that symlink plus selected
  Clio state with dry-run and settings/auth preservation options.

### Changed

- Simplified Clio Coder to a single, unified operating posture, removing old advice, default, and super modes along with the legacy mode matrix.
- Integrated ACP delegation agents as first-class workers and restricted shadow agent delegation to external ACP workers.
- Hardened permissions handling with queued permission overlays and deterministic headless permission denials during `clio run`.
- Replaced the split worker/orchestrator runtime eligibility vocabulary with a
  single `isTargetEligibleRuntime` policy used by chat, print, dispatch, target
  listing, and worker-spec validation.
- Restricted `RuntimeDescriptor` to the direct runtime path Clio can actually
  govern: HTTP/native/pi-ai-backed targets. The normal Anthropic Messages API
  through pi-ai remains; Claude Code as a programmatic runtime does not.
- Changed dispatch receipt behavior for batch and delegated work so worker
  summaries and ACP delegation metadata are clearer and easier to audit.
- Refreshed the root `CLIO.md` from a tiny rule list into Clio Coder's own
  repository rulebook: architecture map, context/bootstrap constitution,
  workflow for changing Clio itself, self-development/contribution etiquette,
  and high-risk failure modes.
- Converted release/developer guide material into interactive HTML blueprints
  for installation, lifecycle, documentation, validation, and related operator
  workflows.
- Reworked the chat loop to compile one session prompt keyed by endpoint, model,
  safety level, and session id. Prompt recompiles are logged as
  `promptRecompiled` ledger entries only when the compiled text changes.
- Reworked provider tool delivery to use one deterministic session tool surface.
  Per-tool safety, pending-skill, ask-user, and dispatch policies are enforced
  at invocation time.
- Reworked the session ledger writer to true append mode: each persisted entry
  is one `O_APPEND` write with a debounced fsync that is forced at checkpoint
  and close, instead of rewriting the whole `current.jsonl` on every append.
  History-rewriting operations keep the atomic tmp+rename path, and a torn
  trailing line from a crash is newline-terminated on resume so the reader
  skips exactly one invalid line with a warning.

### Fixed

- Fixed ACP server/client output to conform to ACP v1 closed-schema shapes:
  non-spec capabilities stay out of top-level initialize responses, tool kinds
  are mapped to ACP's closed enum, Clio metadata is namespaced under `_meta`, and
  pi-agent stop reasons such as tool-use/error are normalized or surfaced as
  protocol-safe results.
- Fixed runtime target cleanup fallout after subprocess removal so target
  eligibility, provider support lists, dispatch worker specs, and runtime
  diagnostics agree on the same direct-runtime model.
- Fixed skill worker launches so runtime options are propagated into worker
  specs instead of being lost across dispatch boundaries.
- Fixed dispatch batch worker summaries so multi-worker runs report coherent
  completion data.
- Fixed CLIO.md project-context injection so custom H2 sections survive parsing
  and are visible to future turns instead of being silently discarded.

### Removed

- Removed the `claude-code-sdk` runtime descriptor, its worker runtime
  implementation (`src/engine/claude-code-sdk-runtime.ts`), and the SDK safety
  policy bridge (`src/engine/sdk-policy-bridge.ts`).
- Removed the `claude-code-cli`, `gemini-cli`, `copilot-cli`, `codex-cli`, and
  `opencode-cli` CLI subprocess runtime descriptors and their invocation/parsing
  paths. There are no remaining built-in subprocess runtimes.
- Removed the subprocess runtime execution engine
  (`src/engine/subprocess-runtime.ts`) and the native CLI
  auth/status/login/logout path (`src/cli/native-cli-auth.ts`).
- Removed the worker-only runtime terminology and eligibility helpers
  (`WORKER_ONLY_RUNTIME_IDS`, `isWorkerOnlyRuntime`,
  `isWorkerTargetEligibleRuntime`, `isOrchestratorTargetEligibleRuntime`),
  replaced by the single direct-runtime eligibility predicate.
- Removed the `cli`/`cli-gold`/`cli-silver`/`cli-bronze` runtime tiers, the `cli`
  auth type, and the `subprocess-codex`/`subprocess-opencode` API families from
  the built-in runtime model.
- Removed the tool-approval IPC that existed solely for the Claude Code SDK
  worker: the `clio_tool_approval_request`/`clio_tool_approval_response`
  channel, the `SpawnedWorker` approval handlers, the worker stdin demux
  approval wait, the TUI tool-approval overlay, and the `tool.approval.*` bus
  channels.
- Removed the `--auto-approve` CLI flag, the `auto_approve` dispatch tool
  argument, the `WorkerSpec.autoApprove` field, the Claude-Code-specific
  `--supervised` dispatch flag, and `DispatchRequest.supervised`.
- Removed Claude Code / agent-SDK entries from `RuntimeApiFamily` and the worker
  spec's accepted runtime API families.
- Removed per-turn dynamic prompt fragments, prompt diagnostics events, send-policy
  prompt churn, and per-turn tool-surface selection.
- Removed the five-stage compaction ladder and replaced the old settings block
  with `compaction: { auto, threshold, excludeLastTurns, model?, systemPrompt? }`.
  Existing settings files are rewritten once by the
  `2026-06-11-compaction-single-threshold` lifecycle migration.

### Release verification

- Deterministic release gate: `npm run ci:release` passed at tag time,
  covering typecheck, Biome checks, the production build, 286 contract,
  smoke, and boundary tests, and `check-dist` packaging verification.
- Manual release-prep evidence covered local source install/uninstall smoke
  checks, interactive TUI checks, dispatch work, destructive-delete refusal,
  and opt-in live model smoke through `npm run test:live`.
- The package is not published to npm for this release; the supported install
  path is a source checkout of the `v0.2.2` tag.

## 0.2.1 - 2026-06-05

Clio Coder 0.2.1 is an alpha source-checkout patch for local model operators
running real CLI/TUI workflows through Mini, Dynamo, llama.cpp, LM Studio, and
OpenAI-compatible gateways. It updates the Pi SDK stack to 0.78.1, ports the
new prompt-envelope and session-boundary behavior from the Pi ecosystem, narrows
per-turn tool exposure, and fixes live-validation issues found while preparing
the GitHub v0.2.1 release. The package is not published to npm for this
release; use a GitHub source checkout and built `clio` binary.

### Added

- Added live and final token-throughput telemetry for completed assistant
  streams. The footer and expanded dashboard can now show compact `Tk/s`
  feedback, generation span, TTFT, and output-token counts when usage data is
  available.
- Added a larger dynamic context fill bar in the footer so long-context local
  runs, including 262k-context Gemma 4 12B llama.cpp targets, are easier to
  monitor during real sessions.
- Added hashed prompt-envelope delivery split into stable static/session
  shells and dynamic turn fragments, improving prompt-cache determinism for
  local OpenAI-compatible and llama.cpp runs.
- Added `clio run --json` prompt diagnostics events so headless consumers can
  inspect prompt signatures, active tool palettes, omitted tools, and segment
  hashes from the event stream instead of only from persisted session JSONL.

### Changed

- Retuned the expanded footer dashboard for smaller terminals: it now uses
  four horizontal sections at 100 columns and above, 2x2 at 80-99 columns, and
  vertical stacking only below 80 columns.
- Restricted dashboard toggling to Alt+U / the leader fallback. Esc is reserved
  for popups, slash-command UI, and active-run cancellation, and `/status`
  prints the dashboard key hint instead of toggling state.
- Compact speed details now use the existing output-token glyph (`↓`) so the
  Gemma 4 12B local harness dashboard stays readable in tight columns.
- Updated Pi SDK dependencies to 0.78.1 and aligned Clio's agent/session
  internals with the current Pi coding-agent reference behavior where it fits
  the Clio boundary.
- Narrowed the active tool surface per turn. Small-talk and tool-meta turns can
  run without tool schemas, repo-inspection turns stay read-only, and mutation
  or dispatch tools appear only when the user's intent calls for them.
- Bounded long tool outputs in the harness so large read/grep results carry an
  offset hint instead of flooding the model context.
- Refreshed README, developer docs, and project guidance around the current
  source-checkout alpha surface.
- Shortened the public README into a release entry point and moved detailed
  command, mode, dispatch, verification, and troubleshooting guidance into
  `docs/commands-and-modes.md`.

### Fixed

- Fixed the expanded dashboard's narrow-terminal behavior so all four sections
  remain available instead of dropping the session section.
- Fixed `clio run --agent <unknown>` so typoed fleet-agent ids fail fast with
  `unknown agent recipe: <id>` and exit 2 instead of silently spawning a generic
  worker with the visible tool surface.
- Fixed `clio run "<task>"` under headless wrappers that leave non-TTY stdin
  open. Positional tasks no longer block waiting for stdin EOF; stdin remains
  the task source when no positional task is supplied.
- Fixed the headless JSON interface gap by streaming prompt diagnostics and the
  active tool palette for main-agent runs.

### Release verification

- Deterministic release gate: `npm run ci:release`, including typecheck,
  Biome checks, build, deterministic tests, and `check-dist` packaging
  verification.
- Packaging sanity: `npm pack --dry-run --json` should show the v0.2.1 package
  contents without publishing to the npm registry.
- Optional live smoke: `npm run test:live` runs only when `CLIO_LIVE_SMOKE=1`
  and a real target is configured. Manual prep evidence included a
  Mini/llama.cpp live smoke returning `clio-live-ok`, interactive TUI coverage,
  a `dispatch_batch` run with Dynamo-backed workers, and destructive-delete
  refusal.

## 0.2.0 - 2026-06-03

Clio Coder 0.2.0 is the first community alpha release for users building from
source. It is experimental software for early adopters who can test from a
tagged checkout, report reproducible issues, and stay close to the release
notes. It hardens durable session storage and fork replay, makes `CLIO.md` the
explicit project-context path, centralizes runtime/model target resolution,
and polishes the interactive terminal UI enough for broader testing with local
and cloud targets.

### Added

- Added JIT skills as a loaded resource type, including skill cataloging,
  slash-command access, prompt injection, tool bootstrap wiring, and tests for
  skill resource loading.
- Added stronger prompt compaction behavior for populated sessions, including
  session-entry aware compaction and tests for compacting older turns without
  dropping the current working context.
- Added `clio init` / `/init` adoption support for project-local agent
  instruction files. The scanner can import supported Claude, Codex, Gemini,
  Cursor, Copilot, and related project context into `CLIO.md` with provenance
  and conflict reporting.
- Added centralized runtime target resolution so orchestrator chat, fleet
  dispatch, prompt runtime text, receipts, worker specs, and model selectors
  resolve target/model/capability state through one path.
- Added runtime diagnostics in model, scoped-model, thinking, provider, and
  overlay surfaces so operators can see target resolution and capability
  issues without leaving the TUI.
- Added command-output routing for interactive shell replay so `!!command`
  output is rendered through the TUI and excluded from model context.
- Added durable session JSONL entry coverage for labels, task ledgers, display
  activity, evidence linking, corrupt-tail recovery, stale tree metadata, and
  fork replay.
- Added documentation pages for architecture, built-in agents, evidence and
  memory, eval runner, middleware/components, model catalog, safety model, and
  scientific validation.
- Added a portable `Ctrl+G` leader-key fallback for Alt-letter TUI actions so
  stock macOS Terminal.app users can reach the dashboard, model selector, and
  other controls without terminal reconfiguration.

### Changed

- Reworked the default damage-control path policy and project policy handling
  so no-access, read-only, no-delete, wildcard, tilde, and relative paths are
  applied consistently.
- Unified headless `clio run` behavior around the orchestrator path, argument
  parsing, JSONL/non-interactive output, dispatch memory injection, and test
  coverage.
- Stabilized prompt cache and worker runtime boundaries so workers receive
  explicit runtime descriptors and prompt context remains coherent across hot
  swaps, retries, dispatches, and memory injection.
- Refactored overlay focus and framing into shared rendering paths for auth,
  cost, hotkeys, keybinding, model, provider, scoped-model, settings,
  thinking, session, tree, and super-mode overlays.
- Replaced the old `docs/specs/*` layout with user-facing docs under `docs/`
  and refreshed the README to describe the current target-first product
  surface.
- Made `clio init` output more compact while still reporting context sources,
  codewiki indexing, fingerprint updates, and workspace dirtiness.
- Consolidated macOS Terminal.app Option-key guidance into one dismissible
  footer notification with both remediation paths: enable Option-as-Meta or
  use the `Ctrl+G` leader and slash commands.

### Fixed

- Fixed damage-control wildcard escaping and formatting so path policies match
  intended files without sibling-prefix leaks.
- Fixed interactive startup and Bash replay so context warnings and command
  output do not corrupt the chat transcript.
- Fixed footer dashboard context/workspace/session freshness so CLIO.md,
  memory count, git branch/dirty state, and live submitted turns update during
  the TUI session.
- Fixed receipt overlay rendering at narrow widths and added focused coverage
  for compact rows.
- Fixed tree overlay rendering, payload-driven previews, and delete
  confirmation so narrow terminals and destructive actions are clearer.
- Fixed status overlay precedence and active-overlay tracking so retry,
  stuck, cancelled, and ended phases do not mask one another incorrectly.
- Fixed assistant summary metadata truncation in the chat panel.
- Fixed overlay key routing for delayed escape sequences in model, session,
  and tree selectors.
- Fixed session persistence and fork hardening gaps, including atomic JSONL
  writes, selected-path replay, task-ledger preservation, missing/stale tree
  recovery, corrupt-tail handling, and evidence reconstruction.

## 0.1.9 - 2026-05-17

Clio Coder 0.1.9 is a broad hardening release on top of the v0.1.6
non-interactive CLI baseline and the v0.1.7/v0.1.8 safety and approval work.
It makes fleet dispatch a first-class agent primitive, removes the retired
internal dev harness, tightens local OpenAI-compatible model handling,
adds frontend validation without shell access, and hardens the interactive TUI
around active-run follow-ups and cancellation.

### Added

- Added `dispatch` as a first-class tool for bounded fleet-agent handoffs. The
  orchestrator prompt now includes the Agent Fleet catalog, unnamed dispatches
  default to `implementer`, and duplicate dispatch requests are guarded before
  they can loop.
- Added `validate_frontend`, a typed execution tool for frontend artifacts. It
  validates `.html`, `.htm`, `.css`, `.js`, `.mjs`, and `.cjs` files under the
  workspace root; checks HTML tag structure, local script/style references,
  JavaScript syntax, CSS balance, and optional headless browser loading.
- Added a local model runtime-capabilities resolver that classifies real mini
  model families, thinking mechanisms, supported levels, effective coercion,
  request payload fields, and response parsers from one shared source.
- Added GPT-OSS/Harmony response parsing for raw llama.cpp chat-template frames
  and request synthesis for Harmony `reasoning_effort`.
- Added finish-contract evidence for successful typed validation tools,
  including `run_tests`, `run_lint`, `run_build`, standard `package_script`
  validation scripts, `validate_frontend`, dispatch receipts, and protected
  artifact records.
- Added active-run TUI coverage for plain follow-up queuing and `Esc`
  cancellation.
- Added tests for local model capability resolution, UI thinking surfaces,
  footer/dashboard effective thinking display, Harmony payload construction,
  streamed reasoning accounting, constrained Harmony JSON responses, dispatch
  tool behavior, frontend validation, finish-contract evidence, and active-run
  TUI control.

### Changed

- `/thinking`, `/settings`, the welcome dashboard, footer, hot model switching,
  prompt runtime block, and fleet-agent selection now display/use the
  effective thinking level after model-specific coercion instead of raw
  configured settings.
- Local OpenAI-compatible targets now preserve server-owned sampler defaults;
  Clio records and passes only the model-family fields it owns.
- Fleet dispatch now requires explicit allowed tool profiles and carries the
  resolved effective thinking state through the internal worker spec.
- Built-in implementer-style agents are prompted to inspect changed frontend
  artifacts and run `validate_frontend` before claiming HTML/CSS/JS work is
  complete.
- `clio run`, `clio targets`, prompt text, receipts, and README-facing copy now
  use fleet/agent terminology. The legacy `workers` settings key remains for
  compatibility with existing config files.
- Print mode now preserves the last valid assistant answer when a later
  diagnostic assistant message is emitted, instead of replacing the answer with
  advisory text.
- Eval harness metrics now count validation evidence only for successful,
  non-timed-out verifier commands.
- Public component inventory now includes the frontend validator as a
  hot-reloadable enforcing tool implementation.

### Fixed

- Fixed GPT-OSS/Harmony constrained JSON frames such as
  `<|channel|>final <|constrain|>json<|message|>{...}` being routed as hidden
  thinking or surfaced as parser errors instead of visible assistant text.
- Fixed stale GPT-OSS/Harmony marker leakage from local OpenAI-compatible
  streamed output.
- Fixed prior assistant thinking blocks being replayed upstream on later
  OpenAI-compatible turns.
- Fixed OpenAI Codex file-tool schema aliases so file/path arguments serialize
  through the expected schema shape.
- Fixed active-run TUI behavior where follow-up text and cancellation could
  leave the operator without a clear queued-turn or cancelled-run signal.
- Fixed frontend completion claims being able to pass the advisory finish
  contract without a meaningful artifact validation path.
- Fixed install/upgrade lifecycle metadata so `clio doctor` flags stale
  `install.json` versions, `clio doctor --fix` refreshes them to the current
  package version, and `clio upgrade` re-enters the installed CLI before
  running migrations and metadata repair.
- Fixed duplicate local-model capability and thinking coercion paths that could
  make UI display, prompt runtime text, and payload construction disagree.

### Removed

- Removed the retired internal dev harness and associated prompt fragments,
  tests, and diagnostic scaffolding.
- Removed user-facing `--dev` mode and internal dev prompt surfaces from
  the CLI/TUI runtime.
- Removed stale local-model helper paths that duplicated provider capability
  resolution.

## 0.1.8 - 2026-05-11

Clio Coder 0.1.8 wires the `claude-code-sdk` runtime into Clio's safety
policy engine, adds bidirectional approval IPC over the worker subprocess's
stdin, exposes a TUI overlay for `ask` decisions, and hardens
`clio configure` against unknown models and oversized context windows. It
also corrects the gemini-cli token parser and surfaces SDK safety
decisions in the receipt.

### Added

- Added the Clio extension package model with filesystem install state,
  user/project scopes, enable/disable/remove behavior, discovery
  diagnostics, and package resource roots for skills and prompt templates.
- Added `clio extensions ...` CLI commands plus `/extensions` in the TUI
  for installed extension visibility.
- Added Clio share archives (`kind: "clio-share-archive"`,
  `formatVersion: 1`) for project context, prompts, skills, settings
  fragments, and extension bundles.
- Added `clio share export|import|inspect` plus `clio export` /
  `clio import` aliases and `/share export|import` TUI flows with dry-run
  conflict reporting.
- Redesigned the welcome dashboard around a CLIO coding-engine view with
  project familiarity, confidence, active capabilities, user preferences,
  extension counts, and level/progression status.
- Added `validateModelChoice` in `clio configure` so unknown models are
  rejected with exit 2 and a listing of the known catalog. A new `--force`
  flag escapes the check with a `warning:` line for advanced users who
  know the runtime accepts the model anyway.
- Added context-window override validation. `clio configure
  --context-window N` is rejected with exit 2 when `N` exceeds the
  catalog's known maximum for the resolved model. `--force` warns and
  proceeds.
- Added a safety policy bridge for the `claude-code-sdk` runtime
  (`src/engine/sdk-policy-bridge.ts`). The bridge maps Claude Code tool
  names to Clio tool names, evaluates them against Clio's `SafetyContract`,
  and returns `allow|block|ask` decisions consistent with the native
  worker.
- Added a bidirectional approval IPC channel over the worker subprocess's
  stdin. The worker entry now demultiplexes its stdin line-by-line
  (`src/worker/stdin-demux.ts`), allowing the orchestrator to deliver
  `clio_tool_approval_response` NDJSON messages after the initial spec.
- Added `SpawnedWorker.onApprovalRequest` / `sendApprovalResponse`,
  `clio_tool_approval_request` and `clio_tool_approval_response` event
  types, and dispatch derivation of effective `autoApprove` from a new
  `supervised` flag on `DispatchRequest`/`JobSpec`/`WorkerSpec`.
- Added `clio run --auto-approve <allow|deny>` and a dispatch policy that
  appends `"headless ask auto-denied; pass --auto-approve to override"`
  to `safety.runtimeLimitations` when an unsupervised run does not opt in.
- Added a TUI tool-approval overlay
  (`src/interactive/overlays/tool-approval-overlay.ts`) that prints the
  Claude tool name, arguments, classification, and policy hint; `[A]`,
  `[D]`, and `Esc` resolve allow / deny / deny.
- Added receipt accounting for SDK safety decisions. `buildCanUseTool`
  now emits `clio_tool_finish` events for every allow, block, elevated
  (ask resolved to allow), and ask-resolved-to-deny path so the receipt's
  `safety.decisions` counters and `safety.blockedAttempts` reflect what
  Clio gated even when the underlying tool runs inside Claude Code.

### Fixed

- `subprocess-runtime` now reads gemini-cli per-call tokens from
  `event.stats` (falling back to `event.usage` for older builds) so
  gemini receipts no longer report `tokenCount: 0` on successful turns.

### Changed

- `clio configure` reuses the new `--force` flag across model validation
  and context-window validation. Without `--force`, both checks fail
  closed and no settings are written.
- The `claude-code-sdk` runtime constructor accepts an optional
  `SafetyContract`, an `autoApprove` mode, and an `awaitApproval`
  callback. When supervised, the runtime emits a
  `clio_tool_approval_request` and awaits the orchestrator's reply over
  the worker stdin channel.

### Tests

- Added focused extension tests for install state, project/user
  precedence, malformed packages, and extension-backed resource loading.
- Added share archive tests for round trips, version mismatch warnings,
  dry-run conflicts, forced imports, and corrupted archive handling.
- Added `validateModelChoice` unit tests and CLI integration cases for
  unknown / known / forced-unknown configure flows.
- Added context-window validation integration tests for known / over-cap
  / over-cap-with-force combinations.
- Added SDK policy bridge tests for the Claude-to-Clio tool mapping and
  for `allow|block|ask` evaluation across modes.
- Added worker stdin demultiplexer tests covering happy path, stdin EOF,
  timeout, and chunked-line delivery.
- Added a dispatch approval handshake integration test that drives a
  stub worker over `spawnNativeWorker` and asserts the response reaches
  the worker over stdin.
- Added e2e coverage for the tool-approval TUI overlay, the
  `--auto-approve` flag, and the `(runtime x mode x env)` permission
  matrix for the five subprocess CLI runtimes.
- Added unit tests pinning the new `clio_tool_finish` emit shape for
  each SDK decision path (policy allow, policy block, autoApprove allow,
  autoApprove deny, supervised IPC allow, supervised IPC deny).

## 0.1.7 - 2026-05-11

Clio Coder 0.1.7 is a safety architecture release. It moves Clio beyond
blacklist-only Bash defense by sharing one policy evaluator across the
orchestrator and native workers, adding default-deny Bash admission, exposing
typed execution tools, tightening dispatch scope, and making receipts/audit
rows stronger evidence for reproducible runs.

### Added

- Added a shared safety policy engine for orchestrator and native workers.
  It composes `damage-control-rules.yaml` base/dev/super packs, snapshots
  project policy, and returns structured allow/elevate/block decisions with
  rule id, reason code, policy source, command, cwd, mode, and action class.
- Added strict `.clio/safety.yaml` parsing for project command policy. Invalid
  policy fails closed for command execution, and the active run keeps the
  validated snapshot so a model cannot edit the allowlist and use it in the
  same run. Project policy `cwd` must be relative to the policy root and may
  not escape it via `..`; entries that omit `cwd` are bound to the policy root.
  Default-mode bash with a caller `cwd` outside the workspace is rejected as
  `bash-cwd-escape`. Bash redirect targets are classified against the call's
  `cwd` argument so a relative redirect cannot launder a write outside the
  workspace.
- Added typed execution tools: `git_status`, `git_diff`, `git_log`,
  `run_tests`, `run_lint`, `run_build`, and `package_script`. These use fixed
  argv vectors, bounded cwd, timeouts, output caps, and structured result
  details.
- Added receipt safety summaries with decision counts, blocked attempts,
  worker mode, dispatch scope, requested action classes, runtime limitations,
  cwd, git branch/commit, dirty-state hash, rule-pack hash, and project policy
  fingerprint.

### Changed

- Native worker safety now enforces the same base hard blocks as the
  orchestrator, including remote install pipe-to-shell patterns, block-device
  writes, filesystem creation, fork bombs, and destructive git patterns.
- Default-mode Bash is now L4-style default-deny for ordinary execution. Common
  curated commands remain available; arbitrary Bash requires project policy or
  super elevation, and base hard blocks remain hard blocks in every mode.
- Dispatch admission now honors `MODE_MATRIX[mode].dispatchScope` and derives
  requested action classes from the actual worker recipe/tool surface instead
  of assuming every worker only reads.
- Claude Code CLI/SDK and other external runtimes are treated as delegated
  sandboxes. Clio no longer maps super mode directly to external full-access
  bypass unless `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1` is set.
- Built-in default worker recipes prefer typed execution tools over Bash.
- Audit JSONL tool-call rows now carry policy provenance fields such as rule
  id, reason code, policy source, command, cwd, and policy hash where
  available.

### Tests

- Added unit coverage for project safety policy validation, active-run policy
  snapshots, default-deny Bash behavior, worker safety parity, dispatch action
  derivation, typed safe execution, and external runtime permission hardening.
- Extended receipt tests to assert blocked-attempt safety summaries and
  reproducibility metadata.

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

## 0.1.4 - 2026-04-30

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

### Added - components

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

### Added - evolve

- `clio evolve manifest init|validate|summarize` creates, validates,
  and summarizes typed change manifests for auditable harness
  improvement proposals.
- Manifest validation enforces version 1, required iteration id, base
  git sha, and per-change rollback plan, requires at least one
  component id or changed file per change, requires predicted
  regressions for high-authority changes, and admits empty evidence
  refs only for the first exploratory iteration.

### Added - evidence

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

### Added - eval

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

### Added - memory

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

### Added - middleware

- A pure middleware domain ships with a deterministic hook runner for
  future policy wiring. Eleven hooks (`before_model`, `after_model`, `before_tool`,
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

### Added - safety / protected artifacts

- Pure protected-artifact safety logic ships for deterministic
  protection state updates, validation command detection, and
  conservative destructive command classification.
- Protected artifact protection events are persisted as session
  entries and exported into deterministic evidence artifacts,
  including `protected-artifacts.json`.

### Added - finish-contract

- Interactive turns run an advisory finish-contract check that warns
  when an assistant completion claim has no recent validation
  evidence or explicit limitation. Recorded in evidence and consumed
  through the middleware `before_finish` and `after_finish` hooks.

### Added - workspace orientation

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

### Added - agents

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

### Added - scientific-validation

- A scientific-validation pack ships as a docs/spec at
  `docs/specs/scientific-validation.md` plus the
  `scientific-validator` agent recipe.
- The spec covers the YAML validation contract format, supported
  artifact families (HDF5, NetCDF, Zarr, FITS, CSV, Parquet, VTK,
  ParaView output, Slurm output, MPI rank-sensitive tests, checkpoint
  files, simulation restart artifacts, plots), and the three
  declarative rule intents.

### Added - dispatch / worker memory

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

### Changed - providers and runtimes

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

### Changed - interactive TUI

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

### Changed - engine parity

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
  annotations to tool results. The built-in middleware registry is
  empty until rules have enforced behavior and tests.
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

- Pi SDK pin remained on the previous package line. Engine
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

## 0.1.3 - 2026-04-27

Polish release on top of v0.1.2. Four user-visible TUI improvements
(live tool output, bash echo, Ctrl+T thinking, footer git branch),
local-runtime hardening for LM Studio and Ollama, CLIO.md as the
canonical project instruction file, identity alignment with IOWarp's
CLIO ecosystem of agentic science, two CI substrate fixes, and a
clean-clone smoke job to catch
dev-env-only test passes before the next tag. No breaking changes.
No settings migration required. Sessions, receipts, and audit JSONL
written by v0.1.2 remain readable.

### Added - interactive TUI

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

### Added - project context loading

- CLIO.md is the canonical project instruction file and is
  auto-loaded by walking from the working directory upward. The
  loader merges CLAUDE.md, AGENTS.md, CODEX.md, and GEMINI.md into
  the same compiled prompt, with CLIO.md winning on conflicts.
  `--no-context-files` (alias `-nc`) still skips the entire chain.

### Added - local runtimes and discovery

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

### Changed - local runtimes

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

### Changed - identity

- Clio Coder is positioned as the coding agent inside IOWarp's CLIO
  ecosystem of agentic science, targeting HPC and scientific-
  software developers across the NSF-funded IOWarp project. The
  system prompt fragment, CLIO.md identity section, README,
  package.json description and keywords, CLI help text, orchestrator
  banner subtitle, and chat-loop fallback identity all reflect the
  new positioning. Architecture, engine boundaries, runtime
  selection, and test surfaces are unchanged.

### Changed - packaging and docs

- `package.json` `files` no longer references AGENTS.md, STATUS.md,
  or GOVERNANCE.md (the files were never shipped). CLIO.md is
  published instead.
- README.md and CONTRIBUTING.md document CLIO.md instead of
  AGENTS.md.

### Changed - safety rule packs

- `damage-control-rules.yaml` is restructured under schema v2 as a
  named `packs[]` list. Historic kill-switches stay under `base`
  and elevated rules stay under `super`, keeping normal operation on
  the base pack alone.

### Changed - CI

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
- `clio doctor --json` returns `{ok, fix, findings}`; `clio targets
  --json` returns `{targets: [...]}`. Both are now stable JSON
  envelopes with room for forward-compatible top-level fields.
- The streaming partial path coerces non-text `partialResult`
  envelopes through `previewResult` instead of `String(...)`. Tools
  that emit non-text partials (e.g. Task partials carrying
  `{ elapsedTimeSeconds, taskId }`) no longer render as
  `[object Object]` under the rail.

### Notes

- Pi SDK pin remained on the previous package line. Engine
  boundary, worker isolation, and domain independence invariants
  unchanged.
- Default safety mode remains `default`; `advise` and `super` modes
  unchanged from v0.1.2.
- v0.1.x runtime tier is still `native` only; `sdk` and `cli` tiers
  remain scaffolded and rejected by dispatch until v0.2.

## 0.1.2 - 2026-04-25

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
- Provider catalog and cloud defaults realign with the then-current `pi-ai`
  package line.
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

## 0.1.1 - 2026-04-24

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

## 0.1.0-exp - 2026-04-24

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
- **Receipts and audit.** Every run writes a receipt under
  `<dataDir>/receipts/<runId>.json` with token counts and USD cost.
- **Safety model.** Three modes (`default`, `advise`, `super`) gate tool
  visibility at the registry. Hardcoded Bash kill-switches live in
  `damage-control-rules.yaml`.
- **State layout.** XDG-aware, with `CLIO_HOME` plus `CLIO_CONFIG_DIR` /
  `CLIO_DATA_DIR` / `CLIO_CACHE_DIR` overrides for sandboxed installs.

### Known limits

- Windows is best-effort until a later release.
- Some runtime slots (remote fan-out, broader MCP) are scaffolded but not
  admitted by dispatch yet.

### Verification

- `npm run ci` gates typecheck, lint, unit/integration/boundary tests,
  production build, and e2e spawn + pty tests.
