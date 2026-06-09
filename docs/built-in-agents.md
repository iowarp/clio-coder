# Clio Coder Agent Fleet

Clio Coder dispatches focused fleet agents from Markdown recipes. Recipes are data files, not hidden code plugins: YAML frontmatter declares identity, mode, tools, optional target/model hints, and thinking level; the Markdown body is the agent instruction text.

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard for the agent registry and dispatch admission check gates is located at [docs/html/agents_blueprint.html](html/agents_blueprint.html) (Version: 0.2.2).

The source of truth is `src/domains/agents/**`.

---

## Agent Architecture Semantics

Clio's agent architecture distinguishes between authoring configurations and runtime policies:

*   **Recipe**: An authored Markdown file containing frontmatter configuration and an instruction body.
*   **AgentSpec**: The normalized runtime and catalog policy object derived from a recipe.
*   **audience**: Determines visibility and routing (`base` | `shadow` | `custom` | `internal`).
*   **source**: Origin of the recipe (`builtin` | `user` | `project`).

### Discovery, Overrides, and Precedence
At startup, Clio loads recipes from three roots:

| Source | Root | Notes |
| --- | --- | --- |
| **Built-in** | `src/domains/agents/builtins/*.md` in the installed package | Shipped defaults. |
| **User** | `<dataDir>/agents/*.md` | Per-user recipes. `<dataDir>` follows Clio's XDG/platform data directory. |
| **Project** | `.clio/agents/*.md` under the current repo | Repository-local overrides and additions (custom/domain agents). |

Recipe IDs are derived from filenames (e.g., `architect.md` -> `architect`). Recipes must live directly under their respective directories.

*   **Customization**: User-level agents can override/customize shipped base agents.
*   **Shadow Protection**: User or project agents can **never** override shadow or internal agents.
*   **Built-in Protection**: Project agents cannot override any shipped built-ins; they are strictly treated as custom/domain agents.
*   **Reserved IDs**: The IDs `worker` and `delegate` are strictly reserved for custom/internal contexts and cannot be registered as custom agent IDs.
*   **Local Ignored Custom Examples**: Local examples (e.g., `benchmark-runner`, `clio-dev`, `implementer`, `scientific-validator`) may exist under `.clio/agents` for documentation or test purposes, but are ignored if they collide with reserved/built-in rules.

---

## Built-in catalog

Current built-ins under `src/domains/agents/builtins/`:

### Shipped Base Agents
User-facing agents visible in `clio agents` and `/agents`.

| Agent ID | Primary tools | Purpose | Capability | Latency |
| --- | --- | --- | --- | --- |
| `architect` | read, grep, glob, ls, find_symbol, entry_points, where_is, git_status, git_diff, write_plan | Designs changes across boundaries, contracts, and validation gates. | `artifact-write` | `deep` |
| `coder` | read, write, edit, grep, glob, ls, web_fetch, git_status, git_diff, git_log, run_tests, run_lint, run_build, package_script, validate_frontend | Implements bounded code changes and behavior-preserving refactors. | `workspace-edit` | `balanced` |
| `debugger` | read, grep, glob, ls, git_status, git_diff, git_log, run_tests, run_lint, run_build, package_script | Diagnoses failing code, tests, or receipts without making edits. | `verification` | `balanced` |
| `documenter` | read, write, edit, grep, glob, ls, git_status, git_diff, run_lint, run_build | Updates developer-facing docs, examples, and operational runbooks. | `workspace-edit` | `balanced` |
| `tester` | read, write, edit, grep, glob, ls, git_status, git_diff, run_tests, run_lint, run_build | Adds focused deterministic tests for regressions and missing coverage. | `workspace-edit` | `balanced` |
| `verifier` | read, grep, glob, ls, git_status, git_diff, git_log, run_tests, run_lint, run_build, package_script, validate_frontend | Independently runs and reports test, lint, build, and release gates. | `verification` | `fast` |

### Shipped Shadow Agents
Internal orchestration helpers. They are hidden from default displays (but visible via `clio agents --all` and in a separate section of the prompt catalog).

| Agent ID | Primary tools | Purpose | Capability | Latency |
| --- | --- | --- | --- | --- |
| `scout` | read, grep, glob, ls, workspace_context, find_symbol, entry_points, where_is, git_status, git_diff, git_log | Shadow fast codebase reconnaissance, symbol mapping, and codewiki context. | `read-only` | `fast` |
| `researcher` | read, web_fetch, read_skill | Shadow docs and external-source researcher for coding decisions. | `read-only` | `deep` |
| `provenance` | read, grep, glob, ls, git_status, git_diff, git_log | Shadow evidence, receipt, diff, and telemetry reader for handoffs. | `read-only` | `balanced` |

---

## Frontmatter schema

`src/domains/agents/registry.ts` parses frontmatter fields from recipe markdown:

```yaml
---
name: Coder                       # string; defaults to recipe id when absent
description: Bounded code changes # string; defaults to empty string
tools: [read, edit, run_tests]    # string array; filtered by target capabilities and dispatch admission
model: null                       # string only when set; null is ignored
endpoint: null                    # string only when set; target/endpoint hint
thinkingLevel: off                # off | minimal | low | medium | high | xhigh
category: implement               # explore | plan | research | implement | quality | science | evolution | operations | internal
capabilityClass: workspace-edit    # read-only | artifact-write | workspace-edit | verification | orchestration | internal
latencyClass: balanced             # fast | balanced | deep
tags: [implementation, repair]    # short lowercase routing hints for catalog display
skills: []                        # knowledge attachments; requiring read_skill, never expands tool authority
output: null                      # optional expected artifact name (e.g. PLAN.md)
---
```

### Skills
Skills are knowledge attachments declared under `skills: [...]` in the YAML frontmatter.
*   They are injected compactly into the prompt/catalog.
*   They require the `read_skill` tool to be accessible.
*   They **never** expand the agent's tool authority; they act purely as static knowledge context.

---

## Dispatching agents

*   **Visibility**: Normal `clio agents` lists user-visible (base/custom) agents. The `/agents` slash command shows both Clio fleet agents and ACP delegation agents. The command `clio agents --all` includes shadow/internal specs reserved for Clio orchestration.
*   **Invocation limits**: User-origin `/run` and `clio run --agent` **cannot** invoke shadow/internal agents.
*   **Orchestrator dispatch**: Internal main-agent dispatch can invoke shadow agents (e.g., using `dispatch` or `dispatch_batch` tools).
*   **TUI rendering**: Shadow dispatch rows are marked with an `sh:` prefix in the dispatch board and footer so users can see when Clio is using internal orchestration helpers.
*   **ACP Delegation**: The `/delegate` command is reserved for ACP delegation only, which is separate from Clio fleet subagents.

### ACP Delegation Agents as First-Class Workers

ACP delegation agents (registered under `delegation.agents` in `settings.yaml`) are integrated as first-class workers:
- **Automatic Routing:** When a task is dispatched to an agent ID matching a configured ACP delegation agent, the dispatch engine automatically routes the execution to that delegation agent.
- **Dynamic Spec Discovery:** The agent registry automatically synthesizes complete AgentSpecs for configured ACP delegation agents. They are visible via `clio agents` and in slash command menus.

### Restricted Shadow Agent Delegation

To ensure security and proper boundary isolation, shadow and internal agents are restricted from being delegated:
- **shadow/internal Restriction:** The dispatch engine rejects any attempt to run a shadow or internal agent on an external ACP delegation worker, throwing a validation error.

Interactive TUI:

```text
/run coder implement the new command
/run --target local-lmstudio --model your-model-id coder fix the failing unit test
/run --agent-profile cheap --tool-profile minimal-local verifier run the regression tests
```

Headless CLI:

```bash
clio run --agent coder "Refactor the parser."
```

Dispatch admission enforces three gates:

1. The recipe's requested tools must be supported by target capabilities.
2. The requested action classes must be allowed by the agent's scope.
3. The worker scope must be a subset of the orchestrator's active scope.

---

## Adding a project agent

Create `.clio/agents/my-agent.md`:

```md
---
name: My Agent
description: Focused local review helper.
tools: [read, grep, glob, ls, git_diff, write_review]
---

You are My Agent. Inspect only the requested area. Never edit files. End by writing a concise review artifact with risks, evidence, and follow-up tests.
```

Then run:

```bash
clio agents
clio run --agent my-agent "Review the parser change."
```
