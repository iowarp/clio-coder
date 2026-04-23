# Post-v0.1 Directions — NAT Distillation

- **Status:** Distillation (not a plan, not a spec)
- **Date:** 2026-04-17
- **Author:** akougkas (Anthony Kougkas) + Claude (Opus 4.7, ultrathink session)
- **Repo:** `~/projects/iowarp/clio-coder`
- **External reference:** NVIDIA NeMo Agent Toolkit (`nvidia-nat`), https://github.com/NVIDIA/NeMo-Agent-Toolkit
- **Scope:** Architectural wisdom extracted from NAT, framed as directional input for Clio's roadmap beyond v0.1. Not a porting plan. Not a todo list. A reference for future sessions choosing what to build and why.

---

## Framing

Clio-coder is a reincarnation of pancode, not a fork. Pancode IP ports through a parallel workstream handled by dedicated sessions. This document is separate. It captures what NAT teaches about the shape of a mature agent orchestrator, with Clio's current architecture as the target for that wisdom. Implementation decisions for any specific idea remain for future Claude Code sessions.

NAT is the NVIDIA production-scale, Python-first, server-native agent platform. It has shipped through enterprise deployment and covers a surface wider than Clio plans to reach. Its architecture choices encode lessons that are directly relevant to Clio's roadmap beyond v0.1 even though no NAT code is (or should be) consumed by Clio.

---

## Table of Contents

1. One-line thesis
2. Twelve distilled lessons
3. Directional implications by phase
4. What NAT validates about Clio's existing architecture
5. Durable differentiators Clio must protect
6. Explicit non-goals extracted from NAT
7. Handoff

---

## 1. One-line thesis

NAT is the mirror-image instantiation of the same "core + plugins + typed config" pattern Clio is building, at a scale that validates the pattern, in a lane (Python, server, enterprise) that does not compete with Clio's lane (TypeScript, terminal, scientific reproducibility). The distilled wisdom is therefore architectural, not competitive.

---

## 2. Twelve distilled lessons

### 2.1 Graph-level workflow optimization via static analysis

NAT ships `nvidia-nat-app` as a graph-analysis package separate from the runtime. It reads function signatures for read/write state, classifies edges as necessary or unnecessary, computes parallel execution stages, applies constraints, and supports speculative branching. The lesson: agent dispatch is not inherently flat. A planner that reads agent I/O contracts can derive the dependency graph and schedule execution without the user writing chain/parallel/batch syntax manually.

This is the single highest-leverage idea from NAT for Clio. The `intelligence/` domain is scaffolded today precisely to wake up around a planner of this shape. The target is not to copy NAT's algorithm but to validate the approach: agent metadata (reads, writes, effects) plus a static analyzer yields an execution plan. Reference: `packages/nvidia_nat_app/src/nat_app/api.py`.

### 2.2 Evaluation as first-class runtime, not test theater

NAT has a complete evaluation subsystem: ATIF support, dataset loaders, runtime evaluators, profiling with bottleneck analysis, token metrics, forecasting, concurrency analysis. Evaluators are plugins that subscribe to the same extension points as production components. The lesson: for a platform whose thesis is reproducibility, evaluation belongs inside the architecture, not bolted on later.

Clio's current verification story is receipts + cost + inline scripts. For scientific workloads that is insufficient at maturity. A future `domains/evaluation/` with evaluator contracts at the per-run, per-agent, and per-suite granularity is the direction. Reference: `packages/nvidia_nat_eval/`, `packages/nvidia_nat_profiler/`.

### 2.3 Observability as plugins, not baked into the core

NAT emits telemetry events in the runner; exporters register in the observability domain. OpenTelemetry, Phoenix, Weave, LangSmith, Data Flywheel each live in separate packages and each subscribe via `register.py`. The core does not depend on any exporter. The lesson: when Clio needs external observability (facility deployments, research groups with OTEL endpoints, managed tracing), the extension shape is subscriber-of-runtime-events, not modified-runner.

Clio's `domains/observability/` already owns receipts and cost. The pattern to formalize is the event-bus subscriber contract: exporters should hook `SafeEventBus` events and translate, not call into the runner directly. Reference: `packages/nvidia_nat_core/src/nat/observability/register.py`.

### 2.4 Middleware chain for cross-cutting concerns

NAT wraps function calls with middleware: cache, defense, dynamic behavior, logging, red teaming, timeout. The builder applies middleware once; every function call inherits it. The lesson: cross-cutting tool-call concerns are a named architectural layer, not scattered conditionals.

Clio's safety gate (action classifier before every tool call) is already middleware-shaped. The direction: formalize a `ToolCallMiddleware` contract as a domain extension so future interceptors (timeout, rate limit, cache, recording) drop in at the registry level without touching dispatch or safety. Reference: `packages/nvidia_nat_core/src/nat/middleware/register.py`.

### 2.5 Front ends are plugins, not the runtime

NAT has console, FastAPI, MCP, A2A, and FastMCP front ends. The runtime doesn't know which drives it. The lesson: even a TUI-first product should treat the TUI as one front end among potential peers, not as the runtime itself.

Clio's `src/interactive/` is the TUI front end today. The design spec plans headless mode for v0.3 and a REST daemon for v1.0. The direction: keep `interactive/` as the front-end directory, not as the runtime layer. Future `headless/` and `daemon/` are peers, not rewrites. Reference: `packages/nvidia_nat_core/src/nat/front_ends/register.py`.

### 2.6 Per-user workflow isolation is the multi-tenancy shape

NAT's `PerUserWorkflowBuilder` lazily instantiates per-user components, isolates them, and cleans them up on inactivity. Shared components (read-only catalogs, provider pools) and per-user components (session, memory, credentials) are distinguished at the builder level. The lesson: multi-tenancy is a build-time distinction in the component graph, not a runtime flag bolted onto a single-user assumption.

Clio is single-user local today. If facility shared-host deployment ever lands, this pattern is the reference. Do not retrofit multi-tenancy onto the single-session orchestrator. Fork the builder. Reference: `packages/nvidia_nat_core/src/nat/builder/per_user_workflow_builder.py`.

### 2.7 Framework adapters as worker tier, not engine

NAT wraps the same function into LangChain, LlamaIndex, CrewAI, Semantic Kernel, Google ADK, Agno, AutoGen, Strands tool surfaces. The operation is not "swap the engine"; it is "adapt the function to the target framework." The engine stays the same. The lesson: Clio's SDK/CLI worker tiers map onto this pattern. The worker is the unit of adaptation; the function or tool is preserved across targets.

When v0.2 admits the SDK tier (Claude Agent SDK subprocess) and the CLI tier (pi-coding-agent, claude-code, codex, gemini, opencode, copilot), NAT's `framework_enum.py` plus per-package adapter `register.py` is the structural reference. One agent spec, multiple adapter targets.

### 2.8 Auth extraction from runtime context, not startup config

NAT resolves user identity at request time from session cookies, Authorization header, or X-API-Key. Identity flows through to the WorkflowBuilder rather than being a boot-time static. The lesson: identity is a runtime concept. Baking it into settings.yaml at startup limits the platform to single-user.

Clio is single-user today; identity is implicit (OS user). The direction: if `domains/auth/` is ever added, the contract should be "resolve identity from request context," not "load identity from config." Reference: `packages/nvidia_nat_core/src/nat/runtime/user_manager.py`.

### 2.9 Typed YAML config as the hub, with versioned blocks

NAT's config covers functions, function_groups, llms, embedders, memory, object_stores, retrievers, middleware, authentication, front_ends, evaluators, logging, tracing, ttc_strategies, trainers, trainer_adapters, trajectory_builders. Each block is typed, extensible, additive. The lesson: typed YAML is the right hub for a plugin-heavy platform, and versioned migration is how it stays compatible.

Clio uses TypeBox-validated YAML already. The direction is continuity: keep the convention, keep adding blocks (Phase 12 adds `compaction`, future phases will add `evaluation`, `tracing`, `mcp`), and keep the migration discipline established by the session v1→v2 migration. Reference: `packages/nvidia_nat_core/src/nat/data_models/config.py`.

### 2.10 WorkflowBuilder → SessionManager → Runner is the canonical pipeline

NAT's execution flow is: CLI load → config validation → (shared) WorkflowBuilder or (shared + per-user) PerUserWorkflowBuilder → SessionManager → Runner. Three distinct layers. Each owns its responsibility. The lesson: composition (what components exist), lifecycle (how sessions spawn), and execution (how turns run) are three separable concerns.

Clio's composition root is `src/entry/orchestrator.ts`. Session management is split across `src/engine/session.ts` and `src/domains/session/`. Execution runs through the chat loop and worker spawn. The direction: keep the three concerns visibly distinct as Clio grows. Resist collapsing them when they look short.

### 2.11 Test-time compute as a strategy layer

NAT has an experimental TTC subsystem with strategies for search, scoring, selection, editing, and orchestration. Each strategy is pluggable. Inference-time reasoning is not a model feature; it is an orchestration layer. The lesson: when one agent needs to produce N candidates, rank them, and pick a winner, the TTC abstraction is the correct architectural shape, not a bespoke loop.

For Clio's scientific-coding specialization (for example generating N candidate numerical implementations, ranking by numerical stability, selecting the best) TTC is a future fit. Reference: `packages/nvidia_nat_core/src/nat/experimental/test_time_compute/register.py`.

### 2.12 Plugin registry pattern validates Clio's manifest approach

NAT uses Python entry points for runtime plugin discovery. Any installed package that declares `nat.plugins.*` entries is picked up automatically. Clio uses build-time manifests with topological sort. Both work. The tradeoff: entry points allow frictionless third-party extension; manifests give build-time type safety and boundary enforcement. The lesson: Clio's choice is not worse. It is tuned for a different priority (safety discipline, reproducibility) and NAT's scale proves the general pattern.

When Clio opens to third-party plugins (v1.0+ agent marketplace), a userspace plugin manifest (`.clio/plugins/manifest.yaml` discovered at boot) can give entry-point-like ergonomics without abandoning the manifest-topology model. Reference: `packages/nvidia_nat_core/src/nat/runtime/loader.py`.

---

## 3. Directional implications by phase

| Phase | Wisdom to apply | Priority |
|---|---|---|
| v0.2 | Middleware contract formalization (§2.4); front-end boundary discipline (§2.5); framework-adapter shape for SDK/CLI worker tiers (§2.7); config-block versioning pattern (§2.9) | High |
| v0.3 | Observability exporter plugin pattern (§2.3); evaluation domain scaffolding (§2.2); graph-level planner prototype in intelligence domain (§2.1) | High |
| v1.0+ | Per-user workflow isolation if facility deployment arrives (§2.6); auth identity-at-request-time (§2.8); TTC strategy layer for scientific specialization (§2.11); third-party plugin manifest (§2.12) | As demand surfaces |

Phase 12 is unaffected. Session compaction is orthogonal to everything above.

---

## 4. What NAT validates about Clio's existing architecture

- **13-domain decomposition with manifests.** Matches NAT's plugin-registry decomposition. Both converge on "core stable, components plug in."
- **Typed YAML config with TypeBox validation.** Matches NAT's first-class config pattern; additive blocks are the right evolution surface.
- **Subprocess-only dispatch.** NAT runs everything through builder/runner and does not privilege in-process execution; validates Clio's locked decision to remove the dual in-process path structurally.
- **SafeEventBus for cross-domain traffic.** NAT's event-driven observability exporters depend on exactly this pattern. The event bus as the cross-cutting backbone is proven correct at scale.
- **Agent specs as markdown + YAML frontmatter.** NAT encodes component metadata similarly (decorators + config). The frontmatter approach is user-friendly without sacrificing typing.
- **Level 3 pi-mono engine boundary.** NAT vendors no agent framework into its core; framework adapters are packages. Clio's equivalent (engine as sole pi-mono import boundary) is the same structural instinct.

---

## 5. Durable differentiators Clio must protect

NAT's surface is wider; Clio's is deeper. Where Clio already leads, the lead must be preserved as Clio's roadmap expands.

- **Mode-gated tool admission at the registry level.** The model never sees forbidden tools. NAT's middleware red-teaming is softer than this.
- **SHA-256 prompt fragment hashing in every audit record.** Reproducibility is structural, not suggestive. NAT has no equivalent.
- **Damage-control bash patterns.** Hardcoded kill-switches for `rm -rf /`, `git push --force main`, raw `dd` writes. NAT has no equivalent.
- **Multi-phase shutdown (DRAIN → TERMINATE → PERSIST → EXIT).** Safe worker termination with state preservation. NAT has middleware timeout but no orchestrator-level shutdown protocol.
- **Receipts with ledger hash verification.** `/receipt verify <id>` is a unique audit surface. NAT's profiling exports metrics; it does not produce verifiable receipts.
- **Single disciplined TUI with slash commands, overlays, dispatch board.** NAT's console front end is basic. Clio's terminal fluency is a differentiator for the scientific-coding user base.
- **XDG + CLIO_HOME isolation for dev vs prod state trees.** NAT has no equivalent; it assumes server deployment. Clio's isolation discipline matters for HPC and research users who need dev/prod separation on a single host.
- **Fragment-based prompt compilation with deterministic hashing.** Every compiled prompt is reproducible. NAT composes prompts imperatively without hash discipline.

---

## 6. Explicit non-goals extracted from NAT

These are deliberately NOT adopted even though NAT has them.

- **Python or FFI bridge.** TypeScript and Node are Clio's runtime. No bridge, no vendoring.
- **Entry-point plugin loading.** Build-time manifest topology with boundary checks wins for Clio's safety discipline.
- **Breadth-match.** NAT has 20+ framework adapters, 10+ observability exporters, 5+ memory backends, 4+ object stores. Clio is deep, not wide. Matching breadth destroys focus and contradicts the locked design decision for a single TUI on a pi-mono engine.
- **A2A before MCP.** NAT supports both. Clio ships MCP first (v0.2 roadmap), then evaluates A2A based on actual interop demand rather than NAT's presence.
- **Fine-tuning and TTC as core features.** Both are first-class in NAT. For Clio they remain deferred beyond v1.0 unless scientific specialization demand surfaces them.
- **Multi-user server before v1.0.** NAT has it. Clio does not need it until facility deployment makes it unavoidable. Retrofitting multi-tenancy into a single-session runtime is negative ROI; the `PerUserWorkflowBuilder` pattern exists for when the requirement is real.
- **Swappable agent frameworks as engines.** NAT adapts to LangChain, LlamaIndex, CrewAI, and others by treating them as function adaptation targets. Clio owns its agent loop via pi-mono L3 and treats external agents as worker subprocesses (CLI tier). Do not invert this.
- **LLM-callable config.** NAT exposes config manipulation through the runtime for some workflows. Clio's locked security invariant is TUI-first config with no LLM-callable config tools. Not negotiable.

---

## 7. Handoff

Pancode IP porting is a parallel workstream tracked under its own phase plans. That work carries forward the known-good patterns already invented in pancode (dispatch primitives, worktree isolation, run ledger, intent detector, solver, learner, agent teams) without guidance from this document.

This document feeds the post-v0.1 direction conversation with NAT-sourced architectural wisdom. It does not prescribe implementation. The session that chooses to act on any lesson here owns the implementation decision, informed by the Clio domain structure, the three hard invariants, and the locked decisions in the v0.1 design spec (`docs/specs/2026-04-16-clio-coder-design.md`).

When future sessions compare a proposal against this document, the test is: does this capture something NAT gets right that Clio would benefit from once the prerequisites are in place? If yes, proceed. If no, the idea either belongs elsewhere (pancode port, new invention, or out of scope) or does not belong at all.
