# Fleet Dispatch

> **Interactive Spec Available:** An interactive fleet node topology planner, scout router, receipt verifier, and failure taxonomy simulator is located at [docs/html/fleet_dispatch_blueprint.html](html/fleet_dispatch_blueprint.html) (Version: 0.3.6).

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
protocol event over the structured stderr control lane. The transport consumes it,
checks the dispatched WorkerSpec version, and accepts ordinary events only after
that check. The worker then attests protocol version (WORKER_PROTOCOL_VERSION = 1),
spec version, process ID, process group ID (or null), host, settings fingerprint,
worker-computed spec digest, runtime ID, target ID, endpoint identity hash, wire
model ID, effective tool signature, and bounded node resource facts (labels, CPU count,
total memory, free memory, GPU count, VRAM, and resident models) before any model
call. Drift from the approved identity kills the whole process group. The announcement and
attestation are strict protocol evidence, not proof against a malicious child
that controls its own process; SSH also uses the attested remote process group
for bounded abort escalation.

Scout routing is advisory rather than forced: the session's Delegation
passage steers explicit broad repository exploration to the read-only `scout` recipe,
and middleware emits one advisory notice after nine or more manual
read-only exploration calls without a successful Scout dispatch. The advisory
costs no extra model round. Direct reads remain allowed; Clio does not
automatically rewrite a broad request into a Scout run.

Design decisions that shape everything else:

- Per-node inference targets, no central proxy. Target URLs resolve on the
  node the worker runs on, so `localhost` in a worker's target means that
  node's own inference server. The orchestrator-resolved API key rides the
  WorkerSpec.
- Shared filesystem. Remote nodes see the project at the same absolute path.
  The doctor preflight verifies this parity per node; hosts with a disjoint
  filesystem fail admission with a clear reason.
- Deterministic placement and measured routing. Exact pins remain exact.
  Unpinned placement prefers lower durable lease usage and declaration order;
  the cross-process lease state is the final capacity authority. Route quality
  can be activated only for named roles/postures after exact-tuple readiness,
  and hard constraints always eliminate before any score.
- Environment whitelist. The SSH command carries an explicit environment
  (`CLIO_CODER_RESIDENCY=observe`, `CLIO_CODER_WORKER_PGID=$$`, and any configured
  `CLIO_CODER_WORKER_LABELS`); the orchestrator's `process.env` never crosses the
  wire. `CLIO_CODER_WORKER_PGID` names the remote process group so an abort escalates
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

Recipes declare a default with `budget: {toolCalls, readReserve, synthesis}`. They may also declare `maximum: {toolCalls, readReserve}` inside that object. A recipe without `maximum` is an exact pin, which preserves the fixed behavior of existing recipes. A ranged recipe admits the optional dispatch request `budget: {toolCalls, readReserve, retryRevision?}` only when the request is inside its maximum. `retryRevision` has the same two integer fields and preauthorizes the ceiling that a later automatic retry, bounded result-contract revision, or review revision may select. The loop guard raises a result-contract revision boundary only in this case. A phase without that ceiling cannot grow and retains the existing text-only repair behavior.

`toolCalls` is the admitted-call phase boundary. The final `readReserve` slots accept canonical `read` plus the agent's granted mutation tools, so a writer can still deliver inside its own reserve. Admission requires integers and `0 <= readReserve < toolCalls` for every declared phase. `synthesis: true` forces a text-only final round, while `false` stops after the admitted phase. `guardrails.workerToolCallCap` remains the operator-controlled lifetime ceiling and always wins when lower. A default may be clamped by a lower operator cap so default callers retain their prior behavior; an explicit request outside the operator cap is denied.

Admission computes one immutable envelope with the recipe policy, invocation request, effective worker budget, and every clamp or escalation reason. Native workers and Claude SDK enforce the effective budget. Claude Code, Antigravity, and ACP delegation reject invocation envelopes because their black-box loops cannot provide equivalent per-call mediation. Before launch, every admitted WorkerSpec v3 still contains one concrete effective budget and a settings fingerprint. The envelope provenance is sealed in the run ledger and receipt and appears in monitor, fleet status, and the live fleet card.

## Node setup

Fleet nodes are declared under `fleet.nodes` in `settings.yaml`. The implicit
`local` node always exists and is never declared. A run's node is the host its
worker process ran on, never the host serving the model, so a run against a
remote target from this machine still records `node: local`.

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

`clioCoderEntry` may override the remote invocation (default `clio-coder worker`).
Node ids must be unique and `local` is reserved.

Worker profiles can pin work to a node: `workers.profiles.<name>.node` routes
every dispatch bound to that profile. Settings → Fleet (`/fleet`) edits the
pin on the profile's `node` row, and the dispatch tool accepts an explicit
`node` argument per task.

## Doctor preflight

A remote node is dispatch-eligible only after one preflight pass proved, over
the node's real SSH channel:

1. reachability (SSH connects in batch mode),
2. a version-matched `clio-coder` on the remote invocation path,
3. path parity for the project root (the shared-filesystem assumption),
4. a writable remote state directory,
5. node-scoped target reachability, runtime/model compatibility, endpoint
   identity, and explicit resource facts where the target exposes them.

Run it with `clio-coder doctor`. Results persist under the state dir
(`fleet-preflight.json`) keyed by node and project root, so eligibility
survives across processes. A record is invalidated by a changed host, a
changed project root, or a local `clio-coder` upgrade; admission then fails closed
with a reason that names the fix (run `clio-coder doctor` again). Failing nodes are
doctor warnings, never fatal: the fleet degrades to the nodes that passed.

## Placement and process-safe admission

Placement and admission are separate, deterministic authorities:

1. An explicit request pin, profile pin, or approved route envelope restricts
   the eligible node set. Unknown, offline, stale-preflight, or incompatible
   pins fail closed; they never silently fall back.
2. For unpinned eligible nodes, placement prefers lower durable lease usage
   read through the fleet registry; declaration order breaks ties.
3. The capacity lease store decides under one cross-process state lock (`dispatch-admission.json`).
   A stale placement preference cannot over-admit a node.
4. If a pinned or selected node is momentarily full, the bounded admission
   queue preserves priority/FIFO order until its finite deadline instead of
   silently selecting another node.

The durable capacity state file (`dispatch-admission.json`) uses schema version 2 and owns global and per-node leases, heartbeats, reservation transfer, retry rebinding, and the TTL-bounded operator drain (`DEFAULT_CAPACITY_DRAIN_TTL_MS` = 3,600,000 ms). A lease acts as durable expiring authority (`DEFAULT_CAPACITY_LEASE_TTL_MS` = 30,000 ms) and is reclaimed only with owner-liveness evidence when a process birth token cannot prove process death. A plan reserves its peak wave, and a retry rebinds the same assignment member to its actual node and cost bound so that an assignment retry belongs to its existing plan slot and cannot queue behind or outspend itself. Full leasing schema and locking protocols are specified in [capacity-and-scheduling.md](capacity-and-scheduling.md).

Use `clio-coder fleet drain [--json]` before maintenance to close that shared
admission authority. Existing workers continue, but new plans and every new
execution start—including a retry or a previously reserved member—fail closed.
The drain expires after one hour so an abandoned operator process cannot wedge
future dispatch; repeating the command renews the deadline. `clio-coder fleet
status [--json]` reports the active deadline, requesting PID, and request time.
Use `clio-coder fleet resume [--json]` to reopen admission early. Detailed drain mechanics are documented in [capacity-and-scheduling.md](capacity-and-scheduling.md).

With no fleet configured and nothing requested, placement resolves to the
implicit local path and optional fleet-node provenance may remain absent.
Every new receipt uses strict integrity v16; older receipt formats are not
accepted by the current reader.

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
- An idle node is never auto-offlined by staleness; only consecutive channel
  failures change the process-local registry health to `offline`. Doctor
  preflight is a separate durable eligibility gate: a failed or stale record
  blocks placement without pretending it changed channel health.
- A result-contract repair round is a synthetic tool exchange, and its assistant
  half carries explicit zero usage. Request sizing reads usage from every
  assistant message that is not aborted or errored, and a repair message with no
  usage crashed the worker one round after its terminal message. Zero usage is
  skipped by the estimator, so the model's last real usage still anchors the
  estimate and the worker survives the repair round (#70).

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
| Detached | `detach: true` | Return logical assignment ids and a batch id immediately; collect later. |
| Review gate | `review: {reviewer?, max_cycles?}` | Builder, read-only reviewer verdict, bounded revise loop. |
| Compete | `mode: "compete", candidates: 2..4` | N candidates in scratch worktrees, read-only judge, winner applied or preserved. |
| Agent automation | `agent: "auto"` | Baselines candidate agent from task shape via shared classifier (`coder`, `tester`, `documenter`, `verifier`, `researcher`, `scout`); advisory unless activated. |

### Typed intent and host-run verification

The singular request and every object in `tasks` accept an optional `intent`:

```json
{
  "read_roots": ["src/domains/dispatch"],
  "write_roots": ["src/tools"],
  "relevant_paths": ["docs/fleet-dispatch.md"],
  "expected_outputs": ["dist/cli.js"],
  "verification": [{ "check": "test", "timeout_ms": 600000 }]
}
```

A top-level intent is inherited by batch items unless an item supplies its own
intent. `gate: "test"` is exact shorthand for
`intent.verification: [{check: "test"}]`; supplying both spellings is refused.
Every path is normalized into a sorted, duplicate-free repository-relative
POSIX path list before approval. Absolute paths, empty paths, root escapes,
malformed entries, and values beyond the documented caps fail admission.
Normalized `intent.writeRoots` feeds the existing worker write-boundary
enforcement when no legacy `JobSpec.writeRoots` exists. Conflicting declarations
are refused as `intent_write_roots_contradiction`.

Verification values are declared check ids, never shell commands. Admission
resolves each id from a package script or `.clio-coder/verifiers.yaml`, clamps
the requested timeout to the declaration, and freezes the exact argv, cwd,
timeout, and normalized intent into the execution snapshot and plan hash. A
later catalog edit cannot change the approved command. Undeclared ids fail
before approval with `verification_check_undeclared` and declaration guidance.

After a successful worker attempt, the orchestrator runs the frozen checks with
no shell, a fixed cwd, and the code-step environment allowlist. Logs are written
under the run artifact directory. Successful evidence is memoized by the
workspace fingerprint, resolved argv, cwd, and allowed environment values. A
memo hit names the run that produced the original evidence. A changed tree is a
miss. An unsuccessful worker records `hostVerification.status="skipped"` with
`reason="worker_not_successful"`; a failed host check records `rejected` with
its exit code, bounded output tail, and artifact path. Worker-reported command
success never populates this status.

Host checks are supported for singular, parallel, sequential, pipeline, and
detached native runs. Review and compete accept intent paths and outputs but
refuse verification entries with `verification_unsupported_for_mode`.
Claude Code subprocess routes refuse them with
`verification_unsupported_runtime`.

### Agent ledger

Every topology that runs more than one worker at once opens an agent ledger, the
bounded coordination board those workers share while they run: the parallel
fan-out (`src/tools/dispatch.ts:3247`), a detached batch of two or more
(`:538`), and compete (`:1549`). A worker reaches it through the `ledger` tool
and posts one of three typed entries. A `claim` stakes path prefixes so peers
stop colliding, a `finding` reports one observation with the path and line that
ground it, and a `review` judges another entry by its id. Nothing untyped is
postable, and a run gets 20 posts.

The orchestrator is the sole writer. A post travels up the control lane as a
body and nothing else, and every attribution field is stamped from the
orchestrator's own admission record, so no worker-supplied value can reach a
field a peer or a receipt reads as identity. Admitted entries are pushed back
down as `ledger_delta` stdin frames into a per-worker mirror, so a read answers
locally with a watermark instead of blocking on a round trip. A worker that
spawns late is handed the whole board twice over: the hub replays it on
subscription, and it is rendered into that worker's dynamic prompt messages at
spawn as untrusted peer data.

The reducers never merge. Citations are compared in workspace-relative form, so
`./src/a.ts` and the absolute path of that file are one path. A path cited by
two or more runs is corroborated, a path cited by one is uncorroborated and still rendered standing on its own, a
finding with no citation is an ungrounded lead, and an entry a review failed is
marked disputed where it stands. Overlapping claims from different runs carry
the ids they overlap, which is advisory; the per-wave write boundary is what
actually stops two writers.

When the board closes depends on where the batch settles. An attached parallel
fan-out closes it when the tool call returns, and compete closes it once every
candidate and the judge have settled. A detached batch, and a parallel batch the
operator moved to the background, carry the ledger id on the durable batch
record and close it on the first `monitor(mode="collect")`, because their peers
stay concurrent past the call that started them. After the close, appends are
refused and counted.

The main model reads the board too, once its workers have all settled. The
parallel dispatch result, the compete result, and `monitor(mode="collect")` for
a detached batch each carry one `agent ledger (<n> entries, sequence <w>)`
section after the per-run lines, holding the same bounded render a worker sees,
with the same attribution and the same corroboration and dispute marks and
still no count, score, or consensus line. The same text is on the result's
`details.agentLedgerBoard`. A board nobody posted to is omitted, so a
single-run dispatch and an unused board read exactly as they did before.

What survives into a receipt is that run's `ledgerContribution`, which is the
ledger id, its posted and refused counts, and a sha256 over its own attributed entries, sealed orchestrator-side
and covered by receipt integrity.

### Detached fan-out, backgrounding, and collect

`detach: true` validates, admits, and spawns every task, then returns. The
reported id is the logical assignment id (also the first attempt's run id).
For an in-flight attached dispatch, pressing `Alt+S` or `Ctrl+Alt+B` converts
the running attached dispatch into a detached batch. Backgrounding checks
against a refusal table: it refuses Scout dependency plans driving stages from
the turn, compete judge gates, review cycle gates, multi-step pipelines,
dispatches with explicit `timeout_ms`, or missing detached records.

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

The builder runs the task. A reviewer then inspects the workspace against the
task. The reviewer defaults to the builtin `verifier` recipe
(`DEFAULT_GATE_DECIDER_AGENT_ID`) and never falls back to the builder's own
agent; it is pinned to read-only autonomy and is routable to a different node,
model, or target.

The reviewer answers a typed `verifier-report` contract rather than trailing
prose:

```json
{"verdict":"pass","checks":[{"name":"npm run typecheck","passed":true,"evidence":"exit 0"}]}
```

`revise` is not a verdict a model authors. The reviewer answers `pass` or
`fail`, and `decideReviewGate` in
`src/domains/dispatch/gate-decisions.ts` owns the continuation policy: a
non-passing verdict below the terminal cycle becomes `revise` and re-runs the
builder with only the failed checks threaded as input data, bounded by
`max_cycles` (default 2, max 4). On the terminal cycle the verdict settles as
reported. A reviewer that produces no structured result settles as `exhausted`
and surfaces as an explicit operator decision, never a silent failure.

### Compete

N candidate builders (2 to 4) run the same task, each in its own scratch git
worktree under `.clio-coder/worktrees/<group>/` on its own
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

### ExecutionPlan and plan approval

Every orchestration shape compiles to one strict ExecutionPlan v2 DAG with
stable task ids, explicit dependencies, requested and approved authority,
capacity-bounded waves, stop/continue semantics, and authenticated structured
handoffs. The scheduler performs whole-plan preflight and reservation before
the first worker spawns. A missing authority grant is an admission failure.

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

The registry boundary is resolved dispatch plan v3. `deadlineMs` is required:
a fleet plan carries a positive finite number and a non-fleet plan carries
explicit `null`. Older versions, missing fields, and compatibility shapes are
rejected.

### Shipped fleets and contract versions

Clio ships three builtin fleet contracts under `src/domains/agents/fleets/`: `build-test`, `build-review`, and `sdlc`. Projects can declare custom fleet contracts or shadow builtin fleets by placing Markdown files under `.clio-coder/fleets/<name>.md`. A file named `.clio-coder/fleets/<name>.md` shadows a builtin fleet of the same name.

Fleet contracts support schema versions 1 through 4:
- Version 1: Supports agent steps only.
- Version 2: Introduces deterministic code steps.
- Version 3: Adds bounded check/repair loops and commit steps with `commitFrom` message sources.
- Version 4 (`FLEET_WRITE_BOUNDARY_VERSION = 4`): Introduces per-step declared write boundaries (`writes`) and orchestrator post-step enforcement.

### Per-step write boundaries (Contract v4)

Contract v4 requires every step to declare its write boundary using the `writes` allowlist property. Steps with scope `readonly` declare an empty allowlist (`[]`).

The grammar for declared write boundary entries requires repository-relative POSIX paths:
- Trailing `/` indicates a directory subtree allowlist.
- Exact relative paths without a trailing `/` permit changes to that single file.
- Declarations must not contain glob characters (`*`, `?`, `[`, `]`, `{`, `}`), `..` or `.` segments, backslashes, or absolute paths.
- Each step declaration is capped at a maximum of 32 entries (`WRITE_BOUNDARY_MAX_ENTRIES = 32`).

Write boundary enforcement is detect-and-rollback, never OS or filesystem sandboxing. A step runs with whatever filesystem permissions its underlying execution environment possesses. Upon step completion, the orchestrator inspects the working tree to verify compliance:
1. Snapshot baseline: Before a step executes, the orchestrator captures a snapshot (`captureWorkspaceSnapshot`) recording the baseline git HEAD commit and existing dirty path content tokens.
2. Workspace diffing: After step completion, the orchestrator runs git status inspection (`diffWorkspace`) to identify changed paths relative to the snapshot baseline commit.
3. Rollback execution: Unauthorized changes (modified paths not covered by the step's declared allowlist) are automatically rolled back (`rollbackPath`).
4. Content source: Rollback restores content strictly from what git already has in the pinned baseline commit (`snapshot.head`). If a path was already dirty when the step snapshot was captured, its prior content is not stored in git, so in-place restoration cannot be guaranteed. The working tree is left as the step made it, and the status settles as `rollback-incomplete`.
5. Violation handling: Any unauthorized change fails the step with the typed reason `writes_boundary_violation`.
6. Window attribution: Enforcement evaluates scheduling windows (`wave-<n>` or `revalidate-<stepId>-<n>`). A wave window cannot combine steps with overlapping declared boundaries or multiple concurrent step writers, ensuring single-step attribution.
7. Ignored paths and state subtraction: Enforcement evaluates paths reported by git status. Git-ignored paths remain outside enforcement. The Clio state directory (`.clio-coder/` or `clioStateDir()`) is subtracted from status checks so orchestrator receipts, code step log artifacts, and boundary verdicts do not trigger false violations.
8. Durable records: Verdicts are serialized as JSON records at `write-boundaries/<rootId>/<window>.json` under the Clio state directory, carrying the baseline HEAD commit, checked paths, violations, rollback actions, status, and SHA-256 digest.

### Bounded check/repair loops

Contract v3 and v4 support declared check/repair loops (`kind: loop`). A loop declares `id`, `maxAttempts` (an integer between 1 and `FLEET_LOOP_MAX_ATTEMPTS = 5`), `check` (a code command or agent reviewer), and `repair` (an agent coder).

At plan compilation, the orchestrator unrolls each loop statically into a deterministic hashed DAG containing `maxAttempts` verification check steps (`<loopId>.check.<n>`) and `maxAttempts - 1` repair steps (`<loopId>.repair.<n>`).
- Receipt per attempt: Every attempt in an unrolled loop executes as an independent plan node and produces its own receipt.
- Recovery role: Repair attempts following the first check are assigned the `recovery` execution role.
- Spent bounds: Reaching `maxAttempts` without a passing check settles the loop with the terminal reason `loop_bound_exhausted`.
- Four terminal reasons: A loop concludes with one of four reasons: `resolved` (verification passed), `loop_bound_exhausted` (attempt ceiling spent), `loop_step_failed` (underlying step errored or was denied), or `loop_not_reached` (prior plan dependencies failed).
- Node counting: Unneeded nodes (verifications or repairs remaining after a loop resolves) are counted separately from skipped nodes.
- Verification staleness: The scheduler enforces verification staleness by re-running a check step if a subsequent workspace-editing step executes after it.

### Deterministic code steps

Deterministic code steps (`kind: code`) execute known commands directly as subprocesses rather than calling an agent model.
- Registry binding: The `command` property must reference a command ID declared in `.clio-coder/fleets/commands.yaml`. Invocation strings are never generated from model output.
- Execution environment: Code steps run unattended with arguments bound from the command registry, fixed working directory, closed environment allowlist (`FLEET_COMMAND_BASE_ENV` plus declared command env), bounded timeout (`timeoutMs`), byte-capped output capture (`CODE_STEP_CAPTURE_MAX_BYTES` = 1 MB log artifact, `CODE_STEP_EXCERPT_MAX_BYTES` = 8 KB excerpt), no stdin pipe, no permission prompt, and no shell interpreter.
- Missing registry diagnostic: If a contract declares code steps but `.clio-coder/fleets/commands.yaml` is missing in the repository, `clio-coder fleet list` reports the fleet status as `setup` and provides the remedy: `needs .clio-coder/fleets/commands.yaml declaring <id>; declare each id there under commands: with an argv list; clio-coder docs fleet_dispatch has the schema`.
- Commit message sources: A code step with `commitFrom` populates its `commitMessage` placeholder from the output of preceding agent steps.
- Route quality: Code steps do not consume model tokens or cost estimates; their quality reports `unmeasured` rather than zero.

#### Command Registry Schema (`.clio-coder/fleets/commands.yaml`)

The repository command registry binds command IDs to exact argument vectors:

```yaml
version: 1
commands:
  test:
    argv: ["npm", "test"]
    timeoutMs: 600000
    description: "Run repository test suite"
  lint:
    argv: ["npm", "run", "lint"]
    timeoutMs: 300000
  build:
    argv: ["npm", "run", "build"]
    timeoutMs: 600000
  commit:
    argv: ["git", "commit", "-m"]
    timeoutMs: 60000
```

Each command entry supports:
- `argv` (required): Array of command arguments starting with the binary name (no shell strings).
- `cwd` (optional): Repository-relative working directory (defaults to repository root).
- `timeoutMs` (optional): Per-step execution timeout in milliseconds (defaults to 600,000 ms; bounds: 1,000 to 3,600,000 ms).
- `env` (optional): Array of extra environment variable names to pass through on top of `FLEET_COMMAND_BASE_ENV` (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`).
- `description` (optional): Human-readable description.


## Measured route selection and agent automation

The joint resolver treats agent, target, model, runtime, and node as one
bounded tuple. Manual pins, the approved plan envelope, authority, audience,
required tools and skills, result contract, response-schema support, locality,
authentication, network policy, endpoint reachability, context, resource fit,
capacity, budget, deadline, and cooldown are hard filters. Only survivors are
estimated and Pareto-ranked by conservative quality, reliability, completed
cost and latency, queue wait, and cache affinity. The complete bounded
candidate/rejection set is sealed; at most three fallbacks are projected.

Shadow is the default and never changes the explicit route. Active route
selection requires both the execution role and posture to be named:

```yaml
routing:
  activeRoles: [researcher, verifier, reviewer, judge]
  activePostures: [quality, balanced]
  agentAutomation:
    activeAgentRoles: []
```

For every exact tuple, `evaluateRouteReadiness` requires consistent hard-
constraint evaluation, no integrity failures, at least six role-specific
quality labels, conservative quality and reliability floors, known cost,
fresh node/endpoint/resource/capacity/settings facts, and decision p95 below
10 ms. If no tuple is ready, active mode refuses the assignment. It never
falls back to the fixed route, and manual or `failover: none` intent never
drifts.

`agent: "auto"` first filters recipe audience, authority, tools, skills,
result contract, locality, and governance. Bounded task features affect cold
priors only; one truthful role-quality label retires the task prior. Agent
automation has its own readiness report per agent/spec/role and stays shadow
unless the operator names an exact agent/role pair. A read-only Scout can
settle reconnaissance directly or return at most four typed subtasks. The
coordinator validates ids, dependencies, expected result contracts, and
requested authority and rejects embedded agents, routes, deadlines, costs, or
other control fields. Escalation to workspace editing requires authenticated
plan approval or existing full-auto authority.

## Assignments, attempts, and failover

A dispatch is a logical assignment containing one or more immutable run
attempts. The assignment id and terminal run ids are distinct identities;
there is no `runIds` compatibility alias. Public `finalPromise` handles resolve only when the assignment succeeds,
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

Assignment status, attempt ids, and terminal run id are stored separately in
`assignments.json` while each attempt keeps its own strict v16 receipt.
Pipelines and batches await assignment terminals, so downstream stages consume
the successful fallback output rather than an earlier failed attempt.

Editing assignments also own one baseline-pinned workspace transaction. Every
attempt gets a distinct worktree. Before any winning diff can reach the
destination checkout, a pure gate checks terminal outcome, receipt integrity,
result conformance, and quality-gate success; protected artifacts, baseline
ancestry, and destination cleanliness are then rechecked on disk. Refusal
preserves the winner and recovery instructions, and the transaction cannot be
closed while a winner remains unapplied.

## Receipts

Receipts carry exactly one integrity version (`RUN_RECEIPT_INTEGRITY_VERSION = 16`), which authenticates the complete receipt and reconstructible ledger provenance surface. There is no historical verification path: any other version is invalid, and a receipt that fails verification is never read as evidence. The fleet provenance fields covered by the digest
include:

- `node`: the fleet node the worker ran on (`id`, `kind`, `host`). The `node.id` explicitly identifies the worker process host executing the task, not the model host (which is represented by the `target` id). This behavior tracks issue #120.
- `reroutes`: dead-node failover hops, oldest first.
- `gate`: review/compete provenance (role, group, cycle, subject run ids with
  their receipt digests, and the verdict that caused a revise builder).
- `plan`: plan-approval provenance (hash, topology, task count, cost ceiling,
  approval kind, and the registry approval identity when supervised).
- `briefing`: byte count and SHA-256 of the exact canonical parent briefing;
  the prose is not retained and is distinct from bounded project context.
- `intent`: the normalized typed path, expected-output, and verification
  declaration that admission sealed for the run.
- `verification`: the existing evidence state and basis observed from worker
  tool execution.
- `hostVerification`: host-run status and the resolved check evidence, including
  argv, cwd, exit code, duration, memo provenance, bounded output tail, and
  optional artifact path.
- `steering`: ordered byte/hash/timestamp and acknowledgement provenance for
  successfully written steers; steering prose is never stored.
- `outcomeCode`: the stable terminal classifier, including
  `worker_final_output_missing` when an otherwise successful worker exits
  without a nonempty receipt-sealed final answer and
  `host_verification_rejected` when a declared host check rejects the settled
  tree. Both suppress automatic retry.
- `routingIntent`, `routeDecision`, and `quality`: the normalized hard bounds,
  complete current-policy decision, exact execution role, route estimate and
  readiness evidence, and authenticated quality sources.
- `resultContract`: the admitted contract identity and `valid`, `invalid`, or
  `not-reached` conformance state. Only a due correctness-bearing contract can
  label route quality.
- `validationGrounding`: claimed versus grounded validations checked against canonical executed commands.
- `capabilityMismatch`: capability class versus task shape verdict (`refuse` vs `flag`).
- worker attestation identity: settings/WorkerSpec fingerprints, runtime,
  target, endpoint, model, tool surface, node, and bounded resource facts.

Process exit zero is not a delegated deliverable. Native and ACP runs succeed
only when the drained event stream yields a nonempty receipt output with
`state: "final"`. A missing final answer fails with
`outcomeCode: "worker_final_output_missing"`; any captured unfinished text is
retained only as `state: "partial"` diagnostics and automatic retry is
suppressed. Dispatch, monitor, ledger, receipt, terminal bus event, and retry
policy all consume that same final classification.

Receipt integrity, host verification, and evidence verification are separate axes. Integrity says
that the sealed receipt matches its ledger envelope; evidence verification
reports whether Clio observed an applicable validation tool (or marks the
basis unknown/not applicable). A read-only Scout can therefore report `receipt_integrity=verified/v16/sha256` alongside
`evidence_verification=not_applicable/read-only-agent`. Host verification is
rendered independently as `host_verification=verified|rejected|skipped|not_requested`.
A host-executed successful check projects onto canonical validation grounding as
authenticated validator evidence. Briefing provenance and
bounded `project_context` provenance are also rendered independently; neither
hash substitutes for the other.

The canonical terminology for these facts is the six-axis trust status in
[`evidence-and-memory.md`](evidence-and-memory.md#canonical-trust-status).
Receipt integrity projects onto artifact integrity; receipt verification,
typed quality, and validation grounding project onto validation grounding;
gate decisions project onto independent review; briefing and project context
project onto context provenance; and `autonomyEnforcement` projects onto
autonomy enforcement. A receipt does not contain independent-review or
completion-evidence outcomes merely because it is sealed. Those axes remain
`absent` until an authenticated gate artifact or finish assessment is composed.
In particular, verified integrity cannot validate claims, known provenance
cannot establish correctness, and a review verdict cannot establish
authorship.

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

- Every run carries the origin that asked for it, and every surface shows it
  with the same pair of glyphs: `◇` for a run the operator started with `/run`
  or `/delegate`, `◆` for one the model started by calling a dispatch tool, and
  a dim `·` for the runs Clio starts for itself. A running `◇` on the board is
  therefore the operator's own work. The footer chip in the status line splits
  into `◇1 ◆3` when more than one kind is live and stays `fleet N` otherwise.
  Board rows carry an origin glyph too.
- User-origin and agent-origin runs stream into the chat transcript as an
  attributed worker block. The typed command is echoed dim above the block.
  Header units display `<agentId>` then `<targetId>/<wireModelId>` then `run <runId>`
  for fleet workers (such as `◇ coder · node-a/example-coder-model · run 2mkas6s`),
  or `<id> (acp) · run <runId>` with no route for ACP delegation peers. The block
  body renders the worker prose down a rail, one coalesced line of tool names,
  and a one-line receipt footer showing the outcome glyph, token count, duration,
  and contract status (such as `└ ✓ ok · 8.4k tok · 18s · contract unmeasured`),
  with the failure reason printed on the rail above the footer when a run fails.
- Runs the model itself asked for through the dispatch tool (identified by
  parentToolCallId) render as folded `◆` cards under the spawning tool segment;
  operator-typed runs are `◇` and open. The fold chord uses the `clio.tool.expand`
  keybinding (`Alt+O`), which toggles the newest foldable item of either kind
  (tool call or worker block). `Ctrl+Alt+O` or `Alt+Shift+O` toggles every tool
  call and worker block at once.
- Sharing: nothing a worker produced enters the main model's context unless
  `--share` was passed or the operator runs `/share [runId]`. What enters is a
  bounded note of the shape `[worker result] <agent> · run <id> · <outcome> · shared by the operator`
  followed by the bounded answer text, traveling the ordinary user-turn path.
  The operating contract tells the main agent that this note is operator
  steering backed by a readable receipt, not a tool result to verify against
  its own dispatch history.
  Bare `/share` picks the newest finished run the operator started themselves
  (never a model-asked `◆` run); `/share <runId>` may name a model-asked run
  explicitly. `/new` resets the transcript and the pool bare `/share` draws
  from, so a run from the previous session cannot be shared into the new one.
- Replay: `/resume` replays worker blocks from receipts; the session file's
  `workerRun` entries carry ids, origin, and runtime only, without prose; the
  replayed answer is bounded from the receipt exactly like the live one. A
  missing receipt renders `receipt unavailable`.
- Memory workers on the background target never appear as transcript blocks.
- The dispatch board shows per-run cards with the node id (absent placement
  renders `local`), gate badges (`gate reviewer c2`), reroute badges, live
  tool activity (names only; arguments never cross the worker stdout seam),
  and a per-worker context meter.
- `Enter` on the selected Fleet Runs row opens its worker detail: the phase,
  the running call with a redacted action descriptor (`bash running npm
  test`), and the bounded tail of the worker's own prose. The default list
  stays compact, so a fan-out of scouts costs one card each until an operator
  opens one. Detail follows the cursor rather than pinning to a run.
- The board and the transcript worker block read one projection
  (`src/interactive/worker-progress.ts`), so they cannot disagree about what a
  worker is saying or touching. It keeps 40 lines and 4096 bytes of tail, 8
  distinct tool names, 4 recent actions, and accepts 16 KB of delta bytes per
  250 ms; what the bounds refuse is counted and named on the card beside the
  `/view dispatch:<runId>` deep link.
- Action descriptors are composed where the arguments are trusted: the tool
  registry's admission path, the Claude tool mapper, and the ACP update
  mapper. Each reads a fixed verb vocabulary and a fixed argument-field
  allowlist, scrubs credentials, strips escape sequences, and bounds the
  result to 64 characters before it crosses the worker stdout seam. Raw
  argument objects never cross at all.
- Reasoning content is never displayed. The detail may name a `thinking`
  phase and the usage facts the card already carries, never the text.
- Settlement replaces the provisional tail with the sealed receipt's answer;
  a run whose receipt cannot be read keeps its own last durable message.
- The context meter renders the worker's last-message context occupancy
  against the model's context window: healthy below 80 percent, warn from 80,
  critical from 95.
- `/fleet` opens Settings → Fleet: profiles (with the node pin), bindings,
  and read-only node rows (state, capacity, and last-seen). Running and
  retrying runs, with their node, live in the `Alt+W` Fleet Runs board.
- The monitor tool reports the node and reroute lineage on `status`, `list`,
  and `collect`.
- `clio-coder fleet status [--json]` shows the durable ledger view cross-process.
- A worker permission escalation uses the `Worker escalation` consequence tier in operator presentation. The tier names the worker agent and run and describes where the one-shot answer returns. It does not approve the request, change the worker's inherited autonomy, or weaken the safety net; the existing worker escalation protocol remains the only resolution path.

## Speculation observer

A shadow-mode observer watches every dispatch, computes the plan a rule-based
pipeline would have chosen (synchronous keyword rules, no model calls), and
records plan-versus-actual accuracy into a bounded JSONL under
`<state>/speculation/observations.jsonl`. It never influences dispatch;
disabling it changes nothing else.

## Residency

Remote workers default to residency observe: the SSH transport exports
`CLIO_CODER_RESIDENCY=observe`, so a worker on a node that serves resident models
(for example a GPU box running the operator's inference server) never evicts
them. A node opts into management explicitly with `residency: manage` in its
fleet entry.

A model the router tags as pinned (`pinned:true` or `role:scout`) is never
evicted once resident, so Clio refuses to load it by evicting a resident that
settings still reference by role; on a one-slot router such an override
declines with a `will-not-fit` notice instead of stranding the configured model.

## Opt-in live regression

After `npm run build`, an operator with a configured model target can run the
single-turn, read-only fleet lifecycle check explicitly:

```bash
npm run live:fleet-dispatch -- --target <id> [--model <wireId>] [--thinking medium]
```

It is not part of deterministic CI. The driver
(`benchmarks/internal/live-fleet-dispatch.ts`) copies the repository into a
committed temporary workspace, sandboxes all Clio config, state, data, and
cache under a scratch home holding only the chosen target, exercises Scout,
bounded spot-checking, detached Debugger briefing, steering, wait, and
collect, and fails if any workspace content changes. A failed run retains its
scratch tree for diagnosis.
