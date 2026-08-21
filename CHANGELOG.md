# Changelog

All notable changes to Clio Coder are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow Semantic Versioning; pre-1.0 minor releases may include incompatible changes.

## Unreleased (0.3.4)

### Added
- Non-destructive working-set eviction. When context pressure crosses `compaction.threshold`, Clio now records which tool-result bodies and closed-turn thinking blocks leave the model's working set instead of rewriting them out of the session. The bodies stay in the ledger, the transcript keeps showing them, and each one is replaced in model replay by a one-line marker naming the ref, the reason, the size, and the exact call that brings it back.
- Exact recall by ref. The model reads an evicted body back with `context(scope="recall", ref="<turnId>")`; the operator reads one into the transcript with `/context recall <ref>`, which never enters model context. A recall does not un-evict: the marker stays byte-identical so the provider prefix cache is untouched, and repeated recalls of one ref are the churn signal.
- Two eviction policies. `structural-v1` is the default: it selects by what the session did since (`stale_after_mutation`, `superseded_read`, `failure_resolved`, `listing_consumed`, `thinking_turn_closed`) and falls back to age only under pressure. `age-horizon` reproduces the previous age-based selection, minus results whose body is below `context.workingSet.minEvictableTokens`. Replayed over 165 Claude Code transcripts at a 128k budget, `structural-v1` retained 0.831 of later-referenced results against 0.781 for `age-horizon` and 0.779 for random eviction; the tables are under `benchmarks/results/context-replay/`.
- `/context` reports the working set: policy, evicted items, evicted tokens, events, recalls, and churn. Evicted tool rows carry a dim `evicted · <reason>` tag in the transcript.
- Cache-honesty attribution for eviction. An applied event stamps `working_set_evict` on the next assistant entry's `promptCache.expectedColdReasons`, and `/context` reports `last cold turn: working-set eviction (expected)` instead of warning about a cold backend it caused itself.
- New guide: `docs/context-working-set.md`.

### Changed
- Session format version 4. The bump is additive: it adds the `contextEviction` and `contextRecall` records and changes no existing entry, so a version 3 session migrates to 4 in place on open with nothing rewritten. Only a session written by a newer build is refused. The bump is one-way for the operator, and a 0.3.3 binary cannot open a session this release wrote.
- New settings under `context.workingSet`: `enabled` (default `true`), `policy` (default `age-horizon`), `target` (default `0.6`), `protectLastTurns` (default `6`), and `minEvictableTokens` (default `200`). `compaction.excludeLastTurns` now governs only the legacy mask path.
- Compaction reports a `working_set` stage on `ContextPruned`, and the middleware `on_compaction` hook gains the `working_set_evict` and `working_set_recall` stages.

### Fixed
- Auto-compaction no longer destroys observations. The stale-observation mask rewrote persisted bodies through `session.replaceEntries`, so masked content was gone from `/resume`, `/tree`, `/fork`, and the HTML export as well as from the model. `CLIO_CODER_LEGACY_MASK=1` restores that stage for one release as a compatibility escape hatch; it is removed in the next release.

## 0.3.3 - 2026-08-21

### Changed
- Unified transcript detail under `/output minimal|default|verbose`, with consistent per-block and all-block tool/thinking overrides that reset when the output level is reapplied.
- Folded Bash execution bodies by default while retaining concise command, outcome, timing, size, and bounded failure evidence on the transcript row (#166, #177).
- Rendered reasoning as stream-ordered thinking segments and made interview prompts true fullscreen workspaces (#171).

### Fixed
- Preserved live, interrupted, and replayed reasoning order and token provenance, including provider-reported zero-output turns.
- Preserved complete replay bodies for HTML export and aggregated multi-call replay receipts.
- Kept failure excerpts and mutation diffs inside narrow terminal frames, including at 40 columns.
- Replaced internal tool-call labels such as `bash(...)` with operator-facing action descriptions in live, replayed, blocked, and exported transcript rows.
- Refreshed the footer immediately after `/output` changes and kept explicit fold choices scoped to the intended tool or thinking stretch.
- Rechecked commit-attribution repository state and repaired missing or damaged cached hook wrappers before reuse.

## 0.3.2 - 2026-08-20

### Added
- Evidence-aware Git commit attribution, with an Advanced setting to disable it without changing commit messages.
- Fullscreen terminal mode, terminal-native Mermaid and LaTex rendering, smooth-streaming controls, instant-shell startup, prompt-history navigation, and improved model, settings, resume, task, decision, and workspace-output views.
- HTML transcript export (with Markdown export retained), live tool-progress and numbered edit/write diffs, and richer tool lifecycle details.
- Directory-scoped `CLIO-CODER.override.md` instructions, project-rule propagation to workers, an installed-skills marketplace, and source/codewiki assets in published packages.
- Compile-cache support for interactive, run, ACP, and worker boot paths; codewiki indexing and several tool implementations now load on demand.
- A Pi SDK boundary/upgrade checklist and declaration-surface checks; Pi SDK libraries are updated to 0.84.0.

### Changed
- Consolidated slash-command spelling and prompt-template argument handling; retired aliases now fail closed while preserving the editor draft.
- Replaced the LM Studio SDK path with an HTTP adapter. `lmstudio` is canonical; `lmstudio-native` remains a compatibility alias for persisted settings.
- Improved local-model selection, residency, context sizing, reasoning controls, retries, OpenAI-compatible streaming, and token accounting.
- Strengthened ACP v1 session, workspace, permission, output-bound, and error contracts for external clients.
- Improved terminal rendering, transcript streaming, timing, export, and session replay behavior.
- `docs/html` is no longer included in npm packages; Markdown guides remain available.

### Fixed
- Preserved prompt submission order during instant-shell startup and restored transcript rendering in fullscreen mode.
- Kept rejected slash-command drafts editable and aligned footer, receipt, and ledger usage for completed or cancelled turns.
- Prevented session switches during streaming from creating phantom entries; fixed task-board branch selection and persisted `/tree` pins.
- Prevented concurrent dispatch processes from overwriting run-ledger rows (#118), and hardened worker compile-cache isolation (#148).
- Fixed LM Studio duplicate-load behavior (#113), llama.cpp residency failures (#127, #134), runtime alias handling (#119), and probed context-window precedence (#129).
- Restored documented headless JSON/event output and CLI exit-code behavior (#122, #123); corrected thinking-level resolution (#128), stalled-stream reporting (#131), and reasoning-token estimates (#132).
- Isolated tests from user configuration (#110, #111), and corrected documentation claims (#117).

### Security
- Hardened worker and session safety-policy consistency, OAuth cancellation, workspace output reads, and ACP permission/cancellation handling.
- Added publish-time version-coherence checks (#124) and removed unsafe or misleading default behaviors in credentials migration and package serving.

## 0.3.1 - 2026-08-16

### Added
- Live worker transcript blocks, receipts, sharing, folding, and durable replay for `/run` and `/delegate`.
- Interoperability discovery and opt-in configuration for compatible coding agents, with protected foreign-agent directories and prompt roots.
- An agent-ledger surface for coordinated worker findings and a transactional Settings Center for routing, runtime, and experience settings.
- Stream-stall retries, authoritative timing/timezone handling, packaged source/code maps, improved trace viewing, and clearer upgrade notices.

### Changed
- Reworked the TUI around adaptive launch, composer, transcript, footer, permission, and narrow-terminal layouts.
- Improved fleet admission, result contracts, benchmark adapters, local-model residency, artifacts, and release packaging.
- Renamed remaining user-facing runtime identifiers to `clio-coder`; legacy settings and environment spellings remain readable where noted.

### Fixed
- Restored TUI prompt-template invocation and implemented documented ACP `--cwd` and `--permission-timeout` options.
- Preserved synthesis-locked worker answers, prevented unsafe llama.cpp model overrides, and corrected tool durations (#82).
- Fixed handbook grounding, reachability diagnostics, JSON result parsing, pasted slash commands, and resumed/forked prompt display.
- Fixed cancelled-turn replay/accounting, credentials corruption safeguards, doctor diagnostics, configuration layout, and missing-artifact errors.

### Security
- Remembered identical per-run escalation decisions without widening different requests.
- Added outward-exposure confirmation, safer artifact defaults, protected foreign-agent paths, and stricter credential, URL-opening, and permission behavior.

## 0.3.0 - 2026-08-14

### Added
- The first npm-published `clio-coder` command and namespace: binary, XDG roots, project directory, handbook, environment variables, and extension manifests use `clio-coder` naming.
- Agent ledgers, intentional compete stances, durable dispatch capacity leases, deterministic execution plans, typed worker contracts, and transactional worker attempts.
- Soak and invariant evaluation suites, receipt-derived accounting, per-step write-boundary checks, bounded check/repair loops, deterministic fleet code steps, and headless session continuation.
- Improved context bootstrap/refresh and generated-wiki workflows, hardened skill discovery/install/evaluation, and updated Pi engine dependencies to 0.83.0.

### Changed
- `clio-coder --help` now emphasizes the human-facing command surface; `--help --all` retains the full scripting and harness surface.
- Reorganized TUI internals without changing its public command surface, and made context budgeting favor target-reported limits.
- Unknown slash commands now fail closed; use a leading backslash for command-shaped prose.

### Fixed
- Preserved active session branches across compaction and replay, made startup option parsing strict, and bounded ACP deadlines.
- Stopped automatic retries after potentially state-changing tool calls.
- Fixed JSON transcript duplication, evaluation threshold enforcement, cancellation recovery, usage totals, uninstall/reset reporting, and narrow-terminal configuration output.
- Corrected provider URL launching, damage-control matching, credentials handling, doctor reporting, and trace help behavior.

### Security
- Replaced shell interpolation when opening provider URLs on macOS/Linux with argument-safe process spawning.
- Made dispatch plans immutable and receipt-backed, enforced worker attestation and write-boundary recovery, and fail-closed on malformed durable contracts, unknown skills, and unsafe retries.

## 0.2.9 - 2026-08-05

### Added
- Deterministic fleet code steps, bounded check/repair loops, shipped SDLC fleets, and a durable trace store with read-only trace commands and viewer.
- Per-step write-boundary verification, typed worker result contracts, strict worker attestation, and process-safe capacity/routing leases.
- One compiled worker harness with explicit tool/budget profiles, model-facing dispatch/collect provenance, and transactional editing attempts.

### Changed
- Added first-class singular dispatch while retaining batch dispatch, and unified synchronous and detached run monitoring.
- Updated Pi engine dependencies to 0.80.6 and advanced receipt, route, plan, and policy formats to their strict current versions.
- Broadened model-authored repository exploration while retaining bounded Scout guidance and Fleet Runs visibility.

### Fixed
- Made successful native and ACP delegation require receipt-sealed final output, and made protected-artifact recovery durable across restart and worktrees.
- Improved compaction, context provenance, routing, external-agent cancellation, and generated-wiki grounding.

### Security
- Enforced immutable approved dispatch plans, strict external-agent policy checks, bounded worker protocol frames, and fail-closed handling of older or partial durable formats.

## 0.2.8 - 2026-07-07

### Added
- A consolidated seven-plane tool surface, task tracking, richer dispatch monitoring/steering, codewiki v4, exports, and improved interactive command hubs.
- Multi-model local residency management and native shadow-agent fleet routing.

### Changed
- Improved local-model prompting, TUI pressure handling, accounting, worker IPC, deadlines, model catalog metadata, and documentation.

### Fixed
- Corrected approval, symlink, loop-guard, worker-profile, reasoning, session-branch, and timeout edge cases.

### Removed
- Legacy tools including `glob`, `workspace_context`, `docs_search`, `run_task`, `validate_frontend`, `write_plan`, `write_review`, `create_skill`, and `dispatch_batch`; use the consolidated tool surface.

## 0.2.7 - 2026-07-02

### Added
- Reviewed marketplace skills, executable skill evaluations, enforced skill tool surfaces, and registry integrity pins.
- Credential damage control, usage reports, headless receipts, dispatch evidence bundles, and high-rigor validation support.

### Changed
- Reduced package size and refreshed release and documentation workflows.

### Fixed
- Improved dispatch, lifecycle, skill, and loop-guard reliability.

### Security
- Added zero-access credential storage and secret redaction in evidence bundles.

## 0.2.6 - 2026-06-24

### Added
- VRAM-aware local-model residency, layered settings, path-scoped rules, operator profiles, hooks, configuration inspection, docs search/viewing, and SciCode benchmark support.

### Fixed
- Prevented dispatched Ollama work from leaving models resident and overflowing VRAM.

## 0.2.5 - 2026-06-23

### Added
- The `alcf` runtime for Argonne ALCF Sophia/Metis targets, including Globus OAuth, discovery, metadata, and gateway documentation.

### Fixed
- Enforced strict OpenAI-compatible reasoning payloads for ALCF targets.

## 0.2.4 - 2026-06-23

### Added
- Fleet management with agent/profile bindings, fault-tolerant dispatch, and a `/fleet` overlay.

### Changed
- Refreshed Pi, Claude, Anthropic, Biome, TypeBox, Undici, UUID, and TSX dependencies.

### Fixed
- Isolated dispatch tests and made receipt digests deterministic across hosts.

## 0.2.3 - 2026-06-17

### Added
- Declarative slash commands and full-screen hubs; enforced autonomy and safety notices; additional subscription/delegation runtimes; codewiki indexing, middleware, live steering, and richer receipts.

### Changed
- Reworked on-disk roots, settings ownership, lifecycle commands, model-target vocabulary, and observability.

### Removed
- Retired legacy slash commands; their workflows moved to `/skill`, `/targets`, `/help`, `/view`, and related hubs.

## 0.2.2 - 2026-06-11

### Added
- Context engine, compaction, bounded tool results, prompt-cache telemetry, ACP support, a curated skills marketplace, and local install/uninstall scripts.
- A richer `CLIO.md` project rulebook and source-tree awareness.

### Changed
- Replaced built-in CLI-subprocess runtimes with direct HTTP/native/Pi targets and ACP delegation.

### Fixed
- Improved prompt-prefix stability, ledger appends, permission overlays, and release verification.

## 0.2.1 - 2026-06-05

### Added
- Live token-throughput telemetry, prompt-envelope hashes, and `clio run --json` prompt diagnostics.

### Changed
- Reduced context pressure through narrower tool exposure and bounded output; improved the footer for smaller terminals.

### Fixed
- Corrected headless run arguments, unknown-agent handling, dashboard layout, and prompt-diagnostic visibility.

## 0.2.0 - 2026-06-03

### Added
- First community alpha for source-checkout users, with JIT skills, stronger compaction, project-instruction adoption, runtime resolution, diagnostics, durable sessions, and expanded documentation.

### Fixed
- Hardened path policy, headless runs, prompt-cache boundaries, overlays, session replay, and TUI startup.

## 0.1.9 - 2026-05-17

### Added
- First-class fleet `dispatch`, frontend artifact validation, typed finish evidence, and local-model capability improvements.

### Fixed
- Corrected reasoning replay, Harmony parsing, Codex file-tool aliases, lifecycle metadata repair, and model-capability duplication.

## 0.1.8 - 2026-05-11

### Added
- Extensions, share archives, associated CLI/TUI workflows, a redesigned welcome dashboard, configure validation, and a Claude Code SDK safety bridge.

### Fixed
- Corrected Gemini CLI token accounting and expanded extension, sharing, configuration, and supervised-SDK coverage.

## 0.1.7 - 2026-05-11

### Added
- A shared safety-policy engine, strict project command policies, typed execution tools, and receipt safety summaries.

### Changed
- Default Bash now denies ordinary execution unless allowed by curated commands or project policy.

### Fixed
- Hardened dispatch scope, external-runtime permissions, audit rows, and worker safety parity.

## 0.1.6 - 2026-05-04

### Added
- `clio --print` / `clio -p` for one non-interactive turn, with stdin/argv composition and stdout safeguards.

### Changed
- Reserved future JSON/RPC modes behind explicit errors.

## 0.1.5 - 2026-05-03

### Added
- Public alpha for source-install developers and research-software teams: interactive TUI, target-first configuration, coding agents, sessions, project context, receipts, audits, evidence, evaluations, memory, and safety modes.
- `clio init`, CLIO.md parsing, codewiki indexing, improved cost/model UI, and documented alpha operating limits.

## 0.1.4 - 2026-04-30

### Added
- Evolution tooling for inventories, change manifests, evidence, evaluations, memory, middleware, protected artifacts, finish checks, workspace orientation, specialist recipes, and scientific validation.

### Changed
- Unified llama.cpp handling and improved TUI, compaction, context accounting, and protected-artifact behavior.

## 0.1.3 - 2026-04-27

### Added
- Live tool output, Bash echo, thinking expansion, and a Git-branch footer slot.

### Changed
- Made `CLIO.md` the canonical project instruction file and improved LM Studio/Ollama detection.

### Fixed
- Corrected Debian/Ubuntu slash autocomplete, doctor/targets JSON envelopes, and partial tool-output rendering.

## 0.1.2 - 2026-04-25

### Added
- Visible retries for transient provider and stream failures.

### Changed
- Improved interactive tool, Bash, dashboard, hotkey, resume, prompt, receipt, compaction, audit, and abort behavior.

### Fixed
- Corrected retry duplication, cancellation races, oversized Bash output, active-run session operations, provider hot-swaps, and local OpenAI-compatible reasoning/tool schemas.

## 0.1.1 - 2026-04-24

### Added
- Deterministic loading of project context files from the working directory upward.

### Fixed
- Corrected rich session replay, subprocess dispatch, out-of-tree SDK rehydration, receipt verification, dispatch heartbeats, and boundary-check documentation.

## 0.1.0-exp - 2026-04-24

### Added
- Initial experimental public release with interactive TUI, lifecycle CLI, target-first configuration, runtime support, built-in agents, dispatch workers, receipts, audit logs, safety modes, and XDG-aware state.

### Security
- Windows support was best effort; remote fan-out and MCP surfaces were scaffolded but not admitted by dispatch.
