# Memory and lessons

See what CLIO Coder remembers, approve lessons, or turn memory off.

## What memory does

Memory is on by default and needs no setup. CLIO Coder keeps task memory for a session: requirements, environment facts, failed attempts, and diagnoses. By default it runs on rules, with no automatic model calls. The model steps are opt-in, and they use your chat route unless you give memory a route of its own.

## Notes have to be demonstrated

What CLIO Coder keeps across sessions is a note: a claim bound to a command that succeeded or a file that was read. The agent writes one with the `memory_note` tool, and a failed command followed by its fix is filed by rule. A note becomes a lesson only after two other sessions demonstrate it, or after you approve it.

A stored lesson is checked once per session before it is delivered. If its command no longer resolves, or the text it quotes has left the file, CLIO Coder withholds it. A lesson you approved keeps its approval and is named in a notice.

## See and approve lessons

Open `/memory` to see the lessons this session can reach, pending and rejected records beside approved ones, and what each one concerns. From the shell:

```sh
clio-coder memory list
clio-coder memory approve <memoryId>
clio-coder memory reject <memoryId>
clio-coder memory prune --stale
clio-coder memory consolidate
```

`memory consolidate` merges records of the same claim, demotes lessons that no longer hold and drops automatic notes with no evidence. It makes no model call and never touches a record you approved or rejected. `memory list --approved-by operator` or `--approved-by guardian` lists approved records by who approved them.

`/memory` also shows the current tier, the live bank, and the last twenty memory steps with their trigger, decision, and latency. That history is the only place a skipped step or a timeout appears. In `/memory`, press `p` on a selected row to propose it for review at repository scope, or `g` for global scope.

A lesson reaches the agent in the `# Memory` section of the prompt and, by default, as a reminder at a decision point: a failed command, a missing check, a touched file or the task of the turn. Reviewing earlier sessions for new lessons is off by default; set `context.memory.surfaces.history: on` to turn it on.

## Turn it off or route it elsewhere

Set `context.memory.enabled: false`, or use `/settings` → **Context and memory** → **Proactive memory**. Off means off: the `# Memory` section leaves main and worker prompts, and history review reads nothing from a session that ran with memory off. To run memory on its own route, set both `context.memory.target` and `context.memory.model`.

## Settings

All keys live under `context.memory` in `settings.yaml`, and `/settings` → **Context and memory** has rows for them.

| Key | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | Turns memory on or off. |
| `target`, `model` | `null` | Dedicated memory route; unset uses the chat route. |
| `surfaces.lessons` | `agent` | Who writes notes: `off`, `rules`, `agent` or `side`. |
| `surfaces.delivery` | `decision` | How lessons reach the agent: `off`, `section`, `decision` or `broadcast`. |
| `surfaces.correct`, `surfaces.bank` | `rules` | `model` adds a model step for corrections or bank upkeep. |
| `surfaces.history` | `off` | `on` reviews earlier sessions for lessons while idle. |
| `sideShare` | `0.15` | Caps automatic memory calls at a share of the session's main output; `0` removes the cap. |
| `thinkingLevel` | `off` | How much the memory side call reasons. |
| `cadenceToolCalls` | `10` | Completed tools between model steps under `surfaces.bank: model`. |
| `trajectorySteps` | `8` | Recent tool steps a background step reads. |
| `maxOutputTokens` | `2000` | Bounds the bank context and the reminder. |
| `timeoutMs` | `60000` | Time limit for one background step. |

## Choose a cheap or local background model

Memory reads a short trajectory and writes a bounded result, so a small model usually suffices. The route's thinking level is `context.memory.thinkingLevel`, which defaults to `off`.

```yaml
context:
  memory:
    target: memory-dedicated
    model: memory-profile/qwen3.5-4b
```

These IDs are examples; check yours with `clio-coder targets --probe`. Locally, both models and their caches must fit in memory.

## Cost and budget

A step is checked against its route's cost before any request leaves, so a skipped step costs nothing. Metered routes stop at `safety.limits.sessionCostUsd`, subscription routes wait out a near-full quota window, and free routes need an open request slot. After a session's first three automatic memory calls, `sideShare` also holds memory output to 15% of main output. Steps appear as `memory steps` in `/usage`.

Memory gives reminders; it does not replace reading the code or running the checks. See the full guide for how reminders are selected and when a lesson is promoted.
