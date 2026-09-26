# Workers and fleets

Assign focused tasks and combine workers into a workflow.

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

Worker profiles can pin work to a node: `fleet.profiles.<name>.node` routes
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

Run it with `clio-coder doctor`. Plain doctor is diagnostic and read-only: it
reports the live probe rows but does not create or refresh
`fleet-preflight.json`, and therefore does not change dispatch eligibility.
Run `clio-coder doctor --fix` to record passing preflight results into
`fleet-preflight.json` and make verified nodes dispatch-eligible.
Placement still reads a pre-existing record under the state directory, keyed by
node and project root; a changed host, changed project root, or local
`clio-coder` upgrade invalidates that record and admission fails closed. Failing
nodes are doctor warnings rather than a failure of the local installation.

## Topologies

All topologies go through the dispatch tool, the same admission chain, and
the autonomy matrix. Every worker runs at `default`, regardless of the main agent's level.
A `readOnly` dispatch restriction denies mutation and outside reads; reviewers and judges use it.

| Topology | Invocation | Semantics |
| --- | --- | --- |
| Singular | `task: "..."` | One assignment, with optional separate `briefing`. |
| Parallel (default) | `tasks: [...]` | Fan out, wait for all, one summary. |
| Sequential | `mode: "sequential"` | One at a time, stop reporting on timeout/abort. |
| Pipeline | `mode: "pipeline"` | Each step receives the previous step's output as data. |
| Detached | `detach: true` | Return logical assignment ids and a batch id immediately; collect later. |
| Review gate | `review: {reviewer?, max_cycles?}` | Builder, read-only reviewer verdict, bounded revise loop. |
| Compete | `mode: "compete", candidates: 2..4` | N candidates in scratch worktrees, read-only judge, winner applied or preserved. |
| Council | `mode: "council", roster: "design"` | Two to five read-only members answer the same task, with optional vote or judge synthesis. |
| Agent automation | `agent: "auto"` | Baselines candidate agent from task shape via shared classifier (`coder`, `tester`, `documenter`, `verifier`, `researcher`, `scout`); advisory unless activated. |

### Single-writer token

A parallel batch may declare `writers: 1`. One is the only accepted value;
omission retains ordinary parallel admission. The scheduler
admits at most one write-scope step at a time. An agent step with a nonempty
`writes` allowlist is a writer, as is a workspace-scope step that may mutate
the checkout. Read-scope steps and agent steps with `writes: []` remain
concurrent. Waiting writers follow the plan's declared step order and then the
request order. Agent ledger claims remain advisory and do not enforce the
token.

### Declared step scope

A v4+ contract's per-step `writes:` declaration has two consumers. The
write-boundary enforcer verifies the step window afterwards, which is where the
boundary is enforced; pre-emptive confinement for declared commands would need a
command sandbox that does not exist. The same declaration also compiles into the
step's typed dispatch intent as `relevant_paths`, so the paths the contract
already named select the project rules that apply to them and pin the worker's
context instead of being reconstructed from path-like tokens in the rendered
prompt.

It is carried as declared scope rather than as intent `write_roots` on purpose.
Intent write roots become the enforced boundary at the per-tool worker seam,
which refuses outright on the subprocess and ACP runtimes a fleet may
legitimately route a step to, so restating the contract's boundary there would
mint a second grant in a second place and fail closed on contracts that run
correctly today. A pre-v4 contract and every readonly step declare nothing and
keep the legacy inference path. See
[dispatch-typed-intent.md](../architecture/dispatch-typed-intent.md) for the full producer
table and the refusal reason codes.

The first checkout writer acquires a process-owned lease under the Clio state
directory. Its key is the canonical checkout path, and its record contains the
owner pid, process birth token, and acquisition time. A live sibling process
causes admission to fail with `checkout_writer_lease_held` and the holder pid.
A dead owner or reused pid is reclaimed. The lease remains held until the last
writer settles, including writers collected from detached batches. Read-only
runs never acquire it.

### Worktree per task

A singular writer or an item in `tasks` may declare `worktree: true` and
`apply: "merge" | "preserve"`. The default is `merge`. Clio creates
`.clio-coder/worktrees/<runId>/` on `clio-coder/task/<runId>`, maps the worker cwd and
protected artifacts into that checkout, and runs declared host verification
there. The approved execution snapshot renders both fields and freezes the
parent checkout as the merge destination.

After a successful worker and successful host verification, merge application
commits the task branch, rechecks protected paths, and uses the same guarded
merge path as compete. A conflict fails closed with
`worktree_merge_conflict` and preserves the branch and worktree. Preserve
application never merges and reports the branch. A detached task applies when its run finalizes, so `monitor(mode="collect")` returns the sealed application receipt.
Admission refuses a non-git checkout, a read-only agent, compete mode, or an
explicit cwd outside the parent checkout with a named reason.

`fleet.worktrees.root` chooses where the working tree is created:

| Value | Location |
| --- | --- |
| `disk` (default) | The location above, under the project root. |
| `tmpfs` | A per-user, per-checkout directory, mode 0700, under `$XDG_RUNTIME_DIR` when that is a tmpfs mount and under `/dev/shm` otherwise. |
| `auto` | The `tmpfs` behavior when such a mount exists, quietly falling back to disk when none does. |
| An absolute path | That directory, provided Clio owns it outright. A directory on a shared mount that Clio does not own outright is refused. |

Before creating a worktree off disk, Clio compares the mount's free space with
twice the size of the tracked tree plus 256 MiB and falls back to disk, with a
`[clio-coder:dispatch] task worktree root` notice, when it is short. A tmpfs is
RAM: what a worker builds inside its worktree counts against it, and uncommitted
files there do not survive a reboot.

Only the working tree moves. Git objects, the index, the branch, and the
ownership claim stay with the repository. The setting applies to local placement
only: when `fleet.nodes` is non-empty a run may be placed on another host, which
reaches the worktree by the project-root path, so task worktrees stay on disk.
Compete candidates always stay under the project root.

Each task worktree is claimed by `.clio-coder/worktrees/<runId>.task-owner.json`,
which always stays under the project root and records the working tree's path,
the branch, the base commit, the apply mode, and a lease on the Clio process
that created it (host, PID, and a PID-reuse-resistant start identity). A run that
ends and keeps its worktree marks the claim `settled`.

`clio-coder doctor` lists every task worktree that outlived its run with its
branch, age, and the git commands to inspect or drop it.

<details>
<summary>What crash recovery removes, preserves, and refuses to touch</summary>

At the next start in the same checkout, a claim that is still `active` while its
owner is gone is a crash.

A worktree with no commit beyond its base and no modified, staged, or untracked
file is removed with its branch, and so is one whose tmpfs working tree a reboot
took, after its stale git metadata is pruned. Its commits, if any, keep it.

One that holds work is kept, marked `abandoned`, and named once on stderr as
`[dispatch] task worktree recovery preserved <runId>: ...`. It is never merged
and never deleted.

A live owner, an owner on another host, a claim written before recovery existed,
and anything git cannot inspect are left alone.

</details>

### Typed intent and host-run verification

The singular request and every object in `tasks` accept an optional `intent`:

```json
{
  "read_roots": ["src/domains/dispatch"],
  "write_roots": ["src/tools"],
  "relevant_paths": ["docs/guide/fleet-dispatch.md"],
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
fan-out in `runBatch`, a detached batch of two or more in `runDetached`, and
`runCompete`, all in [dispatch-runner.ts](../../src/tools/dispatch-runner.ts). A worker reaches it through the `ledger` tool
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

Receipts do not record ledger contributions. Builds before 0.5.6 sealed a
`ledgerContribution` (ledger id, posted and refused counts, and a sha256 over
the run's attributed entries) that nothing read; receipts that carry it still
verify.

### Detached fan-out, backgrounding, and collect

`detach: true` validates, admits, and spawns every task, then returns. The
reported id is the logical assignment id (also the first attempt's run id).
For an in-flight attached dispatch, using `Ctrl+G`, then `s`, or `/background` converts
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
agent; it is given a read-only dispatch restriction and is routable to a different node,
model, or target.

The reviewer answers a typed `verifier-report` contract rather than trailing
prose:

```json
{"verdict":"pass","checks":[{"name":"npm run typecheck","passed":true,"evidence":"exit 0"}]}
```

`revise` is not a verdict a model authors. The reviewer answers `pass` or
`fail`, and `decideReviewGate` in
[gate-decisions.ts](../../src/domains/dispatch/gate-decisions.ts) owns the continuation policy: a
non-passing verdict below the terminal cycle becomes `revise` and re-runs the
builder with only the failed checks threaded as input data, bounded by
`max_cycles` (default 2, max 4). On the terminal cycle the verdict settles as
reported. A reviewer that produces no structured result settles as `exhausted`
and surfaces as an explicit operator decision, never a silent failure.

### Compete

N candidate builders (2 to 4) run the same task, each in its own scratch git
worktree under `.clio-coder/worktrees/<group>/` on its own
`clio-coder/compete/<group>/<n>` branch. Each candidate's work is committed on its
branch; a read-only judge ranks the branches and names a winner
(`WINNER: <n>`). In `yolo` the winning branch is merged. In `default`
the winner's branch and worktree are preserved and the operator
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

### Council

Council is the read-only sibling of compete. Two to five members run the same
singular task concurrently on local HTTP or native targets. A request selects
exactly one configured `fleet.rosters` entry or supplies inline `members`.
Admission gives every member a read-only dispatch restriction and access to the `read`, `grep`,
`find`, `ls`, `code_nav`, and `context` tool surface. A route that resolves to
an SSH fleet node is refused before approval. Council never creates a worktree
and never mutates the workspace.

Council supports one to three rounds. The first round gives every member the
same task and briefing. A later round gives each member the other members'
prior answers as labelled, untrusted briefing data. The member never receives
its own prior answer. Each briefing is limited to 8 KiB and carries an explicit
truncation marker when necessary. A failed peer contributes a labelled failure
marker and no answer text.

Three synthesis modes are available:

| `synthesis` | What it does | Model call |
| --- | --- | --- |
| `none` | Returns the final member answers directly. | No |
| `vote` | Deterministic majority tally over structured `verdict` fields. | No |
| `judge` | Runs one additional read-only judge against all final answers. | Yes, one |

Every member run seals a receipt, a judge receipt points backward to every final
member receipt through gate provenance, and the approval artifact names each
member's label, target, model, thinking level, node, color, round count, and
synthesis mode, so the plan hash binds the whole council contract.

<details>
<summary>How a vote council collects ballots and what it reports without a majority</summary>

A vote council asks each member for that verdict: the member's task carries the
ballot directive and the member's run seals a `council-ballot` postcondition,
`{"verdict":"...","text":"..."}`, in place of the seated recipe's own result
contract. The seated agent, its persona, and its read-only tool profile are
unchanged, so any recipe can be voted with.

The verdict is a single line of at most 64 bytes and is lower-cased before the
tally, so members who reach the same conclusion land on the same key. The
reasoning belongs in `text`, which is what the council report shows as the
member's answer.

A member that seals no conforming ballot fails its own run and is reported as a
failed member rather than dropping silently out of the count. A vote with no
majority reports `no_majority`, and a vote whose final members all failed reports
`no_verdict_field`.

</details>

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
wave, so a three-step sequential plan holds one slot rather than three, and N
parallel tasks whose individual estimates each fit but whose sum breaches the
ceiling are denied together with the aggregate figure.

A member is consumed once by its assignment and released once when that
assignment settles. A retry that lands on a different node or a differently
priced route rebinds the member atomically and fails closed if the new node has
no free slot or the new estimate breaches the ceiling. Reservations owned by a
dead process are reclaimed at startup, with a TTL as the backstop, and live
sibling processes' reservations are preserved.

Execution consumes the same pins, including each expanded builder/reviewer/candidate/judge role and
the SSH node's transport kind and host. A placement, host, capability, or
cost-ceiling change fails before launch rather than silently choosing an
unapproved alternative. Yolo skips the stop and seals the
same plan hash into every run's receipt instead
(`plan.approval: "yolo"` is the stable receipt value). Read-only runs deny dispatch outright
because they deny every non-read action.
Earlier sealed receipts and gate artifacts keep their historical bytes. Clio verifies them as stored
and shows the yolo names in fleet views.

The registry boundary is resolved dispatch plan v3. `deadlineMs` is required:
a fleet plan carries a positive finite number and a non-fleet plan carries
explicit `null`. Older versions, missing fields, and compatibility shapes are
rejected.

### Shipped fleets and contract versions

Clio ships three builtin fleet contracts under `src/domains/agents/fleets/`: `build-test`, `build-review`, and `sdlc`. Projects can declare custom fleet contracts or shadow builtin fleets by placing Markdown files under `.clio-coder/fleets/<name>.md`. A file named `.clio-coder/fleets/<name>.md` shadows a builtin fleet of the same name.

Fleet contracts support schema versions 1 through 5:
- Version 1: Supports agent steps only.
- Version 2: Introduces deterministic code steps.
- Version 3: Adds bounded check/repair loops and commit steps with `commitFrom` message sources.
- Version 4 (`FLEET_WRITE_BOUNDARY_VERSION = 4`): Introduces per-step declared write boundaries (`writes`) and orchestrator post-step enforcement.
- Version 5 (`FLEET_DYNAMIC_STEP_VERSION = 5`): Adds plan steps, executable gate steps, per-step target or worker-profile defaults, and the optional single-writer declaration.

#### Contract v5: plan, gate, and per-step target

A version 5 agent step, including an agent loop check or repair, may declare either `target: <targetId>` or `profile: <fleet.profiles key>`. It may never declare both. Fleet preflight resolves these values through the same worker routing used by `/run --target` and `/run --agent-profile`. An unknown value refuses before approval and names the target or profile. Versions 1 through 4 continue to refuse both fields.

A `kind: gate` step asks its validator agent to write exactly one repository-relative `path`. The contract derives the step's write boundary from that path, so a separate `writes` property is refused. Its `run` property names a command whose argv contains one whole-token `{{path}}` placeholder. After the agent writes the executable acceptance check, the coordinator runs it without a shell against the otherwise untouched tree. A red result admits the gate. A green result refuses the run as `gate_not_discriminating`. The fleet ledger records the gate path hash. A loop may use `check: {kind: gate, gate: <stepId>}`. Only the bounded output lines beginning with `FAIL` cross that failed check edge into the repair agent.

A `kind: plan` step defaults to the builtin `architect`. It declares `roster`, `maxTasks` from 1 through 16, an optional `proposals: true`, its own scope and write boundary, and an optional target or profile default. The architect returns a `delegation-plan` object whose tasks contain `id`, `agent`, `description`, `depends_on`, `writes`, and an optional `mode` of `sequential` or `parallel`. The coordinator admits only roster agents, unique and acyclic task ids, resolvable dependencies, the declared task count, and task writes contained by the plan step boundary. Successful tasks carry lineage to the plan step and inherit its target or profile. A contract with `writers: 1` serializes write tasks through the existing single-writer token.

When `proposals: true`, every roster member first runs with a read-only dispatch restriction against the same task. Their answers reach the architect as labelled, bounded briefing data. Proposal agents do not choose targets for generated work. The plan step's contract default remains authoritative for every admitted task.

### Fleet authoring

The fleet CLI provides five authoring and inspection operations:

- `clio-coder fleet new <name> --from <builtin>` copies one of `build-review`, `build-test`, or `sdlc` into `.clio-coder/fleets/<name>.md`. The command requires a safe file stem and refuses to replace an existing contract.
- `clio-coder fleet validate <name> [--json]` parses the contract, validates its graph and command bindings, resolves every agent, and compiles the execution plan. It creates no state directory, ledger row, reservation, worker, or receipt.
- `clio-coder fleet graph <name> [--json]` renders the compiled waves with each step kind, agent or command, scope, and write boundary. Bounded loops also show their check and repair nodes beneath the loop identifier.
- `clio-coder fleet commands init` discovers declared package scripts, just recipes, Makefile targets, and supported `pyproject.toml` script and tool entries. It writes a fully commented `.clio-coder/fleets/commands.yaml` draft. Uncommenting an entry confirms its exact argument vector, and an existing registry is never replaced.
- `clio-coder fleet run <name> --resume <runId>` starts a new fleet run after replaying the successful, integrity-valid prefix recorded for the named prior fleet run.

Run resumption is separate from `clio-coder fleet resume`, which continues to reopen dispatch admission after an operator drain. A resumable fleet run records its contract name, rendered plan hash, ordered step identifiers, variables, and receipt references in the durable fleet ledger. Runs started from the TUI through `/fleet run` use the same durable record and can be resumed by the authoring CLI. The new run records the prior fleet run as its resume parent. Replayed steps are reported as `replayed`, retain their original receipt or code-report references, and do not create new receipts.

The current contract must compile to the same plan hash. A mismatch refuses before execution and prints the changed positions in the ordered step list. Variables must exactly match the original run. A different value, an added value, or an omitted value is refused even when the resulting task text would otherwise be similar.

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
3. Authorship attribution: A changed path outside the allowlist is blamed on the window only when it intersects what the window's own runs recorded writing. That record is the run's tool-call stream, folded by the same recorder that grounds a sealed mutation report and read back through `DispatchContract.observedRunWriteAttribution`. A change that no run in the window recorded is an unattributed concurrent change: it is listed under `unattributed` in the verdict and reported to the operator, and it is never rolled back. This is what keeps a file an operator edited while a fleet ran from being overwritten with its committed version.
4. Open records: A run's recorded write set is read as a closed list only when the run could not have written outside it. A window whose steps do not all offer a closed record falls back to blaming every change outside the allowlist, which is the behavior that predates attribution. Three things open a record: a `kind: code` step, whose registered command publishes no tool events; a run whose tool telemetry coverage is not `complete`, such as one on a subprocess runtime; and a run that made a successful call to a tool able to mutate a path its own arguments do not name. That last set is derived from the tool surface rather than authored, as every registered tool outside the `read` and `write` action classes, which today is `bash`, `verify`, `dispatch`, and `steer`, plus any dynamic or MCP tool whose schema this process cannot read. The `git` tool is a closed status, diff, and log surface and stays enumerable. When a successful opaque call opens the record, the live Alt+W card immediately names the tool and says that its arguments cannot enumerate every path it may write. The durable verdict records `attributionComplete: false` and an `attributionDowngrades` entry with the reason, tool name, tool call id, run id, and step id. The after-the-fact write-boundary message repeats that cause before explaining why the whole outside diff was blamed on the window.
5. Rollback execution: Attributed unauthorized changes are automatically rolled back (`rollbackPath`).
6. Content source: Rollback restores content strictly from what git already has in the pinned baseline commit (`snapshot.head`). If a path was already dirty when the step snapshot was captured, its prior content is not stored in git, so in-place restoration cannot be guaranteed. The working tree is left as the step made it, and the status settles as `rollback-incomplete`.
7. Violation handling: Any attributed unauthorized change fails the step with the typed reason `writes_boundary_violation`.
8. Window attribution: Enforcement evaluates scheduling windows (`wave-<n>` or `revalidate-<stepId>-<n>`). A wave window cannot combine steps with overlapping declared boundaries or multiple concurrent step writers, ensuring single-step attribution.
9. Ignored paths and state subtraction: Enforcement evaluates paths reported by git status, which never lists a git-ignored path. A declared `writes` entry the repository ignores is therefore refused before anything runs, by `fleet validate`, by `fleet run` preflight, and by the `/fleet run` preview, with a diagnostic naming the entry and the ignoring rule (for example `'work/' is ignored by .gitignore:1:work/`). Silently certifying such a window as clean is not an option, because nothing about it was observed. The Clio state directory (`.clio-coder/` or `clioStateDir()`) is subtracted from status checks so orchestrator receipts, code step log artifacts, and boundary verdicts do not trigger false violations.
10. Durable records: Verdicts are serialized as JSON records at `write-boundaries/<rootId>/<window>.json` under the Clio state directory, carrying the baseline HEAD commit, checked paths, violations, unattributed concurrent changes, the attribution completeness flag and downgrade causes, rollback actions, status, and SHA-256 digest.

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
- Missing registry diagnostic: If a contract declares code steps but `.clio-coder/fleets/commands.yaml` is missing in the repository, `clio-coder fleet list` reports the fleet status as `setup` and provides the remedy: `needs .clio-coder/fleets/commands.yaml declaring <id>; declare each id there under commands: with an argv list; see bundled docs/guide/fleet-dispatch.md for the schema`.
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
    argv: ["git", "commit", "-m", "{{commitMessage}}"]
    timeoutMs: 60000
  acceptance:
    argv: ["node", "{{path}}"]
    timeoutMs: 60000
```

Each command entry supports:
- `argv` (required): Array of command arguments starting with the binary name (no shell strings).
- `argumentSlots` (optional): Operator-declared positional data slots, each with a unique `name` and required `maxLength` (1 to 8192). At most 64 slots. Omission forbids appended fleet arguments; declared slots are all required.
- `cwd` (optional): Repository-relative working directory (defaults to repository root).
- `timeoutMs` (optional): Per-step execution timeout in milliseconds (defaults to 600,000 ms; bounds: 1,000 to 3,600,000 ms).
- `env` (optional): Array of extra environment variable names to pass through on top of `FLEET_COMMAND_BASE_ENV` (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`).
- `description` (optional): Human-readable description.

The whole-token `{{commitMessage}}` substitution is available to commit steps. The whole-token `{{path}}` substitution is available to version 5 gate commands. Each substitution becomes exactly one argv element and never passes through a shell.


A fleet may supply per-task data only when the operator explicitly declares slots in the repository registry. Keep the executable, script path, and fixed flags in `argv`; the fleet cannot replace them. Use a fixed `--` separator where the registered program supports it. For example:

```yaml
# .clio-coder/fleets/commands.yaml, owned by the operator
version: 1
commands:
  check-materials-task:
    argv: ["python3", "scripts/check_materials_task.py"]
    argumentSlots:
      - name: taskDirectory
        maxLength: 256
```

```yaml
# One code step in a version 2 or newer fleet
kind: code
id: check-task
command: check-materials-task
args: ["{{taskDir}}"]
scope: readonly
dependencies: []
```

Run with `--var taskDir=.research/tasks/task-01`. A slot receives exactly one literal argument. Values must be nonempty, fit the slot's length limit, contain no NUL, and not start with `-`; fixed flags belong in the operator's registry. A whole-token `{{variable}}` binds before admission and participates in the plan hash. Missing variables, undeclared or excess slots, embedded placeholders, and flag-like values fail before execution. The code runner repeats slot validation for direct or in-memory plans. Spaces and shell metacharacters remain data without another expansion pass. Existing fixed commands accept no extra args.

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
- Model-launched workers use `◆`; operator-launched workers use `◇`. Both follow the current Output style: Compact identity/outcome, Standard short summary, Detailed bounded activity and a larger summary. `Alt+O` cycles styles for the session. `/view transcript` and `/view dispatch:<runId>` expose full available details. Execution success and validation quality remain separate facts.
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
  ([worker-progress.ts](../../src/domains/observability/worker-progress.ts)), so they cannot disagree about what a
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
- `/fleet run <name> [--var k=v ...]` compiles the contract's plan and opens
  the approval overlay before anything dispatches. The overlay lists the steps
  grouped by wave, and for each step its kind, its agent and resolved target
  (or its command id and the exact argv from `commands.yaml` for a code step),
  its scope, and its declared write boundary, followed by the budget ceiling
  the run would be admitted under. Enter dispatches the plan through the same
  path `clio-coder fleet run` uses, so admission, autonomy, receipts, and the
  durable ledger are identical. Esc cancels with nothing dispatched and nothing
  written. A contract that fails preflight opens the same overlay with its
  diagnostics and no accept key. A turn in flight refuses the command with a
  notice rather than queueing it: an approved plan describes the workspace as
  it stands.
- A council is one question asked of several members, so its rows render as one
  card rather than as three to five unrelated neighbours. On the `Alt+W` board the
  members sit side by side, one column each, as long as every column keeps at
  least 34 cells; below that the whole group stacks one member under another
  rather than squeezing some columns and not others. Each column carries the
  member label in its roster color (a member with no color takes the accent), the
  target and model, the round, the status, and the same bounded answer tail the
  run's own card would show. The synthesis run takes the full width under the
  members, because it is the council's answer rather than one voice in it. A
  council that ran several rounds still shows one column per member: each label
  keeps its newest round, so the card describes the council rather than its
  history.
- The compact Fleet Runs island shows a council as one card naming the group, how
  many members are seated, and which round they are on. The grid belongs to the
  board, where there is width to read an answer in. `/share` is what moves a
  council answer into the main agent's context; the card moves nothing.
- Board rows a fleet plan dispatched carry a phase column naming the step's
  wave index and step id (`w2 build`). A run that is not a fleet step renders
  the column empty. The compact Fleet Runs island keeps its fixed width, so it
  shows the column only when the row can still hold a readable agent label;
  otherwise the phase appears on the expanded card.
- The monitor tool reports the node and reroute lineage on `status`, `list`,
  and `collect`.
- `clio-coder fleet status [--json]` shows the durable ledger view cross-process.
- A worker permission escalation uses the `Worker escalation` consequence tier in operator presentation. The tier names the worker agent and run and describes where the one-shot answer returns. It does not approve the request, change the worker's default autonomy, or weaken the safety net; the existing worker escalation protocol remains the only resolution path.
