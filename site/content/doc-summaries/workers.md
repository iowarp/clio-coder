## Delegate a focused task

A worker handles a bounded task while Clio keeps the main conversation. Start with an explicit goal, files it may change, and the checks it should report.

```sh
clio-coder agents
clio-coder run "Inspect the parser's test coverage and report gaps. Do not edit files." --agent verifier
```

Use an agent ID from your installed catalog. In the terminal, `/run` starts a worker; `/delegate` selects a configured ACP peer. **Fleet** in Settings chooses worker defaults without changing the chat model.

## Follow the work

Open **Workers** with Alt+W to inspect active runs. Select a running worker and use the displayed steer or cancel action. You can also send an addressed message:

```text
@<agentId-or-runId-prefix> Focus on empty input and report the existing tests.
```

A steering message first reports queued, then received when the worker acknowledges it. Some external runtimes have no live steering channel; the interface identifies that limit. Review each run's recorded result before using its conclusions.

## Compose a fleet when you need one

```sh
clio-coder fleet list
clio-coder fleet status
```

Fleet recipes combine workers into workflows such as a review gate, competing solutions, or a council. Inspect the recipe and approval preview before starting one. Remote native workers use SSH and require the project at the same absolute path on each configured node; doctor checks that setup.

Start locally with one worker. Use the full guide for remote-node configuration, capacity, recipe contracts, and failure recovery.
