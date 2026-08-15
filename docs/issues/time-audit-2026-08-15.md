# TIME AUDIT — clio-coder

Repo-wide sweep of every time and clock construct in `src/`, `tests/`, `scripts/`,
plus `apps/trace-viewer` and `benchmarks/` where they emit operator-facing or
published time values. Audit only. No code was changed.

Scope counted: 733 TypeScript files under `src/`, 360 under `tests/`, 9 scripts,
1 browser app. 158 `toISOString()` call sites, 88 `setTimeout`, 23 `setInterval`,
35 `performance.now()`, 19 `process.hrtime`, 55 time-shaped `Math.max(0, a - b)`
clamps, 306 wall-clock reads in tests, 7 distinct time formatters.

Grounding cases: #46 (`75990401`, UTC sliced and rendered as a wall clock in
`/memory`), #52 (`0776a36f`, two chat panels each reading `Date.now()` twice),
#42 (`70ae5b2e`, the stream stall watchdog). All three are instances of general
patterns that remain live elsewhere in the tree. This audit names those instances.

---

## Severity-ranked findings

| # | Severity | Finding | Class | Anchor | Status |
|---|---|---|---|---|---|
| 1 | **Critical** | The stream stall watchdog measures idle time on the wall clock; a forward clock step ≥180s aborts a healthy run and burns a retry | (c) wrong | `src/interactive/turn-runtime.ts:484` | Fixed (Phase 1, `cfe86cd4`) |
| 2 | **Critical** | Capacity lease TTL (30s) is shorter than the state-lock acquire deadline (60s), and the renewal path cannot run while the lock blocks the event loop | (c) wrong | `src/domains/dispatch/capacity-lease.ts:9` + `src/core/state-file-lock.ts:10,79` | Fixed (Phase 2, `91591b19`) |
| 3 | **Critical** | The state root is `$HOME`-relative with no host scoping, but three of four coordination primitives under it adjudicate liveness against the *local* process table. The repo detects Slurm/PBS/LSF, so a shared `$HOME` is an expected deployment | (c) wrong | `src/core/xdg.ts:68-75`, `src/core/state-file-lock.ts:12-23,152`, `src/domains/dispatch/capacity-lease.ts:125-133` | Open (Phase 3 in flight) |
| 4 | **High** | Evidence attribution silently drops session-ledger entries whenever two runs overlap in time — i.e. exactly under the concurrency this product exists for | (c) wrong | `src/domains/evidence/build.ts:629-630,648-654` | Open (deferred to companion ticket) |
| 5 | **High** | Five surviving instances of the #46 bug: UTC rendered to the operator as if it were their wall clock | (c) wrong | `tree-selector.ts:158`, `message-picker.ts:98`, `session-selector.ts:56`, `welcome-dashboard.ts:162`, `interactive-slash-runtime.ts:259` | Fixed (Phase 4, `97d3ca12`) |
| 6 | **High** | The trace viewer mixes the *browser's* `Date.now()` with orchestrator-stamped timestamps to compute live Gantt spans | (c) wrong | `apps/trace-viewer/public/app.js:180,571-572` | Fixed (Phase 4, `97d3ca12`) |
| 7 | **High** | 29 of 44 chat-panel constructions in the #52 test file still read the real wall clock. The fix was applied per-test, three times, by hand. No shared clock harness exists | (b) fragile | `tests/contracts/chat-panel.test.ts`, `tests/harness/` | Fixed (Phase 0, `b968c04e`; Phase 7, `f3728866`) |
| 8 | **Medium** | `Math.max(0, end - start)` at 55 time-shaped sites makes a negative delta (skew, reordered marks) indistinguishable from a genuinely zero-length phase. Nothing anywhere reports a negative duration as an anomaly | (b) fragile | `src/domains/dispatch/phase-timing.ts:7` and 54 peers | Fixed (Phase 0, `b968c04e`; Phase 5, `1bef8397`) |
| 9 | **Medium** | Four independent lock implementations, four staleness windows (5s / 30s / 30s / 130s), none of which refresh the lockfile mtime while held. A live holder past its window is stolen from unconditionally | (b) fragile | `config.ts:1437`, `state-file-lock.ts:9`, `backend-file.ts:11`, `residency-lock.ts:19` | Fixed (Phase 2, `91591b19`) |
| 10 | **Medium** | ~30 durations computed from `Date.now()` deltas in a codebase that already uses `performance.now()`/`hrtime` in 53 places. No rule says which to use | (b) fragile | see §4 | Fixed (Phase 5, `1bef8397`) |
| 11 | **Medium** | `stallSuspendDepth` leaks if a tool never emits `tool_execution_end`, disabling the #42 watchdog for the rest of the run | (b) fragile | `src/interactive/turn-runtime.ts:538,543` | Fixed (Phase 1, `cfe86cd4`) |
| 12 | **Medium** | Audit files are named by **local** date while their rows carry **UTC** instants. The only local time anywhere on disk | (b) fragile | `src/domains/safety/audit.ts:190-198,456` | Open (Phase 3 in flight) |
| 13 | **Medium** | Three different ISO-8601 validation strictnesses across three stores | (c) inconsistent | `capacity-lease.ts:80-84`, `memory/validate.ts:291-292`, `task-memory-telemetry.ts:310` | Fixed (Phase 6, `814a3fcd`) |
| 14 | **Low** | The `runs.json` ring evicts by `startedAt` DESC, so a long-running *live* run is dropped before newer *finished* ones | (b) fragile | `src/domains/dispatch/state.ts:117,241-242` | Fixed (Phase 6, `814a3fcd`) |
| 15 | **Low** | Seven distinct time formatters, three of which are near-duplicates | (b) fragile | see §5 | Fixed (Phase 0, `b968c04e`; Phase 4, `97d3ca12`) |
| 16 | **Low** | The worker heartbeat frame carries `at` from the *worker's* clock. Parsed, required, never read | (b) fragile | `src/worker/heartbeat.ts:18` + `src/worker/protocol.ts:485-488` | Open (Phase 3 in flight) |
| 17 | **Low** | Context fingerprint is `size` + floored `mtimeMs`; blind to same-size edits under coarse or cached filesystem attribute granularity | (b) fragile | `src/domains/context/fingerprint.ts:118` | Open (Phase 3 in flight) |
| 18 | **Low** | An abandoned run's `endedAt` is stamped at *recovery* time, so its reported duration includes the entire orchestrator downtime | (b) fragile | `src/domains/dispatch/orphan-recovery.ts:155` | Fixed (Phase 5, `1bef8397`) |
| 19 | **Low** | Eval ids are a millisecond UTC stamp plus a task-file hash; two concurrent identical evals collide on one artifact path | (b) fragile | `src/domains/eval/store.ts:68-70`, `src/cli/skills-eval.ts:1029-1030` | Fixed (Phase 6, `814a3fcd`) |
| 20 | **Low** | The trace mirror's `endedAt - startedAt` is measured on the orchestrator while the co-stored `duration_ms` comes from the worker. The two disagree by network + queue latency | (b) fragile | `src/domains/observability/trace-store.ts:1177-1178,1196,1199-1200` | Fixed (Phase 5, `1bef8397`) |
| 21 | **Low** | The chat panel's render cache key omits time, so a running tool's elapsed counter is only as fresh as the last unrelated invalidation | (b) fragile | `src/interactive/chat-panel.ts:1000-1007,813` | Fixed (Phase 5, `1bef8397`) |
| 22 | **Low** | An `Intl.DateTimeFormat` is constructed per audit row on a path whose own header says it must not block | (b) fragile | `src/domains/safety/audit.ts:193,456` | Fixed (Phase 4, `97d3ca12`) |
| 23 | **Info** | Benchmark harnesses time published results with `time.time()` rather than `time.monotonic()` | (b) fragile | `benchmarks/community/**/*.py` | Fixed (Phase 5, `1bef8397`) |

---

## 1. Monotonic vs wall clock for durations

The repo already knows the distinction and applies it correctly in 53 places. It
just has no rule, so the choice is per-author.

### Correct and deliberate (a)

- `src/core/startup-timer.ts:15,23,28` — boot profiling on `performance.now()`.
- `src/core/termination.ts:107,110,143,147` — shutdown-hook budgets on `hrtime.bigint()`.
- `src/core/domain-loader.ts:106,114` — same.
- `src/domains/providers/probe/http.ts:78,81,83` and `probe/reasoning.ts:86,94,103` —
  probe latency on `performance.now()`. This matters: latency is what routing decides on.
- `src/domains/middleware/runtime.ts:166,178,191` — hook budgets on an injectable
  clock defaulting to `performance.now()`.
- `src/domains/middleware/memory-intervention.ts:189,213,352,426` — `hrtime.bigint()`.
- `src/domains/dispatch/active-route-planner.ts:91,93` and `extension.ts:5395,5397` —
  route-decision duration on `hrtime.bigint()`.
- `src/core/workspace-files.ts:19-26,359-380` — cooperative walk slicing on
  `performance.now()`, including a pause/resume accumulator at :374-380. This is
  the most careful timing code in the repo.
- `src/domains/context/codewiki/cooperative.ts:32-39` — same idea.
- `src/interactive/chat-panel.ts:993,1007,1075` — render metrics on `performance.now()`.

**The model to copy** is `src/domains/dispatch/code-step.ts:291-306`:

```ts
const startedAtMs = Date.now();                      // wall anchor, for the record
const clock = process.hrtime.bigint();               // monotonic span
const startedAt = new Date(startedAtMs).toISOString();
...
const durationMs = Number((process.hrtime.bigint() - clock) / 1_000_000n);
const endedAt = new Date(startedAtMs + durationMs).toISOString();
```

Wall clock anchors the instant so a human can correlate it; monotonic measures the
span; `endedAt` is derived rather than independently read. A clock step during the
step cannot corrupt the duration, and `endedAt - startedAt === durationMs` always.
Nothing else in the repo does this.

### Wrong (c)

**Finding 1 — the stall watchdog.** `src/interactive/turn-runtime.ts:484`:

```ts
const idleMs = Date.now() - lastActivityAt;
if (idleMs < stallMs) { armStallTimer(stallMs - idleMs); return; }
state.streamStallReason = `stream stalled: no output from ... for ${Math.round(idleMs / 1000)}s, aborting`;
localRuntime.agent.abort();
```

`lastActivityAt` is set from `Date.now()` at `:535` and `:505`. Default
`streamStallMs` is 180000 (`src/core/defaults.ts:346`, `src/domains/session/retry.ts:41`).
A forward wall-clock step of ≥180s while a stream is healthy makes `idleMs` exceed
the threshold on the next timer fire and aborts a live run through the same path as
an operator Esc. It then walks the retry ladder (`turn-recovery.reclassifyStallAbort`),
so the user sees a spurious retry with a fabricated "no output for 3000s" message.

Forward steps of that size are routine on the target hardware: a node that boots
without RTC battery and NTP-syncs afterward, a laptop resuming from suspend, a
container whose clock is corrected on start. The remedy is one line — measure
`idleMs` with `performance.now()` and keep `Date.now()` only for the human-readable
part of the message.

Two secondary defects in the same block:

- `:465` `let lastActivityAt = 0;`. Safe today only because `handle.agent.subscribe`
  sets it at `:535` before the `agent_start` branch arms the timer at `:600`. If
  arming ever moves ahead of the first event, `idleMs` becomes ~1.8e12 and the run
  aborts instantly. Initialize it to the clock, not to zero.
- **Finding 11** — `stallSuspendDepth` increments at `:538` on `tool_execution_start`
  and decrements at `:543` on `tool_execution_end`. A tool that never emits its end
  event (a wedged `bash`, a crashed mediator) leaves the depth above zero, and the
  watchdog re-arms forever at `:480-482` without ever firing. That is precisely the
  hang #42 fixed, reachable again through the suspend path. The reset at `:597` bounds
  it to one run, but one wedged run is the whole failure mode.

**Finding 6 — the trace viewer.** `apps/trace-viewer/public/app.js`:

```js
180:  const end = run.ended_at ? Date.parse(run.ended_at) : Date.now();
571:  const start = starts.length ? Math.min(...starts) : Date.now();
572:  return { start, end: live || ends.length === 0 ? Math.max(...ends, Date.now()) : Math.max(...ends) };
```

`run.started_at` was stamped by the orchestrator process; `Date.now()` here runs in
the operator's browser, possibly on a different one of the five hosts. For a live
run the span end is read in one clock frame and the start in another. With the
browser behind the orchestrator, `end < start` and every bar and tool tick computes
a negative or clamped width. Line 208 divides by `Math.max(1, end - start)`, so the
result is silently a garbage percentage rather than an error.

The server already knows both endpoints. The viewer should render live spans from a
server-supplied `now`, or from an offset it establishes once against the trace store.

### Fragile but working (b)

**Finding 10.** Wall-clock deltas where monotonic was available:

| Site | What it measures |
|---|---|
| `src/core/safe-exec.ts:72,163,183` | subprocess `durationMs` in the result record |
| `src/core/bash-exec.ts` (timeout arming at `:172`) | wall-clock command budget |
| `src/domains/eval/runners/external-command.ts:142,193` | `wallTimeMs` in an eval artifact |
| `src/cli/skills-eval.ts:453,479,495,518,530,783` | `wallTimeMs` per scenario, six sites |
| `src/cli/wiki-generate.ts:176,241,254,411,417` | run budget and progress heartbeat |
| `src/cli/bootstrap-generate.ts:185-186` | fallback duration when no receipt exists |
| `src/domains/dispatch/fleet-preflight.ts:337,339` | `probeDurationMs` per fleet node |
| `src/domains/providers/runtimes/local-native/lmstudio-native.ts:413,426` | `latencyMs` |
| `src/engine/apis/llamacpp-residency.ts:168` | model-load poll loop |
| `src/engine/acp/tool-mediator.ts:656`, `event-mapper.ts:141` | ACP tool `durationMs` |
| `src/engine/claude/tool-safety.ts:330` | tool `durationMs` |
| `src/tools/agent-tools.ts:195` | tool `durationMs` |
| `src/interactive/dispatch-board.ts:1141` | `ttftMs` — a headline TUI number |
| `src/domains/session/retry.ts:178,181,199` | retry countdown |
| `scripts/live-eval-recon.mjs:219,224`, `scripts/lifecycle-matrix.mjs:1091,1101,1112` | script durations |
| `benchmarks/community/**/*.py` (`time.time()`, ~10 sites) | published `wall_s` figures |

Each is individually low-stakes; the pattern is not. `ttftMs` and eval `wallTimeMs`
are numbers the project publishes and compares across runs and machines. A single
NTP correction during a long eval sweep corrupts one row with no marker.

`src/engine/acp/transport.ts:419-427` deserves its own mention: `waitForTermination`
computes an absolute wall-clock `deadline` at `:419` then re-derives `remaining` from
`Date.now()` each poll. A backward step extends process-exit waiting past the caller's
intended bound.

---

## 2. Timestamps produced on one machine and compared on another

The fleet spans five hosts. This section is the reason the audit was commissioned.

### Correct and deliberate (a) — the good news is substantial

**Worker heartbeats are receive-stamped.** `src/domains/dispatch/worker-spawn.ts:188,217,362`
sets `heartbeatAt.current = Date.now()` on the *orchestrator* when a frame arrives.
`src/domains/dispatch/heartbeat.ts:22-26` classifies against that. The worker's own
clock never enters the comparison. This is right, and it is right for SSH workers too,
which is where it would otherwise hurt most.

**All run phase marks are orchestrator-stamped.** `src/domains/dispatch/extension.ts:3268,
3308,3327,3941,4029,4138,4205` all use `new Date(now())` where `now` is the injected
orchestrator clock (`:2234`). `firstModelTokenAt` and `firstToolAt` (`:3325-3327`,
`:4203-4205`) are stamped when the orchestrator *observes* the event, not when the
worker emitted it. That includes transport latency in the number, which is a
deliberate and defensible choice: one clock frame beats an accurate number in an
unknown frame.

**Run envelope `startedAt` is orchestrator-stamped.** `src/domains/dispatch/state.ts:145`.
So the `Date.parse(receipt.startedAt)` / `Date.parse(receipt.endedAt)` deltas at
`extension.ts:2445-2448,3719-3721,4766-4768` are within-frame and skew-safe.

**The agent ledger orders by sequence, not by time.** This is the best coordination
code in the repo. `src/domains/dispatch/agent-ledger-store.ts:174,190` allocates a
monotonic `sequence` under a cross-process lock; `agentLedgerContribution` at `:233-235`
sorts by `sequence`, and the receipt digest at `:236-238` covers the sequence-ordered
entries. `at` (`:182`) is decoration — nothing sorts, windows, or compares on it. Two
concurrent workers posting from different machines cannot reorder each other's entries
no matter how far apart their clocks are. The file also documents its host assumption
in the header (`:10-13`), which the other stores do not.

**`compete-worktrees.ts` scopes ownership by host.** `:176-181` builds a lease from
`{host, pid, birthToken}`; `:207-215` returns `true` (conservative, do not steal) when
`owner.host !== hostname()`. Correct.

**Orphan recovery scopes by host.** `src/domains/dispatch/orphan-recovery.ts:140-149`
skips rows whose `identity.host` is not the local hostname, with a comment naming the
shared-filesystem case explicitly.

**Fleet node last-seen is observer-stamped.** `src/domains/scheduling/cluster.ts:89,
150,167` records the orchestrator's own clock, and the header (`:16-18`) states that
staleness is advisory and no node is ever auto-offlined for silence. Correct: an
idle node produces no signal, so silence carries no information.

### Wrong (c)

**Finding 3 — the state root has no host scope, and three of four locks assume one host.**

`src/core/xdg.ts:68-75` resolves the state root to `$XDG_STATE_HOME/clio-coder`,
defaulting to `~/.local/state/clio-coder`. Nothing in the resolution, and nothing in
`docs/`, says this root must be node-local storage.

`src/domains/dispatch/run-identity.ts:25-45` detects `SLURM_JOB_ID`, `PBS_JOBID`,
and LSF. The project therefore expects to run inside cluster allocations, where a
shared NFS or parallel-filesystem `$HOME` is the normal case, not the exotic one.

Under a shared `$HOME`, three primitives become incorrect:

1. `src/core/state-file-lock.ts` writes only `process.pid` into the lockfile (`:55,106`),
   adjudicates ownership with local `process.kill(pid, 0)` (`:12-23`), and releases
   only if `readLockPid(lockPath) === process.pid` (`:85,152`). Two hosts hitting the
   same PID — routine, PIDs are small — means host A sees host B's dead lock as live
   forever, or host A deletes host B's live lock in its own `finally`.
2. `src/domains/dispatch/capacity-lease.ts:125-133` reads `/proc/<pid>/stat` field 22
   as a birth token. Against a foreign host's PID this reads a *local* process's start
   time, which will not match, so `ownerHoldsLease` (`:161-169`) returns false and
   `reclaim` (`:171-173`) drops a live remote lease. Global concurrency caps are then
   over-admitted fleet-wide.
3. `src/core/config.ts:1409-1427` and `src/engine/apis/residency-lock.ts:32-46`
   perform no liveness check at all — pure mtime staleness against the local clock.

The remedy already exists in the codebase twice (`orphan-recovery.ts:149`,
`compete-worktrees.ts:210`): carry `host` in the lease and refuse to adjudicate a
foreign host's record. Applying that idiom to `state-file-lock.ts` and
`capacity-lease.ts` closes the gap. The alternative — documenting that the state
root must be node-local and refusing to start when it is on a network filesystem —
is a smaller change and arguably the honest one.

**Finding 12 — audit filenames are local dates, rows are UTC.**
`src/domains/safety/audit.ts:190-198` names the file from
`Intl.DateTimeFormat("en-CA")` in local time; `:239,270,289,304,325,351,367` write
`ts: now.toISOString()` in UTC. The header at `:8-9` documents the rotation choice,
so it is deliberate, and readers are correct: `readAuditRows`
(`src/domains/session/archive-readers.ts:49-61`) globs every `*.jsonl` and downstream
filters on `row.ts` (`src/cli/usage.ts:238`) and sorts on `row.ts`
(`src/interactive/view/artifacts.ts:1174`). Classify (a) for the readers.

The fragility is the filename under a shared `$HOME`. Two nodes in different
timezones append to the same `2026-08-15.jsonl`, mixing two different local days
into one file, and a UTC-configured node's evening rows land in the file a
CDT-configured node calls "today". Nothing corrupts, but an operator grepping by
filename gets the wrong window on a fleet.

Same class, lower stakes: `src/interactive/interactive-slash-runtime.ts:259` names
an export file from a **UTC** date, so an operator exporting at 19:30 CDT on Aug 15
gets `...-2026-08-16.md`. `src/domains/dispatch/route-history.ts:132-136` does the
same for retired-history filenames.

### Fragile (b)

**Finding 16 — the heartbeat frame carries a worker-clock timestamp that nothing reads.**
`src/worker/heartbeat.ts:18-19` emits `{ kind: "heartbeat", at: Date.now() }` from the
worker's clock. `src/worker/protocol.ts:485-488` parses it and *rejects the frame*
if `at` is not a finite number. `src/domains/dispatch/worker-spawn.ts:362-364` then
ignores the value entirely and stamps `Date.now()` locally. The current behavior is
correct; the field is a loaded gun. Any future reader that reaches for `frame.value.at`
because it looks authoritative imports the worker's skew into the watchdog. Either
remove it or rename it to something that says it is diagnostic only.

**Finding 20 — the trace mirror stores two disagreeing measurements of the same span.**
`src/domains/observability/trace-store.ts:1178` derives `startedAt` from the mirror's
own clock (or from `at - durationMs` when no start was seen). Twenty lines later the
same row stores `duration_ms: duration` (`:1196`) from the worker's event payload
alongside `startedAt` (`:1199`) and `endedAt: at` (`:1200`) from the mirror's clock.
So `Date.parse(endedAt) - Date.parse(startedAt)` and `duration_ms` differ by transport
and queue latency, and the trace viewer's tool ticks (`app.js:208`) use one while the
duration label (`app.js:265`) uses the other. Pick one frame and derive the other.

**Finding 8 — every duration is clamped, so skew is invisible.**
`src/domains/dispatch/phase-timing.ts:7` is the canonical instance:

```ts
return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
```

Peers include `extension.ts:2448,3721,4768`, `evidence/build.ts:1488-1494`
(same clamp, spelled `end < start` → `0`),
`interactive/session-last-turn.ts:59`, `interactive/dispatch-board.ts:879`,
`chat-panel.ts:623,1031,1059`, `admission-queue.ts:132`, `turn-runtime.ts:546`,
`cli/fleet.ts:707`, `eval/runners/external-command.ts:193`. Fifty-five sites in
`src/` match the time-shaped form.

`Math.max(0, …)` is the right *display* behavior and the wrong *observability*
behavior. There is no site anywhere in the repo that records "this duration came
back negative." A run whose `admittedAt` precedes its `queuedAt`, or whose receipt
was sealed with a stamp from a clock that had since stepped back, reports
`queueWaitMs: 0` and looks like an unusually fast admission. Because the negative is
swallowed at the leaf, skew produces no signal anywhere up the stack — which is a
fair part of why three time bugs shipped in two days.

Recommendation: keep the clamp at the render boundary, but have the derivation
return the raw value and let one place count and log negatives.

---

## 3. Ordering assumptions when events come from concurrent agents

### Wrong (c)

**Finding 4 — evidence attribution collapses under overlap.**
`src/domains/evidence/build.ts:648-654`:

```ts
function linkedRunIdForTimestamp(timestamp, runSources) {
  const candidates = runSources.filter((s) => timestampInRunWindow(timestamp, s.envelope)) ...
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}
```

`timestampInRunWindow` (`:656-662`) is inclusive on both ends. The caller at `:629-630`:

```ts
const runId = linkedRunIdForTimestamp(entry.timestamp, runSources);
if (source.kind === "run" && runId !== source.runId) continue;
```

When two dispatch runs overlap — the normal case for this product — every session
ledger entry inside the intersection produces two candidates, `linkedRunIdForTimestamp`
returns `null`, and the entry is **dropped from the evidence bundle** with no marker.
`clio evidence` for run X therefore loses coverage in proportion to how parallel the
session was. It degrades exactly when the evidence is most valuable.

The fix is already written thirty lines below. `bestEffortAuditLink` (`:910-960`)
handles the identical situation honestly: it emits `linkKind: "ambiguous-timestamp-tool"`,
records `candidateRunIds` (`:945`), and marks `confidence: "best-effort"`. Classify
that function (a) — it is the correct treatment. `linkedRunIdForTimestamp` should
return the same shape rather than silently dropping.

The deeper point: timestamp containment is the wrong join key for concurrent agents
in the first place. Session ledger entries and audit rows should carry the run id they
were produced under, the way `agent-ledger-store.ts:183` stamps attribution at write
time from the orchestrator's own admission record. Timestamp windowing is a fallback,
and it should be labeled as one everywhere, not just in one of the two functions.

### Correct and deliberate (a)

- **The agent ledger.** `agent-ledger-store.ts:174,190,233-235`. Sequence-ordered
  under a lock. Immune to skew. See §2.
- **The execution scheduler.** `src/domains/dispatch/execution-scheduler.ts:222-224`:
  `/** Monotonic completion order, the only clock staleness needs. */ let sequence = 0;`
  A counter, not a clock. Correct, and the comment says why.
- **Admission queue ordering.** `src/domains/dispatch/admission-queue.ts:15-28`.
  Priority, then plan order, then `queuedAt`, then `requestId.localeCompare` as a
  total tiebreak. All values are stamped by one process from one injected clock
  (`:58`), and the final tiebreak makes the sort total even if two requests share a
  millisecond. Deterministic.
- **Code step ordering.** `src/domains/dispatch/code-step-store.ts:51` sorts by
  `startedAt.localeCompare` — safe because every value comes from
  `new Date(startedAtMs).toISOString()` (`code-step.ts:293`), which is fixed-width
  canonical UTC, so lexicographic equals chronological.
- **Audit artifact ordering.** `src/interactive/view/artifacts.ts:1173-1179` sorts on
  parsed `ts` first, with file and line as tiebreakers. Correct.

### Fragile (b)

**Finding 14 — the runs ring evicts by start time, not by liveness.**
`src/domains/dispatch/state.ts:117` sorts merged runs `startedAt` DESC, and `:241-242`
truncates to `maxRuns` (default 1000, `docs/configuration-and-targets.md:249`) and
assigns the truncated array back to the in-memory mirror. A run that has been executing
for hours sorts to the bottom and is dropped from the process's own live state before
1000 newer, already-finished runs are. On a busy fleet this is reachable. Eviction
should exempt rows whose `endedAt` is null.

Secondary: `mergeRunsById` (`:109-119`) merges disk and memory across sibling
orchestrator processes on the same host. Correct locally; see Finding 3 for what
happens on a shared `$HOME`.

**Finding 18 — abandoned runs get a fabricated duration.**
`src/domains/dispatch/orphan-recovery.ts:155` stamps `endedAt: new Date().toISOString()`
at recovery time. `deriveEnvelopePhaseDurations` (`phase-timing.ts:30-32`) then reports
an `executionMs` and `totalEndToEndMs` covering the entire orchestrator downtime. The
row is marked `stalled` with an explicit `outcomeDetail`, so it is signposted rather
than silent, but the duration is not a measurement and shouldn't be presented as one.
Setting `endedAt` to the last known heartbeat, or to null with a separate
`recoveredAt`, would be honest.

**Finding 19 — eval id collision.** `src/domains/eval/store.ts:68-70` builds
`eval-<UTC ms stamp>-<taskFileHash[0..8]>` and `evalArtifactPath` (`:63-66`) maps it
straight to one file. Two workers starting the same task file in the same millisecond
produce the same path and one clobbers the other. `src/cli/skills-eval.ts:1029-1030`
has the identical structure. A random suffix, as used everywhere else in the repo
(`state.ts:62-67`, `reservation-store.ts:232`, `capacity-lease.ts:287`), closes it.

**Finding 2 — the lease/lock TTL inversion.** Cross-referenced here because it is an
ordering hazard as much as a timing one.

`DEFAULT_CAPACITY_LEASE_TTL_MS = 30_000` (`capacity-lease.ts:9`). The renewal interval
is 10s (`admission.ts:208`), a sound 3× margin — until you look at the lock:

- `ACQUIRE_DEADLINE_MS = 60_000` (`state-file-lock.ts:10`). A caller may legitimately
  block for a full minute waiting for the admission lock.
- `withStateFileLockSync` — which is what `heartbeatCapacityLease` uses
  (`capacity-lease.ts:319`) via `acquireCapacityLease`, `releaseCapacityLease`, and
  every other admission mutation — backs off with `Atomics.wait`
  (`state-file-lock.ts:79`). That **blocks the event loop**. The 10s heartbeat
  `setInterval` at `admission.ts:203` cannot fire at all while any admission mutation
  is waiting for the lock.
- `reclaim` (`capacity-lease.ts:171-173`) drops a lease when the owner is dead **or**
  the TTL expired — an `&&` filter on "alive and unexpired". A live process that has
  been blocked on the lock for 31 seconds loses its lease even though its birth token
  proves it is alive.

Net: under lock contention lasting 30–60s, which the lock's own deadline explicitly
permits, a live orchestrator's capacity lease is reclaimed and the slot is handed to
a second process. Both then believe they hold it, and the global concurrency cap is
exceeded. Either the acquire deadline must be well under the lease TTL, or `reclaim`
must trust the birth token over the expiry (`alive && (unexpired || tokenValid)`),
or heartbeats need a path that does not contend with the same lock.

**Finding 9 — four lock staleness policies.**

| Implementation | Stale window | Liveness check | Refreshes mtime while held |
|---|---|---|---|
| `src/core/config.ts:1437` | 5s (default) | none | no |
| `src/core/state-file-lock.ts:9` | 30s | local PID | no |
| `src/domains/providers/auth/backend-file.ts:11` | 30s | none | no |
| `src/engine/apis/residency-lock.ts:19` | 130s | none | no |

Because none of them touch the lockfile while the critical section runs, the stale
window is a hard cap on how long any holder may legitimately take. The settings lock
at 5s is the sharp one: a `settings.yaml` write that stalls 5s on a slow or networked
filesystem has its lock stolen mid-write by a sibling process, with no liveness check
to prevent it. One implementation with one policy and a periodic `utimesSync` on the
held lock would replace all four.

---

## 4. UTC vs local at every render site

### The #46 pattern, still live in five places (c)

`75990401` fixed `src/interactive/memory-overlay.ts` by replacing
`event.at.slice(11, 19)` with a local formatter (`:105-113`). The same construct
survives at:

| Site | Code | What the operator sees |
|---|---|---|
| `src/interactive/overlays/tree-selector.ts:158` | `row.node.at.slice(0, 19).replace("T", " ")` | Every `/tree` row's timestamp, in UTC, unlabeled. Shift+T toggles these on. Identical to #46 |
| `src/interactive/overlays/message-picker.ts:95-98` | `new Date(millis).toISOString().slice(0, 16).replace("T", " ")` | Every fork-picker row's date and time, in UTC |
| `src/interactive/overlays/session-selector.ts:56` | `new Date(ts).toISOString().slice(0, 10)` | The `/resume` date for sessions older than 30 days. Off by one calendar day for any operator east of UTC in their evening, or west of UTC in their morning |
| `src/interactive/welcome-dashboard.ts:162` | `new Date(mtimeMs).toISOString().slice(0, 10)` | Handoff freshness on the banner, same off-by-one |
| `src/interactive/interactive-slash-runtime.ts:259` | `(deps.now?.() ?? new Date()).toISOString().slice(0, 10)` | The **filename** an export is written to. An operator at 19:30 CDT gets a file dated tomorrow and then goes looking for today's |

`tree-selector.ts:158` is the sharpest of the five: it is the same slice on the same
kind of value in the same overlay family that #46 was filed against, and it is
toggled on by an explicit keybinding, so an operator who turns timestamps on is
asking to read them.

### Correct (a)

- `src/interactive/memory-overlay.ts:105-113` — the #46 fix. Local `HH:MM:SS` via
  `toLocaleTimeString("en-GB", { hourCycle: "h23", ... })`, with the detail pane
  keeping the ISO instant so the two can be reconciled. Right on both counts.
- `src/interactive/fleet-overlay.ts:82-88`, `src/interactive/view/artifacts.ts:168-172`,
  `src/interactive/view/view-overlay.ts:207-213` — local `HH:MM:SS` from
  `getHours/getMinutes/getSeconds`. Correct output; see Finding 15 for the duplication.
- `src/domains/safety/audit.ts:190-198` — local date, deliberately, documented at `:8-9`.
- Everything persisted: 158 `toISOString()` sites all write UTC. Nothing except the
  audit filename writes a local time to disk. That is the right default and it holds
  consistently.

### Fragile (b)

**Finding 22.** `src/domains/safety/audit.ts:193` constructs a fresh
`Intl.DateTimeFormat` inside `localDateString`, which `:456` calls on every audit
row — i.e. per tool call. `Intl` formatter construction is one of the more expensive
things in the standard library. The file's own header (`:11-13`) says fsync was moved
off the row path specifically because it "kept blocking the admission hot path."
Hoisting the formatter to module scope is free. (It must be rebuilt if `process.env.TZ`
changes mid-process, which the #46 test at `tests/contracts/memory-overlay.test.ts:102-112`
does — worth a comment either way.)

**`apps/trace-viewer/public/app.js:592`** uses bare `date.toLocaleString()` with no
locale or options, so the trace viewer's rendering depends on browser locale and is
inconsistent with the CLI's pinned `en-GB h23`. Defensible for a browser; worth
deciding rather than defaulting.

---

## 5. Formatter inventory (Finding 15)

Seven implementations, no shared module:

| # | Location | Output | Frame |
|---|---|---|---|
| 1 | `memory-overlay.ts:105-113` | `HH:MM:SS` | local, `en-GB h23` |
| 2 | `fleet-overlay.ts:83-88` | `HH:MM:SS` | local, manual pad |
| 3 | `view/artifacts.ts:168-172` | `HH:MM:SS` | local, manual pad |
| 4 | `view/view-overlay.ts:207-213` | `HH:MM:SS` | local, manual pad |
| 5 | `session-selector.ts:39-57` | relative, then `YYYY-MM-DD` | **UTC** for the date fallback |
| 6 | `welcome-dashboard.ts:149-163` | relative, then `YYYY-MM-DD` | **UTC** for the date fallback |
| 7 | `tree-selector.ts:158` / `message-picker.ts:95-98` | `YYYY-MM-DD HH:MM(:SS)` | **UTC**, unlabeled |

2, 3, and 4 are byte-identical logic written three times. 5 and 6 are near-duplicates
that have already diverged: `session-selector.ts:55` has a `< 30 days → "Nw ago"`
branch that `welcome-dashboard.ts` lacks, so the same 10-day-old artifact reads
"1w ago" in `/resume` and "10d ago" on the banner.

One `src/interactive/format-time.ts` exporting `clockLocal`, `dateLocal`, and
`relative` would replace all seven and give the next #46 exactly one place to be fixed.

---

## 6. Timeouts, deadlines, and timer lifecycle

### Correct (a)

- **Timer cleanup on abort paths is genuinely good.** Every `setTimeout` in
  `src/tools/dispatch.ts` (`:1032`, `:3056`, `:3131`, `:3199`) is cleared in a
  `finally` alongside `signal.removeEventListener`. Verified all four.
- **`unref()` discipline is consistent** where it matters: `worker/heartbeat.ts:20`,
  `worker/entry.ts:214`, `admission.ts:209`, `admission.ts` pump timer, `audit.ts:415`,
  `projection.ts:178`, `turn-runtime.ts:496`, `worker-spawn.ts` kill timer. Several
  carry comments explaining why (`heartbeat.ts:10-12`, `turn-runtime.ts:495-496`,
  `projection.ts:177`). A one-shot `clio run` is not held open by a stray timer.
- **`src/core/timers.ts:5-12`** — `clampTimerDelayMs` normalizes NaN, non-positive,
  and overflow inputs against `MAX_TIMER_DELAY_MS`. Used at `bash-exec.ts:119`,
  `safe-exec.ts:74`, and validated at `acp/transport.ts:110-116`. This is the one
  piece of genuinely shared time infrastructure in the repo and it is well done.
- **`src/engine/alcf-oauth.ts:21,120`** — `EXPIRY_SKEW_MS = 5 * 60 * 1000` subtracted
  at mint time. A deliberate, correctly-sized skew budget against the auth server's
  clock. The only place in the repo that budgets for skew at all.
- **Heartbeat spec** `src/domains/dispatch/heartbeat.ts:20-26` — pure, clock-injected,
  5s window plus 10s grace against a 1s emit interval (`worker/heartbeat.ts:17`).
  Fifteen missed beats before "dead". Well-sized.

### Fragile (b)

- `src/domains/dispatch/extension.ts:2342-2343` computes an absolute wall-clock
  `deadlineAt`, which `admission-queue.ts:91` then converts back into a relative
  `setTimeout(effectiveDeadline - now())`. Round-tripping absolute↔relative through
  a wall clock means a step between the two conversions shifts the effective timeout.
  Same-process, so bounded, but it is the pattern that makes deadline bugs.
- `src/domains/dispatch/extension.ts:5562-5563`: `const startedMs = Date.parse(run.startedAt);
  const at = Date.now();` — reads the raw global clock in a function whose entire
  surrounding module uses the injected `now()` (`:2234`). One of two such lapses
  (`:3406` is the other). Cosmetic today; it defeats the test seam.
- `src/domains/safety/loop-detector.ts:125` slides a window using a caller-supplied
  `Date.now()`. A backward step widens the window and trips the guard early; a
  forward step evicts entries and lets a runaway through. The `keepLastAttempts`
  fallback (`:128-135`) bounds the damage, so this degrades rather than breaks.
- `src/domains/session/retry.ts:181,199` — the retry countdown recomputes `remaining`
  from `Date.now()` each second. Suspend/resume ends the countdown immediately on
  wake. Cosmetic, and arguably the desired behavior.
- `src/interactive/context-overlay.ts:174-182` declares two `setInterval` sites
  against one `clearInterval`. Worth confirming the fallback ticker is cleared on
  every exit path.

### Finding 21 — the elapsed counter can freeze

`src/interactive/chat-panel.ts:1000-1007` guards the render on
`!dirty && cachedWidth === width && cachedExpandKey === expandKey && cachedVerbosity
=== verbosity && cachedLiveToolOutput === liveToolOutput`. Time is not in that key.
`nowMs` is read once per *executed* render at `:1011` and threaded to
`renderToolSegmentLines`, which computes `elapsedMs` at `:623`. But `dirty` is set
only on mutation (`:813`), never on a tick. A running tool's elapsed number therefore
advances only when something unrelated dirties the panel.

Note the tension with #52: reading the clock once per render (`:1011`) is exactly the
right structure and is what made the fix possible. The gap is that nothing invalidates
on time. `dispatch-board.ts:409,527` solves the same problem by folding
`tick: Math.floor(Date.now() / 100)` into the cache key for running rows. The chat
panel should do the equivalent, keyed off `now()` so a fixed clock still produces
byte-stable output.

---

## 7. Persistence, validation, and DST

### Correct (a)

- **Canonical-form validation.** `src/domains/dispatch/capacity-lease.ts:80-84` and
  `src/domains/memory/validate.ts:291-292`:
  `Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v`.
  This rejects `2026-08-15T06:18:32-05:00` and anything else that is a valid instant
  but not canonical UTC. It is what makes the lexicographic sorts elsewhere sound.
- **No local times persisted** except the audit filename (§2).
- **DST is a non-issue on disk**, precisely because of the above. Every stored instant
  is UTC, so no persisted value shifts across a transition. The one calendar
  computation, `src/domains/memory/store.ts:106`
  (`staleAfterDays * 24 * 60 * 60 * 1000`), uses fixed 86400s days rather than calendar
  days, so a 30-day staleness horizon is off by one hour across a DST boundary. For
  memory pruning that is noise. Same for `src/cli/usage.ts:218`, whose window is
  explicitly a rolling `--days × 24h` and is reported as UTC bounds at `:397-398`.
  Correct and honest.
- **`clio usage report` reads audit rows correctly** despite the local-date filenames:
  `archive-readers.ts:49-61` globs all files and `usage.ts:238` filters on the UTC
  `ts`. The filename convention does not leak into the query.

### Finding 13 — three validation strictnesses (c, inconsistent)

| Store | Rule | Accepts `+05:30` offsets? |
|---|---|---|
| `capacity-lease.ts:80-84` | exact `toISOString()` round-trip | no |
| `memory/validate.ts:291-292` | exact `toISOString()` round-trip | no |
| `task-memory-telemetry.ts:310` | `typeof string && length <= 40 && Number.isFinite(Date.parse(v))` | **yes** |
| `session/prompt-manifest.ts:99` | `Number.isFinite(Date.parse(value.at))` | **yes** |

The lax pair will admit a non-canonical instant into a persisted record. Nothing
writes one today — every writer goes through `toISOString()` — but a hand-edited
file, a migration, or a future non-Node producer would pass validation and then break
any lexicographic comparison downstream. `evidence/build.ts:632` sorts session ledger
entries by `compareStrings(a.entry.timestamp, b.entry.timestamp)`, which silently
mis-orders the moment a non-Z offset appears.

Pick the strict rule and apply it in all four places. It costs nothing and it is the
only thing standing between the string sorts and a wrong answer.

### Finding 17 — the context fingerprint (b)

`src/domains/context/fingerprint.ts:118`:
`hash.update(`${relPath}:${stat.size}:${Math.floor(stat.mtimeMs)}\n`)`

Size plus millisecond-floored mtime. On local ext4 with nanosecond timestamps this is
fine. On a filesystem with coarse mtime granularity, or under NFS attribute caching
where `acregmin` can serve a stale mtime for tens of seconds, a same-size edit inside
the granularity window produces an identical fingerprint and the index goes stale
with no way to notice. Given the HPC target and the shared-filesystem question in
Finding 3, this is worth either a content hash for small files or an explicit
documented assumption.

Note the separate 5s in-process cache at `:181-189` is fine and clearly bounded.

---

## 8. Tests reading the wall clock

### Finding 7 — the #52 fix was per-test, and there is no harness for it

`tests/contracts/chat-panel.test.ts` contains 44 `createChatPanel(` calls. Fifteen
pass `{ now: () => <fixed> }`. Twenty-nine read the real clock.

Three separate commits fixed three instances by hand:
- `ab24ad88` — the settled-history comparison
- `0776a36f` (#52) — the cache-invalidation pair at `:901,924`
- the toggle test at `:1067`, which carries the explanatory comment

Each fix added the same two-line comment and the same `now: () => 1000`. Nothing
prevents the fourth instance. The remaining un-clocked comparison assertions
(`:968`, `:987`, `:1011`) are text-only today and therefore safe — but that is a
property of the test fixtures, not of the code. The moment someone adds a tool
segment to `settledTurns` (`:887-896`), three more byte-identity assertions start
racing the clock.

**`tests/harness/` has no clock helper.** Thirteen files (`agent-recipe.ts`,
`dispatch-stub-context.ts`, `receipt.ts`, `scratch-env.ts`, `tmp-root.ts`, …) and not
one of them provides a frozen clock, despite 306 `Date.now()` / `new Date()` calls
across 40+ test files. The right move is a `tests/harness/clock.ts` and making
`createChatPanel`'s test path default to it, so real time is opt-in.

### Real-sleep dependence

43 sites `await` a real `setTimeout`, `delay`, or `sleep`. Most are legitimate (waiting for a subprocess,
a debounce, or an fsync). Two categories are worth attention:

**Deadline-shaped assertions that can flip branch on a loaded runner.**
`tests/contracts/dispatch-admission-queue.test.ts:131` sets
`deadlineAt: Date.now() + 120` and then asserts the error message contains
`"admission timed out after"`. The controller's pump backs off from `PUMP_MIN_MS = 10`
doubling to `PUMP_MAX_MS = 500` (`admission.ts:95-96,189`). On a saturated CI box the
120ms deadline can elapse before the request is enqueued, at which point the code
takes the already-expired branch and produces `"admission deadline had already
passed"` — which the *next* test asserts at `:162`. Two tests, one clock, adjacent
branches. This is the same shape as #52.

**Long fixed sleeps.** `tests/contracts/dispatch-assignment-detached.test.ts:159` and
`tests/contracts/dispatch-assignment.test.ts:452` each `await` 600ms;
`auto-evidence.test.ts:593` waits 250ms; `worker-transport.test.ts:265,275,586,607`
wait 150–250ms. These are wall-time budgets chosen to exceed an internal timer. They
pass reliably today and cost ~3s of suite time; they will fail on a machine slow
enough that the internal timer and the test sleep converge.

**Correctly-shaped waits (a).** `tests/contracts/tool-hardening.test.ts:179-181,205,213`
assert `elapsed < 10_000` for something expected to take ~0ms. Upper-bound assertions
with a 3-order-of-magnitude margin are the right way to test "this did not wait."
`tests/contracts/retry-policy.test.ts:56-68` asserts on `computeRetryDelayMs` return
values, not on elapsed time — a pure function tested purely. Both are good patterns.

**The #46 test is the model for timezone testing.**
`tests/contracts/memory-overlay.test.ts:102-112` pins `process.env.TZ`, restores it in
a `finally`, and asserts the same instant in `America/Chicago`, `Asia/Kolkata`, and
`UTC`. Every render-site fix in Finding 5 should be tested this way.

---

## 9. Scripts

`scripts/` is small and low-risk. `live-eval-recon.mjs:219,224` and
`lifecycle-matrix.mjs:1091,1101,1112` time with `Date.now()` deltas (Finding 10).
`live-verify-dispatch-routing.mjs:1061` builds synthetic `endedAt` values as
`new Date(Date.now() + index + 1).toISOString()` to force distinct stamps — a
test-fixture idiom that works but would be clearer as an explicit counter.
`benchmarks/community/result_manifest.py:18` correctly uses
`datetime.now(timezone.utc)`, while the three harnesses beside it
(`humaneval_clio.py`, `scicode_clio.py`, `swebench_clio.py`) time published `wall_s`
figures with `time.time()` (Finding 23). Those numbers go into result manifests that
get compared across machines and across weeks; `time.monotonic()` is a one-word fix.

---

## 10. Recommended conventions

### Which clock for what purpose

**`performance.now()` for every duration, without exception.** Latency, elapsed,
TTFT, budgets, timeouts, watchdogs, backoff remaining, render metrics. If the number
answers "how long did this take" or "how long until", it comes from the monotonic
clock. It is unaffected by NTP, suspend, and DST. This is already the rule in
`workspace-files.ts`, `probe/http.ts`, `middleware/runtime.ts`, and `termination.ts` —
it just needs to be the rule everywhere.

**`Date.now()` / `new Date()` only to anchor an instant a human or another machine
will read.** `startedAt`, `endedAt`, `createdAt`, `expiresAt`. Never to measure.

**Where both are needed, use the `code-step.ts:291-306` pattern**: one wall read for
the anchor, `hrtime`/`performance.now()` for the span, and derive the far endpoint
by adding the span to the anchor. This is the only pattern that guarantees
`endedAt - startedAt === durationMs`.

**Every module that reads a clock takes it as an injectable option**, defaulting to
the real one, the way `admission-queue.ts:51,58`, `chat-panel.ts:239,839`,
`cluster.ts:74,89`, `task-bank.ts:55`, and `audit.ts:397` already do. The seam is
what makes the test deterministic; #52 existed because one call site had the seam
and the test did not use it.

**Never compare a timestamp produced on one host to a clock read on another.**
Concretely: receive-stamp (as `worker-spawn.ts:217` does), or carry an explicit
offset, or order by sequence instead of by time. Never subtract across the boundary.

**For ordering under concurrency, prefer a sequence to a timestamp.** The agent
ledger (`agent-ledger-store.ts:174`) and the execution scheduler
(`execution-scheduler.ts:222`) both do this and both are correct by construction.
Timestamps are for display and for coarse windowing, and any timestamp-based
attribution must report ambiguity the way `bestEffortAuditLink` does rather than
returning null.

### Where UTC is converted

**Store UTC. Transport UTC. Compare UTC. Convert once, at the render call site.**

- On disk and on the wire: canonical `toISOString()`, always. Validate on read with
  the exact round-trip check from `capacity-lease.ts:80-84`, in all four stores.
- In memory: epoch milliseconds or canonical ISO strings, never a formatted string.
- At the render boundary — and only there — convert to the operator's local zone.
- **Wherever a converted local time is shown, the underlying instant must remain
  reachable.** The #46 fix got this right: the row shows local, the detail pane keeps
  the ISO string, and the two can be reconciled. Make that the rule, not the exception.
- The one live exception, audit filenames, should either move to UTC dates (breaking
  the "one file per working day" affordance) or gain an explicit note in
  `docs/safety-model.md` that the file boundary is local and the row timestamps are
  not. It should not stay undocumented.

### One formatter policy

Create `src/interactive/format-time.ts` exporting exactly three functions, and route
all seven current formatters through it:

| Function | Output | Frame | Replaces |
|---|---|---|---|
| `clockLocal(instant)` | `HH:MM:SS` | operator-local, `en-GB` `hourCycle: "h23"` | formatters 1–4, `tree-selector:158`, `message-picker:98` |
| `dateLocal(instant)` | `YYYY-MM-DD` | operator-local, `en-CA` | `session-selector:56`, `welcome-dashboard:162`, `interactive-slash-runtime:259` |
| `relative(instant, now)` | `"3m ago"` → falls back to `dateLocal` | operator-local | formatters 5 and 6, resolving their divergence |

Both `Intl` formatters constructed once at module scope, with a note that they must
be rebuilt if `process.env.TZ` is mutated (the #46 test does exactly that). Machine
surfaces — filenames, ids, log lines, receipt fields, anything another program parses —
bypass the module entirely and use raw `toISOString()`.

### Two structural changes worth doing alongside

**A `tests/harness/clock.ts`,** and make the test path of every clock-reading factory
default to it. Real time in a test should be opt-in and should require saying so.
This is what stops #52 from recurring a fourth time.

**Decide the state-root question explicitly.** Either (a) carry `{host, pid,
birthToken}` in every durable lock and lease and refuse to adjudicate a foreign host's
record — the idiom already written in `compete-worktrees.ts:207-215`,
`orphan-recovery.ts:140-149`, and `run-identity.ts:23` — or (b) detect a network
filesystem under the state root at startup and refuse to run. What must not persist
is the current state: HPC scheduler detection in the codebase, an unqualified
`$HOME`-relative state root, and four lock implementations that assume one machine
without saying so.

One last note on sequencing: `startedAt` and `endedAt` are inside the receipt
integrity digest (`src/domains/dispatch/receipt-integrity.ts:83,181,333`). Any
normalization or correction of a persisted timestamp has to happen **before** the
receipt is sealed. There is no after.
