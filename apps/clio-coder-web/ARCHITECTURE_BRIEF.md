# Clio Coder web foundation: independent review brief

Status: input to an independent Claude Code architecture review and an executable sprint prompt. No application implementation is authorized by this brief itself.

## Operator intent and constraints

The operator approved exploring a unified Clio Coder web architecture and explicitly requested an independent second opinion from Claude Code **Fable 5.1 at xhigh effort**, running in the adjacent Herdr pane with `--dangerously-skip-permissions`. Astra remains the advisor and reviews the output with Fable.

The immediate deliverable is a specific, self-contained prompt file describing the full dependency-ordered sprint and the route to v0.5.0. Implementation will proceed session by session after this planning session. Do not interpret a complete roadmap as an instruction to implement it now.

Hard requirements from the operator:

- New application work belongs under `apps/`, outside the root harness `src/` tree.
- Respect the canonical CLI and TUI, and retain the existing, more experimental ACP. Do not turn their operation into a dependency on an HTTP daemon.
- The present workbench, standalone trace viewer, and docs server implementations are replaceable. The standalone trace viewer will be absorbed into the unified application and deleted when its useful capabilities are accounted for.
- There are zero users. Do not build migrations, legacy wire readers, compatibility aliases, state importers, or parallel implementations solely to support the old apps.
- The unified surface is provisionally named **Clio Coder**, with source under `apps/clio-coder-web/`. Recommend a consistent technical package/command name. Do not make naming a blocker.
- The app is intentionally separate and not included in every Clio installation today. Integration into the normal Clio installation, including REST API and web/desktop access, is a **v0.5.0 release milestone**, not a prerequisite for the first foundation slice.
- Build a maintainable, useful unified application, not a preservation exercise for current implementation choices. Reuse worthwhile code and behavior when it is actually simpler.
- Do not touch the coding team's unrelated work, change branches, reset, commit, push, or publish.

## Baseline and ownership

Repository: `/home/akougkas/iowarp/clio-coder`.

Branch: `v048`.

Initial committed baseline observed by Astra on 2026-09-11:

`1e1162f687a610f19f27a34495ad06251b237260` — `docs(providers): record cache policy and native gateway validation`.

The coding team may still advance `v048`. Record the exact SHA you inspect. Before finalizing, re-read HEAD and assess whether new commits affect the proposal. The final execution prompt must distinguish its reviewed SHA from the SHA used when a future session begins, and require relevant delta inspection rather than resetting work or claiming an unseen future commit was reviewed.

The pre-existing untracked `docs/architecture-managed-prefill-reuse.md` belongs to another workstream. Leave it alone. Planning artifacts in this new directory belong to this workstream.

## Astra's proposal to challenge

1. Use a Node.js Fastify backend and an app-owned, transport-independent application service layer. Workbench becomes a frontend client of this API.
2. Reuse suitable existing Clio domain functions/contracts for management and historical queries through narrow, explicit server-only adapters. Avoid invoking a CLI process for every inspection if an existing reusable boundary can provide the same behavior.
3. Keep live sessions in supervised `clio-coder acp` processes initially. The existing ACP server is deliberately one session per process and one canonical workspace. Do not assume the orchestrator can safely host many workspaces in one HTTP process.
4. Use REST for commands/queries, with SSE for event delivery initially. Consider WebSockets where justified, especially terminal transport. Do not adopt SSE just because Astra suggested it; evaluate session streaming, permission responses, reconnect, replay, and operation lifetimes against current behavior.
5. Use TypeBox plus versioned contracts and OpenAPI/client generation where that reduces duplication. Keep HTTP framework types outside business logic. Define event schemas separately.
6. Consolidate docs, tracing/evidence, toolchain inventory and installation, settings/targets, resources/library, fleet, and evaluations into a coherent app. Trace detail must be richer than the current summary inspector.
7. React and Vite are reasonable to retain. Evaluate routing and server-state management on merit. Frontend organization and state synchronization matter more than switching rendering frameworks without evidence.
8. Retire the Deno server/runtime for the new app, subject to an honest analysis of process APIs, testing, desktop delivery, and runtime/package consequences.
9. Preserve lazy CLI/TUI startup and the existing independent execution paths. At v0.5.0, ship version-matched prebuilt assets and a supported launch path with the canonical install. Do not introduce source-checkout-only assumptions into the release plan.
10. A toolchain inventory + installation + streamed progress page could be a useful first real vertical slice. Evaluate whether a docs or session slice belongs earlier.

## Critical tension to resolve, not gloss over

The operator requires application work outside root `src/`, while Astra's earlier proposal mentioned extracting shared services from CLI modules and eventually adding `clio-coder serve`. You must explicitly separate:

- App-owned implementation that can be completed now under `apps/` using already existing Clio seams.
- Minimal workspace/package integration outside `apps/` (for example the workspace lockfile), only when necessary and explicitly enumerated.
- Root harness or CLI/public-export changes that would require a separately scoped integration milestone. Do not silently put them in an apps-only foundation slice.

For each direct source reuse, state the exact existing seam, whether it is a public domain export or private implementation coupling, its transitive runtime requirements, how the app builds/runs from a clean checkout, and how it will evolve for installed-package use at v0.5.0. If no suitable seam exists, record that limitation and choose a deliberate bridge or deferred feature. Do not copy Clio business logic into a second harness.

Likewise, deleting/replacing `src/cli/docs.ts` or changing `src/cli/trace.ts` is a root integration action; app consolidation alone cannot honestly claim those code paths were removed.

## Source evidence and entry points

Read the actual current code. These are orientation hints, not immutable claims:

- `CLIO-CODER.md`, `docs/architecture/architecture.md`: project conventions and dependency direction.
- `package.json`, `pnpm-workspace.yaml`, `tsup.config.ts`, `scripts/check-release.mjs`, `scripts/release-manifest.json`: runtime, split command loading, package contents, release gates.
- `src/cli/docs.ts`: independent Node static server; HTML docs are currently checkout-only and excluded from npm.
- `apps/trace-viewer/server.mjs`, `apps/trace-viewer/public/`, its tests and README: SQLite reader, event cursor, trace/receipt/evidence capabilities to absorb.
- `src/cli/trace-inspect.ts`: current GUI projection is a deliberately small summary (eight runs, bounded phases and event aggregates), not a full trace explorer.
- `src/domains/observability/trace-store.ts`: existing durable reader/writer boundaries. Do not blindly expose arbitrary SQL or internal rows.
- `apps/workbench/main.ts`, `src/main.tsx`, `src/protocol.ts`, `clio-host.ts`, `acp-client.ts`, `clio-read-command.ts`, `clio-*-inspector.ts`.
- `apps/workbench/HARNESS_COVERAGE.md` and `PARITY.md`: useful ledgers, some historical; verify claims against code.
- The 13 `clio-*-inspector.ts` files currently total about 5,150 lines. They include useful validation/projection responsibilities as well as subprocess/transport costs. Do not promise all those lines disappear.
- `apps/workbench/artifact-allowlist.ts`: current snapshot-scoped ID restrictions; assess the better resource authorization and deep-link model for a clean app.
- `apps/workbench/deno.json`, `scripts/gui-lifecycle.ts`, tests and README: current build, Deno permissions, process supervision, desktop packaging and browser testing.
- `src/domains/toolchain/index.ts`, `contract.ts`, `install.ts`, `resolve.ts`, `registry.ts`, and `src/cli/tools.ts`: real inventory/install/remove operations; installer already supports progress messages.
- `src/engine/acp/server.ts` (single-session-per-process and workspace binding), `src/engine/acp/transport.ts`, `src/entry/orchestrator.ts` (process workspace and ACP boot), `src/cli/acp.ts`.
- Existing tests under `tests/contracts/` and `apps/workbench/tests/`: reference observable behavior, not a mandate to preserve legacy app protocol details.

Fastify official material already inspected by Astra: https://fastify.dev/, latest Type Providers and Testing guides, and official `@fastify/websocket` and `@fastify/swagger` repositories. Independently verify any runtime/library claim that drives the decision. Fastify speed marketing is not evidence of a Clio performance bottleneck.

## Required review deliverable

Write `apps/clio-coder-web/ARCHITECTURE_REVIEW.md` with:

- Your independent verdict: accept, amend, or reject each major recommendation, with specific reasoning and repository evidence.
- Two or three real architecture choices, the recommendation, and consequences for maintenance, frontends, session semantics, dependency count, packaging, and v0.5.0 integration.
- Resolve the apps-only boundary and classify necessary future harness seams explicitly.
- Decide a concrete app topology, contracts approach, transport, session/process ownership, event/reconnect model, operation lifecycle, error model, resource scope, and source/build/install boundaries. Mark uncertain points as bounded experiments with a decision rule.
- Assess which current capability/restriction should survive, which is obsolete legacy scaffolding, and which functionality must be added for full trace/docs absorption.
- Explain desktop intent honestly: browser launcher versus actual native shell, with no unverified cross-platform claim.
- Avoid speculative distributed infrastructure, migrations, compatibility layers, and introducing a new source of truth for Clio state.

## Required executable prompt deliverable

Write **`apps/clio-coder-web/SPRINT.md`**, the canonical file a fresh coding session can execute without this conversation. It must include:

- Exact reviewed baseline, operator constraints, accepted architecture, clear boundaries, and source-of-truth references.
- A concise v0.5.0 milestone map plus a dependency-ordered battle order of end-to-end slices. Distinguish apps-only work from final root/release integration.
- Each slice sized for one focused agent session, with real existing or explicitly proposed file paths, scope, dependencies, implementation direction, commands, observable acceptance criteria, and out-of-scope limits.
- Explicit per-session start/resume instructions, a progress ledger, and a default of implementing one ready slice then validating and handing off, not charging through the entire release roadmap.
- A green build at every cut point. Specify contract, HTTP, event/session, browser, and packaged-install checks where relevant. Distinguish current runnable commands from commands the slice will introduce.
- A coverage matrix for replacing workbench/trace/docs without accidentally dropping valuable features. No compatibility or state migration obligations to the old apps.
- Clear release acceptance for v0.5.0, including automatically available launch/access after normal install, supported platforms, version-matched assets/API, lazy startup, and source-checkout-independent verification. Publication itself is not authorized.
- A focused first slice that proves a useful end-to-end foundation and leaves a runnable app, rather than a horizontal scaffold with no observable behavior.

Do not implement application code in this planning task. You may write the two requested Markdown outputs. Independently investigate; Astra will review the files and send specific challenges for one or more revision rounds. When ready, report exact paths, key disagreements, baseline SHA, and open decisions in the pane.
