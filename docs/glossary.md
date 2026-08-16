# Clio Coder Glossary

This document defines core architectural concepts and terminology used throughout Clio Coder, mapped to their authoritative TypeScript type definitions in `src/`.

---

## Terms & Concept Definitions

### 1. Assignment
- **Definition**: The logical unit of work dispatched to the fleet. An assignment encapsulates the requested task, briefing, authority boundaries, and retry history across one or more concrete run attempts.
- **Owning Type**: `AssignmentRecord` in `src/domains/dispatch/types.ts`.

### 2. Run
- **Definition**: A concrete execution attempt of an assignment. Every run possesses a unique UUIDv7 identifier, an isolated event stream, a designated execution node, and a final cryptographically sealed receipt.
- **Owning Type**: `RunRecord` in `src/domains/dispatch/types.ts`.

### 3. Attempt
- **Definition**: A 1-based sequential retry index of a logical assignment. When a run fails due to retriable infrastructure errors, a new attempt is created while preserving historical attempt records.
- **Owning Type**: `AssignmentAttemptRecord` in `src/domains/dispatch/types.ts`.

### 4. Batch
- **Definition**: A durable collection of detached assignments created and tracked together under a single batch ID (`batches.json`).
- **Owning Type**: `BatchRecord` in `src/domains/dispatch/types.ts`.

### 5. Plan
- **Definition**: A multi-step directed acyclic graph (DAG) defining steps, dependencies, code validations, and budget ceilings approved by the operator before dispatch.
- **Owning Type**: `ExecutionPlan` in `src/domains/dispatch/types.ts`.

### 6. Receipt
- **Definition**: An immutable, cryptographically sealed record of a completed run containing full execution facts, tool telemetry, token accounting, validation grounding, and outcome codes.
- **Owning Type**: `RunReceiptV15` in `src/domains/dispatch/types.ts` (`RUN_RECEIPT_INTEGRITY_VERSION = 15`).

### 7. Envelope
- **Definition**: A bounded container enforcing byte-length limits, truncation indicators, and SHA-256 provenance on dynamic payloads (e.g. parent briefings and tool outputs).
- **Owning Type**: `ObservationEnvelope` in `src/tools/observation.ts`.

### 8. Phase
- **Definition**: A designated execution interval within a run (such as `warmup`, `prompt`, `tool_execution`, or `finalize`) recorded in the trace store.
- **Owning Type**: `PhaseRecord` in `src/domains/observability/trace-store.ts`.

### 9. Gate
- **Definition**: A validation or review barrier (such as a read-only reviewer verdict or a compete judge decision) determining whether candidate diffs are merged or revised.
- **Owning Type**: `GateDecision` in `src/domains/dispatch/types.ts`.

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
- **Definition**: An exact execution tuple composed of `{ agent, target, model, node }` evaluated by the active route planner for capability fit and cost readiness.
- **Owning Type**: `RouteTuple` in `src/domains/dispatch/types.ts`.

### 15. Posture (Autonomy Level)
- **Definition**: The active safety permission level governing tool mutation authority (`read-only`, `suggest`, `auto-edit`, `full-auto`).
- **Owning Type**: `AutonomyLevel` in `src/domains/safety/autonomy.ts`.

### 16. Capability Class
- **Definition**: The maximum permitted mutation boundary declared by an agent recipe (`read-only`, `verification`, `artifact-write`, `workspace-edit`).
- **Owning Type**: `AgentCapabilityClass` in `src/domains/agents/spec.ts`.

### 17. Topology
- **Definition**: The multi-agent structural orchestration pattern governing workflow execution (`singular`, `parallel`, `sequential`, `pipeline`, `detached`, `review`, `compete`, `auto`).
- **Owning Type**: `DispatchTopology` in `src/domains/dispatch/types.ts`.

### 18. Worker Block
- **Definition**: The attributed transcript segment rendering a worker's streaming execution. It includes a header with origin glyph and route, a rail for worker prose, coalesced tool names, and a one-line receipt footer.
- **Owning Type**: `WorkerEntryState` in `src/interactive/worker-stream.ts`.

### 19. Origin Glyphs (`◇`/`◆`)
- **Definition**: Transcript and fleet board indicators that identify who requested a run. The glyph `◇` marks operator-typed runs, `◆` marks model-requested dispatches, and a dim dot marks internal Clio runs.
- **Owning Type**: `WorkerRunOrigin` in `src/domains/session/entries.ts`.

### 20. Share Note
- **Definition**: A bounded operator note formatted as `[worker result] <agent> · run <id> · <outcome>` that delivers a finished worker answer into the main agent context over the user-turn path.
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
- **Definition**: A security boundary requiring explicit operator opt-in via `skills.trustProjectCompatRoots` before prompt templates or skills from project-scope foreign roots can execute or expand.
- **Owning Type**: `PromptTemplate` in `src/domains/resources/prompts/loader.ts`.
