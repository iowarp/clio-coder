# Changelog

All notable changes to Clio Coder are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow Semantic Versioning; pre-1.0 minor releases may include incompatible changes.

## 0.3.6 - 2026-08-23

0.3.5 was published by mistake and withdrawn; its content ships here.

### Added
- `docs/middleware-and-components.md` documents every built-in middleware registration: id, hooks, trigger, and what does not trigger it.
- Permission and `ask_user` dialogs now derive closed consequence tiers from typed request, scope, reversibility, origin, exposure, and authority facts (#169). Conversational answers, workspace authority, outward consequences, safety-net confirmations, system changes, and worker escalations receive distinct titles and semantic tokens, while caller prose cannot lower a tier or alter the underlying decision protocol.
- Typed invocation-level dispatch budget envelopes (#175). Recipes keep an exact default unless they author a maximum, dispatch can request a phase and preauthorize a retry, result-contract revision, or review revision ceiling inside both recipe and operator policy, and immutable policy, request, effective, clamp, and escalation facts are sealed into receipts and shown by monitor, fleet status, and the live fleet card. Architect retains its 32-call default and now permits explicitly admitted runs up to its authored maximum.
- The `Alt+W` Fleet Runs board shows live worker progress on operator request (#168). `Enter` opens the selected run's detail: the phase, the running call as `<tool> <verb> <object>`, and the bounded tail of the worker's own prose with a `/view dispatch:<runId>` link to the rest. The default list stays compact, so a fan-out of scouts costs one card each until an operator opens one.

### Changed
- The Fleet Runs board and the transcript's worker block now read one bounded projection of the dispatch event stream instead of folding it separately, so the two surfaces cannot disagree about what a worker is saying or touching. The projection keeps 40 lines and 4096 bytes of answer tail, 8 distinct tool names, and 4 recent actions, and accepts 16 KB of streamed bytes per 250 ms; what the bounds refuse is counted and named rather than dropped silently.
- Worker tool activity now carries a redacted action descriptor beside the tool name. The descriptor is composed where the arguments are trusted (the tool registry's admission path, the Claude tool mapper, and the ACP update mapper) from a fixed verb vocabulary and a fixed argument-field allowlist, with credentials scrubbed, escape sequences stripped, and the result bounded to 64 characters. Raw argument objects still never cross the worker stdout seam, and reasoning content is still never displayed.

### Fixed
- Approval overlays now derive call targets from a per-tool field allowlist. Unlisted arguments are shown only by field name, type, and size, so an unexpected credential or pasted document cannot be copied into the rendered frame (#200).
- Worker tool starts and finishes now share a call id when their producer has one. The transcript and Fleet Runs pair concurrent calls by that id, while older streams without ids continue to match by tool name (#201).
- Proactive task memory now reuses deterministic tool-result disposition digests with explicit source provenance (#173). Operation fingerprints remain separate for loop and repeated-failure identity, while redaction and byte caps apply before diagnostics reach the task bank or background policy.
- The llama.cpp router's `sleeping` state now reads as not resident (#192), and `clio-coder targets` reports `resident: none` while preserving the reported context-slot metadata.
- Response model-id presence is now an explicit `responseModelIdObservation` state (#193, #202). The short-lived `servedModel` and `servedCalls` names are replaced by requested and attributed model ids plus counts named for each observation state. Pre-#193 ledgers remain readable under the labeled `legacy-difference-only` state, and providers outside the stream tap retain the `responseModel` fallback without implying that presence was observed.
- The selected live model's capability probe now starts at boot (#195), so the first `/context` view and footer show the probed context window before any model turn.
- The permission dialog now anchors above the composer (#194) and recomputes that placement when the terminal resizes.
- Tool-result offload scratch files older than fourteen days are now swept at boot (#196). A resumed transcript now says when the retention sweep removed the file instead of presenting its stale path as a live full-output pointer (#203).
- A skill suggestion no longer costs the first turn on local models (#184). Every surface that teaches the protocol (the first-turn reminder, the `context(scope="skills")` listing footer, and the operator-gate denial) now says to open with the `Suggested skill:` line and continue the task in the same turn; none instructs the model to wait. A turn that makes the suggestion and stops with only listing calls behind it is continued once with a reminder that only the operator loads a skill.
- Three envelope noise sources on local targets are gone (#191). An always-on reasoning model printed the thinking clamp three ways (`thinking medium resolved to forced`, `medium was ignored because thinking is always on`, and the combined line); only the combined line prints now, once per target, model, and level change. A workspace with no `CLIO-CODER.md` states `<handbook>none …</handbook>` where the handbook would have been injected, so the model stops spending its first tool call on a read that returns ENOENT. `clio-coder --resume` and `--continue` still fail closed, and the error now says that sessions are resumed from the `/resume` picker inside the app.
- A turn is attributed to the reported response model id under LM Link peer routing (#185, #202). The response's `model` field is recorded as `responseModel` when it differs from the request. The footer, `/cost`, `clio-coder usage report`, and dispatch receipts use the shared requested model id, attributed model id, and response model id observation vocabulary. The LM Link peer warning is emitted once per distinct fact instead of once per turn.
- The `/resume` picker previews the operator's first prompt (#188). The first user entry of a session is the composed prompt, with the `<system-reminder>` block and any `[Skill request]` preamble ahead of the operator's words, so every row read `<system-reminder> [Skills] 9 installed…` and the filter matched them all. The preview is now the persisted `operatorText`, the scaffolding-stripped text for older sessions, the next turn when the first carries no operator words, and the first assistant text when none does.
- The context ledger is populated right after `/resume` (#189). Before the first new turn of a process, `/context` and the footer meter now read the window from the live target resolution (falling back to the window the resumed session recorded) and the token facts from the session's last persisted snapshot, which measured the same messages; the selected model's live capability probe runs at resume so the window is the probed one. `context window unknown · 0 tokens` is reserved for a session with no target and no history.
- `/context` names the configured working-set policy instead of the last applied one (#190). A fresh session at the shipped default reads `policy structural-v1 · no events yet` rather than `policy none`; `context.workingSet.enabled: false` reads `disabled`; a policy changed after an event shows `(last event by <policy>)`. The eviction trigger stays at `compaction.threshold`: the replay tables price each event by the cold prefix it re-prefills, and batching from the threshold down to the target is what keeps the event count down.
- A llama.cpp context window is the per-request share, not the server total (#187). `--ctx-size` is split evenly across `--parallel` slots unless `--kv-unified`, so a router started with `--ctx-size 786432 --parallel 4 --no-kv-unified` now resolves to a 196,608-token window instead of 786,432, which is where autocompact was armed at a size the server would never admit. The probe reads the long and short flag spellings and the last kv flag given, `/context` prints `196,608 (786,432 / 4 slots)` with `probed window`, and `clio-coder targets` names the split in its `ctx` note and a probe note.
- A parked permission request always offers allow, deny, and stop (#186). The composer rail switches to `CONFIRM` and carries the dialog's keys while a prompt owns the keyboard, so the `Enter send` hint can no longer contradict a dialog that sits forty rows away on a tall terminal. `Enter` allows only from an empty composer: with a draft present the habitual send key is inert, both surfaces read `[Backspace] clear draft` in its place, and only deletion keys reach the editor. `Esc` is labeled `deny`, which is what it does. A request that parks while another overlay holds the screen is re-presented as soon as that overlay closes.

## 0.3.4 - 2026-08-22

### Added
- A typed project verifier catalog at `.clio-coder/verifiers.yaml` (#170). Each check declares a stable id, description, exact argv vector, repository-relative cwd, bounded timeout, and tags. `verify()` lists package scripts and catalog checks through one `DeclaredCheck` projection, and `verify(check=<id>)` runs the admitted argv through safe-exec with no shell, no model-text interpolation, and no widening of workspace authority. Shell strings, escaping cwds, duplicate ids, unknown fields, unsupported versions, and over-cap values fail closed with diagnostics that name the field and the cap.
- Guided verifier authoring through `clio-coder verifiers discover|author|validate|dry-run|add|edit|rename|remove` (#174). Discovery recognizes package scripts, Cargo manifests, CMake presets, declared Python runners, Go modules, and existing validation-contract commands with source provenance, and proposes argv vectors labeled project-declared or toolchain-defined. Every preview shows path, cwd, timeout, tags, and effective execution authority; nothing is written or executed before `--yes`, validation uses the production catalog parser, and dry runs use the production verify path. Projects with no declared command get an explicit manual-entry path instead of a guessed command.
- One canonical tool-result disposition contract with independent presentation and model-context axes (#165). A tool declares how the operator sees a result and, separately, whether the model receives full content, a bounded excerpt, a deterministic code-produced summary, or metadata only. Typed result metadata records captured, displayed, and context byte counts, the requested versus applied mode, truncation, the offload path, and summary provenance. Exit status, error state, safety facts, and retrieval instructions survive every context mode.
- Canonical Bash output dispositions with a tail-biased bounded default, deterministic redacted diagnostic summaries, metadata-only retrieval, budget-admitted full context, and explicit byte and termination facts (#172). `output_policy` is optional on the Bash tool; omitting it preserves the previous tail behavior.
- A six-axis canonical trust status for runs (#154): artifact integrity, validation grounding, independent review, context provenance, autonomy enforcement, and completion evidence, each with explicit `absent`, `unknown`, and `not_applicable` states and a named source and authority. Composition never promotes one axis from another; the no-promotion rules are enforced at the adapters and the evidence composition boundary. Evidence bundles gain `trust-status.json`.
- Non-destructive working-set eviction. When context pressure crosses `compaction.threshold`, Clio now records which tool-result bodies and closed-turn thinking blocks leave the model's working set instead of rewriting them out of the session. The bodies stay in the ledger, the transcript keeps showing them, and each one is replaced in model replay by a one-line marker naming the ref, the reason, the size, and the exact call that brings it back.
- Exact recall by ref. The model reads an evicted body back with `context(scope="recall", ref="<turnId>")`; the operator reads one into the transcript with `/context recall <ref>`, which never enters model context. A recall does not un-evict: the marker stays byte-identical so the provider prefix cache is untouched, and repeated recalls of one ref are the churn signal.
- Two eviction policies. `structural-v1` is the default: it selects by what the session did since (`stale_after_mutation`, `superseded_read`, `failure_resolved`, `listing_consumed`, `thinking_turn_closed`) and falls back to age only under pressure. `age-horizon` reproduces the previous age-based selection, minus results whose body is below `context.workingSet.minEvictableTokens`. Replayed over the seeded procedural corpora with the summary stage modeled, `structural-v1` cuts the number of lossy summary compactions per 300-turn science trace from 21.5 to 8.8 at a 64k budget and from 8.9 to 3.1 at 128k, retains at or above `age-horizon` at every budget, and beats random eviction on precision by 2.3x or more; the default-policy rule, the cold-prefix cost it pays for finer batching, and the full grid are under `benchmarks/results/context-replay/`.
- `/context` reports the working set: policy, evicted items, evicted tokens, events, recalls, and churn. Evicted tool rows carry a dim `evicted · <reason>` tag in the transcript.
- Cache-honesty attribution for eviction. An applied event stamps `working_set_evict` on the next assistant entry's `promptCache.expectedColdReasons`, and `/context` reports `last cold turn: working-set eviction (expected)` instead of warning about a cold backend it caused itself.
- `clio-coder context replay --sessions <path>...` replays Clio ledgers, and `--synthetic <ids>` replays seeded procedural science-coding corpora (`science-long`, `refactor`, `exploration`), through the live eviction code with `none`, `random`, and `oracle` controls and reports retention, precision, tokens evicted, recall tokens, cold prefix tokens, saturation, turns to first summary, and summaries per trace under a modeled summary stage; `clio-coder context working-set --session <id|path>` prints one session's working-set fold and path index. The procedural corpora replace the private Claude Code transcripts the first tables were built on, so the committed tables under `benchmarks/results/context-replay/` rebuild byte for byte on any checkout.
- New guide: `docs/context-working-set.md`.

### Changed
- Tool offload files are content-addressed: `<stateDir>/scratch/<sessionId>/<sha256 of the captured text>.txt` instead of the tool call id or a timestamp, so identical captures share one file and the `retrieve=` header, the eviction marker, and the resume transcript carry the same bytes every time.
- Editing an existing `.clio-coder/verifiers.yaml` through `clio-coder verifiers add|edit|rename|remove` now mutates the operator's file in place: comments and on-disk order survive, only changed fields move, and a revision that changes nothing writes the file back byte for byte.
- Evidence rows, the latest gate decision and finish contract, and the verifier catalog order by code point instead of locale collation, so two machines rebuild the same bundle in the same order.
- Receipt inspection, evidence bundles, monitor output, and worker evidence derive their trust facts from one canonical derivation (#157). The public `evidence_verification=<state>/<basis>` token is unchanged. An integrity-failed receipt now renders `receipt_integrity=FAILED reason=…` and labels its claims `worker claims (unverified prose)` in both dispatch and monitor output.
- Session format version 4. The bump is additive: it adds the `contextEviction` and `contextRecall` records and changes no existing entry, so a version 3 session migrates to 4 in place on open with nothing rewritten. Only a session written by a newer build is refused. The bump is one-way for the operator, and a 0.3.3 binary cannot open a session this release wrote.
- New settings under `context.workingSet`: `enabled` (default `true`), `policy` (default `structural-v1`), `target` (default `0.6`), `protectLastTurns` (default `6`), and `minEvictableTokens` (default `200`). `compaction.excludeLastTurns` now governs only the legacy mask path.
- Compaction reports a `working_set` stage on `ContextPruned`, and the middleware `on_compaction` hook gains the `working_set_evict` and `working_set_recall` stages.

### Removed
- The Claude Code transcript loader for `context replay` and its `--format` flag. Replay inputs are Clio ledgers and the seeded procedural corpora.
- `TRUST_STATUS_NO_PROMOTION_RULES`, `adaptEvidenceFindingsValidationStatus`, and `adaptEvidenceLinkContextStatus` from the evidence barrel. The no-promotion rules are enforced at the adapters and the composition boundary and are written out in `docs/evidence-and-memory.md`; the two adapters were reachable from no builder.

### Security
- A project-catalog `verify(check=<id>)` no longer sits in the no-prompt set. The policy engine resolves the check against `.clio-coder/verifiers.yaml`, scans the declared argv with the damage-control rules and the zero-access read guard, and tags it unrecognized, so `auto-edit` confirms it once with the argv shown and `full-auto` runs it. Package-script checks and `verify(check="frontend")` are unchanged. `.clio-coder/verifiers.yaml` and `.clio-coder/safety.yaml` are read-only to the model's `write`, `edit`, and bash redirect paths by default: before this, a model at the default `auto-edit` level could write the catalog and run any argv through `verify` without a prompt.

### Fixed
- A completed conversational offer such as "point me at it and I'll get moving" no longer triggers an automatic continuation or the "turn still has open work" footer warning (#178). The stalled-turn detector now requires an announced concrete action: it recognizes inflected verbs ("I'll be running the tests"), announced paths and commands ("Let me open src/cli/index.ts", "I'll npm run build"), and keeps conditional offers, "let me know" phrasing, questions, and wait statements ("I'll wait for your go-ahead before I touch index.ts") suppressed. The one-continuation cap for genuine stalls is unchanged.
- A completion-contract audit row can no longer ground validation. The row is the run's own self-report and feeds completion evidence only; validation grounding is filled by executions the session ledger observed. A run whose receipt fails integrity contributes no verified field, its completion self-report downgrades to `unknown`, and the `no-validation` warning is restored. A blank or whitespace-only identifier in one audit row no longer aborts the whole evidence build.
- Tool-result summaries are honest about omission. Head and tail slices are disjoint, a scratch offload is written only when the model projection actually omits content, whitespace-only output is complete rather than truncated, NUL bytes are removed from model context while presentation and the offload keep the captured bytes, the head-tail strategy honors `redact`, and a throwing disposition resolver fails closed to metadata-only with the cause recorded in the result metadata, the model header, and the transcript row.
- `clio-coder verifiers … --yes` no longer prints "no file has been written" immediately before writing the catalog; the confirmed preview is rendered after authorization.
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
