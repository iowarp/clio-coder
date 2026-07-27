# Fleet Dispatch

> **Interactive Spec Available:** An interactive fleet node topology planner, scout router, receipt verifier, and failure taxonomy simulator is located at [docs/html/fleet_dispatch_blueprint.html](html/fleet_dispatch_blueprint.html) (Version: 0.2.9).

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

Both local and SSH native workers must emit `worker_announce` as their first
protocol event. The transport consumes it, checks the dispatched WorkerSpec
version, and accepts ordinary events only after that check. This is a
wire-contract initialization boundary: it proves that the expected worker
entry parsed the spec and speaks the dispatched protocol version. It is not
cryptographic process identity authentication; the child supplies its own
announcement. SSH also uses the announced remote pid for its kill fallback.

Scout routing is advisory rather than forced: the worker operating contract
steers explicit broad repository exploration to the read-only `scout` recipe,
and middleware emits a continuation nudge after nine or more manual
read-only exploration calls without a successful Scout dispatch. Direct reads
remain allowed; Clio does not automatically rewrite a broad request into a
Scout run.

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
  (`CLIO_RESIDENCY=observe`, `CLIO_WORKER_PGID=$$`, and any configured
  `CLIO_WORKER_LABELS`); the orchestrator's `process.env` never crosses the
  wire. `CLIO_WORKER_PGID` names the remote process group so an abort escalates
  against the whole group rather than one process.

## Worker prompt and budget admission

Dispatch resolves the recipe, target, effective autonomy, and final canonical toolkit before compiling one stable Clio worker harness. The harness contains identity-lite, the shared operating contract, the exact native tool surface (or honest no-tools wording), safety for the enforced autonomy, and the recipe or bounded override persona. Project context, memory, bounded briefing, pipeline input, task text, and run posture remain dynamic messages and therefore do not churn stable hashes. Briefing is explicitly untrusted task data and does not transport conversation or session history.

One run has a first-class singular shape: `task` is the worker assignment and
`briefing` is separate bounded context/data. Briefing never replaces task,
never gets copied into the receipt task, and remains a separately delimited
dynamic prompt message. `tasks` is the batch form. A shared top-level briefing
applies to string tasks and task objects without an override; an object-level
briefing wins. Supplying both `task` and `tasks` fails instead of choosing one.
After approval, execution consumes only the registry-owned resolved plan, so
later mutation of raw arguments cannot change either field.

Recipes may declare `budget: {toolCalls, readReserve, synthesis}`. `toolCalls` is the admitted-call phase boundary; the final `readReserve` slots accept only canonical `read`; `synthesis: true` forces a text-only final round, while `false` stops after the admitted phase. `guardrails.workerToolCallCap` is transported separately as a hard attempt ceiling and always wins when lower. Native workers and Claude SDK enforce this policy. Claude Code and Antigravity reject explicit-budget recipes because their black-box loops cannot provide equivalent per-call mediation; custom recipes without a budget retain the legacy runtime-default route.

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

With no fleet configured and nothing requested, placement resolves to null and
the optional node provenance remains absent. Current v6 receipt fields and
digest/version semantics still apply, so the complete receipt is not
byte-identical to a historical v4 or v5 receipt.

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
| Singular | `task: "..."` | One assignment, with optional separate `briefing`. |
| Parallel (default) | `tasks: [...]` | Fan out, wait for all, one summary. |
| Sequential | `mode: "sequential"` | One at a time, stop reporting on timeout/abort. |
| Pipeline | `mode: "pipeline"` | Each step receives the previous step's output as data. |
| Detached | `detach: true` | Return assignment ids and a batch id immediately; collect later. |
| Review gate | `review: {reviewer?, max_cycles?}` | Builder, read-only reviewer verdict, bounded revise loop. |
| Compete | `mode: "compete", candidates: 2..4` | N candidates in scratch worktrees, read-only judge, winner applied or preserved. |

### Detached fan-out and collect

`detach: true` validates, admits, and spawns every task, then returns. The
reported id is the logical assignment id (also the first attempt's run id).
Attempts keep streaming into the board and immutable run ledger. The batch and
assignment index are durable (`batches.json` and `assignments.json` under the
state dir), so collection survives session exit. Gather results with the
monitor tool: `mode="wait"` observes one assignment for a bounded time (it
never cancels it; `steer` with `action="cancel"` cancels its current attempt
and suppresses later attempts); `mode="collect"` is the barrier over a batch id
or assignment-id list. It returns a pending snapshot while assignments are in
flight, then each assignment's terminal attempt plus `attemptRunIds` history.
Collecting marks the batch so the turn-end nudge stops firing. `wait` observes
without collecting; `collect` is the authoritative terminal batch operation.
Collect every detached batch before final synthesis.

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

The compete group is a durable transaction owner. Its manifest records the
coordinator identity and every admitted worker process before the dispatch
handle is returned. At orchestrator startup, Clio uses process birth tokens
to distinguish the leased process from PID reuse, terminates an abandoned
worker or ACP process group, and then removes the group's registered
worktrees and branches. If a judge output is waiting in the decision journal,
the workers are quiesced but the candidates remain until that output is bound
to an integrity-verified judge receipt; a recovered winner is preserved for
operator inspection rather than silently auto-applied after restart.

### Plan approval

A plan-scale dispatch call (more than one task, review, compete, effective
remote placement, or `apply_winner`) maps to an approval ask at supervised
autonomy levels. Before asking, Clio resolves the effective agent, target,
model, node, bounded review cycles/candidates/judge, and scheduling cost
ceiling, then reserves the plan's capacity and budget as a unit. The parked
call shows that sanitized artifact, including the approved fallback candidates
in preference order, and one approval covers the whole plan. Declining the plan
rolls the whole reservation back.

A reservation holds three scarce things and nothing else: a global concurrency
slot, a per-node slot, and a budget upper bound. It never pins route identity.
Capacity and budget are checked for the plan as a unit at approval time, per
wave, so a three-step sequential plan holds one slot rather than three and N
parallel tasks whose individual estimates each fit but whose sum breaches the
ceiling are denied together with the aggregate figure. A member is consumed
once by its assignment and released once when that assignment settles; a retry
that lands on a different node or a differently priced route rebinds the member
atomically and fails closed if the new node has no free slot or the new
estimate breaches the ceiling. Reservations owned by a dead process are
reclaimed at startup, with a TTL as the backstop, and live sibling processes'
reservations are preserved. Execution consumes the
same pins, including each expanded builder/reviewer/candidate/judge role and
the SSH node's transport kind and host. A placement, host, capability, or
cost-ceiling change fails before launch rather than silently choosing an
unapproved alternative. Full-auto skips the stop and seals the
same plan hash into every run's receipt instead
(`plan.approval: "full-auto"`). Read-only autonomy denies dispatch outright,
as it denies every non-read action.

## Assignments, attempts, and failover

A dispatch is a logical assignment containing one or more immutable run
attempts. Its id is `lineage.rootRunId`, which is also the first attempt's run
id. Public `finalPromise` handles resolve only when the assignment succeeds,
is canceled, or exhausts its retry policy; the returned receipt is the
terminal attempt's unchanged receipt. Earlier attempts stay independently
addressable and integrity-verifiable.

The assignment owns the event stream as well as the terminal receipt. The
stream returned by `dispatch()` yields attempt 1's frames, then a synthetic
`attempt_start` frame for each retry, then that attempt's frames, and ends when
the assignment settles. A consumer therefore observes the same run the receipt
describes, and the marker tells it to discard state accumulated from an attempt
that has been superseded. The stream is single-consumer and bounded
(drop-oldest), so a slow reader degrades live display and never stalls a worker.

Manual `target`, `model`, or `node` pins default to exact failover (`none`): a
retry may repeat the tuple but cannot silently move away from it. `approved`
failover requires an ordered `allowedCandidates` envelope of exact
agent/target/model/node tuples and can never leave that set. `automatic`
failover lets typed infrastructure failures exclude only the failed route
part—for example, an SSH channel failure can move the node while retaining the
agent, target, and model. Cancellation, policy rejection, and permission
refusal neither retry nor penalize infrastructure.

A plan-approved task is never `automatic`. An explicitly pinned task seals its
exact tuple with `failover: "none"`; any other planned task seals
`failover: "approved"` with a bounded candidate list enumerated by
`route-candidates.ts` and rendered into the plan text the operator approves.
Validation rejects `automatic` on a request carrying plan provenance, so an
approved dispatch can only reroute to a tuple the approval actually showed.

Retries are governed by `workers.maxRetries` and backoff, and by nothing else.
A target cooldown protects new work from a known-bad target; it does not gate
an assignment already in flight, because that assignment's own retry budget is
the correct and sufficient bound. A retry denied at admission settles the
assignment failed, reports the reason on stderr, and records it in the
assignment's `outcomeDetail`.

Individual receipt schemas are intentionally unchanged. Assignment status,
attempt ids, and terminal run id are stored separately in `assignments.json`.
Pipelines and batches await assignment terminals, so downstream stages consume
the successful fallback output rather than an earlier failed attempt.

## Receipts

Receipts carry exactly one integrity version (`RUN_RECEIPT_INTEGRITY_VERSION = 6`), which authenticates the complete receipt and reconstructible ledger provenance surface. There is no historical verification path: any other version is invalid, and a receipt that fails verification is never read as evidence. The fleet provenance fields covered by the digest
include:

- `node`: the fleet node the worker ran on (`id`, `kind`, `host`).
- `reroutes`: dead-node failover hops, oldest first.
- `gate`: review/compete provenance (role, group, cycle, subject run ids with
  their receipt digests, and the verdict that caused a revise builder).
- `plan`: plan-approval provenance (hash, topology, task count, cost ceiling,
  approval kind, and the registry approval identity when supervised).
- `briefing`: byte count and SHA-256 of the exact canonical parent briefing;
  the prose is not retained and is distinct from bounded project context.
- `steering`: ordered byte/hash/timestamp and acknowledgement provenance for
  successfully written steers; steering prose is never stored.
- `outcomeCode`: the stable terminal classifier, including
  `worker_final_output_missing` when an otherwise successful worker exits
  without a nonempty receipt-sealed final answer.

Process exit zero is not a delegated deliverable. Native and ACP runs succeed
only when the drained event stream yields a nonempty receipt output with
`state: "final"`. A missing final answer fails with
`outcomeCode: "worker_final_output_missing"`; any captured unfinished text is
retained only as `state: "partial"` diagnostics and automatic retry is
suppressed. Dispatch, monitor, ledger, receipt, terminal bus event, and retry
policy all consume that same final classification.

Receipt integrity and evidence verification are separate axes. Integrity says
that the sealed receipt matches its ledger envelope; evidence verification
reports whether Clio observed an applicable validation tool (or marks the
basis unknown/not applicable). A read-only Scout can therefore report `receipt_integrity=verified/v6/sha256` alongside
`evidence_verification=not_applicable/read-only-agent`. Briefing provenance and
bounded `project_context` provenance are also rendered independently; neither
hash substitutes for the other.

Gate references point backward: a reviewer references the builder it
reviewed, a revise builder references the reviewer whose findings it
received, and a judge references every candidate. Because a worker receipt
seals before the coordinator parses its final verdict, terminal pass/fail,
exhaustion, winner, and confirmation outcomes are append-only integrity-
covered gate-decision artifacts under the state directory. Evidence builds
discover them from linked receipt ids and export `gate-decisions.json`.
Reviewer and judge terminal output first crosses an integrity-covered
write-ahead boundary under `state/gate-decisions/pending/`, before the caller
waits for the final receipt. Restart recovery verifies the receipt, applies
the same verdict/winner parser, materializes the final artifact idempotently,
and only then clears the pending record. Missing receipts, tampering, or a
conflicting artifact fail closed and leave the journal and any compete
worktrees available for inspection.

Protected-artifact hard blocks follow compete work into candidate worktrees:
Clio mirrors every applicable parent-checkout path into each admitted worker
spec and independently rejects a winner branch whose diff touches a protected
parent path. The merge/apply coordinator rechecks the live protection state,
so neither full-auto nor a later supervised winner approval can override that
hard block.

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

## Opt-in live regression

After `npm run build`, an operator with a configured model target can run the
single-turn, read-only fleet lifecycle check explicitly:

```bash
CLIO_LIVE_EVAL=1 npm run test:live-eval:fleet-dispatch
```

It is not part of deterministic CI. The script copies the repository into an
isolated committed workspace, sandboxes all Clio config/state/data/cache,
exercises Scout, bounded spot-checking, detached Debugger briefing, steering,
wait, and collect, and fails if any workspace content changes. Failures retain
their isolated artifacts for diagnosis.
