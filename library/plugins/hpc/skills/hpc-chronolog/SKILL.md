---
name: hpc-chronolog
description: "Uses ChronoLog 4.0 as durable, time-ordered memory for HPC runs: connects Clio to a ChronoLog instance through chronolog-mcp, records run events under stable operation ids, and reads them back with an explicit completeness verdict. Not for deploying ChronoLog across a cluster or for application logging."
---

# ChronoLog for run records

ChronoLog is a distributed log store. A chronicle holds stories, a story holds
events, and every event gets a global, time-ordered timestamp when a Keeper
accepts it. Each read ends with a verdict that says whether the answer is
complete for its time range. That makes it a good record of what a campaign of
runs did, which several agents can share and later replay. It runs on the
cluster's own network and needs no internet access.

## Phase 0 - Is ChronoLog reachable?

1. `bash`: `command -v chronolog chronolog-mcp`. ChronoLog 4.0 is not on PyPI
   yet. It is built from source (GCC 13, CMake 3.25+, vcpkg, Python 3.12+), and
   the `chronolog` launcher and `chronolog-mcp` come from its wheels. If neither
   command exists, stop and say that ChronoLog is not installed here.
2. `chronolog doctor` names the service executables it would run, and
   `chronolog ls` lists registered instances. A `ready` instance can be used. A
   `degraded` one needs `chronolog logs <name> --service supervisor --lines 40`
   before anything else.
3. Start an instance only when the user asks: `chronolog up default`, then
   `chronolog status default --probe`. Leave it running when the session ends;
   `chronolog down default` is the user's decision.

## Phase 1 - Connect Clio

Clio reaches ChronoLog through the `chronolog-mcp` server. This pack does not
declare it, because the server needs a site install and a writer identity that
only the operator can choose. The operator declares it in the user file
`<Clio config directory>/mcp.yaml`:

```yaml
version: 1
servers:
  - id: chronolog
    command: chronolog
    args: [run, --up, default, --, chronolog-mcp]
    env:
      CHRONOLOG_MCP_IDENTITY: hpc/clio
      CHRONOLOG_CHRONICLE: runs
    toolActionClasses:
      context_recall: read
      context_latest: read
      context_follow: read
      context_list: read
      context_status: read
      instance_list: read
      context_open: execute
      context_remember: execute
      context_reconcile: execute
      context_checkpoint: execute
      context_close: execute
      instance_control: destructive
```

chronolog-mcp declares no tool annotations. Without `toolActionClasses`, every
call is `unknown`: it asks at `default`, and a headless run denies it.

Clio gives an MCP server only a small set of safe environment variables, so
anything the server needs (`CHRONOLOG_MCP_IDENTITY`, `CHRONOLOG_CHRONICLE`,
`CHRONOLOG_HOME`, `CHRONOLOG_CATALOG`) must be written in `env` there. It is
not inherited from the shell. Without an identity, only `access="read_only"`
opens work. Then find the tools with `gateway(op="find", query="chronolog")`.

## Phase 2 - Record a run

- `context_open(name="<campaign>", create=true)` returns a `session_handle`.
  The default `access` is `read_write`.
- For each event, call `context_remember(session_handle, operation_id, content)`
  with an `operation_id` derived from what the event is, such as
  `slurm-4211-submitted` or `slurm-4211-completed`. Never use a random one. A
  retry with the same id is idempotent: one event, the same receipt.
- Content is a short JSON object: the job id, the script and its sha256, the
  parameters, the terminal state, and the output path. Pointers and hashes go
  in the event, not bulk data.
- `context_close(session_handle)` when done. Closing never stops the stack.

## Phase 3 - Read it back

`context_recall(session_handle)` pages through events in order;
`context_latest(session_handle, n=10)` gives the newest. Read `answer_complete`
and `verdict` before trusting what you see. If `answer_complete` is false, the
read is partial, and an absent event is not evidence that nothing happened.
After a crash, `context_status` lists unresolved operation ids, and
`context_reconcile` settles them. Do not write the event again under a new id.

## Final answer

Name the instance, the chronicle and context, and each operation id you wrote.
Quote the recall verdict for any claim about what the record does or does not
contain.
