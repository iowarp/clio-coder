# Clio Coder Agent Fleet

Clio Coder dispatches focused fleet agents from Markdown recipes. Recipes are data files, not hidden code plugins: YAML frontmatter declares identity, mode, tools, and optional runtime hints; the Markdown body is the agent instruction text.

The source of truth is `src/domains/agents/**`.

---

## Recipe discovery and precedence

At startup the agents domain loads recipes from three roots:

| Source | Root | Notes |
| --- | --- | --- |
| Built-in | `src/domains/agents/builtins/*.md` in the installed package | Shipped defaults. |
| User | `<dataDir>/agents/*.md` | Per-user recipes. `<dataDir>` follows Clio's XDG/platform data directory or `CLIO_DATA_DIR`. |
| Project | `.clio/agents/*.md` under the current repo | Repository-local overrides and additions. |

Recipe IDs come from filenames (`planner.md` -> `planner`). Recipes must live directly in the root, not nested directories. Merge order is built-in, then user, then project, so later sources override earlier recipes with the same ID.

---

## Built-in catalog

Current built-ins under `src/domains/agents/builtins/`:

| Agent ID | Mode | Primary tools | Purpose |
| --- | --- | --- | --- |
| `attributor` | `advise` | read/search | Recommend keep vs. rollback from eval deltas. |
| `benchmark-runner` | `default` | read/write/edit, safe exec, git | Run/analyze local eval and benchmark tasks. |
| `context-builder` | `advise` | read/search/web | Assemble compact context bundles. |
| `debugger` | `advise` | read/search | Root-cause evidence, run, or session failures. |
| `delegate` | `default` | read | Plan delegation and handoffs. |
| `evolver` | `advise` | read/search/write_plan | Draft change manifests and minimal plans. |
| `implementer` | `default` | edit, safe exec, frontend validation, git | Concrete implementation and repair work. |
| `memory-curator` | `advise` | read/search | Propose evidence-linked memory candidates. |
| `middleware-author` | `advise` | read/search/write_plan | Draft middleware-rule designs and safety notes. |
| `planner` | `advise` | read/web/write_plan | Produce reviewable technical plans. |
| `regression-scout` | `advise` | read/search | Find likely regression paths and negative tests. |
| `researcher` | `advise` | read/web/write_plan | External/API research synthesis. |
| `reviewer` | `advise` | read/search/write_review | Review diffs and plans against project standards. |
| `scientific-validator` | `advise` | read/search | Draft scientific validation contracts and HPC assumptions. |
| `scout` | `advise` | read/search/web | Read-only workspace reconnaissance. |
| `worker` | `default` | edit, safe exec, frontend validation, git | Internal default execution recipe; not usually presented as product vocabulary. |

> [!NOTE]
> The `worker` recipe is runtime terminology used by dispatch internals. User-facing workflows should prefer named agents such as `scout`, `planner`, `reviewer`, and `implementer`.

---

## Frontmatter schema

`src/domains/agents/registry.ts` parses a conservative subset of frontmatter fields:

```yaml
---
name: Implementer                 # string; defaults to recipe id when absent
description: Concrete edits       # string; defaults to empty string
mode: default                     # advise | default | super
tools: [read, edit, run_tests]    # string array; filtered by mode and dispatch admission
model: null                       # string only when set; null is ignored
endpoint: null                    # string only when set; target/endpoint hint
thinkingLevel: off                # off | minimal | low | medium | high | xhigh
runtime: native                   # native | sdk | cli
skills: []                        # string array
---

Markdown body becomes the agent's system instructions.
```

Current built-ins still carry a legacy `provider: null` field in some frontmatter. The loader does not read that field; use `endpoint`, target configuration, or dispatch flags instead.

---

## Dispatching agents

Interactive TUI:

```text
/run scout summarize the repository layout
/run --target local-qwen --model qwen3-coder implementer fix the failing unit test
/run --agent-profile cheap --tool-profile minimal-local reviewer inspect the current diff
```

Headless CLI:

```bash
clio run --agent scout "Summarize the repository layout."
clio run --agent implementer --target local-qwen --tool-profile science-local "Fix the failing test."
```

Dispatch admission enforces three gates:

1. The recipe's requested tools must be visible in the requested mode.
2. The requested action classes must be allowed by the agent's scope.
3. The worker scope must be a subset of the orchestrator's active scope.

Use `clio agents` to list loaded recipes and their resolved source.

---

## Adding a project agent

Create `.clio/agents/my-agent.md`:

```md
---
name: My Agent
description: Focused local review helper.
mode: advise
tools: [read, grep, glob, ls, git_diff, write_review]
runtime: native
skills: []
---

You are My Agent. Inspect only the requested area. Never edit files. End by writing a concise review artifact with risks, evidence, and follow-up tests.
```

Then run:

```bash
clio agents
clio run --agent my-agent "Review the parser change."
```

Keep project agents small and auditable. If a recipe needs write or execute tools, explain why in the body and keep validation expectations explicit.
