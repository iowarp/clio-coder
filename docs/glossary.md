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
