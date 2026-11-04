## What memory does

Clio Coder keeps task memory for a session: requirements, environment facts, failed attempts, and diagnoses. A rules tier runs without model calls. With no memory route of its own, the model tier uses your chat route within that route's cost, quota, or speed budget, so a default install spends some model calls on memory.

## See and approve lessons

Open `/memory` to see the lessons this session can reach, pending and rejected records beside approved ones, and what each one concerns. From the shell:

```sh
clio-coder memory list
```

Memory also keeps commands a completed task proved to work, from its own run records, and offers them when a later session touches the same files. A repository lesson becomes standing guidance only after it is approved.

## Turn it off or route it elsewhere

Set `context.memory.enabled: false`, or use `/settings` → **Context & Memory** → **Proactive memory**. To run memory on its own route, set both `context.memory.target` and `context.memory.model`.

Memory gives reminders; it does not replace reading the code or running the checks. See the full guide for how reminders are selected and when a lesson is promoted.
