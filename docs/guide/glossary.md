# Clio Coder Glossary

This document defines the core architectural concepts and terminology used throughout Clio Coder, mapped to their authoritative TypeScript type definitions in `src/`.

---

## Terms & Concept Definitions

### 1. Assignment
- **Definition**: The logical unit of work dispatched to the fleet. An assignment encapsulates the requested task, briefing, authority boundaries, and retry history across one or more concrete run attempts.
- **Owning Type**: `DurableAssignmentRecord` in [assignment-store.ts](../../src/domains/dispatch/assignment-store.ts).

### 2. Run
- **Definition**: A concrete execution attempt of an assignment. Dispatch creates a 12-character random base36 run identifier with `newRunId()`. Session ids use the same 12-character base36 generator, while appended session turn and entry ids use UUIDv7. Every run has an isolated event stream, a designated execution node, and a final cryptographically sealed receipt.
- **Owning Type**: `RunEnvelope` in [types.ts](../../src/domains/dispatch/types.ts).

### 3. Attempt
- **Definition**: A 0-based sequential retry index of a logical assignment. The first run of an assignment is attempt 0; a retry after a retriable infrastructure error increments it while preserving the earlier attempt's own run and receipt.
- **Owning Type**: `RunLineage.attempt` in [types.ts](../../src/domains/dispatch/types.ts).

### 4. Batch
- **Definition**: A durable collection of detached assignments created and tracked together under a single batch ID (`batches.json`).
- **Owning Type**: `DetachedBatchRecord` in [batch-store.ts](../../src/domains/dispatch/batch-store.ts).

### 5. Plan
- **Definition**: A multi-step directed acyclic graph (DAG) defining steps, dependencies, code validations, and budget ceilings approved by the operator before dispatch.
- **Owning Type**: `ExecutionPlan` in [execution-plan.ts](../../src/domains/dispatch/execution-plan.ts).

### 6. Receipt
- **Definition**: An immutable, cryptographically sealed record of a completed run containing full execution facts, tool telemetry, token accounting, validation grounding, and outcome codes.
- **Owning Type**: `RunReceipt` in [types.ts](../../src/domains/dispatch/types.ts) (`RUN_RECEIPT_INTEGRITY_VERSION = 20` in [receipt-integrity.ts](../../src/domains/dispatch/receipt-integrity.ts)).

### 7. Envelope
- **Definition**: A bounded container enforcing byte-length limits and truncation indicators on a dynamic payload. Tool output carries shown and total byte counts plus a continuation fragment; a parent briefing carries byte count and SHA-256 content hash instead.
- **Owning Type**: `Observation` in [observation.ts](../../src/tools/observation.ts) for tool output; `RunBriefingProvenance` in [types.ts](../../src/domains/dispatch/types.ts) for briefings.

### 8. Phase
- **Definition**: A designated execution interval within a run. Every trace event and spend row is keyed to one `phaseId`, and the `phases` table is opened alongside `runs` for each operator turn.
- **Owning Type**: `TraceEventInput.phaseId` and the `phases` table in [trace-store.ts](../../src/domains/observability/trace-store.ts).

### 9. Gate
- **Definition**: A validation or review barrier (such as a read-only reviewer verdict or a compete judge decision) determining whether candidate diffs are merged or revised.
- **Owning Type**: `GateDecisionArtifact` in [gate-decisions.ts](../../src/domains/dispatch/gate-decisions.ts).

### 10. Recipe
- **Definition**: A versioned Markdown document declaring an agent's static persona, tool profile, execution capability class, cost ceilings, and result contracts. Recipe is the code name of an agent definition. User-facing text says agent, and never uses recipe as a word for skills, prompts, agents and playbooks together; the word for that set is component.
- **Owning Type**: `AgentRecipe` in [recipe-schema.ts](../../src/domains/agents/recipe-schema.ts).

### 11. Worker
- **Definition**: An isolated execution subprocess (or remote SSH worker) running a dedicated tool dispatch runtime and communicating over two lanes of newline-delimited JSON: a bulk lane on stdout for model and tool events, and a control lane on marked stderr lines for the announce, heartbeats and cancellation acknowledgements.
- **Owning Type**: `WorkerSpec` in [spec-contract.ts](../../src/worker/spec-contract.ts).

### 12. Target
- **Definition**: A configured provider endpoint definition mapping a named identifier to a runtime, base URL, authentication method, default model and optional pricing. The settings UI and the GUI call it a connection; the CLI commands (`targets`) and the YAML key (`targets`) keep the technical name.
- **Owning Type**: `TargetDescriptor` in [target-descriptor.ts](../../src/domains/providers/types/target-descriptor.ts).

### 13. Node
- **Definition**: An addressable physical or virtual compute host within the fleet capacity pool (`local` or remote SSH host).
- **Owning Type**: `FleetNodeSnapshot` in [cluster.ts](../../src/domains/scheduling/cluster.ts).

### 14. Route
- **Definition**: The complete execution candidate evaluated by the route planner for capability fit, readiness, and cost. Its operational identity includes agent, execution role, target, model, runtime, node, thinking level when present, tool and prompt composition, endpoint identity, and immutable spec/settings fingerprints.
- **Owning Type**: `RouteCandidate` in [route-decision.ts](../../src/domains/dispatch/route-decision.ts).

### 15. Posture (Autonomy Level)
- **Definition**: The operator-set dial, `default` or `yolo`, that decides which action classes ask for approval and which run at once. Hard blocks and damage-control rules apply at both levels. A dispatched worker resolves its own approval asks through `fleet.permissions.mode`, and a read-only dispatch restricts its tools. Routing postures (`quality`, `balanced`, `latency`, `economy`) under `fleet.adaptiveRouting.postures` are a different axis that ranks candidate routes.
- **Owning Type**: `AutonomyLevel` in [autonomy.ts](../../src/domains/safety/autonomy.ts).

### 16. Capability Class
- **Definition**: The maximum permitted mutation boundary declared by an agent recipe (`read-only`, `verification`, `artifact-write`, `workspace-edit`, `orchestration`, `internal`).
- **Owning Type**: `AgentCapabilityClass` in [spec.ts](../../src/domains/agents/spec.ts).

### 17. Topology
- **Definition**: The multi-agent structural orchestration pattern governing workflow execution. Three unions spell it for three jobs. A compiled plan supports `parallel`, `sequential`, `pipeline`, `review`, `compete`, `council`, and `fleet`. A capacity reservation supports `parallel`, `detached`, `sequential`, `pipeline`, `review`, `compete`, and `council`. The dispatch-plan tool surface supports all eight values from those two sets. The dispatch tool's `mode` argument selects among `parallel`, `sequential`, `pipeline`, `compete` and `council`, and a one-task call omits it.
- **Owning Types**: `ExecutionPlanTopology` in [execution-plan.ts](../../src/domains/dispatch/execution-plan.ts), `ReservationTopology` in [reservation-store.ts](../../src/domains/dispatch/reservation-store.ts), `DispatchPlanTopology` in [dispatch-plan.ts](../../src/tools/dispatch-plan.ts).

### 18. Worker Block
- **Definition**: The attributed transcript segment rendering a worker's streaming execution. It includes a header with origin glyph and route, a rail for worker prose, coalesced tool names, and a one-line receipt footer.
- **Owning Type**: `WorkerEntryState` in [worker-stream.ts](../../src/session-control/worker-stream.ts).

### 19. Origin Glyphs (`◇`/`◆`)
- **Definition**: Transcript and fleet board indicators that identify who requested a run. The glyph `◇` marks operator-typed runs, `◆` marks model-requested dispatches, and a dim dot marks internal Clio Coder runs and harness-started runs. Transcript worker entries admit only user and agent origins; internal and harness runs can appear on dispatch surfaces but never become transcript worker entries.
- **Owning Types**: `WorkerRunOrigin` in [entries.ts](../../src/domains/session/entries.ts) for transcript entries; `DispatchRequestOrigin` in [types.ts](../../src/domains/dispatch/types.ts) for user, agent, internal, and harness dispatches.

### 20. Share Note
- **Definition**: A bounded operator note formatted as `[worker result] <agent> · run <id> · <outcome> · shared by the operator` that delivers a finished worker answer into the main agent context over the user-turn path.
- **Owning Type**: `WorkerShareFacts` in [worker-share.ts](../../src/session-control/worker-share.ts).

### 21. Fold
- **Definition**: Presenting an action as a short summary in the current Output style. `Alt+O` cycles Compact, Standard, and Detailed. Use `/view transcript` for full available details.
- **Owning Type**: `WorkerEntryRenderOptions` in [worker-entry.ts](../../src/interactive/renderers/worker-entry.ts).

### 22. Interop
- **Definition**: Read-only discovery of coding agents, their user and project resources, and connection state. The operator can approve adoption of safe text resources into the library; foreign provenance and the project-import trust gate persist. See [Coding agent interoperability](interop.md).
- **Owning Type**: `InteropContract` in [contract.ts](../../src/domains/interop/contract.ts).

### 23. Consent Record
- **Definition**: A persistent state entry recording the operator's decision to accept or decline an interop agent proposal, written atomically under `interop.json`.
- **Owning Type**: `InteropAgentRecord` in [types.ts](../../src/domains/interop/types.ts).

### 24. Fingerprint
- **Definition**: A SHA-256 digest of stable agent facts (including binary path, version, and launch recipe) that keys consent records so standing decisions stay valid until facts change.
- **Owning Type**: `InteropAgentFacts` in [types.ts](../../src/domains/interop/types.ts).

### 25. noWritePaths
- **Definition**: A damage-control path policy class that permits reads while blocking writes and deletes under every registered foreign agent directory across all autonomy levels.
- **Owning Type**: `PathPolicyKind` in [path-policy.ts](../../src/domains/safety/path-policy.ts).

### 26. Foreign Prompt Root
- **Definition**: An external prompt directory owned by another coding agent (such as `.claude/commands` or `.codex/prompts`) from which Clio loads prompt templates.
- **Owning Type**: `PromptTemplateRoot` in [loader.ts](../../src/domains/resources/prompts/loader.ts).

### 27. Compat Root
- **Definition**: A compatibility directory for prompts or skills discovered from foreign agent installations, ranked below native Clio Coder resource roots.
- **Owning Type**: `ResourceSourceInfo` in [collision.ts](../../src/domains/resources/collision.ts).

### 28. Trust Gate
- **Definition**: A security boundary requiring explicit operator opt-in via `integrations.projectResources.trustProjectImports` before explicitly imported foreign skills or prompt templates can be used at either scope. Loose compatibility roots remain discovery-only even when enabled.
- **Owning Type**: `PromptTemplate` in [loader.ts](../../src/domains/resources/prompts/loader.ts).

### 29. Fleet
- **Definition**: The set of addressable nodes Clio may place work on, `local` plus every configured SSH host, together with their capacity accounting. `fleet` is also the topology of a plan compiled from a playbook. The fleet is the coordinator and its workers; a playbook is what the fleet runs.
- **Owning Types**: `FleetNodeSnapshot` in [cluster.ts](../../src/domains/scheduling/cluster.ts) for capacity; `Playbook` for the declared multi-step workflow (see Playbook below).

### 30. Dispatch
- **Definition**: Sending one unit of work to a worker: the domain that resolves recipe, target, model, and node, admits the request against authority, spawns the worker, and seals the receipt. It is the `dispatch` tool, the `/run` slash command, and `src/domains/dispatch/`.
- **Owning Type**: `DispatchRequest` in [contract.ts](../../src/domains/dispatch/contract.ts).

### 31. Run Ledger
- **Definition**: The durable dispatch run list at `runs.json` in the state directory, retention-capped by `fleet.history.maxRuns`. It is what the fleet board and `clio-coder fleet status` read.
- **Owning Type**: `RunEnvelope` in [types.ts](../../src/domains/dispatch/types.ts), persisted by [state.ts](../../src/domains/dispatch/state.ts).

### 32. Agent Ledger
- **Definition**: The append-only progress log a worker writes for itself through the `ledger` tool, mirrored to the orchestrator over the control lane and persisted in `agent-ledgers.json`. Live subscribers are tracked in memory by the ledger hub.
- **Owning Type**: `AgentLedgerEntry` in [protocol.ts](../../src/worker/protocol.ts), stored by [agent-ledger-store.ts](../../src/domains/dispatch/agent-ledger-store.ts).

### 33. Session Ledger
- **Definition**: The JSONL record of one session's turns, written per session. It is what `/resume`, `/fork`, and replay read.
- **Owning Type**: `SessionEntry` in [entries.ts](../../src/domains/session/entries.ts).

### 34. Task Ledger
- **Definition**: The persisted form of the session task board: goals, subgoals, and the run ids in flight when the snapshot was folded. One session entry kind, distinct from the board that renders it.
- **Owning Type**: `TaskLedgerEntry` in [entries.ts](../../src/domains/session/entries.ts).

### 35. Context Ledger
- **Definition**: The accounting of how the model's context window is spent and the input to compaction decisions. Current buckets are `system`, `tools`, `toolResults`, `agents`, `skills`, `memory`, `project`, `messages`, `pending`, `reserve`, `free`, and `streaming`.
- **Owning Type**: `ContextLedgerCategory` in [context-ledger.ts](../../src/domains/session/context-ledger.ts).

### 36. Dispatch Board
- **Definition**: The live fleet view: one row per in-flight or recently finished run, carrying origin glyph, route, status, and the steer and cancel affordances.
- **Owning Type**: `DispatchBoardRow` in [dispatch-board.ts](../../src/interactive/dispatch-board.ts).

### 37. Task Board
- **Definition**: The operator-facing goal and subgoal checklist for the session. It renders from a snapshot and persists as a task ledger entry, so the UI noun and the wire format are deliberately named differently.
- **Owning Type**: `TaskBoardSnapshot` in [task-board.ts](../../src/domains/session/task-board.ts).

### 38. Dashboard
- **Definition**: The startup and footer panels summarizing targets, session, and spend. Not a board in the dispatch or task sense; it holds no rows a run or a goal maps to.
- **Owning Type**: `WelcomeDashboardStats` in [welcome-dashboard.ts](../../src/interactive/welcome-dashboard.ts).

### 39. Handbook
- **Definition**: `CLIO-CODER.md`, the human-owned, version-controlled project context file at the repository root: project name, one-line description, conventions, hard invariants, and optional sections, closed by a fingerprint comment.
- **Owning Type**: `ParsedClioMd` in [clio-md.ts](../../src/domains/context/clio-md.ts).

### 40. Delegate
- **Definition**: Another coding agent Clio drives over ACP stdio as if it were a worker, configured under `integrations.externalAgents.entries` and invoked with `/delegate`. A delegate is a foreign harness, not a model target.
- **Owning Type**: `DelegationAgentConfig` in [defaults.ts](../../src/core/defaults.ts).

### 41. Working Set
- **Definition**: The part of the session ledger the model receives on the next request. It is the ledger with the current eviction projection applied, and it exists only in memory; the ledger itself is never narrowed. Not to be confused with the context ledger, which is the accounting of how the window is spent.
- **Owning Type**: `WorkingSetView` in [contract.ts](../../src/domains/context/working-set/contract.ts).

### 42. Projection
- **Definition**: The pure, idempotent transform from ledger entries to the entries the replay builder hands the model. It substitutes markers for evicted bodies and drops thinking from closed turns, returning unaffected entries by reference. Nothing about it is persisted.
- **Owning Type**: `projectWorkingSet` in [project.ts](../../src/domains/context/working-set/project.ts).

### 43. Eviction
- **Definition**: The decision that a tool-result body or an assistant turn's thinking leaves the working set, recorded as an append-only ledger entry with a typed reason. It removes nothing: the original entry stays in the ledger and stays visible in the transcript, `/resume`, `/fork`, and the HTML export.
- **Owning Type**: `ContextEvictionEntry` in [entries.ts](../../src/domains/session/entries.ts).

### 44. Recall
- **Definition**: Readmitting an evicted body by ref, through `context(scope="recall", ref=...)` for the model or `/context recall <ref>` for the operator. A recall does not un-evict: the marker stays where it was so the provider prefix cache is untouched, and repeated recalls of one ref are the churn signal.
- **Owning Type**: `ContextRecallEntry` in [entries.ts](../../src/domains/session/entries.ts); resolution in `resolveRecall` in [recall.ts](../../src/domains/context/working-set/recall.ts).

### 45. Marker
- **Definition**: The byte-stable one-line stub the projection renders in place of an evicted body, naming the ref, the reason, the tool, the size, and the exact recall call. It carries no timestamp and no counter, because a marker whose bytes drifted between renders would cold-start the prefix cache on a turn that evicted nothing new.
- **Owning Type**: `renderMarker` in [marker.ts](../../src/domains/context/working-set/marker.ts).

### 46. Canonical Trust Status
- **Definition**: The five-axis record of what is known about one run: artifact integrity, validation grounding, independent review, context provenance, and completion evidence. It is an algebra, not a score: no axis promotes another, every non-absent state names its source and authority, and `absent`, `unknown`, and `not_applicable` are states in their own right. See [docs/architecture/evidence-and-memory.md](../architecture/evidence-and-memory.md) for the full state table.
- **Owning Type**: `CanonicalTrustStatus` in [trust-status.ts](../../src/domains/evidence/trust-status.ts).

### 47. Trust Projection
- **Definition**: The one rendering of the canonical trust status every operator surface prints. The compact human line answers who claims the result, what was observed, what was independently checked, and what is still unknown, in five fixed clauses (`sealed; grounded by host-verification; not independently reviewed; context recorded; completion evidenced`). The machine projection is the same answer as a bounded, versioned record with references to the detailed artifacts. Dispatch and monitor output, `evidence inspect`, `findings.md`, the Fleet Runs board, the receipt view, and the ACP wire all print from it.
- **Owning Type**: `formatTrustSummary` and `TrustSummaryProjection` in [trust-projection.ts](../../src/domains/evidence/trust-projection.ts).

### 48. Trust Verdict
- **Definition**: The presentation tier read off the axes in a fixed order, used for styling and sorting and never as a score. `reviewed` requires an authenticated independent pass and is the only tier styled as independently verified. `grounded` is observed validation without independent review. `unverified` is a sealed receipt with nothing observed. `compromised` is a broken seal, a failed or inferred validation, a failed or correlated review, or a contradictory context record. `unknown` is an unchecked or missing seal.
- **Owning Type**: `TrustVerdict` and `trustVerdict` in [trust-projection.ts](../../src/domains/evidence/trust-projection.ts).

### 49. Trust Vocabulary
- **Definition**: The standardized word for each canonical state, so the same fact is never spelled two ways. `sealed` means the receipt authenticated against the ledger row. `grounded` means validation was observed to run and pass, named by its claimant (`host-verification`, `validation-tool`, `receipt-quality`, `evidence-grounding`). `independently reviewed` means an authenticated reviewer that was not the run itself recorded a verdict. `inferred` means the worker claimed validation and nothing was observed to have run. `unknown` means a named source could not answer; `not applicable` means a named authority decided the axis does not apply.
- **Owning Type**: `TRUST_STATE_WORDS` in [trust-projection.ts](../../src/domains/evidence/trust-projection.ts).

### 50. Commonly Confused Trust States
- **Definition**: `sealed` is not `grounded`: a receipt can authenticate perfectly and describe a run that validated nothing. `grounded` is not `independently reviewed`: a host check is Clio Coder observing the run's own declared command, not a second agent judging the result. A `host checks verified` unit on the board is folded into validation grounding and is never independent review. `mediated` and `enforced` are one state under two names, the receipt grade and the canonical id. `not_requested` is not a trust state at all; a run with no host check reads `no validation observed`. `completion unevidenced` (a mutation finished with no validation at the completion boundary) is distinct from `no validation observed` (no validation was linked anywhere in the run): the first is the finish contract's observation, the second the evidence linker's.
- **Owning Type**: `TRUST_STATE_WORDS` and `trustVerdict` in [trust-projection.ts](../../src/domains/evidence/trust-projection.ts); the axis states in `TRUST_STATUS_STATES` in [trust-status.ts](../../src/domains/evidence/trust-status.ts).

### 51. System One
- **Definition**: An optional fast decision model that answers calibrated, typed questions (`noul`, `choice`, `score`) about one bounded, redacted state at a fixed decision site. Clio Coder's policy reads the probabilities to add a hint, an extra confirmation, a banner, a ranking or a prewarm. It never answers the operator and never removes friction. The shipped fitted cuts are built for one hosted engine build, and Laya is the diffusion-model engine planned for the same wire. System One is experimental. Configured under `systemOne`; see [System One](system-one.md).
- **Owning Type**: `SystemOne` in [types.ts](../../src/domains/system-one/types.ts); built by `createSystemOne` in [factory.ts](../../src/domains/system-one/factory.ts).

### 52. Decision Site
- **Definition**: A place where System One is asked, named by the object it judges: `turn` (the operator's request), `toolCall` (a proposed call, at the `card` and `gate` moments), `toolResult`, `turnEnd`, `relevance`, `consult`, `drafts` and `steer` (queued steering messages). A site owns its state, its questions, its policy and its default deadline. Bound to an engine by `systemOne.sites`; a site with no binding is off.
- **Owning Type**: `SiteDefinition` and `SiteId` in [types.ts](../../src/domains/system-one/types.ts).

### 53. Build
- **Definition**: The identity of what answered a System One question, and the key every cut is fitted against. For a `systemone` engine it is the model the server reports, such as `jev-1.13.0`. For an `llm` engine it is a composite of runtime, host, wire model, readout mode and prompt version. A probability means something only for the build that produced it.
- **Owning Type**: `EngineReply.build` in [types.ts](../../src/domains/system-one/types.ts).

### 54. Cut
- **Definition**: A probability threshold at which a site hints, gates or acts, written `<site>.<key>` and fitted for one build from a labeled run. Fitted cuts live in `FITTED_CUTS`, and `systemOne.cuts` overlays operator values between 0.01 and 0.99 on top. A build with no cut for a site is unfitted.
- **Owning Type**: `SiteCuts` in [types.ts](../../src/domains/system-one/types.ts); `FITTED_CUTS` and `cutsFor` in [calibration.ts](../../src/domains/system-one/calibration.ts).

### 55. Shadow Mode
- **Definition**: What a site does under an unfitted build. The engine is still asked and the call is recorded in the session ledger, and in the dataset when `systemOne.record` is on, but the site produces no hint, no gate, no act and no ranking. With recording off, a site whose build is known to be unfitted makes no call at all. No automatic site waits on a call, shadowed or not.
- **Owning Type**: `SystemOne.shadowed` and `SiteCuts.fitted` in [types.ts](../../src/domains/system-one/types.ts).

### 56. Laya
- **Definition**: The diffusion-model System One engine that serves the same `POST /v1/systemone` wire as the hosted engine, through `laya-serve` and the `systemone` runtime. Not yet fitted: a Laya build runs in shadow until cuts are fitted on that exact build with `scripts/decision-probe.ts`. See [System One Architecture](../architecture/system-one.md).
- **Owning Type**: `createSystemOneEngine` in [systemone.ts](../../src/domains/system-one/engines/systemone.ts).

### 57. Runtime
- **Definition**: A registered adapter for one kind of inference backend. It fixes the runtime id a target names, the kind (`http`, `sdk` or `subprocess`), the tier, the API family, the auth method, the default capabilities, and how to probe the backend and synthesize a model. Only `http` runtimes can drive the main agent; `sdk` and `subprocess` runtimes are worker-only. Built-in runtimes are in `BUILTIN_RUNTIMES`, and plugins add more. See [Configuration and targets](configuration-and-targets.md) and the [provider adapter cookbook](../architecture/provider-adapter-cookbook.md).
- **Owning Type**: `RuntimeDescriptor` in [runtime-descriptor.ts](../../src/domains/providers/types/runtime-descriptor.ts).

### 58. Runtime Tier
- **Definition**: The deployment class of a runtime: `cloud`, `local-native`, `protocol` or `subscription`. The tier changes behavior beyond grouping. A `local-native` runtime prices as free and is probed for loaded models and serving windows, while a `protocol` runtime (a generic endpoint or a gateway such as LiteLLM) never prices as free because it can front a paid model.
- **Owning Type**: `RuntimeTier` in [runtime-descriptor.ts](../../src/domains/providers/types/runtime-descriptor.ts).

### 59. Prompt Tier
- **Definition**: Which compilation path builds a prompt. Main-agent prompts compile in two tiers from one compiler: attended (interactive TUI, GUI, ACP), which carries the operator-facing guidance fragments, and headless (`clio-coder run`), which carries a headless contract and states that approval asks are denied. Workers compile through a separate worker path as the third tier. See [prompt compilation](../architecture/prompt-compilation.md).
- **Owning Type**: `compile` and `compileWorker` in [compiler.ts](../../src/domains/prompts/compiler.ts).

### 60. Model Profile
- **Definition**: A per-model record of what a model is: capability flags, a declared context and output maximum, the thinking mechanism and level mapping, and a recommended output budget. Packaged profiles live in `models/profiles.yaml` and the operator's `<configDir>/model-profiles.yaml` layers over them. A profile describes the model and never a deployment, so a live server report outranks it for the serving window, output cap, tools, vision and reasoning. See [Configuration and targets](configuration-and-targets.md) and the [model catalog](../architecture/model-catalog.md).
- **Owning Type**: `ModelProfile` in [model-profiles.ts](../../src/domains/providers/model-profiles.ts).

### 61. Cost Provenance
- **Definition**: The label that says where a cost figure came from: `known` (declared target rates), `known_free` (declared free, all-zero rates, or a `local-native` runtime), `estimated` (a Pi catalog rate) or `unknown` (no rate source). Absent provenance reads as `unknown`, never as free. Pricing is declared per target, and the label travels with the cost on receipts and in the footer, `/usage` and run tables. See [pricing and cost provenance](configuration-and-targets.md#pricing-and-cost-provenance).
- **Owning Type**: `CostProvenance` in [cost-provenance.ts](../../src/domains/providers/types/cost-provenance.ts); resolved by `resolveEffectivePricing` in [catalog.ts](../../src/domains/providers/catalog.ts).

### 62. Chat Route
- **Definition**: The target, model and thinking level that answer the operator, saved as `chat.target`, `chat.model` and `chat.thinkingLevel`. A session owns its live copy. When an existing home's chat route is missing or unusable, startup detects a replacement from configured targets, environment keys, stored logins and loopback servers and saves it only when no chat route exists. See [chat route detection](configuration-and-targets.md#chat-route-detection).
- **Owning Type**: `DetectedChatRoute` in [detect-chat-routes.ts](../../src/cli/detect-chat-routes.ts); the verdict is `DefaultTargetVerdict` in [default-target.ts](../../src/cli/default-target.ts).

### 63. Route Provenance
- **Definition**: Where each active model route comes from: the `chat`, `memory`, `compaction` and `fleet` routes each report `session`, `project`, `user`, `built-in`, or `chat` when the route is unset and follows the chat route. It is recomputed from live state on every read, so a compaction summary that dropped a session-only route cannot decide what Clio says about it.
- **Owning Type**: `RouteProvenance` in [route-provenance.ts](../../src/core/route-provenance.ts).

### 64. Settled
- **Definition**: The outcome label every route history record carries, from `routeSettledLabel`: `success`, else the receipt's most specific outcome code, else `permission_required`, else `failure` or the receipt outcome. The route observer backfills older records. Adaptive routing reads quality labels and reliability and does not read `settled`.
- **Owning Type**: `routeSettledLabel` in [route-history.ts](../../src/domains/dispatch/route-history.ts); backfilled by [route-observer.ts](../../src/domains/dispatch/route-observer.ts).

### 65. Operator Notes
- **Definition**: The `<operator-notes>` block of a compaction summary, a bounded list of things the operator asked Clio to keep. Each compaction collects the notes already in earlier summaries, sentences in the operator's own messages that open with `remember`, `keep in mind` or `don't forget`, and the instructions given to `/compact`. Instructions to `/compact` also bind the summarizer through an `<operator-instructions>` block and are kept verbatim in the notes. A note is clipped to 400 characters, the block keeps the latest 30, and notes are XML-escaped inside it.
- **Owning Type**: `extractOperatorNotes` and `formatOperatorNotes` in [compact.ts](../../src/domains/session/compaction/compact.ts).

### 66. Receipt Facts
- **Definition**: The compact terminal facts of a finished run, read back from its sealed receipt: outcome and outcome code, exit code, token and tool counts, duration, changed paths, placement, result contract and the authenticated trust status. One module produces them for the TUI worker block (live and replayed) and for ACP terminal fleet frames, so every surface draws the same numbers from the same bytes. A missing or corrupt receipt reads as `receipt unavailable` and never fails a render.
- **Owning Type**: `RunReceiptSummary` and `RunReceiptFacts` in [receipt-facts.ts](../../src/domains/dispatch/receipt-facts.ts).

### 67. Clio Coder
- **Definition**: Clio Coder is named for Kleio, the Greek muse of history, a female figure in myth; the software is referred to by name and has no gender.

### 68. Plugin
- **Definition**: An Agent Plugin: a package with a root `plugin.json` that carries content only (skills, agents, prompt templates and playbooks). Content specific to Clio lives under the Clio namespace, `extensions["ai.iowarp.clio"]` in `plugin.json` and the `ai.iowarp.clio/` directory. Installing a plugin never runs code inside Clio. A plugin is a different package from an extension, and the two never share a manifest, digest or consent.
- **Owning Type**: `PluginManifest` in [types.ts](../../src/domains/plugins/types.ts).

### 69. Extension
- **Definition**: Clio code in its own process, declared in `clio-coder-extension.yaml` with runtime api 2: hooks, runtime tools named `extension_<id>__<tool>`, commands `/ext:<id>:<name>`, workspaces and skins, and interviews. The operator reviews its capability envelope before install and update, and the recorded envelope digest must match when it is applied and loaded. A runtime child runs under the OS sandbox when one exists. See [Extensions](harness-extensions.md).
- **Owning Type**: `ExtensionRuntimeDeclarationV2` in [manifest-v2.ts](../../src/domains/extensions/manifest-v2.ts).

### 70. Pairing
- **Definition**: The link from an extension to the one plugin it serves, written `plugin: <name>` in the extension manifest. Only a paired extension may answer that plugin's prompts (`replaces: prompt`), and only while the plugin is installed and enabled. The runtime reports the plugin through `snapshot.plugin`. The plugin keeps a working fallback when the extension is absent.

### 71. Library
- **Definition**: The curated collection of installable packages in `library/` with its pinned index. `clio-coder library install plugin:<name>` or `extension:<name>` installs one, `/library` browses it (including an Extensions tab), and `clio-coder library components` lists the components that installed and core packages provide, by kind.

### 72. Playbook
- **Definition**: A declared multi-step coordination workflow that the fleet runs, replacing what fleet contracts were called before 0.6.2. Its kind is `playbook`, a plugin carries playbooks under the resource key `playbooks`, and the directories are `playbooks/` in the library, the config directory, `.clio-coder/` and the builtins. `clio-coder playbook new|validate|graph|list|commands` authors and checks them, and `clio-coder fleet run <playbook>` or `/fleet run <playbook>` runs one. `clio-coder upgrade` converts an existing installation once.
- **Owning Type**: `Playbook` in the agents domain.

### 73. Component
- **Definition**: One discoverable unit a package or Clio itself provides: a skill, an agent, a prompt template or a playbook. A package holds components, and `clio-coder library components` reads them with their owner, origin and invocation.
