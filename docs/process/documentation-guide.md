# Documentation Standards and Codebase Alignment

Clio Coder is an experimental community alpha. Documentation should help contributors and early users work from the source of truth without overstating maturity. When docs drift, prefer the current source and tests over older prose or aspirational roadmap notes.

---

## Source-first documentation rule

Before changing public docs, inspect the relevant implementation:

1. `git log --oneline -- <area>` for recent intent and release context.
2. `src/**` for current behavior.
3. `tests/**` for executable contracts and edge cases.
4. `README.md`, `CHANGELOG.md`, and `docs/**/*.md` for existing public wording.

Classify claims clearly:

| Claim class | How to word it |
| --- | --- |
| Shipped and tested | State directly and link to source/tests. |
| Implemented but experimental | Say alpha/experimental and name sharp edges. |
| Typed contract exists, default runtime is inert | Say the schema exists but no public loader/rules are active. |
| Planned/future | Put in roadmap language; do not present as available behavior. |

---

## Documentation map

| Guide | Primary source references | What it should cover |
| --- | --- | --- |
| [README.md](../../README.md) | `CHANGELOG.md`, package metadata, release receipts | Product overview, install, first run, alpha framing, and release status. |
| [docs/README.md](../README.md) | This docs directory | Documentation hub. |
| [documentation-guide.md](documentation-guide.md) | `docs/**`, `src/**`, `tests/**` | Documentation structure, source ownership, writing rules, and rendering policy. |
| [commands-and-modes.md](../guide/commands-and-modes.md) | `src/cli/index.ts`, `src/cli/args.ts`, `src/interactive/slash-commands.ts`, `src/domains/dispatch/**` | CLI commands, headless run flags (`--session`, `--continue`, `--json-events`), session continuity, `--json` wire projection promise, slash commands, keybindings, live steering. |
| [context-engine.md](../architecture/context-engine.md) | `src/domains/context/**`, `src/domains/session/context-accounting.ts`, `src/domains/session/context-ledger.ts`, `src/domains/session/compaction/` | Context window resolution, per-model probe capabilities, token accounting, snapshots, the three compaction mechanisms, model-driven `clio-coder context init`, format v4 session enforcement. |
| [context-working-set.md](../architecture/context-working-set.md) | `src/domains/context/working-set/**`, `src/domains/session/entries.ts`, `src/interactive/turn-context.ts` | Working-set vocabulary, eviction as a projection, the `contextEviction` / `contextRecall` records, the marker contract, the `age-horizon` and `structural-v1` policies, recall semantics, and the operator surfaces. |
| [architecture.md](../architecture/architecture.md) | `tests/boundaries/check-boundaries.ts`, `src/core/domain-loader.ts`, `src/engine/**`, `src/worker/**` | Source layout, six enforced boundary rules, runtime flow mermaid diagram, event and audit model, and detect-and-rollback write boundaries. |
| [time-conventions.md](../architecture/time-conventions.md) | `src/domains/dispatch/code-step.ts`, `src/domains/dispatch/extension.ts`, `src/domains/session/**`, `src/domains/observability/**` | Monotonic durations, wall-clock instants, anchored spans, injected clocks, timeout accounting, and timestamp serialization. |
| [dispatch-architecture-rationale.md](../architecture/dispatch-architecture-rationale.md) | `src/domains/dispatch/**`, `tests/boundaries/check-boundaries.ts` | Design rationale, not behavior: invariants that cross the seams a dispatch split would use, what any future split must preserve, and the closed barrel-import decision. |
| [dispatch-typed-intent.md](../architecture/dispatch-typed-intent.md) | `src/domains/dispatch/intent.ts`, `src/domains/dispatch/intent-compatibility.ts`, `src/domains/dispatch/path-scope.ts`, `src/tools/dispatch-plan.ts` | Dispatch intent v2, path provenance, legacy inference, retirement telemetry, and fail-closed version handling. |
| [configuration-and-targets.md](../guide/configuration-and-targets.md) | `src/core/defaults.ts`, `src/core/config.ts`, `src/domains/providers/**`, `src/cli/configure.ts`, `src/cli/targets.ts`, `src/cli/models.ts`, `src/cli/auth.ts` | TargetDescriptor, contextWindowProvenance (`configured`, `discovered`, `catalog`, `runtime-default`), settings.yaml, strict validation, saved defaults vs live routing. |
| [artifact-placement.md](../architecture/artifact-placement.md) | `src/core/artifact-paths.ts`, `src/core/config.ts`, `src/domains/agents/result-contract-filesystem.ts` | Audience-based artifact placement, configured output roots, containment, and migration from legacy paths. |
| [configuration-reference.md](../guide/configuration-reference.md) | `src/core/defaults.ts`, `src/cli/**`, `src/tools/**`, `src/domains/agents/recipe-schema.ts`, `src/domains/providers/models/local-models/**` | Audited inventory of every settings key, environment variable, CLI flag, project-file key, frontmatter key, tool argument, and model tag with defaults and precedence. |
| [safety-model.md](../architecture/safety-model.md) | `src/domains/safety/**`, `src/tools/registry.ts`, `src/tools/policy.ts`, `src/tools/verify/**`, `src/entry/orchestrator.ts`, `src/domains/dispatch/write-boundary.ts` | Operating posture, `resolveEffectiveAutonomy` / `resolveBaselineAutonomy`, detect-and-rollback write boundaries, approval axes, damage control, typed validation. |
| [prompt-envelope-and-tools.md](../architecture/prompt-envelope-and-tools.md) | `src/domains/prompts/compiler.ts`, `src/interactive/chat-loop.ts`, `src/core/tool-names.ts`, `src/tools/registry.ts`, `src/tools/observation.ts`, `src/tools/agent-tools.ts` | Prompt envelope reuse, canonical tool delivery via single `agent-tools.ts` adapter, seven-plane tool surface, observation envelope, strict `ToolName` keying. |
| [tool-usage.md](../guide/tool-usage.md) | `src/tools/agent-tools.ts`, `src/tools/registry.ts`, `src/tools/observation.ts` | In-depth reference for all 30 built-in tools across 8 planes (21 direct tools, 9 gateway capabilities), including conditional registration, parameters, typical payloads, normalizers, and error examples. |
| [doctor.md](../guide/doctor.md) | `src/cli/doctor.ts` | Diagnostic checks across install structure, credentials, HPC toolchain, and model targets (`doctor`, `doctor --fix`, `doctor --deep`). |
| [slurm.md](../guide/slurm.md) | `src/tools/gateway/**`, `library/skills/slurm/**` | Slurm job submission, polling, and cancellation via the `clio-kit` stdio MCP server. |
| [panes-and-files.md](../guide/panes-and-files.md) | `src/interactive/panes-runtime.ts`, `src/interactive/yazi-bridge.ts`, `src/domains/mux/operations.ts`, `src/domains/mux/yazi/theme.ts`, `src/cli/panes.ts` | Operator path to panes and the files pane: install, settings, doctor rows, `/files` and `Alt+E`, presets, what `/quit` closes, theme boundary, troubleshooting. |
| [provider-adapter-cookbook.md](../architecture/provider-adapter-cookbook.md) | `src/domains/providers/registry.ts`, `src/domains/providers/types/runtime-descriptor.ts` | RuntimeDescriptor, probe(), probeReasoning(), synthesizeModel(), thinking mechanisms. |
| [pi-boundary.md](../architecture/pi-boundary.md) | `src/engine/**`, `src/tools/truncate.ts`, `tests/boundaries/check-boundaries.ts` | Which Pi SDK capabilities Clio delegates to, which Clio-specific adapters remain, and the boundary tests that keep the split explicit. |
| [alcf-provider.md](../architecture/alcf-provider.md) | `src/domains/providers/runtimes/cloud/alcf.ts`, `src/engine/alcf-oauth.ts` | Globus PKCE OAuth, openAuthStorage(), Sophia vLLM, Metis API, chatTemplateKwargsUnsupported. |
| [environment-variables.md](../guide/environment-variables.md) | `src/core/guardrails.ts`, `src/core/xdg.ts`, `src/domains/providers/knowledge-base-path.ts` | Comprehensive env var matrix: guardrail overrides, directory layout (CLIO_CODER_HOME), debug toggles, and internal plumbing. |
| [built-in-agents.md](../guide/built-in-agents.md) | `src/domains/agents/**`, `src/domains/agents/builtins/*.md`, `src/domains/dispatch/**` | Builtin agent recipes, discovery roots, frontmatter schema, fleet contract shadowing (`.clio-coder/fleets/<name>.md`), active route automation. |
| [fleet-dispatch.md](../guide/fleet-dispatch.md) | `src/domains/dispatch/**` | Multi-node SSH dispatch: process-safe admission, capacity leases, fleet contracts v1 through v5, v4 write boundaries, v5 plan and gate steps, bounded check/repair loops (`loop_bound_exhausted`), deterministic code steps, attestation, and receipts v20. |
| [capacity-and-scheduling.md](../architecture/capacity-and-scheduling.md) | `src/domains/scheduling/**`, `src/domains/dispatch/capacity-lease.ts`, `src/domains/dispatch/reservation-store.ts` | Multi-process capacity leases (`dispatch-admission.json`), heartbeat TTLs, cross-process transaction locks (`dispatch-admission.json.lock`), and cluster drain controls. |
| [worker-dispatch-mechanics.md](../architecture/worker-dispatch-mechanics.md) | `src/worker/**` | NDJSON parent-child socket protocols, control/bulk lane demuxing, watchdog timers, worker attestation (13 protocol fields), permission parking, exit codes. |
| [worker-context.md](../architecture/worker-context.md) | `src/worker/spec-contract.ts`, `src/domains/dispatch/**`, `src/worker/**` | Worker context inheritance: isolated, fork, and splice context modes for native workers, historical message selection, and token limits. |
| [fleet-demo-runbook.md](fleet-demo-runbook.md) | `src/domains/dispatch/**` | Multi-node fleet demo: SSH setup, C++ build/repair workflow, reviewer gates, and receipt verification v20. |
| [session-lifecycle.md](../architecture/session-lifecycle.md) | `src/engine/session.ts`, `src/domains/session/**` | Session lifecycle, on-disk ledger format v4 (`current.jsonl`), tree branching (`tree.json`), active-path lineage selection, `/fork`, `/resume`, checkpoints, and write-ahead protected-artifact journal. |
| [acp.md](../architecture/acp.md) | `src/engine/acp/**`, `src/cli/acp.ts` | Agent Client Protocol (ACP) server over stdio, tool mediation, non-stall permission handling, timeout bounds, and error taxonomy. |
| [artifact-versions.md](../architecture/artifact-versions.md) | `src/domains/dispatch/receipt-integrity.ts`, `src/engine/session.ts`, `src/worker/spec-contract.ts`, `src/domains/agents/fleet-contract.ts`, `src/domains/observability/trace-store.ts` | Operator-facing registry and migration policies for selected compatibility-sensitive serialized artifacts. |
| [exit-codes-and-output.md](../guide/exit-codes-and-output.md) | `src/cli/**`, `src/entry/**` | Global process exit codes (0, 1, 2, 3), `--help` standard on stdout, machine-readable JSON streaming (`--json`, `--json-events`), and headless stdout deliverable contracts. |
| [troubleshooting.md](../guide/troubleshooting.md) | `src/core/**`, `src/cli/**`, `src/domains/**` | Actionable error remediation and diagnostics keyed by exact user-facing messages. |
| [glossary.md](../guide/glossary.md) | `src/domains/dispatch/types.ts`, `src/tools/**`, `src/domains/agents/**`, `src/core/**` | Canonical definitions of 50 core architectural concepts mapped to `src/` types. |
| [documentation-coverage.md](documentation-coverage.md) | `src/**` | Complete source-to-documentation mapping matrix and subsystem coverage status. |
| [tui-design.md](../architecture/tui-design.md) | `src/interactive/theme/tokens.ts`, `src/interactive/theme/glyphs.ts` | TUI color system, glyph vocabulary (`contextReserve`), structural layouts, state choreography, code ink. |
| [installation-and-lifecycle.md](../guide/installation-and-lifecycle.md) | `src/cli/paths.ts`, `src/cli/doctor.ts`, `src/cli/uninstall.ts`, `src/cli/removal.ts` | Installation, upgrade, reset, uninstallation, launcher ownership and what `--remove-binary` will and will not remove, partial-failure behavior, configuration folders (`credentials.yaml` `0o600`), and permissions. |
| [release-cut-checklist.md](release-cut-checklist.md) | `scripts/check-release.mjs`, `tests/smoke/installed-package.test.ts`, `.github/workflows/`, `package.json` | Standard release procedure: local candidate preparation, release gate verification, fast-forward landing on main, annotated tag publication, and npm publish. |
| [release-cut-checklist.md (v0.4.1)](../history/release-cut-checklist.md) | `scripts/check-release.mjs`, `tests/smoke/installed-package.test.ts`, `.github/workflows/`, `package.json` | Historical v0.4.1 release procedure retained as evidence; future releases must draft and verify their own checklist. |
| [development-pipeline.md](development-pipeline.md) | `library/skills/git/**`, `.github/**`, `scripts/check-release.mjs`, `package.json` | Issue-to-PR development lifecycle, validation, release inheritance, and the human merge boundary. |
| [git-commit-provenance.md](git-commit-provenance.md) | `src/core/commit-attribution.ts`, `src/core/git-commit-attribution.ts`, `src/domains/dispatch/fleet-commit-attribution.ts` | Evidence-aware commit roles, trailers, managed hook chaining, and receipt v20 attribution. |
| [observability.md](../architecture/observability.md) | `src/domains/observability/**`, `src/interactive/view/**`, `src/domains/dispatch/**`, `src/core/bus-events.ts` | `/view` artifact browsing, receipt verification, worker diagnostics, event routing, and cost snapshots. |
| [performance-methodology.md](performance-methodology.md) | `src/interactive/render-trace.ts`, `src/interactive/**`, `tests/extended/rendering-invariants.test.ts`, `tests/smoke/real-binary-boot.test.ts` | Reproducible terminal and model-path performance endpoints, trace interpretation, measurement controls, and reporting rules. |
| [evidence-and-memory.md](../architecture/evidence-and-memory.md) | `src/domains/evidence/**`, `src/domains/memory/**`, `src/cli/evidence.ts`, `src/cli/memory.ts` | Evidence corpus layout, findings, memory lifecycle and prompt injection. |
| [proactive-memory.md](../guide/proactive-memory.md) | `src/domains/memory/**` | Proactive task memory architecture, session task bank, intervention rules, and handoff carrying. |
| [trace-store.md](../architecture/trace-store.md) | `src/cli/trace.ts`, `src/domains/observability/trace-store.ts` | WAL SQLite trace mirror database schema, rowid cursor queries, rebuildability, and nine `clio-coder trace` subcommands: `runs`, `phases`, `tail`, `procs`, `code-steps`, `inspect`, `prune`, read-only `sql`, and `ui`. |
| [extensions-and-sharing.md](../guide/extensions-and-sharing.md) | `src/domains/extensions/**`, `src/domains/resources/**`, `src/domains/share/**`, `src/cli/extensions.ts`, `src/cli/share.ts` | Prompt, skill, agent, fleet, and reserved theme resources; extension manifests; portable share archives. |
| [library.md](../architecture/library.md) | `src/domains/plugins/**`, `src/domains/resources/library.ts`, `src/cli/library.ts` | Package kinds, catalog resolution, integrity, scope selection, and trust. |
| [resource-library.md](../guide/resource-library.md) | `src/domains/resources/library.ts`, `src/cli/library.ts` | Catalog schemas, private and remote source policy, checksum pins, resource installation, and update checks. |
| [skills-marketplace.md](../guide/skills-marketplace.md) | `src/interactive/overlays/library.ts`, `src/interactive/overlays/library-tabs.ts`, `src/domains/resources/skills/marketplace.ts` | Skills marketplace discovery through library overlays, catalog inspection, install actions, publishing flow. |
| [plugins.md](../guide/plugins.md) | `src/domains/plugins/**`, `src/domains/resources/library.ts`, `src/cli/library.ts` | Portable domain bundles, library installation, enable/disable states, drift detection, pins, and package lifecycle. |
| [authoring-plugins.md](../guide/authoring-plugins.md) | `library/**`, `src/domains/plugins/**`, `src/domains/resources/library-validation.ts` | Plugin and package structure, root plugin.json manifests, resource mapping, validation, and authoring guidelines. |
| [harness-extensions.md](../guide/harness-extensions.md) | `src/domains/extensions/**`, `src/domains/plugins/**`, `src/interactive/**` | Harness extension lifecycle, command handlers, dynamic reload, and interaction with the Clio execution environment. |
| [interop.md](../guide/interop.md) | `src/cli/interop.ts`, `src/domains/interop/**`, `src/interactive/overlays/interop.ts` | External coding agent interoperability: host discovery, resource inspection, safe adoption of prompts and skills into the library. |
| [model-catalog.md](../architecture/model-catalog.md) | `src/domains/providers/catalog.ts`, `src/domains/providers/models/**`, `src/domains/providers/probe/**`, `src/domains/providers/model-capabilities.ts` | Model catalog, live probes (`--offline` toggle), exact-id selector `probeCapabilitiesForModel`, field-note promotion. |
| [middleware-and-components.md](../architecture/middleware-and-components.md) | `src/domains/components/**`, `src/domains/middleware/**`, `src/cli/components.ts` | Active component snapshots, phase-aware middleware hook budgets (`DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS`). |
| [tool-audit-v0.4.9.md](tool-audit-v0.4.9.md) | `src/tools/**`, `src/core/safe-exec.ts`, `src/domains/gateway/mcp/**` | Individual tool purpose, placement, contracts, implementation bounds, scientific integrity, and landed disposition. |
| [scientific-validation.md](scientific-validation.md) | `src/domains/safety/rigor.ts`, `src/domains/safety/finish-contract.ts` | Advisory validation-contract patterns for scientific artifacts and HPC assumptions. |
| [evolution.md](evolution.md) | `src/domains/evolution/**`, `src/cli/evolve.ts` | Falsifiable Change Manifest JSON templates, evidence-linked validation, and `clio-coder evolve`. |
| [gui/README.md](../gui/README.md) | `apps/clio-coder-gui/**`, `dist/gui/**` | Early GUI preview reference: browser documentation, workspace inspection, REST routes, and parity roadmap. |
| [boundary-doctrine.md](../gui/boundary-doctrine.md) | `apps/clio-coder-gui/**` | Architectural invariants and boundary principles governing GUI client-server interactions. |
| [chat-rendering-spec.md](../gui/chat-rendering-spec.md) | `apps/clio-coder-gui/**` | Conversation view blueprint, card taxonomy, diff rendering, and inspector presentations. |
| [cli-surface-routing.md](../gui/cli-surface-routing.md) | `apps/clio-coder-gui/**`, `src/cli/**` | Mapping of CLI commands to GUI routing destinations and REST adapters. |
| [delivery-order.md](../gui/delivery-order.md) | `apps/clio-coder-gui/**` | Ordered delivery sequence and implementation dependencies for GUI capabilities. |
| [event-bus-coverage.md](../gui/event-bus-coverage.md) | `apps/clio-coder-gui/**`, `src/core/bus-events.ts` | Event taxonomy and ACP boundary filtering for real-time frontend updates. |
| [inspector-presentation.md](../gui/inspector-presentation.md) | `apps/clio-coder-gui/**` | Inspector layouts, card ordering, and presentation models for telemetry and state. |
| [parity/01-cli-surface.md](../gui/parity/01-cli-surface.md) | `apps/clio-coder-gui/**`, `src/cli/**` | Command-line surface parity audit and route coverage status. |
| [parity/02-slash-and-surfaces.md](../gui/parity/02-slash-and-surfaces.md) | `apps/clio-coder-gui/**`, `src/interactive/slash-commands.ts` | Interactive slash command and overlay parity audit. |
| [parity/03-domains-and-plan.md](../gui/parity/03-domains-and-plan.md) | `apps/clio-coder-gui/**` | Runtime domain roster and GUI implementation roadmap. |
| [performance-baseline.md](../gui/performance-baseline.md) | `apps/clio-coder-gui/**` | Rendering benchmarks, latency baselines, and performance budgets. |
| [settings-write-surface.md](../gui/settings-write-surface.md) | `apps/clio-coder-gui/**`, `src/core/settings-controls.ts` | Schema v2 settings write coverage and form generation. |
| [workflow-coverage.md](../gui/workflow-coverage.md) | `apps/clio-coder-gui/**` | Operator workflow matrix and human interaction patterns. |
| [battletest-2026-09-20-fixes.md](battletest-2026-09-20-fixes.md) | `src/**`, `tests/**` | Historical record of the Pi 0.86.1 battletest verification and defect resolutions. |
| [configure-tree-proposal.md](configure-tree-proposal.md) | `src/core/defaults.ts` | Historical design proposal for configure and `/settings` information architecture. |
| [config-knobs-audit.md](../history/config-knobs-audit.md) | `src/cli/config.ts` | Point-in-time inventory of legacy environment variables (Historical Appendix). |

---

## Style conventions

### Alpha framing

Use direct, honest language:

- "experimental community alpha"
- "source-build path"
- "current runtime is conservative/inert"
- "advisory contract"
- "planned/future milestone"

Avoid phrases that imply managed production stability, full plugin maturity, or automatic scientific validation when the current code does not provide it.

### Markdown structure

- Prefer short sections with tables for command and schema references.
- Use fenced examples that can be copied.
- Keep links relative and repository-portable; do not use absolute `file:///home/...` links.
- Mention source file paths in backticks instead of editor-specific absolute URLs.

### GitHub alerts

Use alerts sparingly:

> [!NOTE]
> Context or caveats that prevent misinterpretation.

> [!WARNING]
> Sharp edges, alpha limitations, or behavior that can surprise contributors.

> [!CAUTION]
> Safety, data loss, or security-sensitive constraints.

---

## One source, generated presentation

The Markdown tree is the canonical reference for people and agents. The web
application generates the reading view, navigation, search index and heading
outline from those same files. It supplies the theme, code-copy controls and
safe diagram rendering. Do not author or regenerate parallel HTML documents.

Keep `docs/README.md` organized around reader goals. Its linked tables define
the navigation groups; all discovered Markdown pages also appear in the full
inventory. Use descriptive headings and relative links so the renderer can
create stable anchors and keep navigation inside the application.

`pnpm run lint` checks source-corpus coverage and rejects links to retired HTML.
The web documentation tests walk every page, verify its rendered heading targets
and internal links, and check that unsafe content cannot become executable HTML.

---

## Update checklist

When a feature changes:

1. Identify the source owner (`src/cli`, `src/interactive`, `src/tools`, or a domain).
2. Check whether public CLI help changed.
3. Update the mapped guide in the same PR.
4. If behavior affects safety, sessions, receipts, prompts, targets, or dispatch, update both README-level user docs and the deeper guide.
5. Run a lightweight link check for changed Markdown.
6. For release docs, verify version badges/sections match `package.json` and `CHANGELOG.md`.
7. Run `pnpm run lint` and the web documentation tests to verify corpus coverage, links and rendering.

Suggested local link check:

```bash
python3 - <<'PY'
import pathlib, re
for md in list(pathlib.Path('docs').rglob('*.md')) + [pathlib.Path('README.md')]:
    text = md.read_text()
    for m in re.finditer(r'\[[^\]]+\]\(([^)]+)\)', text):
        link = m.group(1)
        if link.startswith(('http://', 'https://', 'mailto:', '#')):
            continue
        target = link.split('#')[0]
        if target and not (md.parent / target).exists():
            line = text.count('\n', 0, m.start()) + 1
            print(f'{md}:{line}: missing {link}')
PY
```

---

## Community documentation priorities

Clio users tend to be early adopters running real repositories, local models, and scientific/HPC code. Good docs should therefore prioritize:

- reproducible first-run and target configuration;
- local model/runtime field notes with exact versions and serving settings;
- safety receipts and redaction guidance for issue reports;
- small examples for project-local `CLIO-CODER.md`, `.clio-coder/safety.yaml`, prompts, skills, and agents;
- clear labels for experimental surfaces such as middleware and scientific validation contracts.
