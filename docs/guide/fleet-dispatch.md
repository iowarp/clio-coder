# Fleet Dispatch

Clio Coder dispatches bounded worker agents locally or on verified SSH nodes.
Registering a remote node keeps unpinned work local. An explicit pin, session
choice or standing preference selects remote execution through the same
admission, worker authority, verification and receipt paths.

Source of truth: `src/domains/dispatch/`, [cluster.ts](../../src/domains/scheduling/cluster.ts),
[dispatch.ts](../../src/tools/dispatch.ts), [dispatch-schema.ts](../../src/tools/dispatch-schema.ts),
[monitor.ts](../../src/tools/monitor.ts), [fleet.ts](../../src/cli/fleet.ts), and the contract tests under
`tests/contracts/`.

### Start here

| If you want to | Go to |
| --- | --- |
| Add machines to the fleet | [Node setup](#node-setup), then [Doctor preflight](#doctor-preflight) |
| Understand how work is placed and admitted | [Placement and process-safe admission](#placement-and-process-safe-admission) |
| Choose which target and model a worker uses | [Worker routing](#worker-routing-profiles-agent-bindings-and-per-call-pins) |
| Choose a review, compete, or council shape | [Topologies](#topologies) |
| Write or run a repo-owned playbook | [Shipped playbooks and playbook versions](#shipped-playbooks-and-playbook-versions), [Playbook authoring](#playbook-authoring) |
| Know what happens when a route fails | [Failure semantics](#failure-semantics), [Assignments, attempts, and failover](#assignments-attempts-and-failover) |
| Watch, cancel, or inspect running work | [Operator visibility](#operator-visibility), [Workers dock and dashboard](#workers-dock-and-dashboard), [Inspect fleet runs from the CLI](#inspect-fleet-runs-from-the-cli) |
| Read what a run proved | [Receipts](#receipts) |

## Architecture

The orchestrator writes one WorkerSpec JSON line to a worker's stdin and reads
NDJSON events from its stdout. A remote worker is the same protocol tunneled
through `ssh -T`, so prompts, safety, receipts and telemetry do not change with
distance. The `local` and `ssh` transports implement one `WorkerTransport`
interface ([transport.ts](../../src/domains/dispatch/transport.ts)). The frames, the announce and
attestation handshake, drift handling and worker exit codes are specified in
[worker-dispatch-mechanics.md](../architecture/worker-dispatch-mechanics.md). Attestation is strict protocol
evidence, not proof against a malicious child that controls its own process.
SSH aborts escalate against the attested remote process group.

Scout routing is advisory. After nine or more read-only exploration calls in
one model round with no successful Scout dispatch in the user turn, middleware
adds one model-only reminder at the end of the turn, at most once per user turn
([dispatch-nudge.ts](../../src/domains/middleware/dispatch-nudge.ts)). The reminder costs no extra model round and the operator
does not see it. Direct reads remain allowed, and Clio Coder does not rewrite a broad
request into a Scout run. A second rail adds one advisory transcript line when a
final reply claims a worker or Scout result and no dispatch ran in the turn.

Design decisions that shape everything else:

- Per-node inference targets, no central proxy. Target URLs resolve on the
  node the worker runs on, so `localhost` in a worker's target means that
  node's own inference server. The orchestrator-resolved API key rides the
  WorkerSpec.
- Verified project files. The project uses the same absolute path on every
  node. Clio proves shared storage through a file challenge, or verifies
  independent clean Git checkouts with the same HEAD and root history.
  Independent-checkout edits return through isolated task branches over SSH.
  There is no arbitrary repository sync, dataset staging or path mapping.
- Deterministic placement and measured routing. Exact pins remain exact.
  Unpinned placement stays local until an operator preference selects a node;
  the cross-process lease state is the final capacity authority. Route quality
  can be activated only for named roles and postures after exact-tuple readiness,
  and hard constraints always eliminate before any score.
- Environment whitelist. The SSH command carries an explicit environment
  (`AI_AGENT=clio-coder`, `CLIO_CODER_WORKER_PGID=$$`, and any configured `CLIO_CODER_WORKER_LABELS`);
  the orchestrator's `process.env` never crosses the wire. Node residency is
  projected into the target lifecycle carried by the WorkerSpec.
  `CLIO_CODER_WORKER_PGID` names the remote process group so an abort escalates
  against the whole group rather than one process.

## Worker prompt and budget admission

Dispatch resolves the recipe, target, read-only restriction and final canonical
toolkit, then compiles one stable worker harness; its layers are described in
[prompt-envelope-and-tools.md](../architecture/prompt-envelope-and-tools.md). Project context, memory, the bounded briefing,
pipeline input, task text and run posture stay dynamic messages, so they do not
churn stable prompt hashes.

One run has a first-class singular shape: `task` is the worker assignment and
`briefing` is separate bounded context, at most 12,000 UTF-8 bytes. A briefing
is untrusted task data. It carries no conversation or session history, never
replaces `task`, never gets copied into the receipt task, and arrives as a
separately delimited dynamic prompt message. `tasks` is the batch form. A shared
top-level briefing applies to string tasks and to task objects without their own;
an object-level briefing wins. Supplying both `task` and `tasks` fails instead of
choosing one. After approval, execution consumes only the registry-owned resolved
plan, so later mutation of raw arguments cannot change either field. What a
worker inherits of the parent session is a separate choice, the `context`
argument (`isolated` by default, `fork` for native workers, or `splice`); see
[worker-context.md](../architecture/worker-context.md).

Recipes declare a default `budget: {toolCalls, readReserve, synthesis}` and may
add `maximum: {toolCalls, readReserve}` inside it. A dispatch call may send
`budget: {toolCalls, readReserve, retryRevision?}`. Every phase needs positive
integers with `0 <= readReserve < toolCalls`. `retryRevision` has the same two
fields and states the estimate that a later automatic retry, bounded
result-contract revision or review revision may use; neither field may be smaller
than the requested phase. Admission never refuses a
request for exceeding the recipe maximum or the operator cap. It resolves one
immutable envelope from the recipe policy, the request, the effective worker
budget and every clamp or escalation reason, then seals the envelope in the run
ledger and receipt. `monitor`, `fleet status` and the live fleet card print the
recipe policy, the requested envelope, the effective envelope and the clamp or
escalation reason ([budget-envelope.ts](../../src/domains/dispatch/budget-envelope.ts)).

The envelope runs in one of two modes; [built-in-agents.md](built-in-agents.md) describes the recipe side.
In the default advisory mode, `toolCalls` is an estimate. At that count the worker gets
one reminder that tools stay available until a hard ceiling. The ceiling is the larger of
the admitted estimate (or revision estimate) and the smaller of the recipe's
`maximum.toolCalls` and `fleet.limits.toolCallsPerRun` (default 150). A recipe without
`maximum` uses its default `toolCalls` as the maximum, and raising `budget.toolCalls`
raises the floor of the ceiling. Native workers stop at the ceiling. The Claude SDK
runtime mediates each call but applies no ceiling in this mode. In enforced mode, which
covers native read-only `scout`, `provenance` and `context-bootstrap` runs whose recipe has
`synthesis: true`, the tool phase ends after 36 observed calls, or
`fleet.limits.toolCallsPerRun` when lower, and a text-only synthesis round follows;
`context-bootstrap` uses its own `toolCalls`. The final `readReserve` calls of an
enforced phase admit `read` and the recipe's delivery tools.

Reaching the advisory ceiling ends tool use on a native worker. A worker with delivery
tools (`write` and `edit`) fails with `worker_tool_call_cap_exhausted`; a reporting
worker seals its synthesis (see [Failure semantics](#failure-semantics)). Subprocess
runtimes (Claude Code, Antigravity and the Codex, OpenCode and Pi CLIs) and ACP delegation peers run an opaque loop, so
their envelope is classified `external-one-shot`: Clio Coder enforces one launch, the
deadline, an output cap, cancellation and result-contract validation, and records the
per-tool numbers as unobserved and not enforced.

## Worker routing: profiles, agent bindings, and per-call pins

A worker's target, model and thinking level resolve in this order
([extension.ts](../../src/domains/dispatch/extension.ts), `resolveDispatchTarget`):

1. The call's `target`. This is the `target` field of the dispatch tool and the
   `--target` flag of `/run` and `clio-coder run`.
2. A named profile from `--agent-profile <name>` on `/run` or `clio-coder run`.
3. The agent's binding in `fleet.agentProfiles`.
4. When the call lists `requiredCapabilities` (`--require`) or a runtime
   (`--agent-runtime` on `clio-coder run`, `--runtime` on `/run`), the first of
   `fleet.default` and then `fleet.profiles` whose target supports them.
5. `fleet.default`.
6. When the selected route is unusable, the best available dispatch target, with
   a warning that names why the first choice failed. An unusable `target` from
   step 1 fails the call instead.

The call's `model` replaces the selected route's model, and `thinking_level`
replaces its thinking level. Without them the model comes from the selected
profile, then from `fleet.default` when it names the same target, then from the
target's `defaultModel`.

```yaml
fleet:
  default:                       # route used when nothing more specific applies
    target: local-qwen
    model: qwen3-coder
    thinkingLevel: off
  profiles:                      # named routes; a profile without a valid target is dropped
    review:
      target: big-box
      model: qwen3-coder-next
      thinkingLevel: high
      node: node-a               # optional placement pin, `local` or a fleet.nodes id
  agentProfiles:                 # agent id to profile name; `auto` is reserved
    verifier: review
  rosters:                       # council rosters, 2 to 5 members each
    default:
      members:
        - {label: fast, target: local-qwen}
        - {label: deep, target: big-box, model: qwen3-coder-next, thinkingLevel: high, color: accent}
```

A roster member needs a unique `label` matching `[a-z][a-z0-9_-]{0,31}` and an
existing `target`. `model`, `thinkingLevel` and `color` are optional, and `color`
is a theme color name or a six-digit hex value. A roster that fails validation is
dropped as a whole. ACP delegation agents ignore native routing, so
`fleet.agentProfiles` cannot bind them. `clio-coder targets profile` lists, sets,
removes, renames, binds and unbinds profiles from the shell
([targets.ts](../../src/cli/targets.ts)); [configuration-and-targets.md](configuration-and-targets.md) owns the
settings layers.

Saved fleet routing is operator-owned. `fleet.default`, `fleet.profiles`,
`fleet.agentProfiles`, `fleet.rosters` and `fleet.adaptiveRouting` live in the
user settings or in a project layer. The project files `.clio-coder/settings.yaml`
and `.clio-coder/settings.local.yaml` apply only while the project `settings`
surface is trusted (`clio-coder config trust settings`); an untrusted or changed
surface is ignored with a notice. A project save from `/settings` writes
`.clio-coder/settings.local.yaml` and needs that trust; rosters are edited there as a raw
collection (Advanced, Raw collections), while profiles and agent routes have guided rows. An agent write to either file asks the operator
at every autonomy level, and `configure_clio` asks the operator before saving
`fleet.default`, `fleet.profiles`, `fleet.agentProfiles`, `fleet.rosters` or `fleet.adaptiveRouting` even in `yolo`
([routing-settings.ts](../../src/domains/safety/routing-settings.ts)).

A one-off target or model is never a settings edit. The coordinator pins it with
the compact dispatch schema's `target` and `model` fields, and may add `node`
([dispatch-schema.ts](../../src/tools/dispatch-schema.ts)); the rule is prompt guidance in
[coordinator.md](../../src/domains/prompts/fragments/operating/coordinator.md), and the confirmation rails above are what enforce
the settings side. Any target, model or node pin makes the call's routing posture
`manual` and its failover `none` (see
[Assignments, attempts, and failover](#assignments-attempts-and-failover)).

## Node setup

A fleet node is a machine where a worker process runs. It is separate from an
inference target: a local worker using a remote model still records `node: local`.
The implicit `local` node always exists and is never declared in `fleet.nodes`.

Start from the project root with noninteractive SSH access and one worker slot:

```sh
clio-coder fleet nodes add node-a --host node-a --max-workers 1
clio-coder fleet nodes list
```

`--host` accepts an existing SSH alias, hostname or address. A host may not
start with `-` or contain whitespace. User, port and identity default to your SSH
configuration; `--user`, `--port` (1 to 65535) and `--identity-file` override
them. `--labels cpu,build` supplies declared labels, not observed hardware.
`--max-workers` takes a positive integer. A node id starts with a letter or
number, continues with letters, numbers, underscores or hyphens, and holds at
most 64 characters; `local` is reserved. Registration starts at **not checked**
and does not change placement. `--test` probes the node right after adding it, and
`--record` also records that check. CLI and Settings additions default to one slot
and `residency: observe`. A hand-written `fleet.nodes` entry that omits
`maxWorkers` gets two slots.

The equivalent user settings are:

```yaml
fleet:
  defaultNode: null             # no standing preference; unpinned work stays local
  nodes:
    - id: node-a
      host: node-a              # existing SSH alias, hostname or address
      user: me                  # optional; defaults to SSH config
      port: 22                  # optional
      identityFile: ~/.ssh/id_fleet   # optional
      labels: [cpu, build]      # declarations, distinct from resource observations
      maxWorkers: 1             # per-node cap; a YAML entry that omits it gets 2
      residency: observe        # default; manage requires an explicit opt-in
```

`/settings fleet` opens **Settings → Fleet**; the slash command `/fleet` opens the
Fleet Runs board instead. **Add SSH node** asks for a name and host, then offers a
test or installation preview. **Discover with Tailscale** offers peer endpoints.
Each SSH row opens check evidence and timestamps plus **Test**, **Preview exact
client installation** and **Remove this node**. Tests record project readiness;
installs show the remote changes before confirmation. The screen manages nodes
saved in the global settings only. Removal affects saved configuration and leaves
remote files in place. `clio-coder fleet nodes remove node-a` does the same;
profile pins or a standing preference must be cleared first.

### Exact client installation

The node needs Node.js >=22.19 and npm on its noninteractive SSH PATH. Clio Coder can
install the exact package this client runs at user level:

```sh
clio-coder fleet nodes install node-a          # preview only
clio-coder fleet nodes install node-a --yes    # execute the reviewed operation
```

The preview names the version, SHA-256, transfer size and private destination
under `~/.local/share/clio-coder/workers/<digest>/`. Execution packs the actual
client package, transfers it over SSH, checks the digest, installs npm
dependencies without optional SDKs, verifies the Clio Coder version, then saves the
worker entry. It uses no sudo, system packages, service changes or shell profile
edits. Build a source checkout before packing it. Installation changes the
connection identity, so record preflight again afterwards.

For an independently managed install, the default invocation is
`clio-coder worker`. A custom `clioCoderEntry` that ends in ` worker` is version
checked through `<base> --version`. Any other custom entry needs an explicit
`clioCoderVersionCommand`, because silence never proves compatibility. For example:

```sh
clio-coder fleet nodes add custom --host custom-host \
  --entry '/home/me/.local/bin/clio-coder worker' \
  --version-command '/home/me/.local/bin/clio-coder --version'
```

The probe must report exactly the client's Clio Coder version. Project compilers,
dependencies and datasets remain the operator's responsibility.

### LAN endpoints and optional Tailscale discovery

Prefer a verified LAN endpoint when the client and node share a network. Use
Tailscale when it provides the reachable route, with an IP address or MagicDNS
name as the configured SSH host. Clio does not automatically switch endpoints.

Throughput differs by route, so check each candidate endpoint with your SSH
configuration and record its preflight before relying on it.

```sh
clio-coder fleet nodes discover [--json]
clio-coder fleet nodes add node-b --host node-b.example-tailnet.ts.net
```

Discovery explicitly reads `tailscale status --json`; Tailscale is optional.
It requires the daemon to report `Running`, and it shows MagicDNS names, IP
addresses and reported peer state for at most 128 peers with four addresses each. The CLI lists
candidates for you to select with `nodes add`; the TUI provides an endpoint
picker. Discovery grants no SSH access, runtime compatibility or eligibility.
An unavailable CLI or daemon produces guidance to sign in or add a host directly.

### Project arrangement

Every node needs the project at the same absolute path as the client. Recorded
verification distinguishes:

- **Shared storage:** a transient file written on the client is read from the
  node. The node probe only reads it. This can support non-Git projects and
  shared edits.
- **Independent checkout:** both trees are clean, have identical Git HEAD and
  the same sorted root commits. Read-only work runs there; editing work requires
  `worktree: true` and the [SSH return path](#return-edits-from-an-independent-checkout).
- **Unverified:** admission refuses the project with a reason. Matching directory
  names alone establish no shared data or repository identity.

There is no automatic initial clone, path mapping or dataset staging. A shared
mount with different paths is unsupported. After applying a returned change
locally, deliberately update the node's original checkout to the next clean
baseline before dispatching against it again.

## Doctor preflight

A remote node needs a passing recorded check for the current project before
admission. The connection probes observe batch-mode SSH, the exact Clio Coder version,
the project path and writable state storage (or a writable existing ancestor).
The probe reads the remote state directory from `XDG_STATE_HOME`, so per-node
`CLIO_CODER_*` directory overrides are unsupported. Project verification then
proves shared storage or a matching clean checkout.

```sh
clio-coder fleet nodes test node-a                 # observation only; exit 1 when a check fails
clio-coder fleet nodes test node-a --record        # record this node for this project
clio-coder fleet nodes list [--json]               # readiness and check age
clio-coder doctor                                 # inspect all setup
clio-coder doctor --fix                           # local repairs and recorded node checks
```

Plain `doctor` and plain node tests do not create remote directories or update
local eligibility. Recording permits a transient client-side shared-storage
challenge and stores the results in `fleet-preflight.json`. `doctor --fix` also
performs its broader local repairs; run plain doctor first to review those.
A failed recorded test revokes prior eligibility.

`FLEET_PREFLIGHT_MAX_AGE_MS` is one day: connection and resource observations
need periodic rechecking. Records bind the complete connection configuration
(host, user, port, identity file, worker entry and version probe), the project
root and client version. Any connection change, different project, upgrade or
expired record requires a new passing recorded check. Dispatch additionally
rechecks project authority at launch. Failed nodes can remain doctor warnings
while local work stays usable.

Target facts stay separate: network reachability, access to a supported model
listing, presence of the configured model and runtime support. Listing success
proves access to that listing only; it does not prove a chat request, a resident
model or general runtime compatibility. Unsupported probes retain **unknown**.
Only targets pinned to the node are probed with credentials: the targets of
profiles whose `node` names it, and the `fleet.default` target when
`fleet.defaultNode` names it. Other targets get an anonymous probe, which records
listing access as `true` on a 2xx answer, `false` on 401 or 403, and **unknown**
otherwise. Credentials travel through stdin for probes and are not stored in
observation facts. Diagnostics read stored keys without refreshing OAuth. Resource
facts are observations; declared labels never substitute for GPU or memory evidence.

Fleet settings shows **not checked**, **ready for this project**,
**needs attention**, or **offline** alongside live capacity. Opening a node
shows its recorded check time and age, project kind, version, resource facts,
target observations and any refusal reason. An offline channel and a failed or
expired recorded check are distinct facts.

## Placement and process-safe admission

Placement and admission are separate, deterministic authorities:

1. Placement honors an explicit request node, then a profile pin, then the
   session choice, then `fleet.defaultNode`, then local. Unknown, offline,
   stale-preflight or incompatible choices fail closed; they never silently
   fall back. Existing approved route envelopes remain authoritative.
2. Registration alone never moves unpinned work. When a verified node suits
   substantial authorized work and no preference or pin exists, Clio Coder asks once
   with `ask_user`, offering local and suitable exact node ids with reasons.
   The harness remembers the selection for that session. Headless runs never
   ask and use explicit pins or configured preferences.
3. The capacity lease store decides under one cross-process state lock.
   A stale placement preference cannot over-admit a node.
4. If a pinned or selected node is momentarily full, the admission queue holds
   the request in priority, then plan, then arrival order instead of silently
   selecting another node. The queue holds at most 256 requests. A request with
   no deadline waits until capacity frees or it is canceled; `routing.deadlineMs`
   or an assignment deadline gives it one.

The durable admission state file (`dispatch-admission.json` under the state
directory) owns global and per-node leases, heartbeats, reservation transfer, retry
rebinding and the operator drain. A plan reserves its peak wave, and a retry
rebinds the same assignment member to its actual node and cost bound, so a retry
never queues behind or outspends its own plan slot. Admission checks the global
pool, the node and the target's inference endpoint independently; a target's
`maxConcurrentRequests` overrides the endpoint slot count Clio discovers, and the
orchestrator's own streaming turn holds one endpoint slot. The schema, locking protocol,
lease and drain lifetimes, and owner-liveness rules are specified in
[capacity-and-scheduling.md](../architecture/capacity-and-scheduling.md).

When `fleet.nodes` is non-empty and dispatch is available, the operating prompt
carries a bounded fleet inventory: the placement preference, the configured local
capacity, and up to eight SSH nodes with readiness, the `checkedAt` time, `maxWorkers`,
declared labels, observed CPU, memory and GPU facts, the project kind, and up to two
target observations, with unknown observations kept unknown. It holds no free-slot
counts or ticking ages, so worker activity does not change the cached prompt.
Delegated peers are listed separately; their presence does not verify SSH
hardware or project access. Inference routing remains a separate choice
([fleet-inventory.ts](../../src/domains/prompts/fleet-inventory.ts)).

Set a standing preference through **Settings → Fleet → Standing worker node
preference** (`/settings fleet`), or set `fleet.defaultNode` to `local` or a
configured node id. Leave it `null` to permit a once-per-session question when
useful. Profile pins live at `fleet.profiles.<name>.node`, and an agent bound to
that profile through `fleet.agentProfiles` inherits the pin. The compact dispatch
surface accepts `node` on a singular request or an individual task. The placement
question does not replace the existing dispatch plan approval. `fleet.default.node`
is accepted by the settings validator and shown as **Default worker location**, but
placement does not read it; use `fleet.defaultNode` or a profile pin.

### Worker limits and `fleet.concurrency: auto`

`fleet.concurrency` sets the global worker pool and the implicit local node's
limit. SSH nodes always use their own `maxWorkers`. A number means exactly that
many workers for both. The default is `auto`. An explicit value in
`settings.yaml`, a number or `auto`, is kept as written.

`auto` sizes the local node from the host it runs on. The limit is the smallest
of four inputs:

| Input | Rule |
| --- | --- |
| cpu | usable CPUs from `os.availableParallelism()`, which honors affinity masks such as a Slurm cpuset |
| memory | (available memory minus a 2 GiB reserve) divided by 1 GiB per worker |
| cgroup | the same formula over the headroom inside a cgroup memory limit, when one is set |
| cap | 8 |

The 1 GiB per-worker estimate covers workers that run compilers, type checkers
and test suites. The result never falls below one worker. Under `auto` the global
pool is the cap, so a small orchestrator host never shrinks work placed on SSH
nodes. Host facts are sampled at most every 30
seconds. Each sample records the host facts and active local worker count together.
The sampler adds back the estimated memory of those workers, avoiding a capacity
reduction caused solely by Clio Coder's own workers while still observing changes in
host pressure. Calls inside the sampling interval reuse that same paired sample.

When a host input binds the limit, the `/settings` fleet row for `local` shows
it after the busy count (`ready · 1/2 busy · memory-bound at 2`), and the
dashboard status page shows it as `Worker cap  2 · memory`. The footer chip shows
only the live worker count. `clio-coder configure` shows what `auto` resolves to on
the current host, and `clio-coder doctor` reports it as the local worker capacity.

Use `clio-coder fleet drain [--json]` before maintenance to close that shared
admission authority. Existing workers continue, but new plans and every new
execution start fail closed, including a retry or a previously reserved member.
The drain expires after one hour so an abandoned operator process cannot wedge
future dispatch; repeating the command renews the deadline. `clio-coder fleet
status [--json]` reports the active deadline, requesting PID, and request time.
Use `clio-coder fleet resume [--json]` to reopen admission early. Detailed drain mechanics are documented in [capacity-and-scheduling.md](../architecture/capacity-and-scheduling.md).

With no fleet configured and nothing requested, placement resolves to the
implicit local path and optional fleet-node provenance may remain absent.

## Failure semantics

- Channel failures (a stalled heartbeat, a spawn failure, SSH exit 255) count
  against the node; completing the protocol counts for it; operator cancels
  are neutral.
- Two consecutive channel failures classify the node offline in the
  process-local registry, and a placement that names it fails closed until a run
  completes over its channel again. Every other in-flight run on that node is reaped through the stall
  path and finalizes as `stalled` (retryable). Its bounded retry re-enters
  placement with the failed node excluded, then follows the usual order: the
  session choice or standing preference when that names another node, otherwise
  local. When no eligible node remains the retry fails closed.
- Every failover hop is recorded as a reroute (`fromNode`, `toNode`, reason)
  on the ledger row and the receipt, so the placement lineage of a run is
  reconstructable from evidence alone.
- An idle node is never auto-offlined by staleness; only consecutive channel
  failures change the registry health to `offline`. Doctor preflight is a separate
  durable eligibility gate: a failed or stale record blocks placement without
  pretending it changed channel health.
- A result-contract repair round is a synthetic tool exchange whose assistant half
  carries explicit zero usage, so request sizing keeps anchoring on the model's
  last real usage.

A file-scoped edit worker whose reply ends with no tool call gets one more repair round
before the run settles. It is told that nothing was done and which edit tools it was
admitted. The round applies to a mutation-report contract on a run that is not
read-only, has an advisory budget, admits `edit` or `write`, and is not already in its
synthesis lock. A second reply with no tool call ends the run as `worker_no_work`.

### Worker permission refusals

A worker has no operator by default, so `fleet.permissions.mode` (`/settings safety`, Worker
approvals; `deny` by default, `fail`, `escalate` or `main`) decides what happens to a call that needs an
approval nobody can give; [built-in-agents.md](built-in-agents.md) describes each posture. In
`deny` mode a refused execute call returns to the worker model as a tool result and
the third one ends the run with exit 3, outcome `permission_required`, and a
reason that names every refused command. Refusals of other action classes never
count, `fail` ends at the first refusal, and the Claude SDK worker runtime ends at
its first execute refusal. Each denial reads as the tool, the command clipped to
200 characters with secrets redacted, and the rule that refused it
([worker-refusals.ts](../../src/engine/worker-refusals.ts)). The protocol is specified in
[worker-dispatch-mechanics.md](../architecture/worker-dispatch-mechanics.md).

### Failure classification and retries

`classifyFailure` ([failure-classification.ts](../../src/domains/dispatch/failure-classification.ts)) sorts every terminal failure into a class that
decides whether the assignment retries and which route part the retry excludes.
The native worker reports the last provider HTTP status on stderr, and a provider
4xx other than 401, 403, 408 and 429 is deterministic, so it is never resent. A 401
or 403 retries on another target. A 429 retries on another target after at least
one second. A 408 is not deterministic and retries. Cancellation, policy denials,
permission failures and the deterministic outcome codes (`worker_tool_call_cap_exhausted`,
`worker_no_work`, `merge_withheld`, `result_contract_exhausted` and the others in
`isDeterministicOutcomeCode`) never retry. No automatic retry follows a failed attempt
that ran a state-changing call or whose tool telemetry cannot prove the checkout
unchanged. Backoff starts at 500 ms, doubles per attempt and stops at 60 seconds.
The full class table is in
[worker-dispatch-mechanics.md](../architecture/worker-dispatch-mechanics.md).

### Reporting workers at their tool cap

A reporting worker is a recipe with `synthesis: true` and no delivery tool: no `write`
or `edit`, and no `code_nav` for an orientation recipe. At its tool cap it does not fail: tools are disabled, the model
writes its final report from what it gathered, and that sealed synthesis is the
result. A worker with a delivery tool keeps the `worker_tool_call_cap_exhausted`
outcome. The mechanics are in [worker-dispatch-mechanics.md](../architecture/worker-dispatch-mechanics.md).

## Topologies

All topologies go through the dispatch tool, the same admission chain, and
the autonomy matrix. Workers do not inherit the session autonomy. Each worker runs under its own
permit, which admits at `default` except that a `yolo` session adds
`executeAutonomy: yolo` for a mediated, non-read-only worker whose recipe and task
do not declare `asks: deny` or `asks: fail`. That grant lifts only execute-class calls
(`bash`, `run_script`, `verify`) to `yolo`
(see [safety-model.md](../architecture/safety-model.md)).
A `readOnly` dispatch restriction denies mutation and outside reads; reviewers and judges use it.

| Topology | Invocation | Semantics |
| --- | --- | --- |
| Singular | `task: "..."` | One assignment, with optional separate `briefing`. |
| Parallel (default) | `tasks: [...]` | Fan out, wait for all, one summary. Writers sharing a checkout need disjoint `write_roots`, `worktree: true` or `writers: 1`; overlapping or undeclared roots are refused as `parallel_writer_conflict`. |
| Sequential | `mode: "sequential"` | One at a time in request order. A timeout or abort stops the remaining tasks and reports `stopped after N/M task(s)`. |
| Pipeline | `mode: "pipeline"` | Each step receives the previous step's output as data. The chain halts at the first failed step, or at a step whose conforming report records `quality=fail`, and reports how many later steps were skipped. |
| Detached | `detach: true` | Parallel mode only. Return logical assignment ids and a batch id immediately; collect later. |
| Review gate | `review: true` or `review: {reviewer?, max_cycles?, node?, target?, model?}` | Builder, read-only reviewer verdict, bounded revise loop. The reviewer defaults to `verifier`. |
| Compete | `mode: "compete", candidates: 2..4` | N candidates in scratch worktrees, read-only judge, winner applied or preserved. |
| Council | `mode: "council", roster: "design"` | Two to five read-only members answer the same task, with optional vote or judge synthesis. An operator starts one with `/council [--roster <name>] [--rounds <n>] [--synthesis judge\|vote\|none] <task>`; without `--roster` the roster named `default` is used. |
| Agent automation | `agent: "auto"` | Picks the agent from the task shape through a shared classifier: `coder` (write, debug, refactor, config), `tester`, `documenter`, `verifier` (review), `researcher`, `world-knowledge` and `scout` (read, unknown). That baseline is the agent that runs; the router's alternative stays shadow-only unless `fleet.adaptiveRouting.agentRoles` activates the pair. |
| Scout split | `from_scout: {run_id, receipt_digest}` | Second call of the Scout continuation. A terminal Scout run either settles with findings or proposes at most four typed subtasks; this call compiles the proposal into one approval-gated dependency plan. Pass no other argument. |

### Single-writer token

A parallel dispatch may declare `writers: 1`. One is the only accepted value, the
mode must be parallel, and omission retains ordinary parallel admission. Through the
dispatch tool every recipe that is not read-only counts as a writer: writers start
one at a time in request order while read-only recipes run concurrently. A
playbook declares the same token as `writers: 1` (version 5). There the scheduler
admits at most one write-scope step at a time: an agent step with a nonempty
`writes` allowlist is a writer, as is a workspace-scope step that may mutate
the checkout. Read-scope steps and agent steps with `writes: []` remain
concurrent. Waiting writers follow the plan's declared step order and then the
request order. Agent ledger claims remain advisory and do not enforce the
token.

### Checkout writer lease

A `workspace-edit` recipe in a Git checkout acquires a process-owned lease under the Clio Coder state
directory before it runs. Its key is the canonical checkout path (the source checkout
for a `worktree: true` writer), and its record contains the
owner pid, process birth token, and acquisition time. A live sibling process
causes admission to fail with `checkout_writer_lease_held` and the holder pid.
A dead owner or reused pid is reclaimed. The lease remains held until the last
writer settles, including writers collected from detached batches. Read-only
runs never acquire it.

### Declared step scope

In a version 4 or newer playbook, a step's `writes:` declaration is enforced
afterwards by the write-boundary enforcer (see
[Per-step write boundaries](#per-step-write-boundaries-playbook-v4)); declared commands run on the host
outside the worker sandbox, so nothing confines them ahead of the check. The same
declaration also compiles into the step's typed dispatch intent as
`relevant_paths`, never as `write_roots`. A playbook older than version 4 and every
readonly step declare no scope. The producer table and the refusal
reason codes are in [dispatch-typed-intent.md](../architecture/dispatch-typed-intent.md).

### Worktree per task

A singular writer or an item in `tasks` may declare `worktree: true` and
`apply: "merge" | "preserve"`. The default is `merge`. Clio creates
`.clio-coder/worktrees/<runId>/` on `clio-coder/task/<runId>`, maps the worker cwd and
protected artifacts into that checkout, and runs declared host verification
there. The approved execution snapshot renders both fields and freezes the
parent checkout as the merge destination. The host commits the task worktree
when the worker finishes. A worker in a task worktree is told to edit and
report even when its task says "and commit", and `expected_outputs` must be
repository-relative file paths, so `.` is refused at admission, as is an action such as `commit` that lies outside the declared `write_roots`.
Admission also refuses a non-git checkout, a repository with no commits
(`worktree_unborn_head`), a read-only agent, compete mode, and an explicit cwd
outside the parent checkout, each with a named reason.

After a successful worker and successful host verification, merge application
commits the task branch, rechecks protected paths, and uses the same guarded
merge path as compete. A conflict fails closed with
`worktree_merge_conflict` and preserves the branch and worktree. Preserve
application never merges and reports the branch. A detached task applies when its
run finalizes, so `monitor(mode="collect")` returns the sealed application receipt.

Four cases withhold the merge: a worker whose own report lists a failing validation,
a worker whose task requested validation but which executed no check, a worker that
names a check it did not run (`declaredChecks`) with no validation that passed, and a
diff that removes existing test cases or deletes a test file. The first three yield
to passing host verification. The fourth does not, because a passing suite says nothing
about a test that is gone. A test that moves to another file or is only reformatted is
not counted as removed. A run without a task worktree has no merge to withhold, so the same
removal fails it as `worker_removed_tests` and leaves the edits in the checkout. In both
places a clause of the task that asks for tests to be removed exempts the removal. A task
clause that tells the worker not to validate (for example "do not run the tests") means an
unrun check does not withhold. A withheld merge ends the run `failed` with outcome code
`merge_withheld`, which suppresses automatic retry; its work stays committed on the preserved
branch, and the detail names the `git merge` that applies it.

A merge-mode run whose host verification rejected the tree fails with
`host_verification_rejected` and keeps its branch with the work committed. The detail
names the `git merge` that applies it. That detail, the receipt's evidence line for the
check, and the merge card all say whether Clio Coder ran the failing check on the task base. Only
a quick command check is replayed, once, inside a bubblewrap sandbox over a throwaway
archive of the base: one that took under two seconds, with a timeout capped at five seconds.
When the task worktree has `node_modules` and its `package.json` and lockfiles match the base,
the replay links them in; otherwise the note says base dependencies were not provisioned.
Judged checks and commands that name the worker checkout are not replayed. The note says the
check also fails on the base, passes there, or was not compared and why. A failure on the
base does not establish that the worker caused it.

#### Merge task branch card

When the gate withholds a merge, an attached operator is asked first with a `Merge task
branch?` card. A headless run and any surface without an operator always withhold. An ACP
session gets the card only when its client advertised the `clio-coder/interviews` capability.
The card shows the task branch, the dispatch checkout's destination branch, the changed
paths, and the failing or unrun check. Worker-reported failures are named; when no matching
host failure was compared on the task base, the card says whether the failure predates the
worker is unknown.

- The card opens on `Keep branch` and ignores keys other than Esc for a moment after it
  appears, so an Enter typed into the composer cannot answer it.
- `Merge` lands exactly the commit the card showed, through the same guarded path with
  protected paths read again at that moment, and the run succeeds. The merge is withheld if
  the dispatch checkout has left its original branch or the task base is no longer an
  ancestor of its HEAD. `Merge` is not offered when the branch changes protected paths; the
  card names them. A conflicting operator merge fails the run like any other merge.
- If the branch or its worktree changed after the preview, `Merge` and `Discard` are
  refused: the run fails with `merge_withheld`, the branch is kept, and the detail says it
  changed after the preview and to inspect it before merging.
- `Keep branch` withholds: the run fails with `merge_withheld`, its work is committed on
  the preserved branch, and the detail names the `git merge` that applies it.
- `Discard` asks `Delete branch <b> and its worktree? This cannot be undone.` (opening on
  `Back`) and, on `Delete`, removes the worktree and branch; `Back` or Esc returns to the
  card. If the worktree is removed but the branch cannot be deleted, the receipt says so and
  the branch remains.
- Esc on the card, an answer that is not one of its options, and a canceled run all keep
  the branch. An attended card has no timeout. `fleet.permissions.escalation.timeoutMs`
  governs worker permission asks only.

A card behind another overlay posts a notice, and an idle model interview yields the screen
to it and resumes afterwards. While it waits, the run shows as running, `fleet cancel`
settles it as Keep, and a lone dispatch keeps its capacity slot free for other work. Cards
for a batch appear one at a time, and members that pass the gate merge without waiting. The
receipt's `worktree.detail` records the decision: a landed merge reads `merged <sha> onto
<branch>; operator merge accepted after the gate held it because ...`, a refused one begins
`operator merge refused:`, a conflict or other failure begins `operator merge:`, and a keep or
discard begins `operator keep:` or `operator discard:` (with `worktree.reason`
`operator_discarded` after a full discard).

`fleet.worktrees.root` (`/settings workspace`, Task copies) chooses where the working tree is created:

| Value | Location |
| --- | --- |
| `disk` (default) | The location above, under the project root. |
| `tmpfs` | A per-user, per-checkout directory, mode 0700, under `/dev/shm` when that is a tmpfs mount and under `$XDG_RUNTIME_DIR` otherwise. `/dev/shm` comes first because the worker sandbox masks the session runtime directory. |
| `auto` | The `tmpfs` behavior when such a mount exists, quietly falling back to disk when none does. |
| An absolute path | A per-checkout subdirectory of that path, which must be a plain directory owned by the user and not writable by group or others. |

Before creating a worktree off disk, Clio compares the mount's free space with
twice the size of the tracked tree plus 256 MiB. When the space is short, when no usable
tmpfs exists for `tmpfs`, or when the directory cannot be trusted, the worktree falls back to
disk with a `[clio-coder:dispatch] task worktree root` notice. A tmpfs is
RAM: what a worker builds inside its worktree counts against it, and uncommitted
files there do not survive a reboot.

Only the working tree moves. Git objects, the index, the branch, and the
ownership claim stay with the repository. The setting applies to local placement
only: when `fleet.nodes` is non-empty a run may be placed on another host, which
reaches the worktree by the project-root path, so task worktrees stay on disk.
Compete candidates always stay under the project root.

Each task worktree is claimed by `.clio-coder/worktrees/<runId>.task-owner.json`,
which always stays under the project root and records the working tree's path,
the branch, the base commit, the apply mode, and a lease on the Clio Coder process
that created it (host, PID, and a PID-reuse-resistant start identity). A run that
ends and keeps its worktree marks the claim `settled`.

`clio-coder doctor` reports where the next task worktree would be created, with its
filesystem and free space, and lists every task worktree that outlived its run with its
branch, age, whether it is held in RAM, and the git commands to inspect or drop it. A
claim whose branch and worktree are both gone is reported as stale, and `doctor --fix`
removes it.

<details>
<summary>What crash recovery removes, preserves, and refuses to touch</summary>

At the next start in the same checkout, a claim that is still `active` while its
owner is gone is a crash.

A worktree with no commit beyond its base and no modified, staged, or untracked
file is removed with its branch, and so is one whose tmpfs working tree a reboot
took, after its stale git metadata is pruned. Its commits, if any, keep it.

One that holds work is kept, marked `abandoned`, and named once on stderr as
`[dispatch] task worktree recovery preserved <runId>: ...`. A worktree git cannot
inspect counts as holding work and is kept the same way. It is never merged
and never deleted.

A live owner, an owner on another host, and a claim written before recovery existed
are left alone.

</details>

### Return edits from an independent checkout

An editing native SSH dispatch on an independent checkout requires
`worktree: true`. The coordinator prepares the node's isolated
`.clio-coder/worktrees/<runId>/` and `clio-coder/task/<runId>` branch at the
approved base commit, claimed by `.clio-coder/worktrees/<runId>.remote-owner.json`
and excluded through the checkout's `info/exclude`. The worker edits there; after
exit, Clio commits the worker's changes on that branch. The source checkout on the node is
left at its base. Git hooks are disabled (`core.hooksPath=/dev/null`) for these
branch operations on the node and for the local import.

The coordinator fetches the branch through the configured SSH host, user, port
and identity into the private local ref `refs/clio-coder/remote/<runId>`. Before importing, the coordinator checks that the
fetched commit is exactly the returned commit, descends from the approved
baseline without merge commits, touches only permitted paths and changes no
protected artifacts. The owned local task tree must still be clean on its
original branch and baseline. Only that task worktree is fast-forwarded.
Host result validation, declared verification and the existing guarded apply
flow then run locally. The operator checkout changes only through that flow.
`apply: "preserve"` keeps the result instead of applying it.

Transfer, path, validation and application failures preserve the node branch
and worktree. The receipt's worktree detail names the node, branch, path and
imported commit when available. Inspect the preserved branch and any uncommitted
files on the node before retrying, merging or deleting them. A local imported
branch is also recoverable through the existing task-worktree guidance. Remote
cleanup runs only after successful guarded application and checks ownership,
commit identity and a clean tree again; a changed remote tree is preserved.
There is no automatic remote branch recovery or deletion after a crash.

The initial source checkouts must match at a clean baseline. This return path
transfers commits from an admitted task; it does not synchronize arbitrary
repositories. After a successful local merge, update the node's original
checkout deliberately before the next dispatch that needs the new baseline.

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

A top-level intent is the ceiling for the items of a batch. An item's fields
override the top-level fields key by key, and an item may narrow `read_roots`,
`write_roots` and `relevant_paths` but never reach outside them
(`intent_scope_widening`). `gate: "test"` is exact shorthand for
`intent.verification: [{check: "test"}]`; supplying both spellings is refused as
`gate_and_intent_verification_conflict`. Path normalization, the caps (32 entries
per list, 8 verification entries) and every refusal reason code, including
`intent_write_roots_contradiction`, are specified in
[dispatch-typed-intent.md](../architecture/dispatch-typed-intent.md).

Narrow write roots confine a native worker one of two ways. When the OS sandbox
covers the run (`safety.sandbox` is `auto` or `required`, a local bubblewrap backend
is usable, the worker runs on a local HTTP runtime, and no `fleet.nodes` are
configured), the worker keeps `bash`, `verify` and `run_script`, and their commands can write only
inside the roots. A `dispatch` from that worker is still blocked. Otherwise
the worker loses `bash`, `verify`, `run_script` and `dispatch` for the run, cannot run
checks itself, and a `write_roots_checks_withheld` scope notice says so. Declared host
verification still runs on the host in both cases. A write root of `.` sets no boundary,
keeps every tool, and raises `write_root_dot_unconfined` instead. The seatbelt backend
on macOS does not count as covering the run for this purpose
([safety-model.md](../architecture/safety-model.md) owns the sandbox).

Each scope notice reaches every operator surface: the terminal transcript, headless
stderr in text mode and a `dispatch_scope_notice` event in `--json`, the ACP
`dispatch.scopeNotice` event for a client that opted into events, and the GUI's
**Dispatch scope** row. The transcript row for a dispatch summarizes `intent` on one line,
such as `write: src/a.ts; checks: test`, with up to three entries per list and `(+N)` for
the rest. A read root that is only the workspace is the default and is left out.

Verification values are declared check ids, never shell commands. Admission
resolves each id from a package script or `.clio-coder/verifiers.yaml`
([quality-policy.md](quality-policy.md) covers declared checks, including the judged
`numeric-compare` and `perf-budget` kinds), clamps
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
success never populates this status. In a parallel batch each distinct check runs
once per wave, on the settled tree after every live member has finished
(`strategy: "batch-settled"`), and a failure is charged to the members whose write
roots cover the paths it names. A member to which the failure is not charged records
`not_implicated`.

Host checks are supported for singular, parallel, sequential, pipeline, and
detached native runs. Compete refuses verification entries with
`verification_unsupported_for_mode` and council with `council_verification_unsupported`;
both still accept intent paths and outputs.
Claude Code subprocess routes refuse them with
`verification_unsupported_runtime`.

### Agent ledger

Every dispatch whose workers can run at the same time opens an agent ledger, the
bounded coordination board those workers share while they run: a parallel fan-out
of two or more, a `writers: 1` batch, a detached batch of two or more, a compete
group, and a fleet plan that has two agent steps neither of which depends on the
other when `maxWorkers` is at least 2 ([dispatch-runner.ts](../../src/tools/dispatch-runner.ts),
[execution-scheduler.ts](../../src/domains/dispatch/execution-scheduler.ts)). A single-run dispatch,
a council and a strictly ordered plan open none. A native HTTP worker reaches the board through the
`ledger` tool and posts one of four typed entries. A `claim` stakes path prefixes so peers stop
colliding, a `finding` reports one observation with the path and line that ground it, a `review`
judges another entry by its id, and a `message` sends text of at most 1,000 characters to a run id,
`main` or `all`, with an optional `replyTo`. Nothing untyped is postable. A run gets 20 posts and a
ledger holds 200 entries; further posts are refused. Workers on other runtimes (Claude SDK and CLI
peers) see the board as it stood at spawn, and the host posts a bounded final-report `message` for
them when they settle.

The orchestrator is the sole writer. A post travels up the control lane as a
body and nothing else, and every attribution field is stamped from the
orchestrator's own admission record, so no worker-supplied value can reach a
field a peer or a receipt reads as identity. Admitted entries are pushed back
down to each worker's local mirror, so a read answers with a watermark instead of
blocking on a round trip, and a worker that spawns late receives the whole board.
Entries that carry information-flow restrictions are withheld from a worker whose
flow policy refuses the destination. The frame-level protocol is specified in
[worker-dispatch-mechanics.md](../architecture/worker-dispatch-mechanics.md).

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

The main model reads the board too. Through the `ledger` tool it can read a
live board and post to it, attributed as `main:<session>`, selecting a run with
`runId` when more than one board is open. After the workers settle, the parallel
dispatch result, the compete result, and `monitor(mode="collect")` for a detached
batch each carry one `agent ledger (<n> entries, sequence <w>)` section after the
per-run lines. It holds the same bounded render a worker sees, with the same
attribution and the same corroboration and dispute marks, and no count, score, or
consensus line. The section also lists the batch's assignments and, for Scout
reports, the findings taken from receipts. The same text is on the result's
`details.agentLedgerBoard`. A batch nobody posted to still shows
`agent ledger (0 entries, sequence 0)`.

Receipts do not record ledger contributions.

### Detached fan-out, backgrounding, and collect

`detach: true` validates, admits, and spawns every task, then returns. It applies to
parallel mode only and is refused together with a review gate or `timeout_ms`. The
reported id is the logical assignment id (also the first attempt's run id).
For an in-flight attached dispatch, using `Ctrl+G`, then `s`, or `/background` converts
the running attached dispatch into a detached batch. A sequential call moved to the
background leaves the finished and undispatched steps out of the batch and says so.
Backgrounding checks against a refusal table: it refuses Scout dependency plans driving
stages from the turn, compete judge gates, council rounds, review cycle gates, multi-step
pipelines, dispatches with explicit `timeout_ms`, or missing detached records. A worker
permission ask that the main agent must answer can also yield an attached call into a
detached batch, so the main agent can reach `steer`.

Attempts keep streaming into the board and immutable run ledger. The batch and
assignment index are durable (`batches.json` and `assignments.json` under the
state dir), so collection survives session exit; `monitor` `list` and `collect` show only the batches and
runs this session dispatched, and the single-run modes also read runs of the same project. Gather results with the monitor tool: `mode="wait"`
observes one assignment for a bounded time (60 seconds by default, at most 10 minutes). It
never cancels the assignment; `steer` with `action="cancel"` cancels its current attempt
and suppresses later attempts. `mode="collect"` is the barrier over a batch id
or assignment-id list. It blocks while assignments are in flight, polling every
second for 30 seconds by default (at most 10 minutes), and then returns each assignment's
terminal attempt plus `attemptRunIds` history. When the wait runs out it returns the
pending snapshot and says the runs keep running. Collect also stops early when a worker in
the batch waits for a main-agent permission decision, and it returns that request.
Collecting marks the batch so the turn-end nudge stops firing. `wait` observes
without collecting; `collect` is the authoritative terminal batch operation.
Collect every detached batch before final synthesis.

### Review gate

The builder runs the task. A reviewer then inspects the workspace against the
task. The reviewer defaults to the builtin `verifier` recipe
(`DEFAULT_GATE_DECIDER_AGENT_ID` in [execution-role.ts](../../src/domains/dispatch/execution-role.ts)) and never falls back to the builder's own
agent; it is given a read-only dispatch restriction and is routable to a different node,
model, or target through `review.node`, `review.model` and `review.target`. The
`review.reviewer` field names another recipe.

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

N candidate builders (2 to 4, default 2) run the same task, each in its own scratch git
worktree under `.clio-coder/worktrees/<group>/` on its own
`clio-coder/compete/<group>/<n>` branch. Candidate N receives a one-line stance in its
prompt, assigned in order: `minimal-diff`, `test-first`, `refactor-tolerant`, `spec-literal`.
Each candidate's work is committed on its
branch; a read-only judge inspects the branches and answers a JSON object with the winning
candidate number and typed checks (`{"winner": <n>, "checks": [...]}`). The judge defaults to `verifier` and is set through `judge.agent`,
`judge.model`, `judge.target` and `judge.node`. In `yolo` the winning branch is merged. In `default`
the winner's branch and worktree are preserved and the operator
confirms through `apply_winner`, whose approval prompt is the winner
confirmation. A judge-picked candidate whose builder failed, or whose branch changes
protected artifacts, is not applied and becomes an operator decision. Losers are cleaned on every path,
including abort, and every removed candidate is first archived under a recovery ref
`refs/clio-coder/compete/<sha256>` in the repository.

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
singular task concurrently on the local node. A request selects
exactly one configured `fleet.rosters` entry or supplies inline `members`. The council fields (`roster`, `members`, `synthesis`, `rounds`) are advertised to the model only when at least one `fleet.rosters` entry exists; admission still honors them when sent.
Admission gives every member a read-only dispatch restriction and the
`council-read-only` tool surface: `read`, `grep`, `find`, `ls`, `git`, `code_nav`, and `context`.
Members default to the `researcher` recipe. An operator starts a council with
`/council [--roster <name>] [--rounds <n>] [--synthesis judge|vote|none] <task>`; without
`--roster` the roster named `default` is used. With no `--roster` and no `default` roster, `/council` prints
`/council needs a roster. Declare one under fleet.rosters in settings.yaml, ...`, and a `--roster` name that is not
configured is refused with `no roster named "<name>" in fleet.rosters (<configured rosters>)`. A member whose route resolves to
an SSH fleet node is refused before approval (`council_member_remote_node`), as is a runtime
that cannot enforce the read-only tool profile, such as an ACP delegation peer. Council never
creates a worktree and never mutates the workspace.

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
| `judge` | Runs one additional read-only judge against all final answers. The judge runs the call's own agent unless `judge.agent` names another recipe. | Yes, one |

Every member run seals a receipt, a judge receipt points backward to every final
member receipt through gate provenance, and the approval artifact names each
member's label, target, model, node, color, round count, and
synthesis mode, so the plan hash binds the whole council contract.

<details>
<summary>How a vote council collects ballots and what it reports without a majority</summary>

A vote council asks each member for that verdict: the member's task carries the
ballot directive and the member's run seals a `council-ballot` postcondition,
`{"verdict":"...","text":"..."}`, in place of the seated recipe's own result
contract. The seated agent, its persona, and its read-only tool profile are
unchanged, so any recipe can be voted with.

The verdict is a single line of at most 64 bytes and is lower-cased before the
tally, so members that reach the same conclusion land on the same key. The
reasoning belongs in `text`, which is what the council report shows as the
member's answer.

A member that seals no conforming ballot fails its own run and is reported as a
failed member rather than dropping silently out of the count. A vote whose top
tally does not exceed half of the members that answered reports `no_majority`, and a vote in
which no answering member carried a verdict reports `no_verdict_field`.

</details>

### ExecutionPlan and plan approval

Every orchestration shape compiles to one strict ExecutionPlan v4 DAG with
stable task ids, explicit dependencies, requested and approved authority,
capacity-bounded waves, stop/continue semantics, and authenticated structured
handoffs. The scheduler performs whole-plan preflight and reservation before
the first worker spawns. A missing authority grant is an admission failure.

A plan-scale dispatch call maps to an approval ask at the `default` autonomy
level and runs without the stop at `yolo`. A call is plan-scale when it fans out more than one task, continues a
Scout split, runs compete or council, places work on a remote node, carries a task
with approved failover, or applies a compete winner with `apply_winner`
([dispatch-plan.ts](../../src/tools/dispatch-plan.ts)). Before asking, Clio resolves the effective agent, target,
model, node, bounded review cycles/candidates/judge, and scheduling cost
ceiling, then reserves the plan's capacity as a unit. The scheduling cost
ceiling is `safety.limits.sessionCostUsd`. When that is `0` there is no session
ceiling: the plan carries a ceiling of 0, renders its advisory baseline as
`no ceiling`, and neither admission nor a Scout continuation fails on it. The parked
call shows that sanitized artifact, including the approved fallback candidates
in preference order, and one approval covers the whole plan. Declining the plan
rolls the whole reservation back.

A reservation holds the global, per-node and per-inference-endpoint slot count of
its widest wave, so a three-step sequential plan holds one slot rather than three.
Cost upper bounds are recorded on the reservation as advisory accounting and never
deny the plan. It never pins route identity. A retry that lands on a different node
or endpoint rebinds its member atomically and fails closed when the new node or
endpoint has no free slot; the new estimate is recorded without a ceiling check. Reservations owned by a dead process
are reclaimed at startup. The reservation and lease lifecycle is specified in
[capacity-and-scheduling.md](../architecture/capacity-and-scheduling.md).

Execution consumes the same pins, including each expanded builder/reviewer/candidate/judge role and
the SSH node's transport kind and host. A placement, host, or capability
change fails before launch rather than silently choosing an
unapproved alternative. Yolo skips the stop and seals the
same plan hash into every run's receipt instead
(`plan.approval: "yolo"` is the stable receipt value).

The registry boundary is resolved dispatch plan v3. `deadlineMs` is required:
a fleet plan carries a positive integer or `null` and a non-fleet plan carries
explicit `null`. Other versions and missing fields are rejected.

### Shipped playbooks and playbook versions

The fleet is the coordinator and its workers; a playbook is what the fleet runs. Playbooks load from four sources, lowest precedence first: the builtin playbooks shipped in the package (`build-test`, `build-review`, `sdlc`), playbooks shipped by enabled plugins under their `playbooks/` directory, `<configDir>/playbooks/<name>.md` for the user, and `.clio-coder/playbooks/<name>.md` for the project. A file in a later source shadows a file of the same name in an earlier one, and `clio-coder playbook list` shows each playbook's source. The three builtins are version 3 playbooks. `build-test` needs the registry command `test`, `sdlc` needs `test` and `commit`, and `build-review` needs none. A repository that has not yet declared the commands sees those playbooks as `setup` in `playbook list` and cannot run them.

Clio reads only the `playbooks/` directories. A pre-0.6.2 installation that still has `fleets/` is converted once by `clio-coder upgrade` and by the first open of a workspace; see [Converting an older installation](#converting-an-older-installation).

A playbook is a Markdown file. Its YAML front matter holds these keys. Its body is a template: every `{{name}}` must resolve from a `--var name=value`, and an unresolved name fails the run. The shipped playbooks use `{{task}}`, so a run passes `--var task="..."`.

| Key | Meaning |
| --- | --- |
| `version` | Schema version, 1 through 5. |
| `name` | Playbook name; `playbook new` rewrites it to the new file stem. |
| `description` | Optional text shown by `playbook list`. |
| `steps` | Non-empty list of steps. |
| `maxWorkers` | Integer of at least 1: how many agent steps of this plan may run at once. |
| `budgetUsd` | Optional positive number. `fleet run` refuses a playbook whose budget exceeds the remaining session budget. With `safety.limits.sessionCostUsd: 0` there is no session ceiling, so the check is skipped. |
| `onFailure` | `stop` cancels the remaining steps after a failure; `continue` lets independent steps finish. |
| `writers` | Version 5 only. The literal `1` serializes write steps (see [Single-writer token](#single-writer-token)). |

Playbooks support schema versions 1 through 5:
- Version 1: Supports agent steps only.
- Version 2: Introduces deterministic code steps.
- Version 3: Adds bounded check/repair loops and commit steps with `commitFrom` message sources.
- Version 4 (`PLAYBOOK_WRITE_BOUNDARY_VERSION = 4`): Introduces per-step declared write boundaries (`writes`) and orchestrator post-step enforcement.
- Version 5 (`PLAYBOOK_DYNAMIC_STEP_VERSION = 5`): Adds plan steps, executable gate steps, per-step target or worker-profile defaults, and the optional single-writer declaration.

#### Playbook v5: plan, gate, and per-step target

A version 5 agent step, including an agent loop check or repair, may declare either `target: <targetId>` or `profile: <fleet.profiles key>`. It may never declare both. Playbook preflight resolves these values through the same worker routing used by `/run --target` and `/run --agent-profile`. An unknown value refuses before approval and names the target or profile. Versions 1 through 4 continue to refuse both fields.

A `kind: gate` step asks its validator agent to write exactly one repository-relative `path`. The playbook derives the step's write boundary from that path, so a separate `writes` property is refused. Its `run` property names a command whose argv contains one whole-token `{{path}}` placeholder. After the agent writes the executable acceptance check, the coordinator runs it without a shell against the otherwise untouched tree. A red result admits the gate. A green result refuses the run as `gate_not_discriminating`. The fleet ledger records `gatePathHash`, the SHA-256 of the gate file's content. A loop may use `check: {kind: gate, gate: <stepId>}`. Only the bounded output lines beginning with `FAIL` cross that failed check edge into the repair agent.

A `kind: plan` step defaults to the builtin `architect`. It declares `roster` (1 to 16 agents), `maxTasks` from 1 through 16, an optional `proposals: true`, its own scope and write boundary, and an optional target or profile default. The architect returns a `delegation-plan` object whose tasks contain `id`, `agent`, `description`, `depends_on`, `writes`, and an optional `mode` of `sequential` or `parallel`. The coordinator admits only roster agents, unique and acyclic task ids, resolvable dependencies, at most the declared task count, and task writes contained by the plan step boundary. Successful tasks carry lineage to the plan step and inherit its target or profile. A playbook with `writers: 1` serializes write tasks through the existing single-writer token.

When `proposals: true`, every roster member first runs with a read-only dispatch restriction against the same task. Their answers reach the architect as labelled, bounded briefing data. Proposal runs are reserved with the rest of the plan and run in parallel, up to the lower of the playbook's `maxWorkers` and the configured worker capacity. Proposal agents do not choose targets for generated work. The plan step's playbook default remains authoritative for every admitted task. A plan step is never replayed by `--resume`, because the tasks it generates splice into the plan at run time.

### Playbook authoring

`clio-coder playbook` authors and checks playbooks and `clio-coder fleet run` runs them. Usage errors exit 2, as does an authoring command that finds its destination already present. A refused or invalid playbook and a run that does not end clean exit 1. The first `playbook` or `fleet run` command in a workspace that still has `.clio-coder/fleets/` converts it once and prints one notice on stderr.

- `clio-coder playbook list` lists every playbook with its source, a state of `valid`, `setup` or `invalid`, and the rendered steps. It takes no flags. `setup` means the playbook needs registry commands this repository has not declared, and the line carries the remedy.
- `clio-coder playbook new <name> --from <builtin>` copies one of `build-review`, `build-test`, or `sdlc` into `.clio-coder/playbooks/<name>.md`. The command requires a safe file stem (lowercase letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit) and refuses to replace an existing playbook.
- `clio-coder playbook validate <name> [--json]` parses the playbook, validates its graph and command bindings, resolves every agent, target and profile, compiles the execution plan, and checks the declared write boundaries against `.gitignore`. It prints one line per check (`parse`, `graph`, `commands`, `agents`, `plan`), exits 1 with the diagnostics when the playbook is invalid, and creates no state directory, ledger row, reservation, worker, or receipt. `--json` emits `{valid, playbook, checks, planHash}` or `{valid: false, playbook, diagnostics}`.
- `clio-coder playbook graph <name> [--json]` renders the compiled waves with each step kind, agent or command, target or profile, scope, and write boundary. Gate and plan steps show their path, command, roster and task limit. Bounded loops also show their check and repair nodes beneath the loop identifier. `--json` emits `{playbook, planHash, waves, loops}`.
- `clio-coder playbook commands init` discovers declared package scripts, just recipes, Makefile targets, and supported `pyproject.toml` script and tool entries. It writes a fully commented `.clio-coder/playbooks/commands.yaml` draft. Uncommenting an entry confirms its exact argument vector, and an existing registry is never replaced.
- `clio-coder fleet run <name> [--var key=value ...] [--resume <runId>] [--json]` runs a playbook ([fleet.ts](../../src/cli/fleet.ts)). Preflight resolves every agent, target and profile, requires each step scope to fit inside the orchestrator scope, checks that the session budget is open and can hold `budgetUsd` (a session ceiling of `0` is always open and holds any `budgetUsd`), binds routes, and checks the write boundaries; a preflight failure exits 2 before anything dispatches. The run prints `fleet <name>: root=fleet-<hex> plan=<hash> steps=<n> loops=<m>` on stderr, one line per settled step (`--json` prints receipts and code reports as JSON lines), and a summary with each loop's terminal reason, staleness re-runs, steps that need an operator decision, and write-boundary violations. Exit code 0 means every required step succeeded, no step was skipped, and every loop resolved; any other finished run exits 1, and an error thrown by the scheduler exits 2 like a preflight failure. `fleet view <fleetRootId>` lists the steps and the run id of each.

Run resumption is separate from `clio-coder fleet resume`, which reopens dispatch admission after an operator drain. A resumable fleet run records its playbook name, rendered plan hash, ordered step identifiers, variables, and receipt references in the durable fleet ledger under the state directory. Runs started from the TUI through `/fleet run` use the same durable record and can be resumed with `fleet run --resume`. `--resume` starts a new fleet run after replaying the longest successful, integrity-valid prefix of the named prior run, in declared step order. The new run records the prior fleet run as its resume parent. Replayed steps are reported as `replayed`, retain their original receipt or code-report references, and do not create new receipts.

The current playbook must compile to the same plan hash. A mismatch refuses before execution and prints the changed positions in the ordered step list. The prior run must belong to the same playbook name, and the variables must exactly match the original run. A different value, an added value, or an omitted value is refused even when the resulting task text would otherwise be similar. An unknown run id is refused as not found in the durable fleet ledger.

#### Converting an older installation

Clio reads no `fleets/` directory and accepts no alias. Before 0.6.2 the same files were called fleet contracts and lived under `fleets/`. `clio-coder upgrade` runs a dated migration for the user home that merges `<configDir>/fleets` into `<configDir>/playbooks` without overwriting. A name present in both places stays in the old directory, which is then moved aside with a dated suffix. A workspace's `.clio-coder/` converts the first time Clio opens it, with one notice that lists what changed and what still needs the operator. A third-party plugin that still declares `resources.fleets`, the `fleet` kind or a `fleet:` requirement stays installed but does not load. The report names the fix, which is for its author to rename `resources.fleets` to `resources.playbooks`, its `fleets` directory to `playbooks`, and fleet kinds and requirements to `playbook`. Nothing in the conversion deletes operator data.

### Per-step write boundaries (Playbook v4)

Playbook v4 gives every step a write boundary through the `writes` allowlist property. A `workspace` step must declare a non-empty allowlist. A `readonly` step is the empty allowlist and is refused if it declares `writes`.

The grammar for declared write boundary entries requires repository-relative POSIX paths:
- Trailing `/` indicates a directory subtree allowlist.
- Exact relative paths without a trailing `/` permit changes to that single file.
- Declarations must not contain glob characters (`*`, `?`, `[`, `]`, `{`, `}`), `..` or `.` segments, backslashes, or absolute paths.
- Each step declaration is capped at a maximum of 32 entries (`WRITE_BOUNDARY_MAX_ENTRIES = 32`).

Write boundary enforcement is detect-and-rollback, never OS or filesystem sandboxing. A step runs with whatever filesystem permissions its underlying execution environment possesses. Upon step completion, the orchestrator inspects the working tree to verify compliance:
1. Snapshot baseline: Before a step executes, the orchestrator captures a snapshot (`captureWorkspaceSnapshot`) recording the baseline git HEAD commit and existing dirty path content tokens.
2. Workspace diffing: After step completion, the orchestrator runs git status inspection (`diffWorkspace`) to identify changed paths relative to the snapshot baseline commit.
3. Authorship attribution: A changed path outside the allowlist is blamed on the window only when it intersects what the window's own runs recorded writing. That record is the run's tool-call stream, folded by the same recorder that grounds a sealed mutation report and read back through `DispatchContract.observedRunWriteAttribution`. A change that no run in the window recorded is an unattributed concurrent change: it is listed under `unattributed` in the verdict and reported to the operator, and it is never rolled back. This is what keeps a file an operator edited while a fleet ran from being overwritten with its committed version.
4. Open records: A run's recorded write set is read as a closed list only when the run could not have written outside it. A window whose steps do not all offer a closed record falls back to blaming every change outside the allowlist. Three things open a record: a `kind: code` step, whose registered command publishes no tool events; a run whose tool telemetry coverage is not `complete`, such as one on a subprocess runtime; and a run that made a successful call to a tool able to mutate a path its own arguments do not name. That last set is derived from the tool surface rather than authored, as every registered tool outside the `read` and `write` action classes, which today is `bash`, `verify`, `dispatch`, and `steer`, plus any dynamic or MCP tool whose schema this process cannot read. The `git` tool is a closed status, diff, and log surface and stays enumerable. When a successful opaque call opens the record, the live Alt+W card immediately names the tool and says that its arguments cannot enumerate every path it may write. The durable verdict records `attributionComplete: false` and an `attributionDowngrades` entry with the reason, tool name, tool call id, run id, and step id. The after-the-fact write-boundary message repeats that cause before explaining why the whole outside diff was blamed on the window.
5. Rollback execution: Attributed unauthorized changes are automatically rolled back (`rollbackPath`).
6. Content source: Rollback restores content strictly from what git already has in the pinned baseline commit (`snapshot.head`). If a path was already dirty when the step snapshot was captured, its prior content is not stored in git, so in-place restoration cannot be guaranteed. The working tree is left as the step made it, and the status settles as `rollback-incomplete`.
7. Violation handling: Any attributed unauthorized change fails the step with the typed reason `writes_boundary_violation`.
8. Window attribution: Enforcement evaluates scheduling windows (`wave-<n>` or `revalidate-<stepId>-<n>`). A wave window cannot combine steps with overlapping declared boundaries or multiple concurrent step writers, ensuring single-step attribution.
9. Ignored paths and state subtraction: Enforcement evaluates paths reported by git status, which never lists a git-ignored path. A declared `writes` entry the repository ignores is therefore refused before anything runs, by `playbook validate`, by `fleet run` preflight, and by the `/fleet run` preview, with a diagnostic naming the entry and the ignoring rule (for example `'work/' is ignored by .gitignore:1:work/`). Silently certifying such a window as clean is not an option, because nothing about it was observed. The Clio Coder state directory (`.clio-coder/` or `clioStateDir()`) is subtracted from status checks so orchestrator receipts, code step log artifacts, and boundary verdicts do not trigger false violations.
10. Durable records: Verdicts are serialized as JSON records at `write-boundaries/<rootId>/<window>.json` under the Clio Coder state directory, carrying the baseline HEAD commit, checked paths, violations, unattributed concurrent changes, the attribution completeness flag and downgrade causes, rollback actions, status, and SHA-256 digest.

### Bounded check/repair loops

Playbook versions 3 through 5 support declared check/repair loops (`kind: loop`). A loop declares `id`, `maxAttempts` (an integer between 1 and `PLAYBOOK_LOOP_MAX_ATTEMPTS = 5`), `check` (a code command or agent reviewer), and `repair` (an agent coder).

At plan compilation, the orchestrator unrolls each loop statically into a deterministic hashed DAG containing `maxAttempts` verification check steps (`<loopId>.check.<n>`) and `maxAttempts - 1` repair steps (`<loopId>.repair.<n>`).
- Receipt per attempt: Every attempt in an unrolled loop executes as an independent plan node and produces its own receipt.
- Recovery role: Repair attempts following the first check are assigned the `recovery` execution role.
- Spent bounds: Reaching `maxAttempts` without a passing check settles the loop with the terminal reason `loop_bound_exhausted`.
- Four terminal reasons: A loop concludes with one of four reasons: `resolved` (verification passed), `loop_bound_exhausted` (attempt ceiling spent), `loop_step_failed` (underlying step errored or was denied), or `loop_not_reached` (prior plan dependencies failed).
- Node counting: Unneeded nodes (verifications or repairs remaining after a loop resolves) are counted separately from skipped nodes.
- Verification staleness: The scheduler enforces verification staleness by re-running a green code check step (at most 3 times per step) if a workspace-editing step finishes after it and before a dependent runs.
- Cycle checkpoint: After each check step settles, Clio captures the workspace as an immutable ref `refs/clio-coder/loop/<sha256>` in the repository, without touching HEAD or the index, and prints `loop <id> cycle <n> checkpoint=<ref>`.
- Repair input: A repair step depends on its check and on the check's own dependencies, so it receives the check's verdict together with the report of the work under repair (the builder's or the previous repair's mutation report).
- Changed-test gate: A code check step that is not a `gate` check also runs the test files that its workspace ancestors changed (see [Changed tests in a loop check](#changed-tests-in-a-loop-check)).

#### Changed tests in a loop check

When a loop's check is a code step and not a version 5 `gate` check, the registered command is not the only thing it runs. The check collects the paths that its workspace ancestors changed: each ancestor's mutation-report `mutatedPaths` plus the changed paths its task worktree or checkout recorded, for ancestors whose receipts passed integrity ([fleet-run.ts](../../src/domains/dispatch/fleet-run.ts), [code-step.ts](../../src/domains/dispatch/code-step.ts)). It keeps the paths that look like test files, resolves a runner for each through the project's own declarations ([test-files.ts](../../src/tools/verify/test-files.ts)), and runs those after the registered command. A failure of any of them fails the check and feeds the repair loop, so a reproduction test the builder adds gates the result even when the registered command names only existing test files. Each extra command appears as a `changed tests (<check id>)` entry on the step's report, with its own exit code and duration.

The recognized runners are `node --test`, `tsx --test`, jest, vitest, pytest, unittest, `go test` and `cargo test`. A changed test with no recognizable runner yields a note on the report, and only the registered command runs for it. A loop whose check is a version 5 `gate` step runs only that acceptance command, and a code step outside a loop check runs its registered command alone. The `build-test` playbook and the check note tell the builder the exact argument vector the check step runs.

#### Step handoffs and retries

A step receives its predecessors' final outputs as labelled data, never as instructions: at most 16 predecessors and 12,000 bytes in total ([execution-handoff.ts](../../src/domains/dispatch/execution-handoff.ts)). The budget is shared max-min fairly, so short outputs keep every byte. An output over its share keeps its head and tail around a marker `[clio: N of M bytes omitted ...]` that names the run whose full output the coordinator retains, and the worker is told the output is an excerpt. A loop repair receives the check's findings in place of the raw check transcript. Plan compilation refuses a step with more than 16 predecessors, so `playbook validate` reports it.

A fleet step settles on the final attempt of its retry chain: a step that fails and then recovers on a retry counts as succeeded, its dependents run, and every attempt's cost counts once in the run total. Each step, including each loop repair, has its own retry allowance under `fleet.retry.maxRetries`.

### Deterministic code steps

Deterministic code steps (`kind: code`) execute known commands directly as subprocesses rather than calling an agent model.
- Registry binding: The `command` property must reference a command ID declared in `.clio-coder/playbooks/commands.yaml`. Invocation strings are never generated from model output.
- Execution environment: Code steps run unattended with arguments bound from the command registry, fixed working directory, closed environment allowlist (`PLAYBOOK_COMMAND_BASE_ENV` plus declared command env), bounded timeout (`timeoutMs`), byte-capped output capture (`CODE_STEP_CAPTURE_MAX_BYTES` = 1 MiB log artifact, `CODE_STEP_EXCERPT_MAX_BYTES` = 8,000-byte excerpt), no stdin pipe, no permission prompt, and no shell interpreter.
- Missing registry diagnostic: If a playbook declares code steps but `.clio-coder/playbooks/commands.yaml` is missing in the repository, `clio-coder playbook list` reports the playbook state as `setup` and provides the remedy: ``needs .clio-coder/playbooks/commands.yaml declaring <id>; declare each id there under `commands:` with an `argv` list; see bundled `docs/guide/fleet-dispatch.md` for the schema``.
- Commit message sources: A code step with `commitFrom` populates its `commitMessage` placeholder from the output of preceding agent steps.
- Cost and route: Code steps run no model. Their cost is recorded as `known_free`, an observed zero, and they produce a code-step record rather than a receipt, route decision, or quality label.

#### Command Registry Schema (`.clio-coder/playbooks/commands.yaml`)

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

The `commands` map needs at least one entry. A command id matches `[a-z0-9][a-z0-9._-]{0,63}`. Each command entry supports:
- `argv` (required): Array of command arguments starting with the binary name (no shell strings).
- `argumentSlots` (optional): Operator-declared positional data slots, each with a unique `name` (letters, digits, `_` and `-`, starting with a letter, at most 64 characters) and required `maxLength` (1 to 8192). At most 64 slots. Omission forbids appended playbook arguments; declared slots are all required.
- `cwd` (optional): Repository-relative working directory (defaults to repository root).
- `timeoutMs` (optional): Per-step execution timeout in milliseconds (defaults to 600,000 ms; bounds: 1,000 to 3,600,000 ms).
- `env` (optional): Array of extra environment variable names (uppercase letters, digits and `_`) to pass through on top of `PLAYBOOK_COMMAND_BASE_ENV` (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`).
- `description` (optional): Human-readable description.

The whole-token `{{commitMessage}}` substitution is available to commit steps. The whole-token `{{path}}` substitution is available to version 5 gate commands. Each substitution becomes exactly one argv element and never passes through a shell.

A playbook may supply per-task data only when the operator explicitly declares slots in the repository registry. Keep the executable, script path, and fixed flags in `argv`; the playbook cannot replace them. Use a fixed `--` separator where the registered program supports it. For example:

```yaml
# .clio-coder/playbooks/commands.yaml, owned by the operator
version: 1
commands:
  check-materials-task:
    argv: ["python3", "checks/check_materials_task.py"]
    argumentSlots:
      - name: taskDirectory
        maxLength: 256
```

```yaml
# One code step in a version 2 or newer playbook
kind: code
id: check-task
command: check-materials-task
args: ["{{taskDir}}"]
scope: readonly
dependencies: []
```

Run with `--var taskDir=.research/tasks/task-01`. A slot receives exactly one literal argument. Values must be nonempty, fit the slot's length limit, contain no NUL, and not start with `-`; fixed flags belong in the operator's registry. A whole-token `{{variable}}` binds before admission and participates in the plan hash. Missing variables, undeclared or excess slots, embedded placeholders, and flag-like values fail before execution. The code runner repeats slot validation for direct or in-memory plans. Spaces and shell metacharacters remain data without another expansion pass. Existing fixed commands accept no extra args.

## Measured route selection and agent automation

The joint resolver treats agent, target, model, runtime, and node as one
bounded tuple. Manual pins, the approved plan envelope, authority, audience,
required tools and skills, result contract, response-schema support, locality,
authentication, network policy, endpoint reachability, context, resource fit,
capacity, budget, deadline, and cooldown are hard filters. Every enumerated
tuple is estimated from conservative quality, reliability, completed cost and
latency, queue wait, and cache affinity. Admissible tuples must clear the posture's
quality and reliability floors, are ranked by a posture-weighted score, and are
flagged when another tuple dominates them. The complete bounded candidate/rejection
set is sealed; at most three fallbacks are projected.

Shadow is the default and never changes the explicit route. Active route
selection requires both the execution role and posture to be named, a call that sends
`routing.failover: "approved"`, and an agent whose capability class is `read-only` or
`verification`:

```yaml
version: 2
fleet:
  adaptiveRouting:
    roles: [researcher, verifier, reviewer, judge]
    postures: [quality, balanced]
    agentRoles: []
```

For every exact tuple, `evaluateRouteReadiness` requires consistent hard-
constraint evaluation, no integrity failures, at least six role-specific
quality labels, conservative quality and reliability floors (and the request's own
`minimumQuality`), known cost, fresh node/endpoint/resource/capacity/settings facts, and
a decision p95 of at most 10 ms. If no tuple is ready, active mode refuses the assignment. It never
falls back to the fixed route, and manual or `failover: none` intent never
drifts.

`roles` takes `researcher`, `verifier`, `reviewer` and `judge`. `postures` takes
`quality`, `balanced`, `latency` and `economy`; `manual` is exact by definition and is
never an activated posture. `agentRoles` takes `{agentId, executionRole}` pairs, with
`builder` also allowed as an execution role, and rejects `agentId: auto`. All three lists
default to empty.

`agent: "auto"` first filters recipe audience, authority and governance. Bounded task
features affect cold priors only; one truthful role-quality label retires the task prior.
Agent automation has its own readiness report per agent/spec/role and stays shadow
unless the call's posture is activated, the call sends `routing.failover: "approved"`, and
the operator names an exact agent/role pair in `agentRoles`. A read-only Scout can
settle reconnaissance directly or return at most four typed subtasks. The
coordinator validates ids, dependencies, expected result contracts, and
requested authority and rejects embedded agents, routes, deadlines, costs, or
other control fields. Escalation to workspace editing requires authenticated
plan approval or existing yolo authority.

### Route history and settled labels

Each settled dispatch writes one record to `route-history.json` in the state directory ([route-history.ts](../../src/domains/dispatch/route-history.ts)). The file is version 3, keyed by terminal receipt digest, and keeps the newest 4,096 records. A file of another version is renamed aside as `route-history.json.v<N>.<timestamp>.retired`, never read, and the store starts empty. A record holds the route identity, the execution role, `qualityLabel` (`pass`, `fail` or `unmeasured`, from independent evidence only), `reliability` (`success`, `failure`, or `neutral` for operator cancels, policy denials and permission refusals), `firstPass`, completed cost and phase timing, cache use, source digests and `settledAt`. The route observer refines `qualityLabel` when later gate evidence authenticates.

Independent quality evidence arrives late or never, so every record also carries `settled`, the receipt's own verdict from `routeSettledLabel`:

| `settled` | Meaning for the operator |
| --- | --- |
| `success` | The receipt outcome is `succeeded`. |
| An outcome code | The receipt's `outcomeCode`, the most specific failure class: `worker_tool_call_cap_exhausted`, `worker_context_exhausted`, `loop_guard_tools_disabled_exhausted`, `result_contract_exhausted`, `worker_final_output_missing`, `host_verification_rejected`, `worker_no_work`, `worker_mutation_blocked`, `merge_withheld`, `worker_removed_tests`, `information_flow_blocked` or `vram_capacity_fit_failure`. |
| `permission_required` | No outcome code, and the outcome detail opens with `permission_required`: the worker ended on its refusal limit or the `fail` posture. |
| `failure` | The outcome is `failed` with neither of the above. |
| An outcome | Any other receipt outcome, unchanged: `timed_out`, `stalled`, `canceled`, `denied_by_policy` or `spawn_failed`. |

A record written without the label receives one from its receipt when the observer next reconciles it. The label is a lowercase token. `clio-coder fleet view <runId>` prints it on a `settled` line once the receipt authenticates ([Model, cost and settled label in `fleet view`](#model-cost-and-settled-label-in-fleet-view)). It is also readable in `route-history.json` and in the `outcome` lines of the route observer log, and the receipt's `outcome` and `outcomeDetail` (shown by `fleet view`) and `outcomeCode` (in the receipt file) are the per-run source it is derived from. No `evidence` or `trace` command prints it. Adaptive routing does not read `settled`: route estimates and readiness use `qualityLabel` and `reliability`, so the label cannot change a route choice. Routing on it needs a recorded decision first.

## Assignments, attempts, and failover

A dispatch is a logical assignment containing one or more immutable run
attempts. The assignment id and terminal run ids are distinct identities.
Public `finalPromise` handles resolve only when the assignment succeeds,
is canceled, or exhausts its retry policy; the returned receipt is the
terminal attempt's unchanged receipt. Earlier attempts stay independently
addressable and integrity-verifiable. The assignment also owns the event stream,
which carries every attempt's frames in order, separated by a synthetic
`attempt_start` frame; [worker-dispatch-mechanics.md](../architecture/worker-dispatch-mechanics.md) specifies it.

Manual `target`, `model`, or `node` pins default to exact failover (`none`): a
retry may repeat the tuple but cannot silently move away from it. `approved`
failover moves only within the ordered `allowedCandidates` envelope of exact
agent/target/model/node tuples that the approved plan lists; Clio Coder enumerates the
envelope and a model cannot send one. `automatic`
failover lets typed infrastructure failures exclude only the failed route
part. For example, an SSH channel failure can move the node while retaining the
agent, target, and model. Cancellation, policy rejection, and permission
refusal neither retry nor penalize infrastructure. A worker information-flow refusal ends the run with deterministic `outcomeCode: "information_flow_blocked"`; it is never retried or failed over.

A worker receipt records the mode that governed its retries as
`effectiveFailover`. That is a different fact from `routingIntent.failover`,
which carries the two-valued policy the request asked for and reads `none`
whenever nothing was requested, so only `effectiveFailover` tells a sealed tuple
apart from an unpinned run that was free to move. A receipt omits it when no
dispatch failover governed the run, as for a main-agent or print-mode receipt.

When a lower-level request omits the failover field, retry policy defaults to
`none` for a target or node pin and `automatic` otherwise. Normal tool
admission resolves `routing.failover` explicitly; a manual target, model, or
node pin requires `none`.

A plan-approved task is never `automatic`. An explicitly pinned task seals its
exact tuple with `failover: "none"`, and so does a planned task that did not send
`routing.failover: "approved"` or has no candidate. A task that did send it seals
`failover: "approved"` with a bounded candidate list of at most three routes, built by the
route resolver and rendered into the plan text the operator approves.
Validation rejects `automatic` on a request carrying plan provenance, so an
approved dispatch can only reroute to a tuple the approval actually showed.

The retry count is bounded by `fleet.retry.maxRetries` (default 2), or by the approved
route's attempt limit minus one when a route approval is active, and the timing follows
backoff: 500 ms at the start, doubling per attempt, stopping at 60 seconds, with a 429
answer raising the delay to at least one second. Whether a failure retries at all
depends on its class, the failover mode, and the safety suppressions listed in
[Failure classification and retries](#failure-classification-and-retries). A target cooldown protects new work from a known-bad target; it does not gate
an assignment already in flight, because that assignment's own retry budget is
the correct and sufficient bound. A retry denied at admission settles the
assignment failed, reports the reason on stderr, and records it in the
assignment's `outcomeDetail`.

A retry that excludes the target, which a target-attributed failure does under
`automatic` failover, moves to the first configured route on another target
that can serve the request. The route must resolve to that target, carry every
capability in the request's `requiredCapabilities`, and have a breaker that is
neither open nor probing. When no other route qualifies, placement chooses
again, which usually lands on the failed route after backoff; the admission
capability gate still applies to whatever it picks.

The cooldown is a per-route circuit breaker, keyed by target, runtime, and wire
model, held in memory by the running process. It moves through three states:

| State | How it is entered | What dispatches see |
| --- | --- | --- |
| Closed | Start, or a success resets the consecutive-failure count. | Normal admission. |
| Open | Consecutive target-attributed failures reach `fleet.retry.breakerThreshold` (default `1`, so the first failure trips it). Lasts `fleet.retry.routeCooldownMs` (default 15000 ms). | Reroute when the failover mode allows it, refusal otherwise. |
| Half-open | The cooldown expired. | The next new dispatch is admitted as the only probe; every other dispatch still sees the route as cooling until that probe finishes. |

The failures that count are `target-auth`, `target-rate-limit`,
`target-transient`, and `worker-runtime`. A probe success closes the route and
resets the backoff. A probe failure reopens it with the cooldown doubled, up to
five minutes, or the configured cooldown if that is longer. A probe that ends
for a reason that says nothing about the target, or never starts, frees the slot
for the next dispatch to probe.

The breaker is not persisted. `clio-coder targets` and `clio-coder doctor` run in
their own processes and cannot see it, so the session's `/settings` targets rows
are where an open, half-open, or probing route shows with its remaining cooldown.

<details>
<summary>Why context overflow and rejected schemas do not trip the breaker</summary>

A provider's context-overflow error and a response schema the server rejects are
verdicts on the request, not on the route, so they never count against it.

A rejected schema ends the attempt without a retry.

A context overflow is retried once, and only onto a route whose effective context
window is strictly larger than the failed route's. The route is chosen like a
target-excluding retry, except that another model on the same target also
qualifies, and under `approved` failover it must be in the approved envelope. The
retry counts against `fleet.retry.maxRetries`, and the attempt's retry reason in
the assignment lineage reads `context-overflow: 8192 -> 32768 on big/qwen`.

An overflow is not retried under `none` failover, when the failed attempt was
itself an overflow retry, or when no eligible route has a larger window. The
assignment then settles failed with an `outcomeDetail` that names the reason.

</details>

Assignment status, attempt ids, and terminal run id are stored separately in
`assignments.json` while each attempt keeps its own strict v20 receipt.
Pipelines and batches await assignment terminals, so downstream stages consume
the successful fallback output rather than an earlier failed attempt.

A fleet run is the exception to "the attempts settle the record". Every step of
a fleet dispatches under the fleet root id as its lineage root, so all of them
share one row, and no single step is the run's verdict. The run claims the row
by writing `verdictOwner: "fleet"` when it opens, files every settled step's
attempt run ids in `attempts` (an agent step's receipt id, a code step's
`code-*` run id, whose report sits under `code-steps/<fleetRootId>/`), and
writes `status` once at the end from the whole-run outcome. Until then the row
stays `running`, and a step settling under it records its attempt without
touching the status. The row is `succeeded` only when every required step
succeeded, no step was skipped and every loop resolved; any other end, including an
unhandled error, is `failed`. A run abandoned by a crashed process is
reconciled to `failed` at the next startup rather than inheriting a green
step's success.

## Receipts

Receipts carry exactly one current integrity version (`RUN_RECEIPT_INTEGRITY_VERSION = 20`), which authenticates the complete receipt and reconstructible ledger provenance surface. There is no historical evidence reader: a lower version is reported as retired, is not migrated, and is never read as evidence; a malformed or future version is invalid. The fleet provenance fields covered by the digest
include:

- `node`: the fleet node the worker ran on (`id`, `kind`, `host`). The `node.id` explicitly identifies the worker process host executing the task, not the model host (which is represented by the `target` id).
- `reroutes`: dead-node failover hops, oldest first.
- `gate`: review/compete provenance (role, group, cycle, subject run ids with
  their receipt digests, and the verdict that caused a revise builder).
- `plan`: plan-approval provenance (hash, topology, task count, cost ceiling
  (`0` when there is no session ceiling), approval kind, and the registry approval identity when supervised).
- `budget`: the sealed budget envelope (recipe policy, request, effective phase and clamp reasons).
- `briefing`: byte count and SHA-256 of the exact canonical parent briefing;
  the prose is not retained and is distinct from bounded project context.
- `intent`: the normalized typed path, expected-output, and verification
  declaration that admission sealed for the run.
- `verification`: the existing evidence state and basis observed from worker
  tool execution.
- `hostVerification`: host-run status and the resolved check evidence, including
  argv, cwd, exit code, duration, memo provenance, bounded output tail, and
  optional artifact path.
- `worktree`: task worktree path, branch, diff hash, requested application,
  applied status, and an optional closed failure reason.
- `steering`: ordered byte/hash/timestamp and acknowledgement provenance for
  successfully written steers; steering prose is never stored.
- `outcomeCode`: the stable terminal classifier. The codes are
  `vram_capacity_fit_failure`, `worker_tool_call_cap_exhausted`,
  `worker_context_exhausted`, `loop_guard_tools_disabled_exhausted`,
  `result_contract_exhausted`, `worker_final_output_missing` (an otherwise
  successful worker exited without a nonempty receipt-sealed final answer),
  `host_verification_rejected` (a declared host check rejected the settled tree),
  `worker_no_work` (an edit worker finished without doing its assignment),
  `worker_mutation_blocked`, `merge_withheld` (a task worktree was preserved instead
  of merged because of one of the four gate cases above), `worker_removed_tests` (a
  run in the current checkout removed existing test cases that the task did not ask to
  remove) and `information_flow_blocked`. Every code suppresses automatic retry.
- `routingIntent`, `routeDecision`, and `quality`: the normalized hard bounds,
  complete current-policy decision, exact execution role, route estimate and
  readiness evidence, and authenticated quality sources.
- `effectiveFailover`: the retry mode that actually governed a worker run;
  a run without dispatch failover omits it.
- `resultContract`: inside `quality`, the admitted contract identity and its `pass`, `fail`, or
  `not-reached` conformance state. Only a due correctness-bearing contract can
  label route quality.
- `validationGrounding`: claimed versus grounded validations checked against canonical executed commands.
- `capabilityMismatch`: the recipe's capability class against the task shape (`agentId`, `capabilityClass`, `taskType`, `suggestedAgentId`). A confident mismatch is refused at admission and never becomes a run, so a receipt carries only a flagged one.
The worker's attestation is verified at spawn and a drifting peer never runs,
but the attested identity is not copied into the receipt, and the receipt records
no ledger contributions. A receipt that carries an `attestation` or
`ledgerContribution` field verifies as stored.

Process exit zero is not a delegated deliverable. Native and ACP runs succeed
only when the drained event stream yields a nonempty receipt output with
`state: "final"`. A missing final answer fails with
`outcomeCode: "worker_final_output_missing"`; any captured unfinished text is
retained only as `state: "partial"` diagnostics and automatic retry is
suppressed. Dispatch, monitor, ledger, receipt, terminal bus event, and retry
policy all consume that same final classification.

Receipt integrity, host verification, and evidence verification are separate axes. Integrity says
that the sealed receipt matches its ledger envelope; evidence verification
reports whether Clio Coder observed an applicable validation tool (or marks the
basis unknown/not applicable). A read-only Scout can therefore report `receipt_integrity=verified/v20/sha256` alongside
`evidence_verification=not_applicable/read-only-agent`. Host verification is
rendered independently as `host_verification=verified|rejected|skipped|not_implicated|not_requested`.
A host-executed successful check projects onto canonical validation grounding as
authenticated validator evidence. Briefing provenance and
bounded `project_context` provenance are also rendered independently; neither
hash substitutes for the other.

A worker that runs `verify` more than once is judged by the latest run of each
check. A check is the call's `check`, `path`, `cwd`, `browser` and `args` taken
together. Re-running `verify(check="test")` after a fix clears the earlier
failure, and a later failure of a check that passed seals as failed. A narrower
`verify(check="test", args=[...])` is a different check, so its pass clears
nothing, and a blocked call never ran its check, so it changes nothing. The
receipt's `quality.typedValidations` carries one `tool:verify` fact per check,
and evidence verification agrees with those facts. A check whose only calls
were blocked seals no typed validation fact because it never ran. Workers leave
denied checks out of mutation-report validations and place source reads and
citations in summary. When no files changed and no check ran, validations may be empty and quality
remains unmeasured. Editing reports may use empty validations when every attempted check was blocked; otherwise they require a concrete executed check. For receipts carrying `safety.readOnly: true`, mutation-report read claims
do not require command evidence; verifier verdicts and executable path claims
retain command grounding; executable validation claims still do.

The canonical terminology for these facts is the five-axis trust status in
[`evidence-and-memory.md`](../architecture/evidence-and-memory.md).
Receipt integrity projects onto artifact integrity; receipt verification,
typed quality, and validation grounding project onto validation grounding;
gate decisions project onto independent review; briefing and project context
project onto context provenance. A receipt does not contain independent-review or
completion-evidence outcomes merely because it is sealed. Those axes remain
`absent` until an authenticated gate artifact or finish assessment is composed.
Integrity authenticates the recorded artifact; provenance identifies its
sources. Validation, review, and authorship are represented by their respective
observations and authenticated identities.

Gate references point backward: a reviewer references the builder it reviewed, a
revise builder references the reviewer whose findings it received, and a judge
references every candidate.

Because a worker receipt seals before the coordinator parses its final verdict,
terminal pass/fail, exhaustion, winner, and confirmation outcomes are append-only
integrity-covered gate-decision artifacts under the state directory. Evidence
builds discover them from linked receipt ids and export `gate-decisions.json`.

Reviewer and judge terminal output first crosses an integrity-covered
write-ahead boundary under `state/gate-decisions/pending/`, before the caller
waits for the final receipt. Restart recovery verifies the receipt, applies the
same verdict/winner parser, materializes the final artifact idempotently, and
only then clears the pending record. Missing receipts, tampering, or a
conflicting artifact fail closed and leave the journal and any compete worktrees
available for inspection.

Protected-artifact hard blocks follow compete work into candidate worktrees:
Clio mirrors every applicable parent-checkout path into each admitted worker
spec and independently rejects a winner branch whose diff touches a protected
parent path. The merge/apply coordinator rechecks the live protection state,
so neither yolo nor a later supervised winner approval can override that
hard block.

## Operator visibility

- Every run carries the origin that asked for it. The board and the transcript
  worker block mark it with a glyph: `◇` for a run the operator started with `/run`
  or `/delegate`, `◆` for one the model started by calling a dispatch tool, and
  a quiet `·` on the board for Clio Coder's internal helper runs (transcript helper
  rows use `↳`). A running `◇` on the board is therefore the operator's own work.
  The footer shows the live worker count (`N workers`) and the Activity quadrant a
  `fleet <summary>` such as `fleet 2 active 1 done`; neither splits by origin.
- User-origin and agent-origin runs stream into the chat transcript as an
  attributed worker block. The typed command is echoed dim above the block.
  Header units display `<agentId>` (a council member shows its roster label)
  then `<targetId>/<wireModelId>` then `run <runId>`, plus `attempt <n>` after a
  failover, for fleet workers (such as `◇ coder · node-a/example-coder-model · run 2mkas6s`),
  or `<id> (acp) · run <runId>` with no route for ACP delegation peers. The header
  ends with the execution outcome (`✓ execution ok`, `✗` with the outcome code,
  `○ ran no tools`, or canceled) and the duration. The block body renders the worker
  prose down a rail, a rail line with tokens processed, context and tool calls (hidden
  in the Compact style), and a `quality` line that keeps validation quality separate
  from execution status. A failure reason prints on the rail.
- Model-launched workers use `◆`; operator-launched workers use `◇`. Both follow the current Output style: Compact identity/outcome, Standard short summary, Detailed bounded activity and a larger summary. `Alt+O` cycles styles for the session. `/view transcript` and `/view dispatch:<runId>` expose full available details. Execution success and validation quality remain separate facts.
- Sharing: nothing an operator-started run (`/run`, `/delegate`) produced enters
  the main model's context unless `--share` was passed or the operator runs
  `/share [runId]`; runs the model started return through the dispatch tool result as
  usual. What enters is a bounded note of the shape
  `[worker result] <agent> · run <id> · <outcome> · shared by the operator`
  followed by the bounded answer text, capped at 8,192 bytes, traveling the ordinary
  user-turn path. The coordinator prompt tells the main agent that such notes are
  steering and that it should verify relevant claims as it would any other evidence.
  `/share` on a council synthesis run shares every labelled member answer with the synthesis.
  Bare `/share` picks the newest finished run the operator started themselves
  (never a model-asked `◆` run); `/share <runId>` may name a model-asked run
  explicitly. `/new`, `/resume`, `/tree`, `/fork` and `/handoff` reset the pool bare `/share`
  draws from, so a run from another session cannot be shared into the current one.
- Replay: `/resume` replays worker blocks from receipts; the session file's
  `workerRun` entries carry ids, origin, runtime and task without worker prose; the
  replayed answer is bounded from the receipt exactly like the live one. A
  missing receipt renders `receipt unavailable`.
- Internal `context-bootstrap` and `wiki-writer` runs report through the context rail
  and never open a transcript block. Other shadow and internal helper runs open a
  compact `↳` row.
- The Fleet Runs board, the overlay that `/fleet` opens, shows per-run cards with the node id (absent placement
  renders `local`), gate badges (`gate reviewer c2`), reroute badges, live
  tool activity (the current or last call as a redacted verb and object; raw
  arguments never cross the worker stdout seam), and a per-worker context meter.
  It also lists finished runs. `Up` and `Down` (or `k` and `j`) move the cursor, `s`
  steers the selected run, and `x` cancels it.
- `Enter` on a live run takes the [workers dock](#workers-dock-and-dashboard)
  over for that run when a pane host is present. It opens the dock or shows a parked one,
  and leaves the keyboard in Clio Coder. Moving the cursor retargets an existing dock to the
  selected live run and never opens one. Without a pane host, and for a finished run,
  `Enter` toggles the inline worker detail: the phase, the running call
  with a redacted action descriptor (`bash running npm test`), the bounded tail of the
  worker's own prose, and the full task, route and budget lines. The default list
  stays compact, so a fan-out of scouts costs one card each until an operator
  opens one. Council rows have no detail.
- The board and the transcript worker block read one projection
  ([worker-progress.ts](../../src/domains/observability/worker-progress.ts)), so they cannot disagree about what a
  worker is saying or touching. Progress settles on `agent_end`, with the live phase shown as `finishing` until the terminal run event arrives. It keeps 40 lines and 4096 bytes of tail, 8
  distinct tool names, 4 recent actions, and accepts 16 KB of delta bytes per
  250 ms; what the bounds refuse is counted and named on the card beside the
  `/view dispatch:<runId>` deep link.
- Action descriptors are composed where the arguments are trusted: the tool
  registry's admission path, the Claude tool mapper, and the ACP update
  mapper. Each reads a fixed verb vocabulary and a fixed argument-field
  allowlist, scrubs credentials, strips escape sequences, and bounds the
  object to 64 characters before it crosses the worker stdout seam. Raw
  argument objects never cross at all.
- Reasoning content is never displayed. The detail may name a `thinking`
  phase and the usage facts the card already carries, never the text.
- Settlement replaces the provisional tail with the sealed receipt's answer;
  a run whose receipt cannot be read keeps its own last durable message.
- The context meter renders the worker's last-message context occupancy
  against the model's context window: healthy below 80 percent, warn from 80,
  critical from 95.
- `/fleet` opens the Fleet Runs board: running, retrying and finished runs with their
  actual node. `←` on an empty composer opens the same overlay, and so does `Alt+W` in a
  session without a pane host. In a `--with-panes` session `Alt+W` drives the
  [workers dock](#workers-dock-and-dashboard) instead. Settings → Fleet (`/settings fleet`) holds
  the default worker, profiles and node pins, the standing placement preference, guided
  SSH add and optional Tailscale discovery, and node rows with readiness and capacity.
  Open an SSH row for evidence, timestamps, a recorded test, installation preview or
  removal. Agent bindings are the **Agent routes** in `/settings agents`.
- `/fleet run <playbook> [--var k=v ...]` compiles the playbook's plan and opens
  the approval overlay before anything dispatches. The overlay lists the steps
  grouped by wave, and for each step its kind, its agent and resolved target
  (or its command id and the exact argv from `commands.yaml` for a code step),
  its scope, and its declared write boundary, followed by the budget ceiling
  the run would be admitted under (`budget: admitted under no session ceiling`
  when `safety.limits.sessionCostUsd` is `0`). Enter dispatches the plan through the same
  path `clio-coder fleet run` uses, so admission, autonomy, receipts, and the
  durable ledger are identical. Esc cancels with nothing dispatched and nothing
  written. A playbook that fails preflight opens the same overlay with its
  diagnostics and no accept key. A turn in flight refuses the command with a
  notice rather than queueing it: an approved plan describes the workspace as
  it stands.
- A council is one question asked of several members, so its rows render as one
  card rather than as two to five unrelated neighbours. On the Fleet Runs board the
  members sit side by side, one column each, as long as every column keeps at
  least 34 cells and a 2-cell gutter separates columns; below that the whole group
  stacks one member under another rather than squeezing some columns and not others.
  The overlay is at most 96 columns wide, so only a two-member council fits in
  columns and larger ones stack. Each column carries the
  member label in its roster color (a member with no color takes the accent), the
  target and model, the round, the status, and a bounded answer tail of at most four rows. The synthesis run takes the full width under the
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
- `clio-coder fleet status [--json]` shows the durable ledger view cross-process;
  [Inspect fleet runs from the CLI](#inspect-fleet-runs-from-the-cli) lists every inspection command.
- A worker permission ask opens a `Worker needs approval` card (tier `Worker escalation`) that names the worker agent and run. The worker is parked while the card is open. Approval covers that call and identical calls under the same permission conditions for that run only. It leaves the autonomy level unchanged, and each call still passes the safety net.

### Workers dock and dashboard

A `--with-panes` session ([Panes and the Files Pane](panes-and-files.md)) can keep a workers dock beside Clio Coder's own pane. The dock runs the workers dashboard: a board of this session's workers and a live takeover of one. The operator opens it. A dispatch starting, detaching or failing never opens a pane ([pane-policy.ts](../../src/interactive/pane-policy.ts)). `interface.panes.layout` set to `workers` or `cockpit` opens the dock at boot, on the board.

#### Workers key

`Alt+W` (action `clio-coder.dispatchBoard.toggle`, leader suffix `w`) is the workers key. With a pane host its single tap settles to one of these:

| State | Single tap |
| --- | --- |
| No dock | Opens the dock on the board and moves the keyboard into it. |
| Dock parked | Shows it at its remembered share, on whatever it was showing, and moves the keyboard into it. |
| Dock visible | Parks it. The dashboard keeps running with its state. |
| No pane host | Opens or closes the Fleet Runs board overlay. |

A second tap within 400 ms of the first closes the dock and ends the dashboard process. A single tap has no added delay. Pressed inside the dock, `Alt+W` reaches Clio Coder through the tap file, so the same key parks the dock, returns the keyboard to Clio Coder and counts toward the double tap. `q` inside the dock also parks it and returns the keyboard, without arming the double tap. While the Fleet Runs board is open, `Alt+W` closes it.

The dock splits to the right of Clio Coder's pane and takes `interface.panes.workers.ratio` of the width (default `0.34`, range `0.05` to `0.5`) but never fewer than 40 columns, which is half of an 80-column terminal. A session pane too narrow for 40 columns at half its width refuses the dock with `the workers dock needs 40 cells and at most half of <n> is available`.

#### Process and request files

The pane runs this install's own CLI: `clio-coder fleet view --watch <state>/watch-selection --dock-taps <state>/watch-dock-taps`, with the config, data, state and cache directories pinned on argv. The dashboard reads durable state only: the run ledger (`runs.json`), each run's [event journal](../architecture/worker-dispatch-mechanics.md#run-event-journal), the sealed receipt and, for a fleet step, the fleet run record. It shares nothing with the orchestrator's memory, runs over SSH, and works from a second terminal. It polls every 250 ms.

Two small files carry everything between Clio Coder and the dashboard, one pair per state root:

| File | Direction | Content |
| --- | --- | --- |
| `<state>/watch-selection` | Clio Coder to dashboard | Replaced atomically. Line 1 is the run id a takeover is requested for (blank asks for the board), followed by `seq=`, `session=` and `since=` lines. `seq` changes on every request, so asking for the same run twice still takes the dock over. `session` and `since` scope the board to this session. |
| `<state>/watch-dock-taps` | Dashboard to Clio Coder | One word per appended line: `hide` for `q`, `key` for `Alt+W`. Clio empties it when a session starts. |

Run by hand without `--dock-taps`, `q` quits the dashboard. Without a TTY, `fleet view --watch` prints the selected run's snapshot, or a note that no worker is selected, and exits 0.

#### Board

The board has one card per worker of this Clio Coder session: runs stamped with the session's id, plus runs with no session stamp that started after this Clio Coder booted. Started by hand with no request, it lists every run in the inspection scope (this project, or all projects with `--all`). A failed attempt that a retry or failover attempt replaced gives way to the replacement's card, which carries `↻<n>`. Live runs (queued, running, stale) come first, newest start first. A `finished` group follows with up to 24 runs, newest end first.

A card has three rows:

1. The state glyph (`●` running, `◌` queued, `!` stale, `✓` done, `⊘` canceled, `✗` failed, `◌` for a run that succeeded without calling a tool), the agent id, the elapsed clock and the task.
2. The route (`target/model`), the tool-budget meter (`▰▰▱ tools 12/40`, or `tools 12` with no cap), tokens, and for a finished run its cost when something priced it.
3. For a live run, the call in flight as a redacted verb and object, the prose being written, `last: <call>` while it waits on the model, or its phase (`starting`, `thinking`, `writing`, `calling a tool`, `waiting for the model`, `sealing the receipt`). A queued run reads `queued, waiting for a slot`. For a finished run, the receipt's verdict: `✓ succeeded`, `◌ ran no tools`, `⊘ canceled` or `✗ <outcome code>`, then `contract pass|fail|not-reached|unmeasured` when the receipt records a result-contract fact, then the trust verdict (`trust reviewed|grounded|unverified|unknown`, or the failed axis in words). A seal that is not intact (such as `seal broken`, `seal retired` or `seal unchecked`) replaces the trust verdict. A run with no readable receipt shows the ledger's own outcome detail or `receipt unavailable`.

A narrow dock sheds the task first, then the model, then cost and route. The state glyph and the clock always stay. Every worker-adjacent string is redacted and stripped of control bytes where it is drawn.

| Board key | Action |
| --- | --- |
| `↑` `↓`, `k` `j` | Select the previous or next card. |
| `g`, `G` | First or last card. |
| `Enter`, `l`, `→` | Take the dock over for the selected card. |
| `q` | Park the dock and return the keyboard to Clio Coder. |
| `Alt+W` | The workers key: park the dock, or close it on a double tap. |
| `Ctrl+C` | End the dashboard and its pane. |

#### Takeover

A takeover pins a header over the worker's live stream. The header holds the back hint, state glyph, agent id, state and elapsed clock with `run <runId>` at the right, the task (up to two lines), the route, tool-budget meter, tokens and cost, and for a step of a fleet run a line `⇲ fleet <name> · <settled>/<planned> steps settled · following`. Below it the stream shows, each row with its offset from the run's start:

- Tool calls as a verb and object, `…` while pending, then `✓` with the duration, `✗ failed` or `⊘ blocked`. A failed or blocked call adds up to two rows of its reason.
- The worker's prose as it streams, and a `thinking` marker where a reasoning block opened. Reasoning content is never shown.
- Approvals asked, and each decision with its reason.
- The run outcome code and reason, steering received, and a note when the journal reached its size cap.

When the journal is missing, the stream says no event journal exists (`fleet.history.journal` may be off). When the head was dropped it says earlier events are not shown. A requested run that is not in the ledger yet shows `waiting for this run to reach the ledger`.

A finished worker adds a receipt section under the stream: the verdict row, a spend row (tool calls, tokens, cost, duration), the seal, trust and validation clause, the first line of a failure message, the changed paths, and the first 12 lines of the sealed answer. A longer answer ends with the count of the rest and `clio-coder fleet view <runId>`.

| Takeover key | Action |
| --- | --- |
| `Esc`, `←`, `h`, `Backspace` | Back to the board at the same card. |
| `↑` `↓`, `k` `j` | Scroll one line. |
| `Ctrl+U`, `Ctrl+D` | Scroll half a page up or down. |
| `g` | Jump to the top. |
| `G` | Follow the newest line. Scrolling to the bottom does the same. |
| `q`, `Alt+W`, `Ctrl+C` | As on the board. |

A takeover follows work forward. When the run it shows finishes and a retry of it, or the next step of the same fleet run, starts, the takeover moves to that run (a live one first, otherwise the newest started). A takeover Clio Coder requested by name follows even when the run had already finished. A finished card opened with `Enter` is inspected and stays. While a followed run has finished and its fleet is still running, the stream ends with `waiting for the fleet's next step`.

#### Dock requests

`/panes show <agent|run>`, the `panes` tool's `show` action and `Enter` on a live run in the Fleet Runs board write a request and take the dock over for that run. They open the dock or show a parked one, and they never move the keyboard, because the caller may be the model. `show` matches live (running or retrying) runs only: an agent id substring first, then a run id prefix, newest first. A target that matches no live run reports `no live run matches <target>` and lists the live agents, so a finished run is inspected with `clio-coder fleet view <runId>` or from the dashboard's board. The Fleet Runs board stays reachable through `/fleet` and `←` on an empty composer.

## Inspect fleet runs from the CLI

Every inspection command reads durable state only, so it works from a second terminal or over SSH. Inspection defaults to the current project, and `--all` widens it to machine-wide state ([fleet-project-scope.ts](../../src/cli/fleet-project-scope.ts)). An unknown flag exits 2.

| Command | What it reports |
| --- | --- |
| `clio-coder fleet status [--json] [--all]` | The admission state (`open`, or `draining` with the deadline, requesting PID and request time), each running or stale row with its node, heartbeat (`alive`, `stale` or `dead`, from the recorded worker PID), attempt, depth, elapsed time and cost, the budget envelope lines, and totals for tokens, cost and runtime. The owning process writes live token counts and cost to the ledger on each reconciler tick, about once a second. The retry queue lives in the owning process, so `retrying` is always empty here. |
| `clio-coder fleet inspect --json [--all]` | A bounded projection for hosts: the newest 8 runs with their 32 newest journal events, evidence state (`pending`, `verified`, `failed`, `unavailable`) and outcome, up to 4 fleet roots with 24 steps each, and the topology of up to 4 councils (seated members, rounds, synthesis kind and judge run, never the answers). Text is sanitized and width-bounded. `--json` is required. |
| `clio-coder fleet decisions --json [--all]` | The newest 8 sealed review and compete gate decisions, each with at most 6 subject runs, the decider run and a closed-set reason. It reports `available: false` when no gate has ever run, plus `truncated` and an `unverifiable` count. `--json` is required. |
| `clio-coder fleet view <runId> [--follow] [--json] [--all]` | One run's ledger entry, event journal transcript and sealed receipt, with the receipt authenticated against its ledger envelope before any field is shown. A unique id prefix resolves. Once the receipt authenticates, the snapshot adds `model`, `cost` and `settled` lines ([below](#model-cost-and-settled-label-in-fleet-view)). `--follow` (or `-f`) tails the journal in an alternate screen until the terminal line and stays open until `q`; without a TTY it prints a snapshot. `--json` prints the snapshot as JSON, including the authenticated receipt. |
| `clio-coder fleet view --watch <selection-file> [--dock-taps <file>] [--all]` | The workers dashboard that the workers dock runs ([Workers dock and dashboard](#workers-dock-and-dashboard)). `--watch` does not take a run id or `--follow`, and `--dock-taps` is valid only with `--watch`. |
| `clio-coder fleet view <fleetRootId> [--all]` | The step index of a fleet run: one line per step with its run id and outcome. Pass one of those run ids back to see that step. |
| `clio-coder fleet verify <runId> --json` | Re-authenticates one run's sealed receipt right now and reports `state` (`pending`, `verified`, `failed` or `unavailable`), a closed-set `reason` when it did not authenticate, and the five trust axes. Exit 1 for an unknown run. |
| `clio-coder fleet cancel <runId> [--json] [--reason <text>]` | Cancels one running run from any terminal. |
| `clio-coder fleet drain [--json]`, `clio-coder fleet resume [--json]` | Close or reopen durable dispatch admission (see [Placement and process-safe admission](#placement-and-process-safe-admission)). |

The `view` transcript comes from `<state>/runs/<runId>/events.ndjson`, which the orchestrator writes while `fleet.history.journal` is on (the default). The line format and write path are in [Run event journal](../architecture/worker-dispatch-mechanics.md#run-event-journal). A run dispatched with the journal off shows its ledger and receipt but no transcript, and the viewer says whether the journal is disabled or missing. The transcript renders each feed line in words: prose as `assistant`, a tool call as `<tool> started` and `<tool> ok|error|blocked in <n>ms` with its verb and object, a model call as `model call (<n> tokens)`, and the lifecycle lines as `run opened (<agent>)`, `receipt sealed (<outcome>)` and `terminal (<outcome>)`. `fleet view` exits 0 after it prints a snapshot or index, or after `--follow` ends. An unknown or ambiguous id, an unknown flag, and an invalid combination (`--json` with `--follow`, `--watch` or a fleet root id) exit 2.

`fleet cancel` acts according to who owns the run. When the owning process is alive, the command leaves a cancel request that the owner's reconciler tick turns into its own abort, so the run seals `canceled` with a full receipt. The command waits up to 15 seconds for the seal and exits 0 when it lands. It exits 1 while the request is still pending; the request stays queued and is applied on the owner's next tick. When no live owner is recorded, the command leaves the request, waits the same 15 seconds and reports a note in the `--json` output, because only a process still holding the run can apply it; it never kills a process it cannot confirm. When the owning process is gone, the command terminates the orphaned worker's process group (SIGTERM, then SIGKILL after 3 seconds) once it has confirmed the PID is the run's worker, and refuses to guess when it cannot. It then seals the ledger row from a verified receipt if the owner wrote one, and otherwise settles the row `canceled` without minting a receipt. It refuses a run that is already terminal, a run recorded on another host, and an invalid run id.

### Model, cost and settled label in `fleet view`

When the receipt authenticates, the snapshot adds three lines after `evidence`:

| Line | Content |
| --- | --- |
| `model` | `requested <wireModelId>` from the receipt, then the provider's report for each call in `upstreamResponses`, grouped with counts: `reported <id> (n/m)`, `no model id in the response (n/m)`, `not observed (n/m)`, or `legacy record, differing id <id> (n/m)`. A receipt with no response rows prints `no provider response recorded`. |
| `cost` | `$<usd to four decimals>` and the receipt's `costProvenance`, or `not recorded` and `provenance not recorded`. |
| `settled` | The receipt's label from `routeSettledLabel`, the value route history stores ([Route history and settled labels](#route-history-and-settled-labels)). |

A receipt that fails authentication prints `RECEIPT INTEGRITY FAILED` and its reason on the `evidence` line, and none of these three lines. The route a run was dispatched on is configuration. Only the provider's report says which model answered, so `not observed` means Clio Coder captured no report for that call. It never means the requested model served it.

Calls over the `openai-codex-responses`, `openai-responses` and `azure-openai-responses` APIs read `response.model` from the provider's lifecycle events ([responses-model-id.ts](../../src/engine/apis/responses-model-id.ts)). A response that names a model records `responseModelIdObservation: reported` with that id, a response object without one records `not-reported`, and a call that produced no response object records `not-observed`. The observation is stored per call in session usage and in the receipt's `upstreamResponses`.

`fleet view <runId> --json` prints one JSON object: `runId`, `agentId`, `model`, `target`, `node`, `phase`, `startedAt`, `elapsedMs`, `task`, the bounded `transcript` and `transcriptTruncated`, `journalPresent` and `journalPath`, `evidence`, `receiptPath`, `outcome`, `outcomeDetail`, `terminal`, `journalUnavailableReason` and `agentLedgerBoard` when they apply, and the full `receipt` only when it authenticated against its ledger row. The snapshot has no `settled` field. The label derives from the receipt's outcome fields.

## Route observer

The route observer records what the joint route resolver decided against what happened for every dispatch. It never selects a route, because selection belongs to the resolver. It appends one JSON line per decision (`kind: "decision"`) or outcome (`kind: "outcome"`) to `<state>/route-decisions/observations.jsonl` and rotates the file to `observations.jsonl.1` at 1 MiB. The records measure route regret, constraint validity, prediction calibration, and outcome. An outcome line also carries the receipt's `settled` label (see [Route history and settled labels](#route-history-and-settled-labels)). The records do not measure whether Clio Coder dispatched the agent the caller asked for, because that is true by construction.

## Speculative worker prewarm

`fleet.speculativeDispatch` (default `false`, experimental) lets Clio Coder start a worker process before the model asks for it. The System One `turn` site predicts which recipe the main agent is about to dispatch. When its fitted prewarm cut fires, Clio spawns that worker and holds it at "waiting for spec" while the main model generates. See [System One](system-one.md) for the `turn` site.

A dispatch adopts a held process only when its agent, target, wire model, runtime, and working directory all match the prediction. Anything else runs on an ordinary cold spawn, and the held process is killed when the turn settles. At most two held processes exist at once. They take no capacity lease, so they never take a slot from a real dispatch.

Nothing is held for a remote node, a non-native runtime, a draining fleet, or an endpoint or fleet already at its limit. The call, admission, spec, and receipt of the adopting dispatch are identical to a cold spawn.

## Residency

Remote workers default to residency observe. The SSH transport projects that
posture as `lifecycle: user-managed` in the worker's target, so a worker on a
node that serves resident models (for example a GPU box running the operator's
inference server) never evicts them. A node opts into management explicitly
with `residency: manage` in its fleet entry. An explicit target
`lifecycle: user-managed` remains authoritative even on a managing node.

A model the router tags as pinned (`pinned:true` or `role:scout`) is never
evicted once resident, so Clio Coder refuses to load it by evicting a resident that
settings still reference by role; on a one-slot router such an override
declines with a `will-not-fit` notice instead of stranding the configured model.

## Manual fleet verification

Use `clio-coder playbook validate <name>` and `clio-coder playbook graph <name>` for
model-free playbook checks. An operator with configured targets can then run
the playbook explicitly with `clio-coder fleet run <name>` and retain its
receipts; `clio-coder fleet verify <runId> --json` re-authenticates a sealed receipt
afterwards. [Topologies](#topologies) explains reviewer gates and verification
commands. Live fleet execution requires an operator.

## Bounded result delivery

Recipes whose result contract is `mutation-report` (`coder`, `documenter`, `tester` and `git-master`) return a structured report. Explicit recipe
selections remain in force. For a read-only explanation, its `summary` carries
the requested explanation and citations, with `mutatedPaths` empty.

| Field | Bound |
| --- | --- |
| Inline `summary` | 16,384 UTF-8 bytes by default, set between 1 and 32,768 by recipe `maxSummaryBytes` or dispatch `result_summary_max_bytes`. |
| Internal helper results | 32,768 bytes (`STRUCTURED_HELPER_RESULT_MAX_BYTES`), the same acceptance and receipt-capture ceiling. |
| Authored `commitMessage` and `architect-plan` authorship | 1,000 UTF-8 bytes. |

In batch
dispatches, a top-level `result_summary_max_bytes` default is inherited by
mutation-report tasks and ignored by other steps; an explicit per-task
`result_summary_max_bytes` on a step without a mutation report fails validation before model
dispatch. A one-task batch counts its top-level value as that task's own. `max_output_bytes`
separately limits the returned preview, not the stored summary.

If worker output exceeds the sealed output bound, capture fails and names the
bound rather than reporting an ambiguous JSON syntax error. If the requested
answer cannot fit within the summary allowance or cannot be grounded, the summary
must state the specific limitation. A longer artifact requires authorization to
write it; a shortened answer or validation log does not satisfy an unmet length
requirement.

Documenter exposes no arbitrary shell commands; it relies on declared verifier checks or grounded source reads. In validation reporting, unexecuted checks must never be recorded as failures (`passed: false` applies only to checks that actually ran and failed). Unexecuted checks or execution limitations belong in the `summary` deliverable as stated limitations.

Eligible native HTTP workers with tool support finish through the worker-local `clio_submit_result` tool. This covers internal helper results and coder `mutation-report` results. Its arguments are the existing contract payload, not a second model-authored envelope. The host validates the payload and grounding, seals `output.structured = {version: 1, kind, data}`, and retains canonical JSON in `output.text` for consumers that read text. A valid handoff ends generation without another narration round. During synthesis or repair only the terminal handoff remains available; mixed work/handoff batches are rejected and repairs remain bounded. A mutation report's schema reaches the model only at the synthesis lock or a terminal-format repair, so working requests carry no extra bytes, and a valid plain JSON answer still seals without the tool. A submission is not work activity and gains no authority: the mutation validator checks the report against the run's observed effects in the worker and again at parent capture. Strict JSON text fallback is validated through the same contract. Other transports retain their existing output path, and Wiki Writer retains its scoped artifact workflow.

Dispatch and `monitor(mode="collect")` expose successful sealed payloads in `details.runs[].helperResult`, with compact text and a receipt lookup. Failed integrity, failed runs, partial/truncated output, or failed contract conformance do not become consumable typed results. `quality=unmeasured` remains unmeasured. Typed data never grants write authority or authorizes Scout split continuation by itself.

For an independent helper task, use `detach:true` and continue useful work; collect the batch when its result is needed. This uses the existing durable detached-run mechanism. The TUI announces helper start and settlement in its notice area even for internal invocations without a transcript island.

The Scout recipe instructs the model to return structured findings with source paths and exact lines checked against live reads. A search hit alone does not establish a citation. Grounding counts the spans a read returned and the lines a grep result showed, whether the call was direct or a settled step of a gateway chain; a pending, failed or refused step grounds nothing, and a chain step cut to its share of the aggregate grounds only the lines that survived the cut. On repair, unsupported findings should be removed rather than moved to convenient range endpoints. Inline delivery and schema conformance do not establish semantic citation accuracy.

Planning time estimates and the dispatch `budget` are advisory during execution rather than automatic aborts. Enforced bounds are explicit caller deadlines (`timeout_ms`), operator cancellation, contract output bounds, capacity rules, and the hard tool-call ceiling described in [Worker prompt and budget admission](#worker-prompt-and-budget-admission). In advisory dispatch `fleet.limits.toolCallsPerRun` lowers that ceiling for recipes with a larger maximum but never below the admitted estimate. Repetition guards still apply. The `fleet.limits.internalRunTimeoutMs` setting (default 900000 ms) bounds internal CLI dispatch such as the wiki documenter and the bootstrap scout; it does not impose a wall-clock deadline on ordinary TUI dispatch workers.

A pipeline stops before admitting a dependent when a completed step reports failed quality. Execution success, result conformance, and deliverable quality remain separate facts. An independent recovery has its own receipt and does not replace the failed pipeline result. When delivery is missing or incomplete, report the terminal result and limitation; a successful process exit alone does not establish the requested deliverable.

An editing mutation report may omit all validations when every checking call it attempted has an observed blocked outcome. It conforms with unmeasured quality. No attempts, unknown outcomes, or any executed check retain the concrete validation requirement.

Validation grounding treats `npm test`, `pnpm test`, and `yarn test` as aliases of the canonical `npm run test` command across all three managers. The test aliases also match the package-manager-neutral `verify(check="test")` summary recorded as `npm run test`. Other script names remain distinct; `npm run test:unit` does not ground a claim of `npm test`.

A terminal colon in a validation claim, such as `npm test:`, is punctuation and grounds against `npm run test`. Script suffixes such as `test:unit` remain distinct.

A typed-scope replacement produces one stderr diagnostic per root run, on the first attempt of an internal or harness dispatch, and none for `context-bootstrap` or `wiki-writer`. Retries are quiet, and receipts keep the scope provenance. The notice changes no working-context path, rule selection, or worker authority.
