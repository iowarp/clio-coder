# Clio Coder

Clio Coder is a TypeScript/Node.js project. Coding agent for HPC and scientific-software developers, part of IOWarp's CLIO ecosystem of agentic science.

## Conventions

- Local imports end in `.js`. Tests use `node:test`. Avoid `any` without a tracking issue.

## Context retrieval

The codewiki currently indexes 901 source files. Start orientation with these indexed entry points: `src/cli/index.ts`, `src/domains/agents/index.ts`, `src/domains/components/index.ts`, `src/domains/config/index.ts`, `src/domains/context/bootstrap.ts`, `src/domains/context/index.ts`, `src/domains/dispatch/index.ts`, `src/domains/eval/index.ts`. Use `code_nav` (modes: entries, path, symbol) before broad reads when the task is navigational.

## Repository shape

Largest indexed areas: src/domains (382), tests/contracts (228), src/interactive (83), src/cli (48), src/tools (43), src/engine (40), src/core (35), benchmarks/community (9). Treat this as an orientation hint, not a complete file map; refresh the codewiki after structural edits.

## Verification expectations

Before handoff, run `npm run typecheck` and `npm run lint` for TypeScript and style checks. Run `npm run build` after CLI, worker, packaging, or generated-dist changes. Use targeted checks for narrower risk: `npm run test:contracts`, `npm run test:smoke`, `npm run check:boundaries`. Run `npm run test` when behavior crosses domains, tool contracts, smoke flows, or boundaries. Use `npm run ci` for the full local gate before committing broad or shared behavior changes.

## Context artifacts

`CLIO.md` is the versioned, human-owned project handbook and should be reviewed like source when intentionally changed. `.clio/codewiki.json`, `.clio/state.json`, `.clio/proposals/`, and `.clio/handoffs/` are ignored local context-engine artifacts. Do not commit `.clio/*` unless the user explicitly asks to force-add a shared artifact. `clio context init --propose` writes ignored drafts; `--apply` updates from the existing handbook; `--rewrite` generates a fresh handbook from repository structure and sibling context.

## Configuration lifecycle

`settings.yaml` is validated directly against the current schema. Lifecycle commands do not transform removed settings keys.

## Middleware

Middleware hook budgets are strictly phase aware through `DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS`.

## Providers

Provider authentication credentials are managed through `openAuthStorage()`.

## Model discovery CLI

`clio models` probes live targets by default. The `--offline` flag disables live probing. The former `--probe` and `--no-probe` flags are not supported.

## Remote marketplace cache

Remote marketplace cache files require explicit finite `listingTimestamp` and `detailTimestamp` fields. Invalid cache files are refreshed from the remote marketplace.

## Process-safe dispatch admission

- `src/domains/dispatch/capacity-lease.ts` is the durable, expiring global and per-node capacity authority. Lease acquisition, retry rebinding, heartbeat, drain state, and reservation transfer are serialized by one cross-process state lock. The lease bound fails admission closed rather than dropping a lease, and lease reclamation needs owner-liveness evidence wherever a process birth token cannot prove death.
- `setCapacityDraining` is the operator's machine-wide drain. It is TTL-bounded so an abandoned drain cannot wedge the host, and process shutdown never writes it; a shutting-down bundle drains its own admission controller instead.
- `src/domains/dispatch/admission-queue.ts` owns bounded deterministic priority/FIFO ordering, finite queue deadlines, cancellation, and reserved plan-peak admission. A plan slot belongs to an assignment rather than an attempt, so a retry never queues behind itself.
- Placement spreads work by durable lease usage read through `FleetRegistry.bindActiveWorkers`, then by declaration order. That preference is advisory: leases decide capacity under the lock, and a pinned node that is momentarily full is queued rather than refused.
- A retry rebinds its reservation member to the node and cost bound it actually resolved, so a costlier recovery route cannot escape the plan's aggregate ceiling.

## Dispatch routing intent

- `src/domains/dispatch/routing-intent.ts` strictly parses the model-facing routing object, applies shadow-balanced defaults, preserves exact route pins as fail-closed manual intent, and evaluates cost, deadline, quality, capability, and locality hard bounds.
- Plan artifacts and receipt integrity v11 seal normalized routing intent. Candidate envelopes remain coordinator-authored; route explanations are bounded projections of the sealed decision and never accept task text, prompts, endpoints, or credentials.

## Dispatch routing quality

- `src/domains/dispatch/route-quality.ts` is the pure reducer for integrity-valid receipt, gate, and eval evidence. Descriptive receipt verification never establishes routing quality.
- `src/domains/dispatch/route-history.ts` is the bounded durable estimator source. Receipt integrity v10 requires a run-local `quality` block; later gate and eval results link by authenticated receipt digest instead of mutating receipts.

## Strict agent recipes

- `src/domains/agents/recipe-schema.ts` is the only versioned frontmatter schema; malformed custom recipes are quarantined with `AgentsContract.diagnostics()` and builtins fail startup.
- `src/domains/agents/result-contract.ts` validates typed terminal contracts. Result conformance is sealed in receipt quality facts, while only correctness-bearing contracts can label routing quality.

## Worker runtime

Worker processes accept only WorkerSpec version 2 with a concrete `budget` block. Runtime budgets are inherited directly from the admitted worker specification.

## Execution plans and fleets

- `src/domains/dispatch/execution-plan.ts` compiles orchestration into the one deterministic, hashed `ExecutionPlan` DAG and computes capacity-bounded waves.
- `src/domains/dispatch/execution-scheduler.ts` performs whole-plan preflight and reservation before spawning, then admits dependency-ready waves with stop/continue semantics.
- Fleet contracts are strict version 1 DAGs with stable step ids, explicit dependencies, scopes, and `maxWorkers`; authenticated terminal outputs cross edges through bounded structured handoffs.
- Logical work is named by assignment id. Terminal attempts are named separately as terminal run ids; `dispatchBatch` has no `runIds` compatibility alias.

## Execution roles and quality gates

- `src/domains/dispatch/execution-role.ts` owns the one `ExecutionRole` union (`builder`, `reviewer`, `judge`, `researcher`, `verifier`, `recovery`), its derivation from strict recipe facts, the gate decider default, and the route correlation and independence policy.
- The role is required and typed on every dispatch request, ledger envelope, receipt, route candidate, plan task, route decision, and route-history key. Route statistics never mix roles, and any attempt after the first is `recovery`.
- Review and compete gates default to the builtin `verifier` and never fall back to the builder agent. Topology roles override recipe defaults, and a gate decider's postcondition is the gate result contract rather than its own recipe contract.
- Gate deciders answer typed contracts, not trailing prose. Review uses the Slice 2 `verifier-report`; `revise` is the coordinator's bounded continuation policy in `decideReviewGate`, not a verdict a model authors. Compete uses the judge gate-result schema in `src/domains/dispatch/gate-decisions.ts`.
- `GateDecisionArtifact` is v2 and seals route correlation across agent, target, model family, runtime, and node. Independence is a deterministic soft preference among already-eligible routes; it never bypasses a hard constraint or quality floor, and a correlated gate is reported rather than hidden.
- Every gate decision crosses the staged durable boundary (`stagePendingGateDecision` then `materializePendingGateDecision`); there is no direct compatibility writer.
