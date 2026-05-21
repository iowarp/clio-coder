# Clio Coder Agent Fleet: Built-in Recipes & Custom Agents

Clio Coder operates a coordinated fleet of specialized coding agents. Rather than relying on a single, general-purpose LLM prompt to manage research, planning, testing, and editing, Clio dispatches task-scoped sub-agents equipped with bounded tool sets and targeted instructions.

---

## 🚢 The Agent Fleet Catalog

Clio Coder ships with 16 built-in agents under `src/domains/agents/builtins/`:

| Agent ID | Operating Mode | Core Specialty & Purpose |
| :--- | :--- | :--- |
| `scout` | `advise` | Fast repository reconnaissance, search, mapping, and symbol exploration. |
| `planner` | `advise` | Developing reviewable technical implementation plans. |
| `researcher` | `advise` | Literature searches, API investigations, and web-grounded research. |
| `reviewer` | `advise` | Assessing implementation diffs against plans and style guides. |
| `scientific-validator` | `advise` | Drafting scientific validation contracts for scientific outputs. |
| `context-builder` | `advise` | Assembling and compacting key context bundles for downstream agents. |
| `attributor` | `advise` | Mapping benchmark and evaluation delta changes to rollbacks or keeps. |
| `evolver` | `advise` | Drafting JSON change manifests and plan steps for code audits. |
| `memory-curator` | `advise` | Reviewing run evidence and proposing long-term memory candidates. |
| `implementer` | `default` | General code editing, bug fixing, and localized modifications. |
| `debugger` | `default` | Explaining failing tests, error sessions, and debugging traces. |
| `regression-scout` | `default` | Finding likely regression paths and drafting negative tests. |
| `middleware-author` | `default` | Writing declarative middleware hooks and safety rule updates. |
| `benchmark-runner` | `default` | Managing evaluation tasks and analyzing token/cost performance budgets. |
| `worker` | `default` | In-process worker dispatch, parsing, and pipeline task runs. |
| `delegate` | `super` | Master orchestrator routing tasks across multiple concurrent sub-agents. |

---

## 📝 Anatomy of an Agent Recipe

Agents are declared as Markdown files with YAML frontmatter. Built-ins live in `src/domains/agents/builtins/*.md`. Clio parses the frontmatter to construct the agent's identity, sandbox bounds, and tool scopes.

### Frontmatter Schema Invariants:

```yaml
---
name: AgentName           # PascalCase string
description: String      # Brief description of the agent's role
mode: advise | default   # Enforcement mode gating tool classes
tools: [read, grep, ...] # Allowed tool names (subset of mode capabilities)
model: null | string     # Optional target model override
provider: null | string  # Optional target provider/runtime override
runtime: native | subprocess # Execution model
skills: [skill1, ...]    # Optional dynamic skills to inject
---
```

### The System Prompt Body:
The remainder of the markdown file (after the frontmatter block) forms the agent's system prompt instructions. It should define:
1. **Role and Tone:** Clear statement of the agent's focus (e.g., "You are Scout...").
2. **Tool Discipline:** Bounded instructions on how and when to use allowed tools.
3. **Outcome Constraints:** Clear definitions of the output structure (e.g., "Never edit files...").

---

## 🛠️ Authoring Custom Agents

To create a custom agent recipe for your team or repository:

1. **Create the file:** Add a markdown file to `src/domains/agents/builtins/custom-agent.md`.
2. **Define the constraints:**
   - If your agent only does research, set `mode: advise` and restrict tools to `[read, grep, find]`.
   - If your agent needs to edit, set `mode: default` and include `[write_file, replace_file_content]`.
3. **Write strict system instructions:** Avoid fluffy directives. Provide hard rules on verification, validation commands, and outcome formats.
4. **Link the agent in TUI or headless runs:**
   - In the TUI: `/run custom-agent "my exploration task"`
   - Headless: `clio run "my task" --agent custom-agent`

> [!IMPORTANT]
> **Safety Admission:** An agent's requested `tools[]` list must be a strict subset of the active orchestrator's mode. If an agent tries to register an unauthorized tool (e.g. an `advise` agent requesting `bash`), the tool registry fails closed, rejecting the dispatch.
