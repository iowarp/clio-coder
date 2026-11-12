# Memory and lessons

See what CLIO Coder remembers, approve lessons, or turn memory off.

## What memory does

Memory is on by default and needs no setup. CLIO Coder keeps task memory for a session: requirements, environment facts, failed attempts, and diagnoses. A rules tier runs without model calls. With no memory route of its own, the model tier uses your chat route within that route's cost, quota, or speed budget, so a default install spends some model calls on memory.

## See and approve lessons

Open `/memory` to see the lessons this session can reach, pending and rejected records beside approved ones, and what each one concerns. From the shell:

```sh
clio-coder memory list
clio-coder memory approve <memoryId>
clio-coder memory reject <memoryId>
clio-coder memory prune --stale
```

`/memory` also shows the current tier, the live bank, and the last twenty memory steps with their trigger, decision, and latency. That history is the only place a skipped step or a timeout appears. In `/memory`, press `p` on a selected row to propose it for review at repository scope, or `g` for global scope.

Memory also keeps commands a completed task proved to work, from its own run records, and offers them when a later session touches the same files. A repository lesson becomes standing guidance only after it is approved.

## Turn it off or route it elsewhere

Set `context.memory.enabled: false`, or use `/settings` → **Context and memory** → **Proactive memory**. Off means off: the `# Memory` section leaves main and worker prompts, and history review reads nothing from a session that ran with memory off. To run memory on its own route, set both `context.memory.target` and `context.memory.model`.

## Settings

All keys live under `context.memory` in `settings.yaml`. `/settings` has rows for `enabled`, the route, and `cadenceToolCalls`; set the others in the file.

| Key | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | Turns memory on or off. |
| `target`, `model` | `null` | Dedicated memory route; unset uses the chat route. |
| `cadenceToolCalls` | `10` | Minimum completed tools between background steps. |
| `trajectorySteps` | `8` | Recent tool steps a background step reads. |
| `maxOutputTokens` | `2000` | Bounds the bank context and the reminder. |
| `timeoutMs` | `60000` | Time limit for one background step. |

## Choose a cheap or local background model

Memory reads a short trajectory and writes a bounded result, so a small model usually suffices. CLIO Coder requests thinking off for this route.

```yaml
context:
  memory:
    target: memory-dedicated
    model: memory-profile/qwen3.5-4b
```

These IDs are examples; check yours with `clio-coder targets --probe`. Locally, both models and their caches must fit in memory.

## Cost and budget

A step is checked against its route's cost before any request leaves, so a skipped step costs nothing. Metered routes stop at `safety.limits.sessionCostUsd`, subscription routes wait out a near-full quota window, and free routes need an open request slot. Steps appear as `memory steps` in `/usage`.

Memory gives reminders; it does not replace reading the code or running the checks. See the full guide for how reminders are selected and when a lesson is promoted.
