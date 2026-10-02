# System One Architecture

System One is a decision layer. A site names one object, a typed question set about that object is answered by a pluggable engine, and the site's policy reads the answers under cuts fitted for the build that answered. The domain is `src/domains/system-one/`. This page describes the contract and its invariants. For configuration and operation, see the [System One guide](../guide/system-one.md).

## Contract in one paragraph

Every entry point returns `null` instead of throwing, and `null` always means the caller behaves exactly as it would if System One did not exist. A call that is unbound, over the engine's window, canceled, timed out, refused, unreadable or unfitted never blocks or changes a turn. The types are in [types.ts](../../src/domains/system-one/types.ts): `SiteDefinition`, `Answer`, `DecisionEngine`, `SystemOne`, `DecisionRecord`, `OutcomeRecord` and `DecisionRecorder`.

## Questions and answers

A question is one of three types ([questions.ts](../../src/domains/system-one/questions.ts)).

| Type | Criteria | Answer |
| --- | --- | --- |
| `noul` | What true and false each look like | Probability of true |
| `choice` | Option key to when it applies, 1 to 255 options | Most probable key and mass per option |
| `score` | 2 to 10 levels from lowest to highest | Expected level and mass per level |

Criteria describe situations, not degrees. Every answer carries `certainty`, an engine-neutral peakedness in [0, 1] recomputed from the mass so engines that report confidence differently compare, a `calibrated` flag (false for vote counts and tournament readouts) and optional `flip` and `approximate` flags. A missing answer is an abstention on that question alone. Sites treat an answer below a certainty floor as undecided, which is `null` and not `false`.

## Sites are keyed by the object they judge

A site declares `id`, a `version`, a hard `deadlineMs`, an optional `moment`, and four pure functions: `state(object)` builds the bounded state or returns `null` to ask nothing, `questions(object)` fans out every question about that state, `read(answers, object, cuts)` applies policy under the build's cuts and returns a typed verdict or `null`, and `summarize(value)` gives the ledger its outcome fields.

One call carries one state and every question about it. The `systemone` engine sends those questions in one request. The `llm` engine sends requests per question and option order or vote, with concurrency bounded by the endpoint's capacity. Every state is capped by code points in [bounds.ts](../../src/domains/system-one/sites/bounds.ts) so a fitted cut was measured on evidence of a known size and a small-window engine never truncates the part that matters.

Two definitions can share the id `toolCall` and differ in `moment`: `card` (the advisory on an open approval card) and `gate` (the detached yolo reading). Each moment trips its own breaker, so a slow card never opens the gate's.

The site ids are `turn`, `toolCall`, `toolResult`, `turnEnd`, `relevance`, `consult` and `drafts`, defined one per file under `src/domains/system-one/sites/`. `consult` is a factory because the agent supplies the questions. `drafts` and `consult` have no cut and no policy.

## Engines

An engine implements `decide(request)` and rejects on transport failure, an unusable reply or abort. It does not own deadlines or fallback ([systemone.ts](../../src/domains/system-one/engines/systemone.ts) and [llm.ts](../../src/domains/system-one/engines/llm.ts)).

- `systemone` posts to `POST /v1/systemone` through a runtime's `decide` verb (`typesafe-jev` and `systemone`) and converts the wire reply, dropping an answer whose type does not match its question or whose choice is not a declared key. The build is the model the server reports.
- `llm` runs an ordinary chat target as a one-letter decider. With logprobs it reads first-token letter alternatives through a softmax whose temperature is fitted per build and question bucket (1.0 for a build nobody fitted). Without them it casts five votes with alternating option order and marks the answers uncalibrated. Questions of more than 26 options run as a tournament. Requests share one state prefix so a server's prefix cache prefills it once, and a scheduler bounds concurrency by the endpoint's capacity.

`createSystemOne` in [factory.ts](../../src/domains/system-one/factory.ts) resolves a site's binding from live settings on every call, memoizes one engine per configured name, and rebuilds it when a digest of its own configuration, target and runtime changes.

## The runner

[runner.ts](../../src/domains/system-one/runner.ts) owns everything that must hold for every engine.

1. **State.** The site builds it, and the runner redacts it once before any request exists, so every engine kind and every record sees the same scrubbed state.
2. **Validation.** Every question is validated, and a site that asks nothing fails the call.
3. **Window.** An engine that declares a window and cannot fit the state plus its longest question gets `overflow`, because a server silently truncating evidence is the failure a gate cannot detect.
4. **Breaker.** Three consecutive timeouts at one (engine configuration, site, moment) open a breaker for five minutes, then exactly one call probes. Only timeouts trip it. An answer or a refusal proves the engine responds and resets it.
5. **Deadline.** The binding's `timeoutMs` or the site's `deadlineMs` aborts the engine through a signal, and a caller's own signal cancels the call.
6. **Read.** The answering build selects the cuts. `read` and `summarize` are wrapped, and an exception in a site's policy becomes an error on the call's record, not on the turn.
7. **Record.** One `DecisionRecord` is emitted per evaluated call whatever its outcome (`answered`, `failed`, `timeout`, `canceled`, `overflow`, `breaker-open`), carrying the session that was current when the call started so a late answer is filed under the session that asked. If every route is skipped because a required cut is missing, no decision row is emitted.

In-flight calls are tracked so shutdown can wait a bounded time for a row that a turn stopped waiting on. The runner remembers the build each engine last answered with for ten minutes, so callers can ask `shadowed(site)` cheaply.

## Calibration: cuts belong to a build

[calibration.ts](../../src/domains/system-one/calibration.ts) is the one reviewable table of what a build's numbers mean. `FITTED_CUTS` is keyed by answering build and holds `<site>.<key>` entries, each fitted from a labeled run on that exact build with the run cited beside the numbers. `cutsFor(build, site, overrides)` overlays the operator's `systemOne.cuts` and reports `fitted`, true when any cut exists for the site under the build.

A site that hints, gates or acts must stay silent when `fitted` is false. That state is **shadow mode**: the engine is still asked and the call is fully recorded, but the policy returns no hint, no gate and no act. A keyed threshold is chosen so that the classes do not overlap where the key acts or gates, and only display or hint keys may accept missed positives. Safety sites can only add friction. `FITTED_TEMPERATURES` follows the same rule for LLM builds and is empty until a build is fitted.

In [system-one-host.ts](../../src/entry/system-one-host.ts), `turn`, `turnEnd`, the `toolCall` gate and the `toolResult` screen always detach. An unfitted reading is skipped when dataset recording is off; the gate and screen only record, even with fitted cuts. Callers query `shadowed(site, moment)` under the same moment that recorded the answering build. `relevance` reads a finished cached ranking synchronously and starts missing work detached; shadow requests are skipped unless the dataset is recording.

## Records

Two readers get two artifacts from the same `DecisionRecord`. The recorder is installed by the composition root only. Workers install none and record nothing.

**Session ledger rows.** Always on. A compact row per call, custom entry type `systemOne`, drained at the next turn boundary into the session that asked ([rows.ts](../../src/domains/system-one/recorder/rows.ts)). It carries site, site version, engine, kind, build, outcome, error, latency, deadline, the estimated state tokens, a SHA-256 of the state, the number of questions, the answers, usage, `fitted` and the policy summary. It never carries the state, so a ledger stays small and safe to share.

**Dataset rows.** Only when `systemOne.record` is true ([dataset.ts](../../src/domains/system-one/recorder/dataset.ts)). One append-only JSONL file per UTC day under `<state>/systemone/`, created `0700`/`0600`. Three row kinds start with their own `"kind"` so a reader classifies a line without parsing it: `decision` (redacted state capped at 16 KiB with a `stateTruncated` flag, a digest of the unredacted state, a redaction count, question hashes and the answers), `spec` (one question spec per hash) and `outcome` (what followed, joined by `ref` at export). Writes are queued and appended on the next event-loop turn with one synchronous `appendFileSync` per day file, and a process `exit` hook flushes what is left. A decision finished before any session exists is held until a session adopts it, so it is not filed as `session: null`. Pruning by age and size runs on the first write and at most hourly.

The `ref` on a call is the join key for outcomes: the user turn id, a permission request id or a tool call id. Outcome sources are `turn`, `next-operator`, `permission`, `follow-up`, `draft` and `compaction`. `clio-coder systemone status|export` and the doctor rows read the dataset through shared helpers in [store.ts](../../src/domains/system-one/recorder/store.ts) so all three agree on what a dataset file is.

## Where sites are read

The composition root builds one `SystemOne`, one recorder and one host ([system-one-host.ts](../../src/entry/system-one-host.ts)). The host is what readers that cannot await take from.

| Site | Reader | Degrades to |
| --- | --- | --- |
| `turn` | Started once before the prompt is built without waiting; a reading ready in time can inform hints, turn control and prewarm, and a late reading cannot enter the next continuation | No hints, previous turn-control behavior |
| `toolCall` gate | Detached recording as an unrecognized `execute` starts at `yolo`, interactive only; never parks | `yolo` unchanged |
| `toolCall` card | Approval overlay, polled per frame, never waited on | No advisory line |
| `toolResult` | Detached recording for `web_fetch`, `web_read` and MCP tool results; never adds a banner | No banner beyond the deterministic scan |
| `turnEnd` | Detached record of the settled turn; no nudge or settlement waits for it | The regular expressions |
| `relevance` | Skills listing, gateway `find` and memory recall take a finished cached ranking synchronously; a cache miss starts work without waiting | Local vocabulary order |
| `consult` | The `consult` tool, registered at startup when bound | Tool absent |
| `drafts` | `/draft` overlay. `Enter` on a finished draft appends it to the composer and records a `draft` outcome joined to the judging call by `ref` | Candidates shown unjudged |

Every reader wraps its call so a throw degrades to the same fallback. The `toolResult` reading runs detached and preserves result delivery; the `after_tool` deterministic marker scan still judges the original result.

## Validating a Laya build

A new engine or a new build of an existing engine ships in shadow. It cannot hint or act until cuts are fitted for its exact build string; the gate, result screen and turn-end sites remain record-only in this release. The procedure is:

1. Bind the engine to a site and run `scripts/decision-probe.ts <fixture> --engine <name>` against the labeled fixtures in `tests/fixtures/decision-cases/` (`turn`, `turn-end`, `tool-calls`, `tool-results`, `capabilities`). Each case goes through `createSystemOne` exactly as production does, with an in-memory recorder that keeps the raw answers.
2. For each labeled key, read agreement, abstention, wrong and confidently wrong counts, the probability ranges of the positive and negative classes per run, and the suggested cut with its margin to each side. The suggestion is null when the classes overlap.
3. Add the cuts to `FITTED_CUTS` under the printed build only for keys whose classes clear the site's margin rule, citing the run beside them. An operator can try cuts earlier with `systemOne.cuts`, which overlays the table without changing it.
4. Record real traffic with `systemOne.record` and export it to compare builds on the operator's own turns.

A cut from one build says nothing about another build, another vendor, or a chat model reporting logprobs, which is why the key is the build and a build absent from the table never acts.

## Invariants

- No System One failure reaches a turn. Every runner, factory and host entry point catches and returns `null`.
- The main model never falls back to interpreting the turn when the `turn` site is silent.
- A verdict is advice. Only `consult` returns a distribution to the agent, and it never returns a chosen option.
- Safety sites only tighten. A site cannot remove a confirmation, clear a deterministic flag or unblock a call.
- Redaction happens once before the request is built, so what a hosted engine receives and what is recorded are the same text.
- Workers record nothing and never receive `consult`.

## Source map

| Component | Source | Key contracts |
| :--- | :--- | :--- |
| Contract | [types.ts](../../src/domains/system-one/types.ts) | `SiteDefinition`, `DecisionEngine`, `SystemOne`, `DecisionRecord` |
| Questions and answers | [questions.ts](../../src/domains/system-one/questions.ts), [answers.ts](../../src/domains/system-one/answers.ts) | `noul`, `choice`, `score`, `certaintyFromMass` |
| Calibration | [calibration.ts](../../src/domains/system-one/calibration.ts) | `FITTED_CUTS`, `cutsFor`, `temperatureFor` |
| Runner and factory | [runner.ts](../../src/domains/system-one/runner.ts), [factory.ts](../../src/domains/system-one/factory.ts) | `createRunner`, `createSystemOne` |
| Engines | [systemone.ts](../../src/domains/system-one/engines/systemone.ts) and [llm.ts](../../src/domains/system-one/engines/llm.ts) | `createSystemOneEngine`, `createLlmEngine` |
| Sites | [turn.ts](../../src/domains/system-one/sites/turn.ts), [tool-call.ts](../../src/domains/system-one/sites/tool-call.ts), [tool-result.ts](../../src/domains/system-one/sites/tool-result.ts), [turn-end.ts](../../src/domains/system-one/sites/turn-end.ts), [relevance.ts](../../src/domains/system-one/sites/relevance.ts), [consult.ts](../../src/domains/system-one/sites/consult.ts), [drafts.ts](../../src/domains/system-one/sites/drafts.ts) | `TURN_SITE`, `TOOL_CALL_GATE_SITE`, `TOOL_RESULT_SITE`, `TURN_END_SITE`, `RELEVANCE_SITE`, `consultSite`, `DRAFTS_SITE` |
| Recorder | [index.ts](../../src/domains/system-one/recorder/index.ts), [dataset.ts](../../src/domains/system-one/recorder/dataset.ts) | ledger rows, dataset writer, export, `describeBindings` |
| Host | [system-one-host.ts](../../src/entry/system-one-host.ts) | `createSystemOneHost` |
| CLI | [system-one.ts](../../src/cli/system-one.ts) | `systemone status`, `systemone export` |
