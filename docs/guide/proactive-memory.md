# Proactive task memory

> **Visual blueprint:** The source checkout includes the complete
> [Proactive task memory visual reference](https://github.com/iowarp/clio-coder/blob/main/docs/html/proactive_memory_blueprint.html).

Clio's proactive task memory protects long-running work from behavioral state
decay: a requirement, environment fact, failed attempt, or diagnosis can still
exist in the transcript while no longer influencing the next action. The design
follows Wu et al., *Remember When It Matters: Proactive Memory Agent for
Long-Horizon Agents* (2026), adapted to Clio's visible middleware and local-model
routing.

The rules-only tier is enabled by default and makes no model calls. An LLM memory
tier is opt-in through the independent `context.memory.target` and
`context.memory.model` route. The action agent's system prompt and tool surface
do not change, and disabling `context.memory.enabled` removes observation, bank
writes, model resolution, reminders, handoff offers, and handoff seeding.

## Architecture

```mermaid
flowchart LR
  T[tool and lifecycle hooks] --> R[memory intervention registration]
  R --> B[session task bank]
  R --> D{trigger boundary}
  D -->|rules only| S[deterministic policy]
  D -->|background configured| L[two-phase local model policy]
  S --> V[visible advisory reminder]
  L --> V
  V --> U[next user turn and session ledger]
  R -. counts and outcomes only .-> J[bounded state JSONL]
  B -. explicit context-handoff .-> H[redacted handoff snapshot]
```

The task bank is in `src/domains/memory/` and belongs to one live session. It is
separate from both durable approved lessons and the regenerable repository
context engine.

- **Private status** is the memory policy's short progress model. It can be
  inspected with `/memory`, but is never rendered to either model, injected into
  the action turn, or exported to a handoff.
- **Knowledge** contains stable task facts such as requirements, paths,
  environment facts, and constraints.
- **Procedural memory** contains attempts and outcomes such as failed commands,
  ruled-out hypotheses, diagnoses, and fixes that worked.

Knowledge and procedural entries have stable short IDs. A visible reminder is
one `Memory:` advisory block and records the cited entry IDs' injection counts.
The existing middleware path places that block in the next submitted user turn
and persists its attribution in the session ledger; there is no hidden
`transformContext` injection.

## Paper mapping and Clio constraints

| Paper mechanism | Clio implementation |
| --- | --- |
| Separate memory agent | One stateful middleware registration beside the unmodified action agent |
| Status, knowledge, and procedural bank | Bounded in-memory `TaskMemoryBank`; status stays out of every reminder except the post-compaction restore |
| Phase 1 bank maintenance | Strict `update_status`, `save_knowledge`, `save_procedural`, and `delete` operations |
| Phase 2 intervene or stay silent | One advisory `inject_reminder` effect or explicit silence |
| Fixed memory cadence | Deterministic decay signals plus a coarse interval floor |
| Learned intervention calibration | Structural authority gate: spontaneous reminders must cite a bank entry; deterministic triggers may be uncited |
| Passive and always-on ablations | A/B harness compares baseline, rules, and LLM tiers and flags always-noisy ties as regressions |

Model output uses a strict two-line grammar parsed by `src/domains/memory/task-memory-policy.ts`:

```text
<operations>[{"op":"update_status","content":"Tracking the current requirement."}]</operations>
<no_intervention/>
```

When a visible reminder cites an existing bank entry, the second line uses:
```text
<operations>[]</operations>
<context_for_action>Restored requirement [tm-k-1]</context_for_action>
```

Knowledge and procedural saves use `{"op":"save_knowledge","content":"..."}` or
`{"op":"save_procedural","content":"..."}`; an `id` is only valid when updating
an existing entry.

The parser locates that envelope rather than matching the response byte for byte,
because a small local model routinely delivers a correct decision inside
imperfect packaging. A markdown fence, a `<think>` block, a leading "Here is my
step:", a closing pleasantry, and a pretty-printed multi-line operations array
are all accepted. Two shapes are read conservatively rather than generously:

- A response with no phase-two line at all is silence, since silence is the
  prompt's documented default. Its phase-one writes still apply. An envelope
  truncated mid-reasoning yields nothing at all.
- Tag shapes are stripped from the reminder before it is emitted, so the memory
  model cannot close the `<system-reminder>` block it rides inside. Ordinary
  comparisons and arrows survive.

Operations are validated structurally as a batch: a malformed entry or more than
eight operations rejects the whole list and changes nothing, because both say
the model did not produce an operation list at all. Two narrower mistakes cost
one operation instead of the step, because a small model makes both routinely
and the notes beside them are the point of the step.

Identity is repaired rather than rejected, because a small model invents a
descriptive id for content it is recording for the first time. A
`save_knowledge` or `save_procedural` whose id names no entry of that class
becomes a new entry, and a `delete` of an unknown id is dropped.

An unrecognized `op` is dropped the same way. Handed a JSON tool trajectory, a
small model borrows that trajectory's shape for an entry or two and answers
`{"op":"read","path":"..."}` beside otherwise valid saves; on the reference
route that happened in a third of sampled steps, and three of four such batches
carried a valid operation that the old whole-batch rejection discarded. A step
whose every operation was invented still records `malformed` rather than
passing as silence, since recovering nothing is not a decision to stay quiet.

Phase 1 writes remain valid when Phase 2 is gated or yields to a deterministic
reminder; an over-budget reminder is recorded as `gated` and suppressed rather
than discarding the writes that came with it. A timeout, provider failure,
malformed response, or telemetry failure is silent and never blocks a tool.

### Intervention Defaults & Cadence Knobs
- `context.memory.enabled` (default `true`): Enables observation, task bank writes, and reminder injection.
- `context.memory.cadenceToolCalls` (default `10`): Minimum completed-tool interval between background interventions.
- `context.memory.trajectorySteps` (default `8`): Completed tool-trajectory window analyzed during background evaluation.
- `context.memory.maxOutputTokens` (default `2000`): Bounds the rendered memory-bank context and the ordinary policy-model completion. An always-on-thinking model receives additional reasoning headroom, at least `4,000` tokens when its model cap permits, so it can still reach the strict envelope.
- `context.memory.timeoutMs` (default `60000`): Wall-clock limit for one background memory-policy request. The step is detached, so this deadline never delays a turn, but it does hold a request slot on a real inference endpoint that your own turns and dispatched workers queue against. Raise it only after inspecting the timeout and hit-rate evidence for the selected route.

## Trigger semantics

Memory does not call a model after every tool. Signals accumulate and coalesce at
a turn-end boundary; at most one prompted step is started for that boundary, and
it runs detached from it.

| Trigger | Behavior |
| --- | --- |
| Interval | After `context.memory.cadenceToolCalls` completed tools since the last prompted step; default 10. This is the nondeterministic/citation-gated path. |
| Tool-error streak | Two consecutive error outcomes. A successful tool resets the streak. |
| Loop signal | Reuses the orchestrator loop guard's verdict; it does not infer a second competing loop detector. |
| Repeated failure | The rules tier records failed operation fingerprints and annotates the failing tool result once the same failure appears twice in the bounded trajectory. |
| Post-compaction | The first turn start after compaction restores status and knowledge once, without a model call, because compaction is precisely where execution facts leave the active window. |

### Two delivery channels

A turn boundary is the wrong place to warn about a failure that happened forty
tool calls earlier in the same turn, because the reminder cannot reach the model
until the operator submits again. Memory therefore has two channels, and each
repeated failure uses exactly one of them:

- **Mid-turn annotation.** The second identical failure appends one cited
  `Memory:` advisory to that tool's own result, through the existing
  `annotate_tool_result` effect the loop guard already uses. The advisory uses
  the canonical result-disposition digest when one is available. Older hook
  producers fall back to the first tool-error line that names a problem. Every
  digest is redacted and byte-capped before it reaches the task bank. The model
  reads the advisory on its very next round. This is spent once per operation
  fingerprint per turn and re-earned in a later turn, because the same command
  failing again after an operator turn is news again.
- **Next-turn reminder.** Post-compaction reactivation and any background-model
  reminder ride the `inject_reminder` buffer into the next submitted turn, inside
  the visible `<system-reminder>` block, and persist in the session ledger.

A boundary that already spoke through the annotation stays silent at turn end and
records one telemetry row, not two.

## Background steps never hold a turn open

The agent loop does not become idle until every `agent_end` listener settles, so a
memory step awaited at that boundary would add its full latency to the visible
end of every triggered turn. Historical operator measurements below put a
typical step in the tens of seconds. This makes an awaited step intolerable as
an end-of-turn pause.

The prompted step is therefore detached. `evaluateAsync` starts it and returns
immediately; the turn ends on schedule. When the step resolves, its reminder is
delivered through the deferred-reminder path into the next submitted turn, which
is exactly where an awaited turn_end reminder would have been buffered anyway.
Two consequences follow, both deliberate:

- At most one background step is alive per session. A boundary that arrives while
  a step is still running is dropped rather than queued, so a model slower than
  the turns that trigger it can never build a backlog. The drop is recorded as
  its own telemetry row, because a cadence starved by a slow route and one that
  simply never triggered are otherwise identical in the step log. Its triggers
  stay pending, so the next free boundary still runs for them.
- A reminder can arrive one turn later than the trajectory that earned it. The
  rules tier is unaffected and stays synchronous, so deterministic protection
  keeps its original timing.

`/memory` shows whether a step is in flight, and the footer's memory row shows
`working` while one is running.

The error-streak, loop, repeated-failure, and post-compaction paths are
deterministic. A prompted reminder from one of those paths may be uncited. An
interval-only prompted reminder must cite at least one current knowledge or
procedural ID or it is recorded as `gated` and remains invisible.

### Outcome semantics

The `/memory` overlay displays `last <decision>` where `<decision>` is the
combined outcome of the most recent actual memory boundary. A **memory boundary**
is a turn-end evaluation that includes newly completed tools or an explicit
deterministic trigger (interval, error-streak, loop signal). A no-tool
middleware continuation is another turn-end with no new tools since the previous
boundary. It is not a new memory boundary and does not replace the prior outcome.
Thus `last` remains `injected` across such continuations until a later
tool-bearing or explicitly triggered memory step produces a new outcome (e.g.,
a healthy tool leading to `silent`).

## Cost and the default decision

The LLM tier costs real tokens, real seconds of model time, and a request slot on
a server that is usually the same machine the operator's own turns run on. Every
step is therefore accounted for the way a `/btw` side question is: one cost entry
under the `background-memory` label, which `/cost` shows as its own `memory steps`
row, and one durable row in `<stateDir>/usage/out-of-turn.jsonl` carrying the
usage, the call's duration, and the backend's prefill facts, which
`clio-coder usage report` folds after the process exits. `/memory` shows the
lifetime figures folded from `steps.jsonl`: steps, tokens, model time, and the
hit rate.

### The measurement

From one operator's dated `steps.jsonl` export, 274 rows spanning 2026-08-14 to
2026-08-29 on a small local background route:

| Figure | Value |
| --- | --- |
| Model-tier steps | 60 |
| Tokens | 137,205 |
| Model time | 1,666.6 s |
| Step latency | median 18.7 s, p90 70.2 s, max 102.5 s |
| Injections produced by the model tier | 6 |
| Hit rate | 10.0 percent |
| Cost per injection | 22,868 tokens and 278 s of model time |
| Model-tier injections in the last 5 days | 0 of 4 steps |

Four further injections in the same window came from the free rules tier, so the
lifetime total of 10 injections is not the model tier's score. Rules-tier
injections cost nothing.

### The decision

The default does not change, and it is a deliberate default rather than an
unexamined one:

- `context.memory.enabled` stays `true`. It runs the rules tier, which makes
  no model calls, spends no tokens, and produced 4 of the 10 injections.
- The LLM tier stays opt-in through `context.memory.target` and `context.memory.model`,
  which is already the case: an unset background role never resolves a client.
  A 10 percent hit rate at 22,868 tokens per injection does not earn a default-on
  position, and it is not so poor that it earns removal from an operator who has
  measured their own route and wants it.
- `context.memory.timeoutMs` is `60000` in the current defaults. The dated study
  considered a 30-second counterfactual: two of six observed injections, at
  53.6 and 57.7 seconds, would have been cut, while 531 of 1,666 model seconds
  would not have been spent. The current 60-second deadline is the source-backed
  bound on what one optional call may hold a shared local server for, not a
  prediction of when a route answers.
- A step that would run on the endpoint the chat target is streaming against is
  skipped with reason `endpoint_busy`, and the skip is recorded. On a single-slot
  llama.cpp router the alternative is queueing behind the operator's own decoding
  or evicting the resident model, and neither is a cost an optional call may
  impose.

### What a background target costs on a shared local server

If `context.memory.target` names the same server as `chat.target`, that
server's slots are shared. On a llama.cpp router started with `--parallel 1`
there is exactly one, and the memory step and the operator's turn contend for it.

The consequence is worth stating plainly: a shared endpoint suppresses the model
tier rather than merely delaying it. A step is started from the `turn_end` hook,
which fires inside the streaming run at `agent_end`
(`src/interactive/turn-runtime.ts`), while the chat loop still holds its
foreground registration on that endpoint; the loop releases the hold afterwards,
in the `finally` around the run (`src/interactive/chat-loop.ts`). Every boundary
therefore finds the endpoint busy and records `dropped`/`endpoint_busy`. That is
the intended trade: an optional call may not take the one slot the operator's own
turn is using, and it may not make the server swap the resident model out. The
`/memory` step list and `steps.jsonl` say so on every boundary, so the tier is
visibly declining rather than quietly idle.

The second mechanism is an `expected cold` stamp, for the case where a step did
run on the chat endpoint. Its prompt is a trajectory rather than the chat prefix,
so the next turn's prefill is expected to be cold; `/context` names
`background_memory` as the reason instead of reporting an unexplained cold
prefix.

Pointing the background role at a second machine avoids both effects and is the
arrangement the tier is designed for.

## Choosing a background model

Memory reads a trajectory and writes a fixed envelope. It does not plan, and it
does not need to be clever. A small non-reasoning model is the right choice, and
Clio always requests the memory route with thinking off. Version 2 therefore
has no configurable memory thinking-level key.

That request reaches the wire wherever the runtime carries a thinking control:
llama.cpp reads `chat_template_kwargs.enable_thinking`, and LM Studio reads
`reasoning_effort`, where `none` is the off value.

A model that reasons anyway still works. Some genuinely cannot be silenced, and
the catalog records those as always-on so the level reads `forced` rather than
`off`; the shipped model catalog classifies `qwopus3.5-9b-v3` that way. No model
is selected for background memory by default. Reasoning
blocks are discarded and only the envelope is kept, and the output budget is
sized to let a reasoning preamble run its course first. The cost is latency,
which the detached step absorbs.

One configuration is refused rather than degraded. If the background role names
the same target and model as the orchestrator, and that model reasons, the LLM
memory tier stays off and memory runs on its free deterministic tier. A single
reasoning model already driving chat, workers, and shadow agents cannot also
deliberate over memory steps without contending with the work the operator
actually asked for.

This is a mix-and-match plane, not a local-only one. The background role resolves
through the same target machinery as every other role, so the useful shapes are:

- A frontier model for chat and a small efficient model for memory, whether that
  small model is co-hosted, on another node, or a cheap cloud tier.
- A local workhorse for chat and a co-resident small local model for memory, with
  the co-residency caveat below.
- Everything cloud: pick the provider's small fast model for memory and spend the
  budget on the agent and the fleet.

Local co-residency still matters. The background model, the action model, their
KV caches, and parallel slots must all fit the target's available memory.

## Operator setup

The shipped defaults are:

```yaml
context:
  memory:
    enabled: true
    target: null
    model: null
    cadenceToolCalls: 10
    trajectorySteps: 8
    maxOutputTokens: 2000
    timeoutMs: 60000
```

With `context.memory.target` and `context.memory.model` unset, Clio stays in the
zero-cost rules tier. `/memory` shows the current tier, last decision, approved
durable lessons, the live bank, and a bounded history of the last twenty memory
steps with their trigger, decision, write count, cited-entry count, tier, and
latency. That history is the only place a capture, a gate, or a timeout becomes
visible, since those outcomes produce no transcript entry by design; only an
actual injection reaches the transcript. It carries counts and outcomes only,
never bank or trajectory text. `/settings` exposes controls for every key above;
its compact row labels retain shorter operator-facing names. The saved
background-memory target is the Memory target row in Settings → Orchestrator,
independent of the chat target and the fleet default. A running session owns
its routing snapshot, while the saved
selection becomes the default for new sessions.

The reference topology separates chat from memory work:

| Role | Target | Runtime and endpoint | Model | Capacity |
| --- | --- | --- | --- | --- |
| Chat | `dynamo` | LM Studio at `192.168.86.143:1234` | `qwen3.8-27b-dynamo` | Reported by the LM Studio probe |
| Background memory | `mini` | llama.cpp router at `192.168.86.141:8080` | `ornith1.5-35b-moe` | 4 parallel slots, 262,144 context tokens per slot |

The corresponding saved role selection is:

```yaml
chat:
  target: dynamo
  model: qwen3.8-27b-dynamo
context:
  memory:
    target: mini
    model: ornith1.5-35b-moe
```

A smaller, efficient model is the intended shape for this role. The current
reference uses a separate multi-slot endpoint so memory does not compete with
the LM Studio chat stream. Capability is not the only constraint; latency and
endpoint contention still matter, and the detached step above bounds their
effect on the operator's turn.

The deadline is a bound on what an optional call may hold that server for, not a
figure sized to capture the tail. The shipped `60000` is a bounded compromise,
and a step that exceeds it records `timeout` with
its work discarded. A route whose steps mostly record `timeout` is a
misconfigured deadline before it is a slow model, so read the ledger before
raising it: `/memory` shows the hit rate the raise would be buying.

The target ID is not hard-coded. Any configured orchestrator-eligible local
target and wire model can fill the background role. Before enabling it, use the
real target surfaces to verify the route:

```bash
clio-coder targets --probe
clio-coder models --target mini
clio-coder models --target dynamo
clio-coder
```

Then inspect `/settings targets`, `/settings`, and `/memory`. Local co-residency still
matters: the background model, action model, their KV caches, and parallel slots
must fit the target's available memory. Increase `context.memory.timeoutMs` for
a deliberately slow local route; lowering `context.memory.maxOutputTokens`
bounds the visible reminder and ordinary completion budget but does not change
the background model's strict output grammar.

For an immediate kill switch, set `context.memory.enabled` to `false` in
`/settings`. Removing the background target instead returns to rules-only
operation while leaving deterministic protection active.

## Where what the tier writes ends up

A bank entry lives and dies with its session. When a reminder actually reaches
the operator, the entries it cited are also proposed into the durable store at
`<dataDir>/memory/records.json`, unapproved, scoped to the repository the session
is working in, with provenance naming the session and the source entry. That is
the one automatic writer of that file; everything else about it is unchanged.
`/memory` and `clio-coder memory list` show the proposal, and
`clio-coder memory approve <id>` is still a separate operator action, so nothing
the background plane produced reaches a system prompt without review. A step with
no session, or one running outside a canonical repository, proposes nothing:
global scope broadens applicability to every future session and is not a claim a
background step may make on the operator's behalf.

Rules-tier reminders are not proposed. Their entries are this middleware's own
one-line records of a repeated tool failure, and filing each one as a durable
lesson would fill the review queue with rows nobody asked for. They remain
promotable by hand from `/memory`.

## What the LLM tier actually writes

Measured on the shipped prompt against `google/gemma-4-26b-a4b-qat`, across ten
live steps and forty controlled runs on the same route.

Earlier measurements found that the tier wrote `update_status` reliably and
`save_knowledge` rarely. At that time a successful trajectory step carried an
opaque result fingerprint, so a window of successful reads told the model which
files were touched and nothing about what was in them.

A current trajectory step keeps two fields with different jobs. The operation
fingerprint identifies repeated calls and remains derived only from the tool name
and arguments. The result digest is human-readable diagnostic content from the
canonical result-disposition projection, with explicit source provenance. Secret
redaction and a 240-byte cap apply before the digest reaches the task bank or the
background request. A metadata-only disposition contributes outcome facts and no
captured body. Results without a canonical disposition use a redacted deterministic
fallback, so older tool producers remain useful without gaining a second model
summarizer.

Three candidate causes were ruled out in the earlier implementation by
controlled runs that changed one variable at a time:

- rewriting the prompt's second worked example to carry a `save_knowledge` moved
  nothing, and made the model emit no operations at all in four of five runs;
- seeding the bank with existing knowledge entries so the model could learn the
  shape by example moved nothing;
- giving successful steps a content-bearing digest moved nothing on its own.

What does elicit knowledge is a durable fact in the input. With a task stating two
explicit constraints the model wrote both as knowledge; with that same task plus
content-bearing digests it wrote six. Error digests already carry a real
diagnostic line, which is why `save_procedural` fires on failing windows.

The consequence for reactivation is why the post-compaction block restores status.
Restoring knowledge alone restored nothing in the common case, because the one
class it read was usually the one class the model had not written.

Two further numbers from the same route. Roughly a quarter of live steps returned a
malformed envelope, usually `<operations>` with no list followed by
`<no_intervention/>`, which is recorded as `malformed`/`unparseable` and is
model behavior rather than a route fault. The boundary drop rate remains 0% at
shipped settings.

## Handoff continuity

The bank normally dies with the session. When `context-handoff` is explicitly
requested, Clio supplies the skill a redacted `clio-task-memory` fenced snapshot
containing knowledge and procedural entries only. Ordinary turns receive no
snapshot. The handoff artifact remains under ignored `.clio-coder/handoffs/`; private
status and secret-shaped values do not cross the export boundary.

After `/resume`, Clio checks only the newest handoff and offers `/memory seed` if
it contains a valid snapshot. Seeding is explicit and deduplicated. It resets
injection attribution for the new session, and the master kill switch disables
both the offer and writes. `/new`, `/fork`, `/resume`, and ACP session changes
clear the prior heap bank before the new session can observe it.

## Telemetry

Each completed memory step appends one content-free record to:

```text
<stateDir>/memory/steps.jsonl
```

Use `clio-coder paths --json` to resolve the state directory (the `"state"` property). The log rotates after 1 MiB and
keeps one previous generation as `steps.jsonl.1`. Every exact-schema record has:

- timestamp and schema version;
- one to three coalesced trigger reasons;
- `rules` or `llm` tier;
- per-class added, updated, and deleted entry counts;
- `silent`, `injected`, `gated`, `timeout`, `malformed`, or `dropped` decision;
- count of cited entries, input/output/total memory-model tokens, and latency.

The same steps are also billed. See "Cost and the default decision" for the
`/cost` row, the durable out-of-turn usage row, and the lifetime figures `/memory`
folds out of this file.

`dropped` is the one outcome that ran no step. It has two causes, separated by
the row's reason: `step_in_flight` means the boundary triggered while an earlier
step still held the single in-flight slot, and `endpoint_busy` means the step
would have called the endpoint the chat target was streaming against. Both cost
no tokens and no latency, both leave their triggers pending for the next free
boundary, and neither replaces the operator-visible last decision. Counting
`dropped` rows against `llm` rows over a session is how a starved cadence becomes
visible.

A step that exceeds the deadline records `timeout`, never `silent`: reason
`deadline` when the policy's own race fired first, and `timed_out` when the
transport aborted at its deadline. Both are distinct from `client_error`, which
is a route that refused rather than a route that was slow.

The log contains no task, trajectory, bank, error, or reminder text. File creation,
rotation, serialization, and injected sinks are all best effort; a read-only
state directory or full disk cannot alter intervention behavior.

Note that routine no-tool continuation checks do not emit telemetry rows, as they
are not considered new memory boundaries. Only actual tool-bearing or explicitly
triggered memory steps produce rows.

## Evaluation and promotion bar

`src/domains/eval/proactive-memory.ts` exports a fixed three-task, matched A/B
harness. It executes `baseline`, `rules`, and `llm` variants in stable order and
accepts any `{ id, model }` target. A runner adapter owns isolated task execution
and returns action tokens/latency plus the exact telemetry rows emitted for that
trial. The report provides:

- pass rate;
- injected and cited reminder counts;
- reminders per task and citation rate;
- total and baseline-relative added tokens and latency;
- an `alwaysNoisyRegression` verdict.

The source-level harness remains available to a runner adapter, and the eval
platform remains active. Its former dedicated contract test was retired, and
the current test tree has no direct reference to `runProactiveMemoryEval`.
There is therefore no maintained direct test coverage or standalone
`npm run test:file` invocation for this harness. Treat a live comparison as an
explicit measurement campaign.

For a live local comparison, an adapter should route only the `llm` variant
through the request's target/model (the reference memory route is `mini` /
`ornith1.5-35b-moe`), keep baseline memory telemetry empty, and run all
nine trials in equivalent isolated workspaces. Do not promote the LLM tier from
one anecdotal task. The evidence bar is a pass-rate gain from a small number of
specific, usually cited reminders at acceptable added token and latency cost.
Injecting at least once per task while merely tying or losing to baseline is
always a regression, even when every reminder is cited.

## Worker growth path

Worker-side intervention is intentionally not implemented in this sprint. The
bank, policy client, telemetry, and registration interfaces carry no interactive
chat-loop types, so they can be instantiated per worker later without moving the
policy into the action agent.

The existing transport already exposes the required seams:

1. `src/domains/dispatch/worker-spawn.ts` receives worker NDJSON events and its
   `SpawnedWorker.send` path can write bounded control messages while the worker
   is alive.
2. Worker steering already drains between tool batches, which is the safe point
   for a visible memory advisory; it must not interrupt a tool in flight.
3. Workers already maintain per-worker loop detectors and tool-call caps. A
   future registration should consume those verdicts instead of re-deriving
   them.
4. Each dispatched run needs its own bank, cadence, spend guard, telemetry
   attribution, and teardown. Parent session memory must not leak into sibling
   workers implicitly.

The future sequence is therefore worker events → worker-local registration → one
bounded steering advisory between batches. It must preserve the current receipt,
safety, timeout, and permission semantics, and it should ship only after a
Terminal-Bench-style long-run evaluation shows a selective benefit.
