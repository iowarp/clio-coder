# Fleet Dispatch

Clio Coder dispatches bounded worker agents. With a fleet configured, those
workers run on remote machines over SSH while the orchestrator keeps every
guarantee it makes locally: one admission path, one autonomy matrix, one
receipt chain. This page covers the architecture, node setup, the doctor
preflight, placement, topologies, failure semantics, and the residency
default. For the end-to-end demo see
[fleet-demo-runbook.md](fleet-demo-runbook.md).

Source of truth: `src/domains/dispatch/**`, `src/domains/scheduling/cluster.ts`,
`src/tools/dispatch.ts`, `src/tools/monitor.ts`, and the contract tests under
`tests/contracts/`.

## Architecture

The worker protocol is transport-neutral: the orchestrator writes one
WorkerSpec JSON line to the worker's stdin and reads NDJSON events from its
stdout. A remote worker is exactly the same protocol tunneled through
`ssh -T`, so nothing about prompts, safety, receipts, or telemetry changes
with distance. Transport is a ladder: `local` and `ssh` exist today; a future
container or cloud tier implements the same `WorkerTransport` interface
(`src/domains/dispatch/transport.ts`) without touching the protocol.

Design decisions that shape everything else:

- Per-node inference targets, no central proxy. Target URLs resolve on the
  node the worker runs on, so `localhost` in a worker's target means that
  node's own inference server. The orchestrator-resolved API key rides the
  WorkerSpec.
- Shared filesystem. Remote nodes see the project at the same absolute path.
  The doctor preflight verifies this parity per node; hosts with a disjoint
  filesystem fail admission with a clear reason.
- Deterministic placement. There is no scored or learned scheduler; placement
  is a fixed priority order the operator can predict and pin.
- Environment whitelist. The SSH command carries an explicit environment
  (`CLIO_RESIDENCY=observe`, `CLIO_WORKER_ANNOUNCE=1`); the orchestrator's
  `process.env` never crosses the wire.

## Node setup

Fleet nodes are declared under `fleet.nodes` in `settings.yaml`. The implicit
`local` node always exists and is never declared.

```yaml
fleet:
  nodes:
    - id: node-a
      host: node-a.example.net
      user: me                  # optional; defaults to the SSH config
      port: 22                  # optional
      identityFile: ~/.ssh/id_fleet   # optional
      labels: [cpu]             # optional operator labels
      maxWorkers: 2             # per-node cap; defaults to 2
      residency: observe        # observe (default) or manage
    - id: node-b
      host: node-b.example.net
      maxWorkers: 1
```

`clioEntry` may override the remote invocation (default `clio worker`).
Node ids must be unique and `local` is reserved.

Worker profiles can pin work to a node: `workers.profiles.<name>.node` routes
every dispatch bound to that profile. The `/fleet` overlay's profiles tab
edits the pin (`o` key), and the dispatch tool accepts an explicit `node`
argument per task.

## Doctor preflight

A remote node is dispatch-eligible only after one preflight pass proved, over
the node's real SSH channel:

1. reachability (SSH connects in batch mode),
2. a version-matched `clio` on the remote invocation path,
3. path parity for the project root (the shared-filesystem assumption),
4. a writable remote state directory.

Run it with `clio doctor`. Results persist under the state dir
(`fleet-preflight.json`) keyed by node and project root, so eligibility
survives across processes. A record is invalidated by a changed host, a
changed project root, or a local `clio` upgrade; admission then fails closed
with a reason that names the fix (run `clio doctor` again). Failing nodes are
doctor warnings, never fatal: the fleet degrades to the nodes that passed.

## Placement order

Placement resolves before the global concurrency slot, so a node admission
failure never holds capacity. The order is deterministic:

1. Explicit `node` on the dispatch request. Unknown, offline, unpreflighted,
   or full pins throw an admission error; they never silently fall back.
2. The worker profile or agent binding pin.
3. The least-loaded eligible remote node; declaration order breaks ties.
4. The local node.

With no fleet configured and nothing requested, placement resolves to null
and receipts stay byte-identical to pre-fleet Clio.

## Failure semantics

- Channel failures (a stalled heartbeat, a spawn failure, SSH exit 255) count
  against the node; completing the protocol counts for it; operator cancels
  are neutral.
- Two consecutive channel failures classify the node dead. Every other
  in-flight run on that node is reaped through the stall path, finalizes as
  `stalled` (retryable), and its bounded retry re-enters placement on a
  surviving node.
- Every failover hop is recorded as a reroute (`fromNode`, `toNode`, reason)
  on the ledger row and the receipt, so the placement lineage of a run is
  reconstructable from evidence alone.
- An idle node is never auto-offlined by staleness; death comes from channel
  failures, operator marks, or a failed preflight.

## Topologies

All topologies go through the dispatch tool, the same admission chain, and
the autonomy matrix. Workers never exceed the orchestrator's authority; a
request-level `autonomy` can only narrow the level (reviewers and judges run
`read-only`).

| Topology | Invocation | Semantics |
| --- | --- | --- |
| Parallel (default) | `tasks: [...]` | Fan out, wait for all, one summary. |
| Sequential | `mode: "sequential"` | One at a time, stop reporting on timeout/abort. |
| Pipeline | `mode: "pipeline"` | Each step receives the previous step's output as data. |
| Detached | `detach: true` | Return run ids and a batch id immediately; collect later. |
| Review gate | `review: {reviewer?, max_cycles?}` | Builder, read-only reviewer verdict, bounded revise loop. |
| Compete | `mode: "compete", candidates: 2..4` | N candidates in scratch worktrees, read-only judge, winner applied or preserved. |

### Detached fan-out and collect

`detach: true` validates, admits, and spawns every task, then returns. Runs
keep streaming into the board and the run ledger. The batch is durable
(`batches.json` under the state dir), so it survives session exit. Gather
results with the monitor tool: `mode="wait"` blocks on one run with a
timeout; `mode="collect"` is the barrier over a batch id or run-id list; a
pending snapshot while runs are in flight, full results once all are
terminal. Collecting marks the batch so the turn-end nudge stops firing.

### Review gate

The builder runs the task. A reviewer (default: the builder's agent under a
built-in reviewer persona, pinned to read-only autonomy, routable to a
different node, model, or target) inspects the workspace against the task and
ends with a `VERDICT: pass|revise|fail` line. A revise verdict re-runs the
builder with the findings threaded as input data, bounded by `max_cycles`
(default 2, max 4). Exhaustion, a fail verdict, or a broken reviewer surface
as an explicit operator decision, never a silent failure.

### Compete

N candidate builders (2 to 4) run the same task, each in its own scratch git
worktree under `.clio/worktrees/<group>/` on its own
`clio/compete/<group>/<n>` branch. Each candidate's work is committed on its
branch; a read-only judge ranks the branches and names a winner
(`WINNER: <n>`). At full-auto the winning branch is merged. At supervised
levels the winner's branch and worktree are preserved and the operator
confirms through `apply_winner`, whose approval prompt is the winner
confirmation. Losers are cleaned on every path, including abort.

### Plan approval

A plan-scale dispatch call (more than one task, compete, a remote node pin,
or `apply_winner`) maps to an approval ask at supervised autonomy levels. The
parked call shows the rendered plan artifact (topology, per-task agent,
model, node), and one approval covers the whole plan. Full-auto skips the
stop and seals the plan hash into every run's receipt instead
(`plan.approval: "full-auto"`). Read-only autonomy denies dispatch outright,
as it denies every non-read action.

## Receipts

Receipt integrity stays v3. Fleet dispatch adds optional, presence-gated
fields only, so every receipt sealed before this work still verifies:

- `node`: the fleet node the worker ran on (`id`, `kind`, `host`).
- `reroutes`: dead-node failover hops, oldest first.
- `gate`: review/compete provenance (role, group, cycle, subject run ids with
  their receipt digests, and the verdict that caused a revise builder).
- `plan`: plan-approval provenance (hash, topology, task count, approval).

Gate references point backward: a reviewer references the builder it
reviewed, a revise builder references the reviewer whose findings it
received, a judge references every candidate. The chain is reconstructable
newest to oldest from receipts alone.

## Operator visibility

- The dispatch board shows per-run cards with the node id (absent placement
  renders `local`), gate badges (`gate reviewer c2`), reroute badges, live
  tool activity (names only; arguments never cross the worker stdout seam),
  and a per-worker context meter.
- The context meter renders the worker's last-message context occupancy
  against the model's context window: healthy below 80 percent, warn from 80,
  critical from 95.
- `/fleet` cycles status (running and retrying runs with a node column),
  nodes (the registry view with state, capacity, and last-seen), profiles
  (with the node pin), and bindings.
- The monitor tool reports the node and reroute lineage on `status`, `list`,
  and `collect`.
- `clio fleet status [--json]` shows the durable ledger view cross-process.

## Speculation observer

A shadow-mode observer watches every dispatch, computes the plan a rule-based
pipeline would have chosen (synchronous keyword rules, no model calls), and
records plan-versus-actual accuracy into a bounded JSONL under
`<state>/speculation/observations.jsonl`. It never influences dispatch;
disabling it changes nothing else.

## Residency

Remote workers default to residency observe: the SSH transport exports
`CLIO_RESIDENCY=observe`, so a worker on a node that serves resident models
(for example a GPU box running the operator's inference server) never evicts
them. A node opts into management explicitly with `residency: manage` in its
fleet entry.
