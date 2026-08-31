# Documentation Standards and Codebase Alignment

> [!TIP]
> **Interactive Spec Available:** An interactive documentation link linter, phrasing/claim evaluator, and alignment portal is located at [docs/html/documentation_blueprint.html](html/documentation_blueprint.html) (Version: 0.4.0).

Clio Coder is an experimental community alpha. Documentation should help contributors and early users work from the source of truth without overstating maturity. When docs drift, prefer the current source and tests over older prose or aspirational roadmap notes.

---

## Source-first documentation rule

Before changing public docs, inspect the relevant implementation:

1. `git log --oneline -- <area>` for recent intent and release context.
2. `src/**` for current behavior.
3. `tests/**` for executable contracts and edge cases.
4. `README.md`, `CHANGELOG.md`, and `docs/*.md` for existing public wording.

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
| [README.md](../README.md) | `CHANGELOG.md`, package metadata, release receipts | Product overview, install, first run, alpha framing, and release status. |
| [docs/README.md](README.md) | This docs directory | Documentation hub. |
| [commands-and-modes.md](commands-and-modes.md) | `src/cli/index.ts`, `src/cli/args.ts`, `src/interactive/slash-commands.ts`, `src/domains/dispatch/**` | CLI commands, headless run flags (`--session`, `--continue`, `--json-events`), session continuity, `--json` wire projection promise, slash commands, keybindings, live steering. |
| [context-engine.md](context-engine.md) | `src/domains/context/**`, `src/domains/session/context-accounting.ts`, `src/domains/session/context-ledger.ts`, `src/domains/session/compaction/` | Context window resolution, per-model probe capabilities, token accounting, snapshots, the three compaction mechanisms, model-driven `clio-coder context init`, format v4 session enforcement. |
| [context-working-set.md](context-working-set.md) | `src/domains/context/working-set/**`, `src/domains/session/entries.ts`, `src/interactive/turn-context.ts` | Working-set vocabulary, eviction as a projection, the `contextEviction` / `contextRecall` records, the marker contract, the `age-horizon` and `structural-v1` policies, recall semantics, and the operator surfaces. |
| [architecture.md](architecture.md) | `tests/boundaries/check-boundaries.ts`, `src/core/domain-loader.ts`, `src/engine/**`, `src/worker/**` | Source layout, 5 enforced boundary rules (dependency direction vs import form), runtime flow mermaid diagram, event/audit model, detect-and-rollback write boundaries. |
| [dispatch-architecture-rationale.md](dispatch-architecture-rationale.md) | `src/domains/dispatch/**`, `tests/boundaries/check-boundaries.ts` | Design rationale, not behavior: invariants that cross the seams a dispatch split would use, what any future split must preserve, the one dispatch→eval import, and the closed barrel-import decision. |
| [configuration-and-targets.md](configuration-and-targets.md) | `src/core/defaults.ts`, `src/core/config.ts`, `src/domains/providers/**`, `src/cli/configure.ts`, `src/cli/targets.ts`, `src/cli/models.ts`, `src/cli/auth.ts` | TargetDescriptor, contextWindowProvenance (`configured`, `discovered`, `catalog`, `runtime-default`), settings.yaml, strict validation, saved defaults vs live routing. |
| [safety-model.md](safety-model.md) | `src/domains/safety/**`, `src/tools/registry.ts`, `src/tools/policy.ts`, `src/tools/verify/**`, `src/entry/orchestrator.ts`, `src/domains/dispatch/write-boundary.ts` | Operating posture, `resolveEffectiveAutonomy` / `resolveBaselineAutonomy`, detect-and-rollback write boundaries, approval axes, damage control, typed validation. |
| [prompt-envelope-and-tools.md](prompt-envelope-and-tools.md) | `src/domains/prompts/compiler.ts`, `src/interactive/chat-loop.ts`, `src/core/tool-names.ts`, `src/tools/registry.ts`, `src/tools/observation.ts`, `src/tools/agent-tools.ts` | Prompt envelope reuse, canonical tool delivery via single `agent-tools.ts` adapter, seven-plane tool surface, observation envelope, strict `ToolName` keying. |
| [tool-usage.md](tool-usage.md) | `src/tools/agent-tools.ts`, `src/tools/registry.ts`, `src/tools/observation.ts` | In-depth reference for all 20 worker tools: parameters, typical payloads, `prepareArguments` normalizers, and error examples. |
| [provider-adapter-cookbook.md](provider-adapter-cookbook.md) | `src/domains/providers/registry.ts`, `src/domains/providers/types/runtime-descriptor.ts` | RuntimeDescriptor, probe(), probeReasoning(), synthesizeModel(), thinking mechanisms. |
| [alcf-provider.md](alcf-provider.md) | `src/domains/providers/runtimes/cloud/alcf.ts`, `src/engine/alcf-oauth.ts` | Globus PKCE OAuth, openAuthStorage(), Sophia vLLM, Metis API, chatTemplateKwargsUnsupported. |
| [environment-variables.md](environment-variables.md) | `src/core/guardrails.ts`, `src/core/xdg.ts`, `src/domains/providers/knowledge-base-path.ts` | Comprehensive env var matrix: guardrail overrides, directory layout (CLIO_CODER_HOME), debug toggles, and internal plumbing. |
| [built-in-agents.md](built-in-agents.md) | `src/domains/agents/**`, `src/domains/agents/builtins/*.md`, `src/domains/dispatch/**` | Builtin agent recipes, discovery roots, frontmatter schema, fleet contract shadowing (`.clio-coder/fleets/<name>.md`), active route automation. |
| [fleet-dispatch.md](fleet-dispatch.md) | `src/domains/dispatch/**` | Multi-node SSH dispatch: process-safe admission, capacity leases, Contract v4 write boundaries (detect-and-rollback), bounded check/repair loops (`loop_bound_exhausted`), deterministic code steps, attestation, receipts v16. |
| [capacity-and-scheduling.md](capacity-and-scheduling.md) | `src/domains/scheduling/**`, `src/domains/dispatch/capacity-lease.ts`, `src/domains/dispatch/reservation-store.ts` | Multi-process capacity leases (`dispatch-admission.json`), heartbeat TTLs, cross-process transaction locks (`dispatch-admission.json.lock`), and cluster drain controls. |
| [worker-dispatch-mechanics.md](worker-dispatch-mechanics.md) | `src/worker/**` | NDJSON parent-child socket protocols, control/bulk lane demuxing, watchdog timers, worker attestation (13 protocol fields), permission parking, exit codes. |
| [fleet-demo-runbook.md](fleet-demo-runbook.md) | `src/domains/dispatch/**` | Multi-node fleet demo: SSH setup, C++ build/repair workflow, reviewer gates, receipt verification v16. |
| [session-lifecycle.md](session-lifecycle.md) | `src/engine/session.ts`, `src/domains/session/**` | Session lifecycle, on-disk ledger format v4 (`current.jsonl`), tree branching (`tree.json`), active-path lineage selection, `/fork`, `/resume`, checkpoints, and write-ahead protected-artifact journal. |
| [acp.md](acp.md) | `src/engine/acp/**`, `src/cli/acp.ts` | Agent Client Protocol (ACP) server over stdio, tool mediation, non-stall permission handling, timeout bounds, and error taxonomy. |
| [artifact-versions.md](artifact-versions.md) | `src/domains/dispatch/receipt-integrity.ts`, `src/engine/session.ts`, `src/worker/spec-contract.ts`, `src/domains/agents/fleet-contract.ts`, `src/domains/eval/schema/`, `src/domains/observability/trace-store.ts` | Version registry and migration policies for all 9 serialized artifact schemas across Clio Coder. |
| [exit-codes-and-output.md](exit-codes-and-output.md) | `src/cli/**`, `src/entry/**` | Global process exit codes (0, 1, 2, 3), `--help` standard on stdout, machine-readable JSON streaming (`--json`, `--json-events`), and headless stdout deliverable contracts. |
| [troubleshooting.md](troubleshooting.md) | `src/core/**`, `src/cli/**`, `src/domains/**` | Actionable error remediation and diagnostics keyed by exact user-facing messages. |
| [glossary.md](glossary.md) | `src/domains/dispatch/types.ts`, `src/tools/**`, `src/domains/agents/**`, `src/core/**` | Canonical definitions of 45 core architectural concepts mapped to `src/` types. |
| [documentation-coverage.md](documentation-coverage.md) | `src/**` | Complete source-to-documentation mapping matrix and subsystem coverage status. |
| [tui-design.md](tui-design.md) | `src/interactive/theme/tokens.ts`, `src/interactive/theme/glyphs.ts` | TUI color system, glyph vocabulary (`contextReserve`), structural layouts, state choreography, code ink. |
| [installation-and-lifecycle.md](installation-and-lifecycle.md) | `src/cli/paths.ts`, `src/cli/doctor.ts`, `src/cli/uninstall.ts`, `src/cli/removal.ts` | Installation, upgrade, reset, uninstallation, launcher ownership and what `--remove-binary` will and will not remove, partial-failure behavior, configuration folders (`credentials.yaml` `0o600`), and permissions. |
| [release-cut-checklist.md](release-cut-checklist.md) | `scripts/check-release.mjs`, `tests/smoke/pack-install.test.ts`, `benchmarks/internal/`, `package.json` | Ordered release-cut steps with an explicit authorization boundary: everything external or irreversible is marked not run and needs an operator decision. |
| [observability.md](observability.md) | `src/domains/observability/**`, `src/interactive/view/**`, `src/domains/dispatch/**`, `src/core/bus-events.ts` | `/view` artifact browsing, receipt verification, worker diagnostics, event routing, and cost snapshots. |
| [evidence-and-memory.md](evidence-and-memory.md) | `src/domains/evidence/**`, `src/domains/memory/**`, `src/cli/evidence.ts`, `src/cli/memory.ts` | Evidence corpus layout, findings, memory lifecycle and prompt injection. |
| [proactive-memory.md](proactive-memory.md) | `src/domains/memory/**` | Proactive task memory architecture, session task bank, intervention rules, and handoff carrying. |
| [trace-store.md](trace-store.md) | `src/cli/trace.ts`, `src/domains/observability/trace-store.ts` | WAL SQLite trace mirror database schema, rowid cursor queries, rebuildability, 6 `clio-coder trace` subcommands (`runs`, `phases`, `tail`, `procs`, read-only `sql` SELECT, `ui`). |
| [eval-runner.md](eval-runner.md) | `src/domains/eval/**`, `src/cli/eval.ts` | Local YAML eval tasks, dual token accountings (`tokens.*` wire vs `receiptUsage.*` journal), fail-closed null totals, EvalArtifactV4 format, `verify.measure` task outcome recording. |
| [evals-internal.md](evals-internal.md) | `src/domains/eval/**` | Private context index determinism and target smoke matrices. External model benchmarks are documented under `benchmarks/`. |
| [extensions-and-sharing.md](extensions-and-sharing.md) | `src/domains/extensions/**`, `src/domains/resources/**`, `src/domains/share/**`, `src/cli/extensions.ts`, `src/cli/share.ts` | Prompt and skill resources, extension manifests, portable share archives. |
| [skills-marketplace.md](skills-marketplace.md) | `src/interactive/overlays/skills-hub.ts`, `src/domains/resources/skills/marketplace.ts` | Skills Hub marketplace discovery through the install resolver, empty state, install actions, publishing flow. |
| [model-catalog.md](model-catalog.md) | `src/domains/providers/catalog.ts`, `src/domains/providers/models/**`, `src/domains/providers/probe/**`, `src/domains/providers/model-capabilities.ts` | Model catalog, live probes (`--offline` toggle), exact-id selector `probeCapabilitiesForModel`, field-note promotion. |
| [middleware-and-components.md](middleware-and-components.md) | `src/domains/components/**`, `src/domains/middleware/**`, `src/cli/components.ts` | Active component snapshots, phase-aware middleware hook budgets (`DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS`). |
| [scientific-validation.md](scientific-validation.md) | `src/domains/safety/rigor.ts`, `src/domains/safety/finish-contract.ts` | Advisory validation-contract patterns for scientific artifacts and HPC assumptions. |
| [evolution.md](evolution.md) | `src/domains/evolution/**`, `src/cli/evolve.ts` | Falsifiable Change Manifest JSON templates, evidence-linked validation, and `clio-coder evolve`. |
| [config-knobs-audit.md](config-knobs-audit.md) | `src/cli/config.ts` | Point-in-time inventory of legacy environment variables (Historical Appendix). |

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

## Blueprint Coverage & Format Strategy

Clio Coder maintains two complementary documentation formats:

1. **Markdown Documents (`docs/*.md`)**: The single canonical reference for coding agents, developers, and maintainers. They optimize for retrievability, exact enumerations, schema tables, typed TypeScript contracts, and source citations (`src/...:line`).
2. **Interactive HTML Blueprints (`docs/html/*.html`)**: Visual reference cards and client-side simulators designed for human operators exploring dynamic behaviors (such as safety rule evaluation, token compaction calculation, YAML target validation, and prompt structure).

### Blueprint Creation Policy

Not every markdown document earns a standalone interactive HTML blueprint. Reference specifications—such as `artifact-versions.md`, `exit-codes-and-output.md`, `glossary.md`, `troubleshooting.md`, `session-lifecycle.md`, `acp.md`, `capacity-and-scheduling.md`, and `documentation-coverage.md`—are authoritative tabular contracts and state machine specifications. Building client-side JavaScript simulators for these documents would duplicate runtime validation logic and introduce synchronization hazards across releases. These pages are therefore linked directly from `docs/html/index.html` as Markdown Reference Specifications with explicit visual distinction from interactive simulator blueprints.

---

## Update checklist

When a feature changes:

1. Identify the source owner (`src/cli`, `src/interactive`, `src/tools`, or a domain).
2. Check whether public CLI help changed.
3. Update the mapped guide in the same PR.
4. If behavior affects safety, sessions, receipts, prompts, targets, or dispatch, update both README-level user docs and the deeper guide.
5. Run a lightweight link check for changed Markdown.
6. For release docs, verify version badges/sections match `package.json` and `CHANGELOG.md`.

Suggested local link check:

```bash
python3 - <<'PY'
import pathlib, re
for md in list(pathlib.Path('docs').glob('*.md')) + [pathlib.Path('README.md')]:
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
