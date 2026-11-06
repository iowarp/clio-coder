---
name: hpc-chronolog
description: "Uses ChronoLog as durable, time-ordered memory for HPC runs through its MCP server: chrono-mcp from a released ChronoLog 3.x tree, or chronolog-mcp from an unreleased ChronoLog 4.0 development build. Records run events and reads them back, quoting what the server says about completeness. Not for deploying ChronoLog across a cluster or for application logging."
---

# ChronoLog for run records

ChronoLog is a distributed log store. A chronicle holds stories, a story holds
events, and every event gets a global, time-ordered timestamp when a Keeper
accepts it. Each read ends with a verdict that says whether the answer is
complete for its time range. That makes it a good record of what a campaign of
runs did, which several agents can share and later replay. It runs on the
cluster's own network and needs no internet access.

## Phase 0 - Which ChronoLog is here?

1. `gateway(op="find", query="chronolog")`. A declared ChronoLog server can run
   from an absolute path that is not on `PATH`, so its tools decide the line:
   - `start_chronolog`, `record_interaction`, `retrieve_interaction`: chrono-mcp
     from the released ChronoLog 3.x line (latest 3.4.0). Follow "Released
     ChronoLog 3.x" below and skip Phases 1 to 3.
   - `context_open`, `context_remember`, `context_recall`: chronolog-mcp from a
     ChronoLog 4.0 development build. 4.0 is not released (no release, not on
     PyPI). Say that it is unreleased, then continue with Phase 2.
2. No server is declared: `bash`: `command -v chronolog chronolog-mcp`.
   - Neither exists: stop and say that ChronoLog's MCP server is not installed
     here. Do not guess an install.
   - `chronolog-mcp` exists but `chronolog` does not: the released 3.x line.
     Its MCP server, chrono-mcp, ships in the ChronoLog source tree at
     `plugins/chrono-mcp` and installs the command `chronolog-mcp`. Show the
     operator the 3.x declaration below; nothing can be recorded until it is
     declared and trusted.
   - Both exist: a ChronoLog 4.0 development build, built from source (GCC 13,
     CMake 3.25+, vcpkg, Python 3.12+); the `chronolog` launcher and
     `chronolog-mcp` 4.0 come from its wheels. Say that it is unreleased and
     continue with Phase 1.
3. 4.0 with the launcher on `PATH`: `chronolog doctor` names the service executables it would run, and
   `chronolog ls` lists registered instances. A `ready` instance can be used. A
   `degraded` one needs `chronolog logs <name> --service supervisor --lines 40`
   before anything else.
4. Same case: start an instance only when the user asks: `chronolog up default`,
   then `chronolog status default --probe`. Leave it running when the session
   ends; `chronolog down default` is the user's decision.

## Released ChronoLog 3.x (chrono-mcp)

chrono-mcp talks to a running ChronoLog 3.x deployment through the
`py_chronolog_client` module of that ChronoLog build, which its Python
environment must be able to import. The operator declares it in the user file
`<Clio config directory>/mcp.yaml`, run from the ChronoLog checkout:

```yaml
version: 1
servers:
  - id: chronolog
    command: uv
    args: [--directory, <ChronoLog checkout>/plugins/chrono-mcp, run, chronolog-mcp]
    env:
      CHRONO_HOST: <ChronoVisor host>
      CHRONO_PORT: "5555"
      CHRONICLE_NAME: runs
      STORY_NAME: <campaign>
    toolActionClasses:
      retrieve_interaction: read
      start_chronolog: execute
      record_interaction: execute
      stop_chronolog: execute
```

Its other settings are `CHRONO_PROTOCOL` (default `ofi+sockets`),
`CHRONO_TIMEOUT`, and `CHRONO_QUERY_HOST`, `CHRONO_QUERY_PORT` and
`CHRONO_QUERY_PROVIDER_ID` for replay through ChronoPlayer; Clio passes the
server only what `env` names. The tools are `start_chronolog(chronicle_name,
story_name)`, `record_interaction(user_message, assistant_message)`,
`retrieve_interaction(chronicle_name, story_name, start_time, end_time)` and
`stop_chronolog()`. The server records message pairs: write each run event as
`record_interaction` with the operation id (such as `slurm-4211-completed`) as
`user_message` and the short JSON content as `assistant_message`. It has no
idempotent operation ids and returns no completeness verdict, so never retry a
write blindly, and say when you read back that 3.x cannot state whether the
answer is complete. clio-kit's own ChronoLog server is being retired in favor
of chrono-mcp; do not declare it.

## Phase 1 - Connect Clio (4.0 development builds)

Clio reaches ChronoLog 4.0 through its `chronolog-mcp` server. This pack does not
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

chronolog-mcp 4.0 declares no tool annotations. Without `toolActionClasses`, every
call is `unknown`: it asks at `default`, and a headless run denies it.

Clio gives an MCP server only a small set of safe environment variables, so
anything the server needs (`CHRONOLOG_MCP_IDENTITY`, `CHRONOLOG_CHRONICLE`,
`CHRONOLOG_HOME`, `CHRONOLOG_CATALOG`) must be written in `env` there. It is
not inherited from the shell. Without an identity, only `access="read_only"`
opens work. Then find the tools with `gateway(op="find", query="chronolog")`.

## Phase 2 - Record a run (4.0)

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

## Phase 3 - Read it back (4.0)

`context_recall(session_handle)` pages through events in order;
`context_latest(session_handle, n=10)` gives the newest. Read `answer_complete`
and `verdict` before trusting what you see. If `answer_complete` is false, the
read is partial, and an absent event is not evidence that nothing happened.
After a crash, `context_status` lists unresolved operation ids, and
`context_reconcile` settles them. Do not write the event again under a new id.

## Final answer

Name the ChronoLog line (released 3.x or unreleased 4.0 development), the instance or deployment, the chronicle and context or story, and each operation id you wrote.
Quote the recall verdict for any claim about what the record does or does not
contain.
