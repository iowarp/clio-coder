# Clio Coder Glossary

This document defines the 50 core architectural concepts and terminology used throughout Clio Coder, mapped to their authoritative TypeScript type definitions in `src/`.

---

## Terms & Concept Definitions

### 1. Assignment
- **Definition**: The logical unit of work dispatched to the fleet. An assignment encapsulates the requested task, briefing, authority boundaries, and retry history across one or more concrete run attempts.
- **Owning Type**: `DurableAssignmentRecord` in `src/domains/dispatch/assignment-store.ts`.

### 2. Run
- **Definition**: A concrete execution attempt of an assignment. Dispatch creates a 12-character random base36 run identifier with `newRunId()`. Session ids use the same 12-character base36 generator, while appended session turn and entry ids use UUIDv7. Every run has an isolated event stream, a designated execution node, and a final cryptographically sealed receipt.
- **Owning Type**: `RunEnvelope` in `src/domains/dispatch/types.ts`.

### 3. Attempt
- **Definition**: A 0-based sequential retry index of a logical assignment. The first run of an assignment is attempt 0; a retry after a retriable infrastructure error increments it while preserving the earlier attempt's own run and receipt.
- **Owning Type**: `RunLineage.attempt` in `src/domains/dispatch/types.ts`.

### 4. Batch
- **Definition**: A durable collection of detached assignments created and tracked together under a single batch ID (`batches.json`).
- **Owning Type**: `DetachedBatchRecord` in `src/domains/dispatch/batch-store.ts`.

### 5. Plan
- **Definition**: A multi-step directed acyclic graph (DAG) defining steps, dependencies, code validations, and budget ceilings approved by the operator before dispatch.
- **Owning Type**: `ExecutionPlan` in `src/domains/dispatch/execution-plan.ts`.

### 6. Receipt
- **Definition**: An immutable, cryptographically sealed record of a completed run containing full execution facts, tool telemetry, token accounting, validation grounding, and outcome codes.
- **Owning Type**: `RunReceipt` in `src/domains/dispatch/types.ts` (`RUN_RECEIPT_INTEGRITY_VERSION = 20`).

### 7. Envelope
- **Definition**: A bounded container enforcing byte-length limits and truncation indicators on a dynamic payload. Tool output carries shown and total byte counts plus a continuation fragment; a parent briefing carries byte count and SHA-256 content hash instead.
- **Owning Type**: `Observation` in `src/tools/observation.ts` for tool output; `RunBriefingProvenance` in `src/domains/dispatch/types.ts` for briefings.

### 8. Phase
- **Definition**: A designated execution interval within a run. Every trace event and spend row is keyed to one `phaseId`, and the `phases` table is opened alongside `runs` for each operator turn.
- **Owning Type**: `TraceEventInput.phaseId` and the `phases` table in `src/domains/observability/trace-store.ts`.

### 9. Gate
- **Definition**: A validation or review barrier (such as a read-only reviewer verdict or a compete judge decision) determining whether candidate diffs are merged or revised.
- **Owning Type**: `GateDecisionArtifact` in `src/domains/dispatch/gate-decisions.ts`.

### 10. Recipe
- **Definition**: A versioned Markdown document declaring an agent's static persona, tool profile, execution capability class, cost ceilings, and result contracts.
- **Owning Type**: `AgentRecipe` in `src/domains/agents/recipe-schema.ts`.

### 11. Worker
- **Definition**: An isolated execution subprocess (or remote SSH worker) running a dedicated tool dispatch runtime and communicating over structured NDJSON socket channels.
- **Owning Type**: `WorkerSpec` in `src/worker/spec-contract.ts`.

### 12. Target
- **Definition**: A configured provider endpoint definition mapping a named identifier to an LLM provider runtime, base URL, authentication method, and default model.
- **Owning Type**: `TargetDescriptor` in `src/core/config.ts`.

### 13. Node
- **Definition**: An addressable physical or virtual compute host within the fleet capacity pool (`local` or remote SSH host).
- **Owning Type**: `FleetNodeSnapshot` in `src/domains/scheduling/cluster.ts`.

### 14. Route
- **Definition**: The complete execution candidate evaluated by the route planner for capability fit, readiness, and cost. Its operational identity includes agent, execution role, target, model, runtime, node, thinking level when present, tool and prompt composition, endpoint identity, and immutable spec/settings fingerprints.
- **Owning Type**: `RouteCandidate` in `src/domains/dispatch/route-decision.ts`.

### 15. Posture (Autonomy Level)
- **Definition**: The active safety permission level governing tool mutation authority (`read-only`, `suggest`, `auto-edit`, `full-auto`).
- **Owning Type**: `AutonomyLevel` in `src/domains/safety/autonomy.ts`.

### 16. Capability Class
- **Definition**: The maximum permitted mutation boundary declared by an agent recipe (`read-only`, `verification`, `artifact-write`, `workspace-edit`).
- **Owning Type**: `AgentCapabilityClass` in `src/domains/agents/spec.ts`.

### 17. Topology
- **Definition**: The multi-agent structural orchestration pattern governing workflow execution. Three unions spell it for three jobs. A compiled plan supports `parallel`, `sequential`, `pipeline`, `review`, `compete`, `council`, and `fleet`. A capacity reservation supports `parallel`, `detached`, `sequential`, `pipeline`, `review`, `compete`, and `council`. The dispatch-plan tool surface supports all eight values from those two sets. The operator-facing argument is spelled `mode`; `singular` (the one-task call shape) and `auto` are values of that argument, not topologies.
- **Owning Types**: `ExecutionPlanTopology` in `src/domains/dispatch/execution-plan.ts`, `ReservationTopology` in `src/domains/dispatch/reservation-store.ts`, `DispatchPlanTopology` in `src/tools/dispatch-plan.ts`.

### 18. Worker Block
- **Definition**: The attributed transcript segment rendering a worker's streaming execution. It includes a header with origin glyph and route, a rail for worker prose, coalesced tool names, and a one-line receipt footer.
- **Owning Type**: `WorkerEntryState` in `src/interactive/worker-stream.ts`.

### 19. Origin Glyphs (`◇`/`◆`)
- **Definition**: Transcript and fleet board indicators that identify who requested a run. The glyph `◇` marks operator-typed runs, `◆` marks model-requested dispatches, and a dim dot marks internal Clio runs. Transcript worker entries admit only user and agent origins; internal runs can appear on dispatch surfaces but never become transcript worker entries.
- **Owning Types**: `WorkerRunOrigin` in `src/domains/session/entries.ts` for transcript entries; `DispatchRequestOrigin` in `src/domains/dispatch/types.ts` for user, agent, and internal dispatches.

### 20. Share Note
- **Definition**: A bounded operator note formatted as `[worker result] <agent> · run <id> · <outcome> · shared by the operator` that delivers a finished worker answer into the main agent context over the user-turn path.
- **Owning Type**: `WorkerShareFacts` in `src/interactive/worker-share.ts`.

### 21. Fold
- **Definition**: Collapsing an expanded tool call or worker block down to a single-line summary row. Toggled for the newest foldable item with `Alt+O` or for all items with `Ctrl+Alt+O` / `Alt+Shift+O`.
- **Owning Type**: `WorkerEntryRenderOptions` in `src/interactive/renderers/worker-entry.ts`.

### 22. Interop
- **Definition**: The domain governing discovery, compatibility roots, and delegation wiring for other coding agents installed on the local machine and in the repository.
- **Owning Type**: `InteropContract` in `src/domains/interop/contract.ts`.

### 23. Consent Record
- **Definition**: A persistent state entry recording the operator's decision to accept or decline an interop agent proposal, written atomically under `interop.json`.
- **Owning Type**: `InteropAgentRecord` in `src/domains/interop/types.ts`.

### 24. Fingerprint
- **Definition**: A SHA-256 digest of stable agent facts (including binary path, version, and launch recipe) that keys consent records so standing decisions stay valid until facts change.
- **Owning Type**: `InteropAgentFacts` in `src/domains/interop/types.ts`.

### 25. noWritePaths
- **Definition**: A damage-control path policy class that permits reads while blocking writes and deletes under every registered foreign agent directory across all autonomy levels.
- **Owning Type**: `PathPolicyKind` in `src/domains/safety/path-policy.ts`.

### 26. Foreign Prompt Root
- **Definition**: An external prompt directory owned by another coding agent (such as `.claude/commands` or `.codex/prompts`) from which Clio loads prompt templates.
- **Owning Type**: `PromptTemplateRoot` in `src/domains/resources/prompts/loader.ts`.

### 27. Compat Root
- **Definition**: A compatibility directory for prompts or skills discovered from foreign agent installations, ranked below native Clio resource roots.
- **Owning Type**: `ResourceSourceInfo` in `src/domains/resources/collision.ts`.

### 28. Trust Gate
- **Definition**: A security boundary requiring explicit operator opt-in via `integrations.projectResources.trustProjectImports` before prompt templates or skills from project-scope foreign roots can execute or expand.
- **Owning Type**: `PromptTemplate` in `src/domains/resources/prompts/loader.ts`.

### 29. Fleet
- **Definition**: The set of addressable nodes Clio may place work on, `local` plus every configured SSH host, together with their capacity accounting. `fleet` is also the topology of a plan compiled from a fleet contract.
- **Owning Types**: `FleetNodeSnapshot` in `src/domains/scheduling/cluster.ts` for capacity; `FleetContract` in `src/domains/agents/fleet-contract.ts` for the declared multi-step workflow.

### 30. Dispatch
- **Definition**: Sending one unit of work to a worker: the domain that resolves recipe, target, model, and node, admits the request against authority, spawns the worker, and seals the receipt. It is the `dispatch` tool, the `/run` slash command, and `src/domains/dispatch/`.
- **Owning Type**: `DispatchRequest` in `src/domains/dispatch/contract.ts`.

### 31. Run Ledger
- **Definition**: The durable dispatch run list at `runs.json` in the state directory, retention-capped by `fleet.history.maxRuns`. It is what the fleet board, `clio-coder fleet status`, and eval linking read.
- **Owning Type**: `RunEnvelope` in `src/domains/dispatch/types.ts`, persisted by `src/domains/dispatch/state.ts`.

### 32. Agent Ledger
- **Definition**: The append-only progress log a worker writes for itself through the `ledger` tool, mirrored to the orchestrator over the control lane and persisted in `agent-ledgers.json`. Live subscribers are tracked in memory by the ledger hub.
- **Owning Type**: `AgentLedgerEntry` in `src/worker/protocol.ts`, stored by `src/domains/dispatch/agent-ledger-store.ts`.

### 33. Session Ledger
- **Definition**: The JSONL record of one session's turns, written per session and referenced by eval artifacts as `sessionLedgers`. It is what `/resume`, `/fork`, and replay read.
- **Owning Type**: `SessionEntry` in `src/domains/session/entries.ts`.

### 34. Task Ledger
- **Definition**: The persisted form of the session task board: goals, subgoals, and the run ids in flight when the snapshot was folded. One session entry kind, distinct from the board that renders it.
- **Owning Type**: `TaskLedgerEntry` in `src/domains/session/entries.ts`.

### 35. Context Ledger
- **Definition**: The accounting of how the model's context window is spent and the input to compaction decisions. Current buckets are `system`, `tools`, `agents`, `skills`, `memory`, `project`, `messages`, `pending`, `reserve`, `free`, and `streaming`.
- **Owning Type**: `ContextLedgerCategory` in `src/domains/session/context-ledger.ts`.

### 36. Dispatch Board
- **Definition**: The live fleet view: one row per in-flight or recently finished run, carrying origin glyph, route, status, and the steer and cancel affordances.
- **Owning Type**: `DispatchBoardRow` in `src/interactive/dispatch-board.ts`.

### 37. Task Board
- **Definition**: The operator-facing goal and subgoal checklist for the session. It renders from a snapshot and persists as a task ledger entry, so the UI noun and the wire format are deliberately named differently.
- **Owning Type**: `TaskBoardSnapshot` in `src/domains/session/task-board.ts`.

### 38. Dashboard
- **Definition**: The startup and footer panels summarizing targets, session, and spend. Not a board in the dispatch or task sense; it holds no rows a run or a goal maps to.
- **Owning Type**: `WelcomeDashboardStats` in `src/interactive/welcome-dashboard.ts`.

### 39. Handbook
- **Definition**: `CLIO-CODER.md`, the human-owned, version-controlled project context file at the repository root: project name, one-line description, conventions, hard invariants, and optional sections, closed by a fingerprint comment.
- **Owning Type**: `ParsedClioMd` in `src/domains/context/clio-md.ts`.

### 40. Delegate
- **Definition**: Another coding agent Clio drives over ACP stdio as if it were a worker, configured under `integrations.externalAgents.entries` and invoked with `/delegate`. A delegate is a foreign harness, not a model target.
- **Owning Type**: `DelegationAgentConfig` in `src/core/defaults.ts`.

### 41. Working Set
- **Definition**: The part of the session ledger the model receives on the next request. It is the ledger with the current eviction projection applied, and it exists only in memory; the ledger itself is never narrowed. Not to be confused with the context ledger, which is the accounting of how the window is spent.
- **Owning Type**: `WorkingSetView` in `src/domains/context/working-set/contract.ts`.

### 42. Projection
- **Definition**: The pure, idempotent transform from ledger entries to the entries the replay builder hands the model. It substitutes markers for evicted bodies and drops thinking from closed turns, returning unaffected entries by reference. Nothing about it is persisted.
- **Owning Type**: `projectWorkingSet` in `src/domains/context/working-set/project.ts`.

### 43. Eviction
- **Definition**: The decision that a tool-result body or an assistant turn's thinking leaves the working set, recorded as an append-only ledger entry with a typed reason. It removes nothing: the original entry stays in the ledger and stays visible in the transcript, `/resume`, `/fork`, and the HTML export.
- **Owning Type**: `ContextEvictionEntry` in `src/domains/session/entries.ts`.

### 44. Recall
- **Definition**: Readmitting an evicted body by ref, through `context(scope="recall", ref=...)` for the model or `/context recall <ref>` for the operator. A recall does not un-evict: the marker stays where it was so the provider prefix cache is untouched, and repeated recalls of one ref are the churn signal.
- **Owning Type**: `ContextRecallEntry` in `src/domains/session/entries.ts`; resolution in `resolveRecall` in `src/domains/context/working-set/recall.ts`.

### 45. Marker
- **Definition**: The byte-stable one-line stub the projection renders in place of an evicted body, naming the ref, the reason, the tool, the size, and the exact recall call. It carries no timestamp and no counter, because a marker whose bytes drifted between renders would cold-start the prefix cache on a turn that evicted nothing new.
- **Owning Type**: `renderMarker` in `src/domains/context/working-set/marker.ts`.

### 46. Canonical Trust Status
- **Definition**: The six-axis record of what is known about one run: artifact integrity, validation grounding, independent review, context provenance, autonomy enforcement, and completion evidence. It is an algebra, not a score: no axis promotes another, every non-absent state names its source and authority, and `absent`, `unknown`, and `not_applicable` are states in their own right. See [docs/architecture/evidence-and-memory.md](../architecture/evidence-and-memory.md#canonical-trust-status) for the full state table.
- **Owning Type**: `CanonicalTrustStatus` in `src/domains/evidence/trust-status.ts`.

### 47. Trust Projection
- **Definition**: The one rendering of the canonical trust status every operator surface prints. The compact human line answers who claims the result, what was observed, what was independently checked, and what is still unknown, in six fixed clauses (`sealed; grounded by host-verification; not independently reviewed; mediated; context recorded; completion evidenced`). The machine projection is the same answer as a bounded, versioned record with references to the detailed artifacts. Dispatch and monitor output, `evidence inspect`, `findings.md`, the Alt+W board, the receipt view, the eval bridge, and the ACP wire all print from it.
- **Owning Type**: `formatTrustSummary` and `TrustSummaryProjection` in `src/domains/evidence/trust-projection.ts`.

### 48. Trust Verdict
- **Definition**: The presentation tier read off the axes in a fixed order, used for styling and sorting and never as a score. `reviewed` requires an authenticated independent pass and is the only tier styled as independently verified. `grounded` is observed validation without independent review. `unverified` is a sealed receipt with nothing observed. `compromised` is a broken seal, a bypassed gate, a failed or inferred validation, a failed or correlated review, or a contradictory context record. `unknown` is an unchecked or missing seal.
- **Owning Type**: `TrustVerdict` and `trustVerdict` in `src/domains/evidence/trust-projection.ts`.

### 49. Trust Vocabulary
- **Definition**: The standardized word for each canonical state, so the same fact is never spelled two ways. `sealed` means the receipt authenticated against the ledger row; it says nothing about correctness. `grounded` means validation was observed to run and pass, named by its claimant (`host-verification`, `validation-tool`, `receipt-quality`, `evidence-grounding`). `independently reviewed` means an authenticated reviewer that was not the run itself recorded a verdict. `inferred` means the worker claimed validation and nothing was observed to have run. `mediated` is the word for the `enforced` autonomy state: Clio's own safety gate mediated the run. `approximated` and `bypassed` name an external runtime's enforcement, always with the runtime's id. `unknown` means a named source could not answer; `not applicable` means a named authority decided the axis does not apply.
- **Owning Type**: `TRUST_STATE_WORDS` in `src/domains/evidence/trust-projection.ts`.

### 50. Commonly Confused Trust States
- **Definition**: `sealed` is not `grounded`: a receipt can authenticate perfectly and describe a run that validated nothing. `grounded` is not `independently reviewed`: a host check is Clio observing the run's own declared command, not a second agent judging the result. A `host checks verified` unit on the board is folded into validation grounding and is never independent review. `mediated` and `enforced` are one state under two names, the receipt grade and the canonical id. `not_requested` is not a trust state at all; a run with no host check reads `no validation observed`. `completion unevidenced` (a mutation finished with no validation at the completion boundary) is distinct from `no validation observed` (no validation was linked anywhere in the run): the first is the finish contract's observation, the second the evidence linker's.
- **Owning Type**: `TRUST_STATE_WORDS` and `trustVerdict` in `src/domains/evidence/trust-projection.ts`; the axis states in `TRUST_STATUS_STATES` in `src/domains/evidence/trust-status.ts`.
