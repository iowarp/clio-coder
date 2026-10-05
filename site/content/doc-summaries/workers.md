## Delegate a focused task

A worker handles a bounded task while Clio Coder keeps the main conversation. Start with an explicit goal, files it may change, and the checks it should report.

```sh
clio-coder agents
clio-coder run "Inspect the parser's test coverage and report gaps. Do not edit files." --agent verifier
```

Use an agent ID from your installed catalog. In the terminal, `/run` starts a worker; `/delegate` selects a configured ACP peer. **Fleet** in Settings chooses worker defaults without changing the chat model.

## Follow the work

Open **Workers** with Alt+W to inspect active runs. Select a running worker and use the displayed steer or cancel action. In a session with panes, Alt+W opens a live dashboard beside the conversation instead. You can also send an addressed message:

```text
@<agentId-or-runId-prefix> Focus on empty input and report the existing tests.
```

A steering message first reports queued, then received when the worker acknowledges it. Some external runtimes have no live steering channel; the interface identifies that limit. Review each run's recorded result before using its conclusions.

## Permissions, sandbox, and merges

Native workers run their shell, script, and verification commands in an OS sandbox: bubblewrap on Linux, or an experimental `sandbox-exec` profile on macOS. With the default `safety.sandbox: auto`, they run unsandboxed when no sandbox works; `required` refuses them instead, and `off` disables it. `safety.sandboxNetwork: true` allows network access. Your own session's commands are not sandboxed.

When a worker's task branch would merge with a failing or unrun check, the terminal asks first with a **Merge task branch?** card showing the branch, changed paths, and the check. The card opens on **Keep branch**. Headless and ACP runs always keep the branch.

## Compose a fleet when you need one

```sh
clio-coder fleet list
clio-coder fleet status
```

Fleet recipes combine workers into workflows such as a review gate, competing solutions, or a council. Inspect the recipe and approval preview before starting one.

Remote native workers use SSH and need the same Clio Coder version and the project at the same absolute path on each node. Add a node with `clio-coder fleet nodes add`, or in the terminal under `/settings fleet`.

A node receives work only after `clio-coder fleet nodes test <id> --record` passes for this project; the record lasts one day. Adding a node moves nothing by itself: unpinned work stays local.

Start locally with one worker. Use the full guide for remote-node configuration, capacity, recipe contracts, and failure recovery.
