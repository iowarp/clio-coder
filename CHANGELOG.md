# Changelog

All notable changes to Clio-Coder will be documented in this file.

Format follows the spirit of Keep a Changelog (https://keepachangelog.com).
Versioning: semver after 0.1.0 ships; pre-release versions use `0.1.0-dev`
with phase tags (`phase-N-complete`, `phase-N-partial`).

## 0.1.0-rc1 (2026-04-17)

Sprint range: `50ff10e..HEAD`. Real local-provider wiring against the
homelab, TUI overlays for providers, cost, and receipts, the
dispatch-board streaming overlay, and a stub-removal sweep.

### Added

- Real local-provider dispatch against `llamacpp`, `lmstudio`,
  `ollama`, and `openai-compat` endpoints with per-endpoint model
  discovery and registration into the pi-ai runtime catalog.
- `EndpointSpec` threaded through the worker subprocess boundary so
  workers inherit the active local endpoint from dispatch.
- First-install `settings.yaml` seeded with commented `llamacpp@mini`
  and `lmstudio@dynamo` endpoint examples plus matching
  `orchestrator` and `workers.default` override blocks.
- `pi-ai` `stream` re-exported through `src/engine/ai.ts` so every
  consumer crosses the engine boundary through one module.
- `/providers` interactive overlay with live endpoint health, covered
  by `diag-interactive-tui`.
- `/cost` interactive overlay showing session token totals and USD
  cost from completed runs.
- `/receipts` interactive overlay and `/receipt verify <runId>` slash
  command backed by a verify-receipt reader.
- Dispatch-board overlay streams worker events live via `Ctrl+B`,
  covered by `diag-interactive-tui`.
- `diag:inference:live` real-inference diag against `llamacpp@mini`
  and `lmstudio@dynamo`, with a matching npm alias.
- `diag:vision:live` end-to-end vision-inference diag against
  Qwen3-VL on `mini`.
- Opt-in real-provider mode for the stress harness against the same
  two endpoints.

### Changed

- Providers domain diag split into separate config-only and
  live-probe variants; config errors preserved through the live path.
- Local-model registry extracted into its own module under
  `src/engine/local-model-registry.ts`; Qwen preset detection
  tightened so thinking-format pass-through only fires for
  Qwen-family models.
- Local-endpoint bootstrap now clears stale discovery entries before
  registering new ones.
- Dispatch rejects `sdk` and `cli` runtimes in v0.1; only the native
  tier is admitted.
- Intelligence domain fails fast when its detector is missing;
  scheduling now reports the local cluster node.
- Dispatch-board terminal state derives from `agent_end`, caps rows
  at fifty, and includes cache tokens in live totals.
- Providers overlay stays aligned on narrow terminals, stops updates
  after close, and yields Ctrl+C to active overlays.
- Interactive focus restored for slash-run streams so their output
  keeps rendering under an open overlay.
- Vision diag sends the prompt before the image payload, caps its
  request timeout, and surfaces provider errors verbatim.

### Removed

- `web_search`, `dispatch_agent`, `batch_dispatch`, and
  `chain_dispatch` tool stubs. Real backends land in v0.2.
- Unused worker provider-bridge placeholder and engine tool-identity
  helper.

## Unreleased

Post-`phase-10-partial` commits on `main` (in landing order):

### Added

- `feat(dispatch): enrich bus payloads with provider + model + duration`
  (a4df8b2). `dispatch.completed` now carries `durationMs` and
  receipt-derived `providerId` + `modelId` so observability groups
  correctly.
- `feat(dispatch): accumulate worker usage tokens into receipt + observability`
  (ec14bae). A tee on the worker event stream reads `AssistantMessage`
  usage per `message_end` and folds tokens into the receipt and cost
  tracker.
- `feat(interactive): wire /run + /help slash commands through dispatch`
  (a6bef10). The TUI scaffold now dispatches a worker via `/run <agent>
  <task>` and streams its events inline. `parseSlashCommand` is pure, so
  the diag unit-tests every branch without a terminal harness.
- `docs(guides): overview + walkthrough + scripts reference` (7e766b3).
  User-facing guides under `docs/guides/`.

### Fixed

- `fix(engine+dispatch): tighten boundary + PID-owned ledger lock`
  (3a92f6b). `engine/pi-mono-names.ts` is the single source for pi-mono
  package strings. `withLedgerLock` writes `process.pid` into the
  lockfile, probes owner liveness with `process.kill(pid, 0)`, and only
  unlinks peer locks when the owner is dead or the file is older than
  30s. 5-worker concurrent regression test lives in
  `diag-dispatch-state`.

## 0.1.0-dev (phase-10-partial): 2026-04-17

### Phase 10: Observability, Scheduling, Intelligence scaffolding (`phase-10-partial`, cbf70fc)

- Added: `observability` domain tracks telemetry counters and histograms,
  aggregates metrics into p50/p95/avg views, and accumulates per-session
  USD cost via catalog pricing. Subscribes to
  `dispatch.completed/failed` and `safety.classified`.
- Added: `scheduling` domain enforces a monotonic budget ceiling with
  three-state verdict, ships a token-bucket concurrency gate, and emits
  `budget.alert` when `dispatch.enqueued` would cross the ceiling. v0.1
  alerts are informational; admission still allows.
- Added: `intelligence` contract + intent-detector stub + extension
  gated on `settings.intelligence?.enabled`. Disabled by default; zero
  bus subscriptions when off.
- Added: config schema carries an optional `intelligence` section so
  future enablement is a one-line `settings.yaml` edit.
- Changed: orchestrator registers the three new domains after session
  and before lifecycle.
- Added: `diag-observability` (10 checks) and `diag-scheduling` (15
  checks) wired into `ci`.

Source commit: `cbf70fc feat(domains): scaffold observability + scheduling + intelligence`.

### Phase 9: Interactive TUI scaffold (`phase-9-partial`, e47b4f7)

- Added: minimal interactive TUI scaffold with banner, editor, and
  footer panel mounted under pi-tui.
- Added: Shift+Tab cycles default ⇄ advise via a pure
  `routeInteractiveKey` helper with footer refresh.
- Added: Ctrl+D triggers `termination.shutdown(0)` through the existing
  four-phase coordinator.
- Added: `clio` with no subcommand launches interactive when stdin is a
  TTY; piped stdin falls back to the non-interactive boot so `verify.ts`
  and CI do not hang.
- Added: `diag-interactive-tui` unit-tests the router against mock
  contracts (12 checks).

Source commit: `e47b4f7 feat(interactive): add minimal TUI scaffold with banner + footer + mode cycle`.

### Phase 8: Claude SDK subprocess adapter (`phase-8-complete`, bb0028c)

- Added: `claude-sdk` adapter with runtime-assembled specifier,
  `sdk_missing` graceful-fallback message, and `ANTHROPIC_API_KEY`-gated
  `canSatisfy`.

Source commit: `bb0028c feat(providers): add Claude SDK subprocess adapter with graceful fallback`.

### Phase 7: CLI adapter fleet (`phase-7-complete`, c6100f2)

- Added: six CLI adapter stubs plus generic `cli-entry` wrapper.
- Added: capability manifest silver/bronze tiers, `RUNTIME_ADAPTERS`
  extended.

Source commit: `c6100f2 feat(providers): ship six CLI adapter stubs + generic cli-entry wrapper`.

### Phase 6: Dispatch and native worker (`phase-6-complete`, 6356b27)

- Added: `clio run` headless dispatch surface that spawns a native
  worker subprocess with NDJSON stream, heartbeat, receipt, and exit
  code.
- Added: dispatch admission via `safety.isSubset`, validation, backoff,
  batch, and resilience paths.
- Added: run ledger with atomic persist and per-run receipts.
- Added: stress suite, shutdown wiring, and multi-process ledger safety.
  Ten concurrent workers all produce valid receipts and merge into the
  shared ledger.
- Added: worker-runtime wired through `pi-agent-core` faux and real
  paths.
- Fixed: four Phase 6 audit findings (exit-code mis-reporting, child
  error listener, bedrock id, ledger clone).
- Fixed: utf8-safe truncation in tools and em-dash prose cleanup.

Source commits (oldest → newest): `40a39b6`, `ff93f98`, `647faa3`,
`d4621f3`, `c07fc54`, `424f5e4`, `322c12e`, `07f46f8`, `6356b27`.

### Phase 5: Core tool registry (`phase-5-complete`, 44c637c)

- Added: `read` + `write` + `edit` + `bash` core tools.
- Added: `grep` + `glob` + `ls` search tools.
- Added: `web-fetch` and `web-search` tools.
- Added: `write-plan` and `write-review` path-constrained writers.
- Added: `dispatch-agent` + `batch-dispatch` + `chain-dispatch` stubs.
- Added: every tool registered with mode gating, action class, and
  `allowedModes` metadata plus consolidated diag.

Source commits: `e905731`, `dd3ed3d`, `fa2703f`, `05efdf6`, `6ce8d79`,
`44c637c`.

### Phase 4: Providers and agents (`phase-4-complete`, 0e70be3)

- Added: provider catalog, matcher, discovery, and health pure logic.
- Added: eight-provider runtime adapter stubs.
- Added: credentials store with mode `0600` and no-leak audit.
- Added: agent recipe, frontmatter, and fleet-parser primitives.
- Added: seven builtin agent recipe markdown files.
- Added: providers domain wired with probe-all and health bus.
- Added: agents domain wired with builtin + user + project discovery.
- Added: `clio providers` and `clio agents list` CLI commands.
- Fixed: credentials umask race (CWE-377) closed by opening with `0o600`.
- Fixed: `diag-providers` asserts `data-dir-matches-home`.
- Fixed: tarball `files` globs so agent builtins, prompt fragments, and
  damage-control rules ship in the package.

Source commits: `ba71856`, `958d784`, `9798e5d`, `31b8fb0`, `8040900`,
`3686ae5`, `0309111`, `19ddb7a`, `ebd5055`, `59f2966`, `0e70be3`.

### Phase 3: Prompts and session (`phase-3-complete`, dfebddc)

- Added: prompt fragment set (nine files) and full frontmatter
  validator.
- Added: Clio session JSONL writer/reader through the engine boundary.
- Added: prompt compiler with two-hash reproducibility and `diag-prompt`.
- Added: session domain wired with lazy create and atomic checkpoint.
- Added: verify exercises prompt compile determinism and session
  round-trip.
- Added: prompts domain wired with safe reload and hot-reload hook.

Source commits: `d08278c`, `1ab6848`, `91cc038`, `4892bc4`, `c6f0adb`,
`dfebddc`.

### Phase 2: Safety and modes (`phase-2-complete`, d0e31c1)

- Added: safety action classifier, scope rules, and NDJSON audit
  writer.
- Added: mode matrix and in-memory state helper.
- Added: damage-control rules, loop detector, and rejection feedback.
- Added: safety domain wired into orchestrator with hermetic diag.
- Added: modes domain wired with persistence and super-mode
  confirmation.
- Added: mode-gated tool registry with end-to-end admission.

Source commits: `a81aa2c`, `a1e00bb`, `01ce3ae`, `28103a5`, `a43fde6`,
`d0e31c1`.

### Phase 1: Foundation and hardening (`phase-1-hardened`, 2f82d8c)

Pre-orchestrator scaffolding that established the runtime shape: config
domain (TypeBox schema, manifest, watcher with hot-reload classifier,
extension), lifecycle domain (install metadata, doctor diagnostics,
manifest, extension), engine boundary wrappers around pi-mono 0.67.4
and pi-agent-core, CLI dispatcher with `version` + `install` + `doctor`
subcommands, orchestrator composition root, `~/.clio` idempotent
bootstrap, event bus with synchronous delivery, bus tracer, XDG path
handling, and the Phase 1 inline verify script.

Hardening pass before `phase-1-hardened`:

- Added: `diag-config` hot-reload matrix smoke, `diag-interactive`
  SIGINT shutdown smoke, `diag-xdg` XDG + install error matrix smoke.
- Added: doctor diagnoses missing credentials and invalid
  `settings.yaml`; credentials row unified.
- Added: pre-commit hook and installer, macos-14 CI matrix,
  boundary check hardened against type-only re-export and reference
  directive leaks.
- Added: CONTRIBUTING.md and run-from-source documentation.
- Fixed: bus delivery synchronous so shutdown phases are observable.
- Fixed: interactive loop stays alive so shutdown owns the exit.
- Fixed: `diag-xdg` strips all `XDG_*` vars and tightens breakage
  assertions.

Source: `git log 86c80a7..2f82d8c --oneline`.
