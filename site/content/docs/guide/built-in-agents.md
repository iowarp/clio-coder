# Built-in and custom agents

See the agents you can dispatch and add your own.

## See the agents

CLIO Coder dispatches focused agents from Markdown recipes. Each recipe declares the agent's tools, budget, and the result it must return.

```sh
clio-coder agents
clio-coder agents validate
clio-coder run --agent coder "<task>"
```

`clio-coder agents` lists the agents you can run, including `architect`, `coder`, `debugger`, `documenter`, `git-master`, `tester`, and `verifier`. `/run` dispatches one from a session. Add `--read-only` to deny writes, commands, and delegation for one dispatch.

Helper agents such as Scout are dispatched by the main agent, and `clio-coder agents --all` lists them. You cannot start them directly.

## Shipped agents

| Agent | Use it to | Edits files |
| --- | --- | --- |
| `architect` | Design a change or cut a plan into a sprint | Plan file only |
| `coder` | Make a bounded change, repair, or refactor | Yes |
| `debugger` | Diagnose failing code, tests, or runs | No |
| `documenter` | Write docs and examples from source | Yes |
| `git-master` | Commits, worktrees, merges, pull requests | Yes |
| `tester` | Add deterministic regression tests | Yes |
| `verifier` | Run test, lint, build, and review gates | No |
| `wiki-writer` | Plan a wiki or write one page | Yes |
| `wiki-repair` | Fix one wiki draft's diagnostics | Yes |

## Add your own

Put a recipe at `.clio-coder/agents/<id>.md` for one project, or in the `agents` folder of your CLIO Coder config directory for yourself. The file name is the agent's id, and when a user recipe and a project recipe share an id, the project one wins. Run `clio-coder agents validate` after an edit.

A recipe must declare every required key, and `audience` must be `custom`:

```md
---
version: 1
name: My Agent
description: Focused local review helper.
tools:
  required: [read, artifact]
  optional: [grep, find, ls, git]
skills: []
audience: custom
category: quality
capabilityClass: artifact-write
latencyClass: balanced
projectContextTier: bounded
budget: {toolCalls: 20, readReserve: 4, synthesis: true}
resultContract: {kind: artifact-report}
tags: [review]
---

You are My Agent. Inspect only the requested area. Never edit files.
```

The body is the agent's instructions. Model and target are chosen at dispatch, not in the recipe. Start it with `clio-coder run --agent my-agent "Review the parser change."`. A user recipe may replace a shipped agent such as `coder`; a project recipe cannot.

## What validation rejects

`clio-coder agents validate` checks project and user recipes and skills, and the fleet bindings in `.clio-coder/settings.local.yaml`. It prints each problem as a `file: field: message` line and exits 1 when there is any. It rejects an unknown or missing key, an audience other than `custom`, a `budget` whose `readReserve` is not below `toolCalls`, a skill that does not resolve, and tools that break the `capabilityClass`, such as a `verification` agent that uses `bash`. A rejected recipe is not loaded.
