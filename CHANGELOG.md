# Changelog

Public release notes for Clio Coder are documented here. This file is kept
intentionally short for users, operators, and community contributors. The full
developer-facing history, including implementation detail and verification
notes, lives in [DEVLOG.md](DEVLOG.md).

Versions follow semantic versioning for a pre-1.0 project: minor versions may
still change interfaces.

## 0.3.0 - 2026-08-06

- Marked v0.3.0 prominently as experimental in the CLI/TUI startup experience and repository front page: behavior and interfaces may break or change without notice.
- Fixed active session branches staying active through production compaction, post-compaction replay, and editor `!command` sidecars. Switching to an older `/tree` branch no longer lets the most recently appended abandoned sibling silently replace provider context.
- Made global CLI startup parsing one strict, order-independent pass. Interleaved `--skill`, `--api-key`, and context flags no longer expose a secret as a mistaken subcommand, command recognition and dispatch now share one registry, and misspelled leading options fail closed instead of disappearing.
- Made ACP connect, turn, and permission deadlines mandatory schedulable bounds. Zero can no longer disable a request timer, oversized values can no longer overflow Node into an approximately 1 ms timeout, and CLI, settings, direct adapter, and transport paths share the same defaults and timer ceiling.
- Stopped automatic retries after a failed attempt has executed a potentially state-changing tool call, including a tool that returned an error after partial work. Clio does not yet isolate ordinary retry workspaces, so launching a successor in the same checkout could consume partial edits; read-only, model-startup, and transport failures remain retryable. Removed the disconnected workspace-transaction implementation and direct-only tests that falsely implied this boundary was wired.
- Removed unreachable pre-release scaffolds, obsolete barrels, empty tombstones, and the superseded auth selector, then enabled TypeScript unused-local and unused-parameter checks so dead implementation residue fails the build instead of accumulating.
- Added the soak, a benchmark whose subject is Clio rather than the model. Every other suite measures what a model produced and passes a run whose receipt never sealed, whose seal does not authenticate, or whose stream republished its own transcript. `benchmarks/soak/clio-soak.yaml` inverts that: a weak model that never repairs the fixture passes because the machinery behaved, and a strong model that repairs it fails the moment Clio breaks a promise about itself. Three sibling suites gate what their own surface can answer, for write boundaries, bounded loops, and SIGINT chaos. It runs offline against a local target, because a gate on Clio's own invariants that needs a cloud key is not a gate.
- Made invariant metrics fail closed by construction. `src/domains/eval/metrics/invariants.ts` reduces receipt, session, process, and write-boundary promises from the journal each eval item leaves behind, and every reader is total: a metric it could not compute is absent rather than false, because a threshold on an absent metric fails closed while a fabricated value is indistinguishable from a check that passed. Each metric has a test proving it fails on a corrupted artifact.
- Made eval token accounting observed rather than assumed. Usage is folded out of a runner's live stdout as it arrives, so truncating the operator-facing artifact cannot erase it. A runner that observed no usage reports `tokens.measured: false` and no counts at all, never a zero, and reports say how many runs a total covers. Eval artifacts moved to version 4 with a discriminated `summary.tokens`; the parser refuses counts beside `measured: false`, a `tokens.total` threshold on an unmeasured artifact fails closed, and a comparison against an unmeasured side reports an unmeasured delta.
- Added receipt-derived accounting for surfaces that publish no usage stream. `clio fleet run --json` drains its workers' events, so a bounded loop's cost never reached the stream fold. `receiptUsage.*` reads what the run sealed and authenticated, carries its own provenance, and never merges with or masquerades as stream-observed `tokens.*`. An incomplete or unauthenticated receipt set reports unmeasured and no counts.
- Added per-step write boundaries. Fleet contract v4 declares a `writes` path allowlist per step, `readonly` being the empty one, and the orchestrator verifies the claim after the fact by diffing the checkout against a pinned baseline, rolling back unauthorized changes, and sealing a verdict carrying its own digest and that baseline. This is detect-and-rollback, never sandboxing: nothing prevents a write, and confinement an agent cannot escape needs OS-level isolation this does not provide. A path that cannot be cleanly restored is reported and left for the operator rather than guessed at.
- Added bounded check/repair loops and the shipped SDLC chains. A `loop` declares `maxAttempts`, a check, and an agent repair, and compilation unrolls it into conditional nodes so the plan stays one deterministic hashed DAG with a receipt per attempt. The declared bound is the promise: attempts never exceed it, every attempt after the first is `recovery`, and a spent bound reports `loop_bound_exhausted` rather than a green it did not earn. Verification staleness is scheduler-enforced.
- Added deterministic `code` steps. A step names a command id from the repo-owned registry at `.clio/fleets/commands.yaml`, never a shell string a model authored, and an unknown id or missing registry fails contract validation before anything dispatches. A code step holds no capacity lease and carries no execution role or authority grant.
- Added headless session continuity. `clio run --session <id>` appends to an existing session and `--continue` to the most recent one for the working directory. Continuation is a hard requirement rather than a hint: a session that cannot be resumed exits 2 before any model call, because an answer written without the history the caller asked for is worse than no answer. The session id is discoverable from the surface that ran the turn, and stdout stays the assistant's answer alone.
- Made process-safe dispatch admission durable. Capacity leases are the expiring global and per-node authority, with acquisition, retry rebinding, heartbeat, drain, and reservation transfer serialized by one cross-process lock. The lease bound fails admission closed rather than dropping a lease, a plan slot belongs to an assignment so a retry never queues behind itself, and the operator's machine-wide drain is TTL-bounded so an abandoned drain cannot wedge the host.
- Made context budgeting distinguish a target-reported limit from Clio's planning assumption. A router can answer `/props` with `n_ctx: 0` while a model-specific probe or LM Studio detail row records the selected model's context, including its currently loaded window rather than its larger theoretical maximum; selection is exact-id and target status names the source. A target that declares no window now receives Clio's explicit 131,072-token assumption with a human-visible warning to probe it, and a reported window below 128,000 warns on every runtime tier instead of quietly shrinking a session to the obsolete 8K fallback.
- Fixed `clio run --agent --json` republishing its segment transcript. Every message in an `agent_end` had already crossed the wire as its own `message_end`; on a two-minute run that was 24 KB restating 19 KB, and the ratio grew with the answer. Both `--json` wire projections now live in one module and make the same promise: content crosses exactly once.
- Fixed a suite's declared `thresholds.fail` deciding nothing at run time. Only a later `eval gate` invocation read it, so a run that broke a declared threshold still exited zero. A gate now reaches per-run metrics, so the failure names the run rather than an aggregate, and an assertion whose metric was never measured fails closed in both layers.
- Updated the Pi engine dependencies to 0.83.0. `src/engine/` is now the one place pi types enter the codebase; no file outside it imports `@earendil-works/*`, type-only included.
- Made the default `clio --help` describe the command surface a person needs to read while preserving the complete surface for scripts and agents. Harness-oriented commands are grouped under `clio dev`, `clio --help --all` reveals both sets, and the former top-level command forms continue to resolve unchanged.
- Reorganized the interactive application into focused controller, presentation, input, event-projection, process-shell, transcript, ticker, editor, slash-command, and overlay lifecycle modules. The TUI's public behavior and command surface are unchanged; the decomposition gives lifecycle, input, overlay, and rendering contracts independent test seams instead of concentrating them in a 3,600-line entrypoint.
- Fixed direct shell interpolation while opening provider URLs on macOS and Linux. Interactive OAuth authorization, device-code, and console URLs once entered an `exec()` command after only double-quote escaping, so backticks or command substitutions in provider-supplied text could execute before the browser opened; `open` and `xdg-open` now receive the URL as a distinct `spawn()` argument. Windows still starts its browser through `cmd /c start`, so this change removes the original `exec()` construction there but does not claim a shell-free Windows launch.
- Made retries distinguish a self-hosted model that is loading from an ordinary rate limit. Unloaded or loading-model errors now qualify for retry with a 15-second minimum delay that still honors the configured maximum, so disk and VRAM loading does not spend the usual short backoff sequence before the target can serve a request.
- Corrected damage-control matching so it evaluates commands that will execute rather than prose a file will contain. Writing documentation that quotes `rm -rf /`, a migration that contains `DROP TABLE`, or a classifier fixture no longer trips a command-pattern block; the same destructive command remains subject to policy when passed to a command-bearing tool, and destination paths still receive path-based checks.
- Reworked project-context bootstrap around the dedicated `context-bootstrap` agent and a generated local handbook. `CLIO.md` is a gitignored runtime artifact rather than this repository's canonical instructions; the agent uses ordinary binding and default route resolution while honoring a legacy Scout binding, an existing handbook informs generation rather than silently cancelling it, and default initialization preserves it until an explicit `--apply` or `--rewrite` action. Bootstrap retains the previous handbook provenance when a run generates nothing and reads project identity from the manifests, build files, citation records, and README forms each ecosystem uses instead of assuming a Node package.
- Made `clio context refresh` update only the existing handbook sections the rebuilt codewiki owns, leaving model- and human-authored prose stable, and made context status name a partial generated wiki as incomplete rather than presenting it as coverage it has not earned. Context reset preserves the wiki by default and its help names that exception, so a destructive action is not hidden behind a generic reset.
- Rebuilt generated wikis around a depth-scaled, index-derived page plan and isolated page writers. A bounded planner may refine the deterministic candidate, but each `wiki-writer` dispatch is confined to staging, receives a bounded source set and no Git tool, checkpoints one page at a time, and promotes the coherent pages it wrote while recording the rest for `clio context wiki --update`. Deterministic assembly regenerates navigation from pages on disk, drops empty pages so they remain owed, and records unresolved links and citations for the next update rather than fabricating complete coverage.
- Hardened the skill substrate from discovery through evaluation. A `SKILL.md` must be bounded valid UTF-8 text and a discovered root must contain the content it advertises; scalar or sequence tool declarations resolve to Clio's actual tool surface and warn on unenforceable names. `clio skills eval` now measures the precedence-winning copy activation would load and reports its origin and hash, while install and update constrain GitHub paths to the cloned repository, validate a staged replacement before an atomic swap, preserve the installed copy on failure, and detect post-install drift against the recorded or catalog-pinned normalized hash.
- Fixed worker budgets so late-run guardrails preserve the artifact a worker was admitted to produce. The reserve and soft limit now end broad discovery rather than read, write, edit, or the closed `orientation` product's `code_nav` delivery surface; executed calls remain bounded by the lifetime cap, refused calls do not spend it, free refusals carry their own bounded backstop, and loop escalation scales with the worker's admitted budget instead of the interactive threshold.
- Made provider thinking controls and usage accounting describe what actually reached a model. `thinking: off` now sends an explicitly mapped off effort for supported effort-level families, while families with no such mapping continue to omit the field and LM Studio native reports its transport cannot send template thinking controls. Reasoning tokens remain accounted even when Clio suppresses the thought text, so an incorrect reasoning-never classification cannot make the server's observed usage disappear.
- Made the npm release contract follow the runtime resources an installed CLI actually resolves. One shared release manifest now drives the package gate and tests, source analysis checks literal package-root paths against the allowlist, bundled HTML remains present for `clio docs`, and generated repository-local handbooks cannot leak from a release checkout into the tarball.
- Changed how the TUI treats a slash command it does not recognize. A command-shaped token now fails with `/<token> is not a command. Type /help for the list.` instead of being sent to the model as ordinary chat. This removes the fall-through that previously let four renamed spellings, `/status`, `/hotkeys`, `/skills`, `/connect`, `/disconnect`, `/receipts`, and every typo reach the model as a question about itself. The accepted cost is that one command-shaped word followed by prose now resolves as a command, so `/tmp is full` fails; the escape is a leading backslash, and `\/tmp is full` reaches the model unchanged.
- Fixed `clio uninstall --remove-binary` reporting that it removed a dangling launcher symlink while leaving it in place, which left a broken `clio` on `PATH` after an uninstall that exited zero. Launcher ownership is now the resolved identity of this installation's own entry, so a link into a different clio installation and a symlink whose target is a directory are both preserved with an actionable warning, and only a link that resolves to this installation, or a dangling link naming a clio entry, is removed.
- Fixed `clio reset` and `clio uninstall` reporting global success after a partial delete. Both now attempt every selected root, collect per-path failures instead of throwing the first one, rebuild the skeleton, name each surviving path with its reason, and exit 1 with the exact invocation to rerun.
- Fixed `clio trace --help` failing with `unknown trace flag: --help` and exiting 2 while every other subcommand answered on stdout with status 0. `clio trace` usage also now says that `clio trace ui` needs a source checkout, which is where the viewer ships; from an installed package the other trace subcommands read the same database.
- Fixed `clio configure --list` and the first-run runtime menu writing fixed-width rows sized for roughly 88 columns, which ran model hints to 141 columns on an 80-column terminal. The plain-stdout configure surfaces now measure the terminal and degrade by restacking rather than by dropping information.
- Fixed error messages that named a command which could not change the outcome. An invalid `settings.yaml` now names the file, the keys, and `clio reset --config --force` rather than `clio doctor --fix`, which by design never rewrites settings content; an interrupted install that leaves a missing chunk reports reinstall instructions; and `clio run --no-context-files` explains that global options precede the subcommand instead of reporting an unknown option.

## 0.2.9 - 2026-08-05

- Added deterministic `code` steps to fleet contracts and execution plans. A step names a command id from the repo-owned registry at `.clio/fleets/commands.yaml`, never a shell string a model authored, and an unknown id or a missing registry fails contract validation before anything dispatches. A code step holds no capacity lease, carries no execution role or authority grant, and returns the typed `code-report` contract; under `onFailure: continue` its verbatim output is the input to the step that repairs it.
- Added bounded check/repair loops and shipped three SDLC fleets. A `loop` declares `maxAttempts`, a check (a registered command or a gate agent), and an agent repair; compilation unrolls it into conditional nodes so the plan stays one deterministic hashed DAG with whole-plan admission and a receipt per attempt. Verification staleness is scheduler-enforced: a workspace step landing after a green re-runs it before any dependent may rely on it. `build-test`, `build-review`, and `sdlc` ship from `src/domains/agents/fleets/`, and a project `.clio/fleets/<name>.md` shadows a builtin.
- Added a durable trace store: every run is mirrored into a rebuildable WAL SQLite database beside the ledger, with a fail-closed schema version, seven Clio-mapped tables, and one documented rowid-cursor query. Writes are bounded and secret-redacted, run off the worker event pump, and drop display-only progress before any lifecycle, terminal, tool, attempt, or usage fact; a trace failure degrades the mirror, never the dispatch it observes.
- Added `clio trace` (`runs`, `phases`, `tail --follow`, `procs`, a single read-only `sql` SELECT, and `ui`) plus a no-build localhost-only waterfall viewer under `apps/trace-viewer`, outside the published package. Component dollar columns stay empty where no authoritative producer supplies them, and the viewer says "not recorded" rather than inventing a breakdown.
- Added per-step write boundaries. Fleet contract v4 declares a `writes` path allowlist per step, `readonly` being the empty one, and the orchestrator verifies the claim after the fact by diffing the checkout against a pinned baseline, rolling back unauthorized changes, and failing the step with `writes_boundary_violation` naming the paths and the declaration. This is detect-and-rollback rather than sandboxing; a path that cannot be restored cleanly is reported and left for the operator instead of guessed at.
- Updated the Pi engine dependencies to 0.80.6, including native `max` thinking-level support and upstream runtime, accounting, and protocol fixes.
- Made singular `dispatch({agent, task, briefing, detach})` first-class while preserving batch `tasks`, pinned task/briefing separation through approval, and rejected briefing-only or ambiguous `task`+`tasks` calls.
- Made native-worker initialization fail closed on the same `worker_announce` wire-version handshake locally and over SSH, then required a full identity and resource attestation before the first model call.
- Required a nonempty receipt-sealed final answer for successful native and ACP delegation, with deterministic `worker_final_output_missing` failure and no automatic retry; added prose-free steering provenance and advanced receipt integrity to strict v15, whose reader rejects every earlier format.
- Made model-facing dispatch and collect output distinguish verified receipt integrity, evidence verification, briefing provenance, and bounded project-context provenance, and tightened collect-before-synthesis and bounded Scout spot-check guidance without restoring forced routing.
- Unified ordinary synchronous and detached model dispatch over one per-tool run consumer: synchronous calls auto-wait on the registered drain, while detached calls return run ids and leave that same drain running so the parent model can monitor or steer mid-run. The interactive operator/TUI can monitor and steer an active synchronous native run through the dispatch contract; ACP runs remain monitorable but have no steering channel. Review and compete retain direct gate-sensitive drains so reviewer/judge output is staged before their receipt-facing settlement path.
- Added one prompts-domain-compiled Clio worker harness with deterministic canonical tool slicing, stable/dynamic prompt separation, and read-only reviewer/judge parity; added strict per-agent `budget` frontmatter, Scout `18/4/true` and Coder `50/5/true` profiles, native and Claude SDK enforcement, and fail-closed explicit-budget admission for black-box subprocess runtimes while preserving the operator hard cap.
- Hardened dispatch authority and provenance: approval now uses one registry-owned, deeply immutable resolved plan (effective agent, target, model, node id/kind/host, every bounded gate role, and cost ceiling); approval rendering and execution consume that same trusted artifact, execution fails closed on route or ceiling drift, forged plan fields are ignored, and receipts identify the actual one-shot approval or full-auto decision.
- Added write-ahead, integrity-covered coordinator evidence for review verdicts, compete winners, and supervised/full-auto winner application; reviewer/judge output is staged before receipt settlement and reconstructed only from a verified receipt after restart, and evidence bundles now include `gate-decisions.json`.
- Closed external-agent policy gaps by canonicalizing standardized ACP locations for path-bearing reads and mutations, rejecting contradictory tool metadata, unenforceable profiles, and authority narrowing before launch, representing external tool inventory as unknown, supporting bounded read-only ACP reviewer/judge roles, and bounding resistant ACP process groups on abort, stall, failure, and successful teardown.
- Made protected-artifact boundaries durable across session append, synchronous flush, reload, reset, restart, local/shared-filesystem dispatch, and compete worktrees with a write-ahead recovery journal, merge-time protected-diff check, and fail-closed degraded mode.
- Made iterative compaction cumulative, surfaced compaction failures distinctly from legitimate no-ops, and isolated repository-scoped memory by canonical repository identity in interactive and headless agent prompts.
- Made compete worktree ownership transactional and segment-safe, with all admitted workers settled before cleanup, durable coordinator/worker process leases, PID-reuse-resistant termination of hard-crash orphans at orchestrator startup, and restart preservation of a pending or recovered winner while losers are removed.
- Made broad repository exploration model-authored: the chat harness and middleware no longer force Scout routing or block direct reads, while the operating contract, Scout catalog description, and an advisory after 9 or more manual read-only calls steer delegation. Dispatched Scout workers retain the 18-call exploration-to-synthesis guardrail, and the task-aware Fleet Runs UI exposes live tools, tokens, priced cost, retries, steering acknowledgements, and per-run cancellation.
- Added strict versioned agent recipes and typed terminal result contracts. Malformed custom recipes are quarantined, built-in schema failures stop startup, Scout citations must be grounded in the worker's own live reads, and a postcondition that was never reached is recorded as `not-reached` rather than fabricated as a quality failure.
- Added one deterministic `ExecutionPlan` v2 DAG with whole-plan preflight, capacity-bounded waves, authenticated handoffs, requested/approved authority on every task, and a strict resolved-plan v3 boundary with explicit deadlines. Older or partial durable forms are rejected rather than migrated or accepted through aliases.
- Added process-safe global and per-node admission with durable expiring leases, deterministic priority/FIFO queues, finite deadlines, retry reservation rebinding, TTL-bounded operator drain, and cross-process owner-liveness checks. Placement spreads by durable lease usage, but leases remain the authority under the state lock.
- Added a two-lane worker protocol and pre-call attestation of protocol, process group, host, settings and WorkerSpec digests, runtime, target, endpoint, model, tool surface, and resource facts. Local and remote aborts terminate the whole process group; display backpressure cannot delay heartbeats, acknowledgements, or receipt-bearing frames.
- Added measured joint route resolution across agent, target, model, runtime, and node. Hard constraints eliminate before deterministic Pareto ranking; route history v3 aggregates only compatible capability evidence, retires older files, and invalidates buckets on tool-surface or endpoint drift.
- Added operator-scoped active routing for read-only-capability work in researcher, verifier, reviewer, and judge roles. Shadow remains the default; activation requires named role/posture settings and exact-route readiness evidence, and no-ready-candidate, manual pin, and `failover: none` paths fail closed.
- Added bounded `agent: auto` evaluation and typed Scout phase escalation. Agent authority, tools, skills, result contract, locality, and governance remain hard filters; authority-changing transitions require an authenticated plan approval or existing full-auto authority, and agent automation stays shadow by default with per-agent/per-role readiness.
- Added transactional attempt isolation for editing work. Every assignment owns baseline-pinned attempt worktrees, winning changes are checked for outcome, receipt integrity, result conformance, quality gate, protected artifacts, ancestry, and destination cleanliness before apply, and a refused winner is preserved with recovery instructions.
- Advanced receipt integrity to strict v15, route policy to v4, route history to v3, ExecutionPlan to v2, and resolved dispatch plans to v3. Current readers accept only the current format for each boundary; earlier forms are rejected or explicitly retired.
- Clarified the compact main and worker harness prompts with an explicit direct-tool inventory and a strict distinction between tools, fleet agents, and operator-activated skills, preventing capability questions from triggering irrelevant fleet queries.
- Grounded generated wikis in detected repository instructions and their declared source-of-truth documents, added dirty-working-tree evidence and source-tree freshness metadata, tightened capability-claim guidance, let the bound documenter worker profile control its thinking level, and raised the local tool-bearing turn ceiling to the configured 32K default so long-context documenters are not artificially constrained to 16K.

## 0.2.8 - 2026-07-07

- Redesigned the tool surface into seven planes with consolidated observe,
  execute, orchestrate, retrieve, interact, mutate, and artifact tools.
- Added session task tracking with the `tasks` tool, `/tasks`, open-task
  continuation nudges, and receipt-backed task evidence.
- Added richer dispatch controls: `monitor`, `steer`, pipeline dispatch,
  ad-hoc specialist personas, and worker permission escalation.
- Rebuilt context indexing around codewiki schema v4, a separate
  agent-authored wiki layer, `/context refresh`, worker context injection, and
  one ignore policy for grep/find visibility.
- Added prompt manifests, eval provenance, public benchmark manifests, unified
  observation truncation envelopes, `/export`, and deeper per-tool usage docs.
- Improved the interactive UI with a shared TUI design system, slash-command
  argument completion, a `/context` hub, clearer permission queues, and better
  skill-loading guidance.
- Fixed safety and autonomy edge cases around approval denials, symlink path
  checks, loop-guard recovery, external worker tool profiles, reasoning-off
  models, and source-tree awareness in nested repositories.
- Reworked local model residency: local inference targets are treated as
  multi-model servers with finite VRAM, one shared reconciler drives llama.cpp
  routers, LM Studio, and Ollama, co-resident models such as a scout beside
  the main coder are protected symmetrically, residency mutations against one
  server are serialized across processes, and the `CLIO_RESIDENCY=observe`
  and `lifecycle: user-managed` opt-outs now work on every runtime path.
- Added native shadow-agent fleet routing: `/agents` lists shadow agents and
  `/fleet` binds native agents to target/model worker profiles, including
  changing a bound profile's model from the bindings tab.
- Enforced loop-guard synthesis lockouts mechanically for the main agent and
  dispatched workers: locked turns can only answer (request-level
  `tool_choice: none`), dead tool-call markup is sanitized out of locked
  answers, and a result-stagnation detector blocks byte-identical retry
  escalations that evaded the verbatim detector.
- Conditioned the harness for local models with measured fixes: a
  deterministic tool-routing order in the system prompt, task-board reminders
  on enumerated multi-step requests, a validation nudge on successful edits,
  recovery guidance with sanctioned pivots on blocked calls and denials,
  ask_user gated to genuine decisions, bundled-docs retrieval repairs, and
  observation-budget stubs that end retry traps.
- Made the TUI truthful under pressure: context meters draw the autocompact
  reserve with its own glyph, the dispatch board renders at the terminal's
  real width, overflowing rows drop whole facts behind an ellipsis instead of
  clipping mid-number, permission overlays show the parked call's target
  (including worker escalations, sanitized at the trust boundary), and
  blocked or aborted tool calls settle instead of spinning forever.
- Fixed accounting: aborted turns keep their real token usage, headless run
  receipts sum usage across all agent segments, guard blocks are recorded as
  blocked safety decisions, and worker tool-call caps count blocked attempts.
- Fixed session integrity across `/tree`, `/fork`, resume, and compaction so
  abandoned sibling turns are never replayed, copied, or summarized.
- Hardened worker IPC: subprocesses drain stdout before exit, streaming no
  longer amplifies quadratically, and internal generator dispatches (wiki
  update, context bootstrap) get a wall-clock deadline with progress output.
- Fixed deadline timers that could silently never fire in a quiet process:
  ACP request timeouts, dispatch and internal-generator deadlines, the
  dispatch drain grace, and worker escalation timeouts now hold the event
  loop until they fire or are cleared.
- Updated the model catalog: the Qwopus3.6 Coder entries carry the upstream
  presence-penalty sampler default, and reasoning-never model families no
  longer receive or replay thinking fields.
- Aligned the documentation corpus with v0.2.8, added worker-dispatch and
  provider-adapter guides, and refreshed the HTML docs viewer with new
  interactive blueprints.
- Breaking: legacy tool names such as `glob`, `workspace_context`,
  `docs_search`, `run_task`, `validate_frontend`, `write_plan`,
  `write_review`, `create_skill`, and `dispatch_batch` were removed in favor of
  the consolidated tool surface.

## 0.2.7 - 2026-07-02

- Added five reviewed marketplace skills: `scientific-debugging`,
  `experiment-protocol`, `design-council`, `credentials`, and
  `workflow-distiller`.
- Added executable skill evals, enforced skill tool surfaces, and registry
  integrity pins for catalog skills.
- Added credential damage control with zero-access credential storage,
  secret-value redaction in evidence bundles, and a read-only
  `credential_present` tool.
- Added `clio usage report`, headless main-agent receipts, dispatch evidence
  bundles, high-rigor validation prompts, and evidence-linked change manifests.
- Reduced package size, tightened the release workflow, refreshed
  documentation, and fixed several dispatch, lifecycle, skill, and loop-guard
  reliability issues.

## 0.2.6 - 2026-06-24

- Added VRAM-aware local model residency so interactive, headless, and worker
  runs reconcile model load/evict behavior through one path.
- Added first-class customization surfaces: layered project settings,
  path-scoped rules, operator profiles, user hooks, and `clio config inspect`.
- Added self-orientation through the `docs_search` tool and `clio docs`
  viewer.
- Added SciCode benchmark support, coverage gates, deterministic repeat lanes,
  and refreshed guides and HTML blueprints.
- Fixed a dispatched-run residency gap that could leave Ollama models resident
  and overflow VRAM.

## 0.2.5 - 2026-06-23

- Added the `alcf` runtime for Argonne ALCF Sophia/Metis inference targets over
  Globus OAuth.
- Added ALCF model metadata, gateway-specific documentation, authenticated
  provider discovery, and strict OpenAI-compatible payload handling.
- Added contract coverage for ALCF OAuth selection, runtime discovery, and
  strict reasoning-payload behavior.

## 0.2.4 - 2026-06-23

- Added agent fleet management with agent-to-profile bindings, profile CRUD,
  fault-tolerant dispatch, and a `/fleet` overlay.
- Isolated dispatch tests from the real run ledger and pinned several dispatch
  invariants with regression coverage.
- Made receipt digests deterministic across hosts and refreshed the pi engine,
  Claude SDK, Anthropic SDK, Biome, TypeBox, undici, uuid, and tsx
  dependencies.

## 0.2.3 - 2026-06-17

- Rebuilt the interactive command surface around a declarative slash-command
  registry and full-screen hubs for help, agents, prompts, extensions, targets,
  skills, settings, and receipts.
- Introduced the enforced autonomy model with an always-on safety net, clearer
  approval and safety notices, and stricter tool admission across chat,
  workers, headless runs, and ACP delegations.
- Added subscription and delegation runtimes including `anthropic-max`,
  `claude-code`, `claude-sdk`, Claude Code over ACP, and `antigravity-code`
  workers.
- Added `clio context-index`, deterministic multi-language codewiki indexing,
  `code_nav`, scratch offloading for large tool results, middleware hooks, live
  agent steering, and richer receipt tool activity.
- Reworked Clio's on-disk roots, settings ownership, lifecycle commands,
  model-target vocabulary, and observability workflows.
- Removed several legacy slash commands; their workflows moved into `/skill`,
  `/targets`, `/help`, `/view`, and related hubs.

## 0.2.2 - 2026-06-11

- Retired built-in CLI-subprocess runtimes in favor of direct HTTP/native/pi-ai
  targets and ACP delegation for external coding agents.
- Added the context engine, single-threshold compaction, bounded tool results,
  prompt-cache telemetry, and session-owned live routing.
- Added `clio acp`, ACP delegation support, a curated skills marketplace,
  richer skill activation, and local source install/uninstall scripts.
- Upgraded `CLIO.md` into a project rulebook with custom sections and better
  source-tree awareness.
- Improved prompt-prefix stability, session-ledger append behavior, permission
  overlays, and release verification.

## 0.2.1 - 2026-06-05

- Added live token-throughput telemetry, a larger context fill bar, hashed
  prompt-envelope delivery, and prompt diagnostics in `clio run --json`.
- Narrowed per-turn tool exposure and bounded long tool outputs to reduce
  context pressure.
- Retuned the footer dashboard for smaller terminals and refreshed README and
  operator documentation.
- Fixed headless `clio run` argument handling, unknown-agent failures,
  dashboard layout, and prompt-diagnostic visibility.

## 0.2.0 - 2026-06-03

- First community alpha release for source-checkout users.
- Added JIT skills, stronger prompt compaction, `clio init` / `/init`
  adoption of existing project instruction files, and centralized runtime
  target resolution.
- Added runtime diagnostics, command-output routing, durable session JSONL
  coverage, expanded user docs, and a portable `Ctrl+G` leader-key fallback.
- Hardened path policy handling, headless `clio run`, prompt cache boundaries,
  overlay rendering, session persistence, fork replay, and TUI startup.

## 0.1.9 - 2026-05-17

- Added `dispatch` as a first-class fleet-agent handoff tool.
- Added `validate_frontend` for HTML/CSS/JavaScript artifacts and finish
  evidence for typed validation tools.
- Improved local model capability handling, GPT-OSS/Harmony parsing, active-run
  follow-ups, and cancellation behavior.
- Fixed reasoning replay, Harmony stream parsing, OpenAI Codex file-tool
  schema aliases, lifecycle metadata repair, and duplicate model-capability
  paths.

## 0.1.8 - 2026-05-11

- Added extensions, share archives, extension and share CLI/TUI workflows, and
  a redesigned welcome dashboard.
- Added model and context-window validation to `clio configure`.
- Added a Claude Code SDK safety bridge, supervised approval IPC, a TUI
  approval overlay, and receipt accounting for SDK safety decisions.
- Fixed Gemini CLI token accounting and expanded tests for extensions, share
  archives, configure validation, and supervised SDK decisions.

## 0.1.7 - 2026-05-11

- Added a shared safety policy engine for orchestrator and native workers.
- Added strict project command policy parsing, typed execution tools, and
  receipt safety summaries.
- Changed default-mode Bash to default-deny ordinary execution unless allowed
  by curated commands or project policy.
- Hardened dispatch scope, external-runtime permission mapping, audit rows,
  and worker safety parity.

## 0.1.6 - 2026-05-04

- Added `clio --print` / `clio -p` for one non-interactive orchestrator turn.
- Added stdin plus argv prompt composition and stdout guarding for scriptable
  print-mode use.
- Reserved future JSON/RPC modes behind explicit errors and added focused CLI
  coverage.

## 0.1.5 - 2026-05-03

- Public alpha release for developers and research-software teams testing a
  terminal-first coding agent from source.
- Shipped the interactive TUI, target-first configuration, built-in coding
  agents, persistent sessions, project context, receipts, audit logs, evidence,
  evals, memory, and safety modes as an integrated product surface.
- Added `clio init`, CLIO.md parsing, codewiki indexing, clearer `/cost`
  accounting, a redesigned `/model` popup, and CLIO-branded popup frames.
- Documented alpha limits: source install remained the supported path, model
  behavior varied by target, and operators were expected to review privileged
  actions.

## 0.1.4 - 2026-04-30

- Added the evolution plane: component inventory, typed change manifests,
  deterministic evidence building, local eval runs, memory records, middleware
  hooks, protected-artifact safety, and finish-contract checks.
- Added workspace orientation, a `workspace_context` tool, eight specialist
  agent recipes, and a scientific-validation pack.
- Unified llama.cpp runtime handling, improved the TUI, expanded compaction and
  context accounting, and hardened protected-artifact behavior.

## 0.1.3 - 2026-04-27

- Added live tool output, bash command echo, `Ctrl+T` thinking expansion, and a
  git-branch footer slot in the TUI.
- Made `CLIO.md` the canonical project instruction file and improved local
  runtime detection for LM Studio and Ollama.
- Aligned Clio Coder's identity with IOWarp's CLIO ecosystem, updated package
  docs, reorganized safety rule packs, and added a clean-clone smoke CI job.
- Fixed slash autocomplete on Debian/Ubuntu, stabilized JSON envelopes for
  `doctor` and `targets`, and improved partial tool-output rendering.

## 0.1.2 - 2026-04-25

- Added visible retry handling for transient provider and stream failures.
- Improved tool, bash, edit, dashboard, hotkey, resume, prompt, receipt,
  compaction, audit, and abort behavior in the interactive TUI.
- Fixed retry duplication, cancellation races, oversized Bash output handling,
  resume/fork/new behavior during active runs, provider hot-swaps, and local
  OpenAI-compatible reasoning/tool schemas.

## 0.1.1 - 2026-04-24

- Added deterministic loading of project context files from the current working
  directory upward.
- Fixed resume, fork, and tree-switch replay for rich session entries and
  durable tool records.
- Fixed subprocess worker dispatch, out-of-tree SDK runtime rehydration,
  receipt verification, dispatch heartbeat state, and the documented boundary
  check command.

## 0.1.0-exp - 2026-04-24

- Initial experimental public release.
- Shipped the interactive TUI, CLI lifecycle commands, target-first
  configuration, runtime coverage, seven built-in agents, dispatch workers,
  receipts, audit logs, safety modes, and XDG-aware state layout.
- Known limits: Windows was best effort, and some remote fan-out and MCP
  surfaces were scaffolded but not yet admitted by dispatch.
