# System One Architecture

System One is an experimental decision layer. A site names one object, a typed question set about that object is answered by a pluggable engine, and the site's policy reads the answers under cuts fitted for the build that answered. The domain is `src/domains/system-one/`. This page describes the contract and its invariants. For configuration, operation and what each site does with an answer, see the [System One guide](../guide/system-one.md).

## Contract in one paragraph

Every entry point returns `null` instead of throwing, and `null` always means the caller behaves exactly as it would if System One did not exist. A call that is unbound, over the engine's window, canceled, timed out, refused, unreadable, unfitted or denied by the information-flow check never blocks or changes a turn. The types are in [types.ts](../../src/domains/system-one/types.ts): `SiteDefinition`, `Answer`, `DecisionEngine`, `SystemOne`, `DecisionRecord`, `RouteRecord`, `OutcomeRecord` and `DecisionRecorder`.

## Questions and answers

A question is one of three types ([questions.ts](../../src/domains/system-one/questions.ts)).

| Type | Criteria | Answer |
| --- | --- | --- |
| `noul` | What true and false each look like | Probability of true |
| `choice` | Option key to when it applies, 1 to 255 options | Most probable key and mass per option |
| `score` | 2 to 10 levels from lowest to highest | Expected level and mass per level |

Criteria describe situations, not degrees. Every answer carries `certainty`, an engine-neutral peakedness in [0, 1] recomputed from the mass so engines that report confidence differently compare ([answers.ts](../../src/domains/system-one/answers.ts)). It also carries a `calibrated` flag, false for vote counts, tournament readouts and a single option order, and optional `flags` (`flip` when the two option orders disagree, `approximate` for a tournament, `partial` when an option order was unreadable). `readout` names what the number is as the engine's profile declares it (`server`, `softmax-binary`, `softmax-exclusive`, `sigmoid-independent`, `ordinal-expectation`, `logprob` or `vote`). It is not a calibration claim. A missing answer is an abstention on that question alone. Sites treat an answer below a certainty floor as undecided, which is `null` and not `false`, and read a `noul` only through a calibrated probability, so a vote fraction never crosses a cut.

## Sites are keyed by the object they judge

A site declares `id`, a `version`, a hard `deadlineMs`, an optional `moment`, an optional `requiredCut`, optional `compact` wordings, and pure functions: `state(object)` builds the bounded state or returns `null` to ask nothing, `questions(object)` fans out every question about that state, `read(answers, object, cuts)` applies policy under the build's cuts and returns a typed verdict or `null`, and `summarize(value)` gives the ledger its outcome fields. `taskOf` and `cutTask` say which decision task a question serves and which task's answers a cut is compared with. The decision tasks are `intent`, `recipe`, `toolRisk`, `injection`, `turnEnd`, `relevance`, `clusterSelect`, `consult`, `drafts` and `steer`. `SITE_TASKS` in [contract.ts](../../src/domains/system-one/contract.ts) is the source matrix of which tasks each site asks, and settings validation refuses a task route outside it.

| Site | Definitions (moment, version) | Tasks asked | Cut keys read |
| --- | --- | --- | --- |
| `turn` | `turn-v2`; moment `recipe`, `turn-recipe-v1` | `intent`, `recipe`, `clusterSelect` | `direct`, `dispatch`, `orientation`, `direction`, `prewarm`, `recipeGroup`; `recipeInGroup` at the `recipe` moment |
| `toolCall` | moment `card` and moment `gate`, both `tool-call-v2` | `toolRisk` | none at `card`; `gateRadius` and `gateDestroys` at `gate` |
| `toolResult` | `tool-result-v2` | `injection` | `instructions` |
| `turnEnd` | `turn-end-v3` | `turnEnd` | `asksOperator`, `blocksOnDecision`, `blocksOnDecisionFloor` |
| `relevance` | `relevance-v1`; moment `clusters`, `relevance-cluster-v2` | `relevance`, `clusterSelect` | `ranked` (a validation marker); `clusters` at the `clusters` moment, required |
| `consult` | `consult-v1` | `consult` | none |
| `drafts` | `drafts-v1` | `drafts` | none |
| `steer` | `steer-v1` | `steer` | none |

Each definition lives in one file under `src/domains/system-one/sites/`. `consult` is a factory because the agent supplies the questions. `consult`, `drafts` and `steer` have no cut and no policy.

One call carries one state and every question about it. The `systemone` engine sends those questions in one request. The `llm` engine sends requests per question and option order or vote, with concurrency bounded by the endpoint's capacity. Every state is capped by code points in [bounds.ts](../../src/domains/system-one/sites/bounds.ts) so a fitted cut was measured on evidence of a known size and a small-window engine never truncates the part that matters. A site's `compact` wordings are short variants for renderers with a declared per-option bound. They carry their own version, which joins the threshold identity of any build read through them.

Two definitions can share an id and differ in `moment`. `toolCall` has `card` (the advisory on an open approval card) and `gate` (the detached yolo reading). `turn` has a second, chained definition for choosing a recipe inside a category. `relevance` has `clusters` for selecting catalog groups. Each moment trips its own breaker and keeps its own answered build, so a slow card never opens the gate's. A site that sets `requiredCut` is skipped on any route whose identity lacks that cut, before any request, and a call skipped for that reason on every route leaves no decision row.

## Engines

An engine implements `decide(request)` and rejects on transport failure, an unusable reply or abort. It does not own deadlines or fallback ([systemone.ts](../../src/domains/system-one/engines/systemone.ts) and [llm.ts](../../src/domains/system-one/engines/llm.ts)). `unsupported(task, question)` says, without any I/O, why the engine must not be asked a question.

- `systemone` posts to `POST /v1/systemone` through a runtime's `decide` verb (`typesafe-jev` and `systemone`) and converts the wire reply, dropping an answer whose type does not match its question or whose choice is not a declared key. A choice with one option has no uncertainty and is answered locally without a request. The build is the model the server reports. A server that reports none, or `unknown`, gets the build `<target id>/<requested model or default>`, so a fitted cut never applies to an unidentified server. Every question passes the profile's renderer again here, so no caller reaches the wire with a question the profile refuses.
- `llm` runs an ordinary chat target as a one-letter decider. With logprobs it reads the first-token letter alternatives in both option orders and averages them through a softmax whose temperature is fitted per build and question bucket (`FITTED_TEMPERATURES` is empty, so every build reads at 1.0). An unreadable order is dropped and the answer is flagged `partial` and uncalibrated. Without logprobs it casts five votes with alternating option order, needs at least three valid votes, and marks the answers uncalibrated. Questions of more than 26 options run as a tournament of groups of 25 that keeps each group's two strongest, flagged `approximate`. Questions are never packed into one request. Requests share one state prefix so a server's prefix cache prefills it once, and a scheduler bounds concurrency by the endpoint's capacity (4 when the host cannot say).
- `llm` mode `auto` starts with logprobs. A warm request that returns no usable logprobs downgrades that target, model and URL to votes, re-checked after ten minutes. Three consecutive calls with half or more of their option orders unreadable flip it the same way. A logprobs verdict is trusted for 30 minutes. The reply `note` (`downgraded: no-logprobs`, `downgraded: partial-logprobs` or `partial: N of M logprob orders unreadable`) says why a readout is not the configured one, and a call never mixes the two readouts.
- The build key of an `llm` engine is `llm:<runtime>@<host>/<model>#<mode>:<prompt version>` (`oneshot` replaces the host for a runtime without an HTTP chat wire). Its window is the target's context window less a 256-token reserve when that window exceeds 1,024 tokens, and the window itself otherwise.
- Every request an `llm` engine sends, schema retries included, passes the composition root's paid-request admission ([system-one-host.ts](../../src/entry/system-one-host.ts)). A request to a priced target is refused once the session cost ceiling is reached and never waits for a raise, a refused request fails the whole decision, and usage is recorded under the `system-one` label that `/usage` and `clio-coder usage report` count as System One calls and not as turns. `safety.limits.sessionCostUsd: 0` means no ceiling, so `sessionCeilingReached` in [budget.ts](../../src/domains/scheduling/budget.ts) never refuses a request for cost.

A `systemone` engine's window is `engineWindow(profile, declared)` in [profiles.ts](../../src/domains/system-one/profiles.ts): the target's `capabilities.contextWindow` (or the runtime default, 480 on the `systemone` runtime) bounded by the profile's ceiling. An engine has no placement. The processor a decision model runs on (an integrated GPU, an NPU, the CPU or a hosted service) belongs to the server behind the target, and the server's reported build, which already keys every cut, is what distinguishes two placements of one checkpoint. Doctor reports each bound engine's profile, window and passive round trip without asking a decision.

`createSystemOne` in [factory.ts](../../src/domains/system-one/factory.ts) resolves a site's binding from live settings on every call, memoizes one engine per configured name, and rebuilds it when a digest of its own configuration, target and runtime changes. A binding's `tasks` map adds one route per other engine, each carrying the tasks sent to it. A routed engine that is unusable abstains its tasks and never falls back to the site's engine. `limits(site, task)` reports the window and option bound of the engine answering a task, so a caller can choose a bounded hierarchy over a flat ask.

## Capability profiles

A profile is a declared contract for a served model, not a measurement ([profiles.ts](../../src/domains/system-one/profiles.ts)). It says which tasks and answer semantics the model may be asked (`boolean`, `exclusive`, `ordinal`, `independent`), the limits its publisher declares, and how its numbers are read. `render` runs before any byte leaves. A question outside the profile's tasks, semantics or option count is abstained on with a reason. A bounded renderer prefers the site's compact wording, keeps option keys and order, and abstains when neither wording provably fits. It never cuts text to make a question fit.

| Profile | Renderer | Tasks | Semantics | Options | Window ceiling |
| --- | --- | --- | --- | --- | --- |
| `generic`, `jev` | `systemone-v1` | all | all | 1 to 255 | none |
| `laya` | `systemone-v1` | all | all | 1 to 255 | 512 |
| `laya-multilingual` | `systemone-v1` | all | all | 1 to 255 | 1024 |
| `julia-1` | `julia-compact-v1` | all | all | 2 to 20, 48 tokens each, 512-token question head | 8192 |
| `gliner2.5-small` | `gliner-label-v1` | `intent`, `recipe`, `relevance`, `clusterSelect` | `exclusive`, `independent` | 2 to 255 | none |
| `gliner2.5-decide` | `gliner-label-v1` | those four and `turnEnd` | all | 2 to 255 | none |
| `strands-decider` | `systemone-v1` | all | all | 1 to 255 | 4096 |

The legacy renderer is the identity, so `generic`, `jev`, `laya` and `strands-decider` send each question exactly as the site wrote it. The semantic question id, task and renderer revision stay in Clio's record and are not sent. Julia-1 options are proven to fit by UTF-8 bytes, which is an upper bound and abstains more often than a count. Once `julia-1` is bound, [julia-tokenizer.ts](../../src/domains/system-one/julia-tokenizer.ts) fetches the model's tokenizer once from its published repository, pinned by revision and SHA-256, into the Clio cache and replaces the byte proof with the real count. Offline, or before that file is cached, the byte proof stays. The `strands-decider` ceiling is its checkpoint's `max_length`. Its own fitting rule gives the question the window first and the state the rest, and the runner applies that rule without the cuts: state plus the longest question must fit the window or nothing is sent.

## The runner

[runner.ts](../../src/domains/system-one/runner.ts) owns everything that must hold for every engine.

1. **State.** The site builds it, and the runner redacts it once before any request exists, so every engine kind and every record sees the same scrubbed state. Question text is redacted by value too, while ids and option keys stay exact.
2. **Validation and routing.** Every question is validated, and a site that asks nothing fails the call. Each question goes to the route that answers its task. An engine that refuses a question through `unsupported` abstains on it, and a call where no route accepts any question ends as `unsupported`.
3. **Required cut.** A route whose identity lacks the site's `requiredCut` is skipped before any request.
4. **Window.** A route whose engine declares a window and cannot fit the state plus its longest question (estimated at one token per four characters) gets `overflow`, because a server silently truncating evidence is the failure a gate cannot detect.
5. **Breaker.** Three consecutive timeouts at one (engine configuration, site, moment) open a breaker for five minutes, then exactly one call probes. Only timeouts trip it. An answer or a refusal proves the engine responds and resets it.
6. **Information flow.** The composition root supplies a content-blind check that judges the restrictions the evidence inherited against the engine's model destination (target, runtime, URL, model). A refusal ends that route as `flow-denied` and nothing is sent. A configured check that cannot answer is not a permit. With no check installed the request is allowed. Callers pass the restrictions their evidence carries, and the root adds the session's own. See the [information flow guide](../guide/information-flow.md).
7. **Deadline.** The binding's `timeoutMs` or the site's `deadlineMs` is one budget counted from the call's start and shared by every route. It aborts the engines through a signal, and a caller's own signal cancels the call.
8. **Read.** The answering build selects the cuts. `read` and `summarize` are wrapped, and an exception in a site's policy becomes an error on the call's record, not on the turn. A cut is read from the route that answered the task the cut is compared with, so a cut fitted on one engine never applies to another engine's number.
9. **Record.** One `DecisionRecord` is emitted per evaluated call whatever its outcome (`answered`, `failed`, `timeout`, `canceled`, `overflow`, `breaker-open`, `unsupported` or `flow-denied`), carrying the session that was current when the call started so a late answer is filed under the session that asked. Each engine that took part leaves a `RouteRecord` with its profile, renderer, tasks, build, threshold identity, the validation of its cuts (`measured`, `operator` or `none`), its own outcome and round trip, and the questions as a bounded renderer sent them. The call's `build` is set only when one engine answered all of it. If every route is skipped because a required cut is missing, no decision row is emitted.

In-flight calls are tracked so shutdown can wait a bounded time for a row that a turn stopped waiting on. The runner remembers the identity each engine last answered under for ten minutes, per site and moment, so callers can ask `shadowed(site, moment)` cheaply.

## Calibration: cuts belong to a threshold identity

[calibration.ts](../../src/domains/system-one/calibration.ts) is the one reviewable table of what a build's numbers mean. A cut is keyed by `thresholdIdentity(build, renderer, siteVersion, compactVersion)` ([contract.ts](../../src/domains/system-one/contract.ts)). For the legacy wire and the `llm` prompt the identity is the bare build string. For a bounded renderer it is `<build>+<renderer>@<siteVersion>`, with `/<compactVersion>` appended when a compact wording was read. `FITTED_CUTS` holds `<site>.<key>` entries per identity, each fitted from a labeled run on that exact build with the run cited beside the numbers. `FITTED_CONTRACTS` lists the renderer and site versions a measured table was fitted under, and a measured cut applies only when the call matches exactly, so a reworded site or another rendering goes silent until it is measured again. `cutsFor(identity, site, overrides, contract)` overlays the operator's `systemOne.cuts`, which are not subject to the contract match, and reports `fitted`, true when any cut exists for the site under the identity. `source(key)` says whether a cut is `measured` or the operator's.

The table ships cuts for one build, `jev-1.13.0` over the `systemone-v1` renderer, under the site versions `turn-v2`, `turn-end-v3`, `tool-call-v2`, `tool-result-v2` and `relevance-v1`.

| Cut key | Role |
| --- | --- |
| `turn.direct` | `[Scope]` hint |
| `turn.dispatch` | `[Plan]` hint and the expected-dispatch act |
| `turn.orientation`, `turn.direction` | Orientation and direction acts |
| `turn.prewarm` | Worker prewarm |
| `toolCall.gateRadius`, `toolCall.gateDestroys` | Yolo gate escalation, read by the site policy and only recorded by the host |
| `toolResult.instructions` | Instruction flag, read by the site policy and only recorded by the host |
| `turnEnd.asksOperator` | Reading that the reply asks the operator, only recorded |
| `turnEnd.blocksOnDecision`, `turnEnd.blocksOnDecisionFloor` | The two sides of one policy: blocking needs the first, not blocking needs the second or less, and the middle is no decision. Only recorded |
| `relevance.ranked` | Validation marker, not a threshold. A build without it never reorders a listing |

`turn.recipeGroup`, `turn.recipeInGroup` and `relevance.clusters` have no shipped value for any build, so category-first recipe picks and category-first relevance ranking act only under operator cuts.

A site that hints, gates or acts must stay silent when `fitted` is false. That state is **shadow mode**: the engine is still asked and the call is fully recorded, but the policy returns no hint, no gate and no act. A keyed threshold that acts or gates is chosen above the highest observed negative with margin, and it accepts missed positives where the classes overlap. Safety sites can only add friction. `FITTED_TEMPERATURES` follows the same rule for LLM builds and is empty until a build is fitted.

In [system-one-host.ts](../../src/entry/system-one-host.ts), `turn`, `turnEnd`, the `toolCall` gate, the `toolResult` screen and `steer` always detach. An unfitted reading is skipped when dataset recording is off, and the `turn` reading is kept for its readers only from a fitted build. The gate and screen only record, even with fitted cuts. Callers query `shadowed(site, moment)` under the same moment that recorded the answering identity. It is true only when every engine taking part last answered from an unfitted identity within ten minutes, and an engine not yet heard from is unknown, which is never shadow. `relevance` reads a finished cached ranking synchronously and starts missing work detached. Shadow requests are skipped unless the dataset is recording. A catalog too large for one request is asked by its own categories (at most 32 groups of at most 64 entries, two levels deep), which needs the `relevance.clusters` cut.

## Records

Two readers get two artifacts from the same `DecisionRecord`. The recorder is installed by the composition root only. Workers install none and record nothing.

**Session ledger rows.** Always on. A compact row per call, custom entry type `systemOne`, drained at the next turn boundary into the session that asked ([rows.ts](../../src/domains/system-one/recorder/rows.ts)). It carries site, site version, engine, kind, build, outcome, error (cut to 160 characters), latency, deadline, the estimated state tokens, a SHA-256 of the state, the number of questions, the answers, usage, `fitted`, the policy summary and the per-engine routes without their rendered text. It never carries the state, so a ledger stays small and safe to share.

**Dataset rows.** Only when `systemOne.record` is true ([dataset.ts](../../src/domains/system-one/recorder/dataset.ts)). One append-only JSONL file per UTC day at `<state dir>/systemone/YYYY-MM-DD.jsonl`, created `0700` for the directory and `0600` for files. Three row kinds start with their own `"kind"` so a reader classifies a line without parsing it.

| Kind | Holds |
| --- | --- |
| `decision` | One call: the redacted state capped at 16 KiB with a `stateTruncated` flag, a digest of the unredacted state, a redaction count, question hashes, the answers, the policy outcome and the routes, rendered questions included. The row's `engineKind` names the engine kind because `kind` classifies the line |
| `spec` | One question spec per hash, written once per process and day file so decisions stay small |
| `outcome` | What followed a decision, joined to it by `ref` at export |

Writes are queued (at most 512 rows) and appended on the next event-loop turn with one synchronous `appendFileSync` per day file, and a process `exit` hook flushes what is left. A failed write drops its batch and warns once. A decision finished before any session exists is held until a session adopts it, so it is not filed as `session: null`, and an outcome naming a held decision waits and is written right after it. Pruning runs once shortly after the recorder starts, whether or not recording is on, and then on writes at most hourly: day files older than `systemOne.retentionDays` are deleted, then the oldest files until the directory is under `systemOne.maxMiB`. The newest file is never deleted for size.

The `ref` on a call is the join key for outcomes: the user turn id, a permission request id, a tool call id, a ranking call id or a queue entry id. Outcome sources are `turn` (what the turn did), `turn-tokens` (amends a canceled turn with worker tokens that sealed after it), `next-operator`, `permission` (how a parked approval was answered and how long it took), `follow-up` (whether a ranked skill, capability or memory entry was later used), `draft` (the draft taken, the judge's pick and whether they agreed) and `steer` (what became of a queued message).

`clio-coder systemone status|export` and the doctor rows read the dataset through shared helpers in [store.ts](../../src/domains/system-one/recorder/store.ts) so all three agree on what a dataset file is. Export runs the scrub over every row again on the way out, so a day file written before a scrub fix does not leak through it. The operator workflow for these commands is in the guide's [training dataset](../guide/system-one.md#the-training-dataset) section.

## Where sites are read

The composition root builds one `SystemOne`, one recorder and one host ([system-one-host.ts](../../src/entry/system-one-host.ts)). The host is what readers that cannot await take from.

| Site | Reader | Degrades to |
| --- | --- | --- |
| `turn` | Started once before the prompt is built without waiting; a fitted reading ready in time can inform hints, turn control and prewarm, and a late reading cannot enter the next continuation. A category pick for a recipe is a second call chained after the first | No hints, previous turn-control behavior |
| `toolCall` gate | Detached recording as an unrecognized `execute` starts at `yolo`, interactive only; never parks | `yolo` unchanged |
| `toolCall` card | Approval overlay, polled per frame, never waited on | No advisory line |
| `toolResult` | Detached recording for `web_fetch`, `web_read` and MCP tool results; never adds a banner. The result's information-flow restrictions travel with the request | No banner beyond the deterministic scan |
| `turnEnd` | Detached record of the settled turn; no nudge or settlement waits for it | The regular expressions |
| `relevance` | Skills listing, gateway `find` and memory recall take a finished cached ranking synchronously (32 kept, keyed by catalog, question, binding and flow restrictions); a cache miss starts work without waiting | Local vocabulary order |
| `consult` | The `consult` tool ([consult.ts](../../src/tools/consult.ts)), registered at startup when bound; waits for the answer up to the deadline because the agent chose to ask | Tool absent |
| `drafts` | `/draft` overlay, which waits for the judgment up to the deadline. `Enter` on a finished draft appends it to the composer and records a `draft` outcome joined to the judging call by `ref` | Candidates shown unjudged |
| `steer` | Chat loop, when a message is queued mid-run. Detached record; nothing reads the answer | Nothing changes |

Every reader wraps its call so a throw degrades to the same fallback. The `toolResult` reading runs detached and preserves result delivery; the `after_tool` deterministic marker scan still judges the original result.

## Validating a Laya build

A new engine or a new build of an existing engine (Laya, Julia-1, the Strands Decider, a hosted build) ships in shadow. It cannot hint or act until cuts are fitted for its exact threshold identity, and the gate, result screen, turn-end and steer sites remain record-only. The procedure is:

1. Bind the engine to a site and run `node --import tsx scripts/decision-probe.ts <fixture.json> --engine <name>` against a labeled fixture in `tests/fixtures/decision-cases/` (`turn.json`, `turn-end.json`, `tool-calls.json`, `tool-results.json` or `capabilities.json`). The engine comes from `systemOne.engines` in the operator's settings, or from `--kind`, `--target` and `--model`. Each case goes through `createSystemOne` exactly as production does, with an in-memory recorder that keeps the raw answers. The probe calls the engine live and is never part of CI.
2. For each labeled key, read agreement, abstention, wrong and confidently wrong counts, the probability ranges of the positive and negative classes per run, and the suggested cut with its margin to each side. The suggestion is null when the classes overlap.
3. Add the cuts to `FITTED_CUTS` under the printed build only for keys whose classes clear the site's margin rule, citing the run beside them, and list the renderer and site versions in `FITTED_CONTRACTS`. An operator can try cuts earlier with `systemOne.cuts`, which overlays the table without changing it.
4. Record real traffic with `systemOne.record` and export it to compare builds on the operator's own turns.

A cut from one build says nothing about another build, another vendor, a different renderer or site version, or a chat model reporting logprobs, which is why the key is the identity and an identity absent from the table never acts. The probe and the fixtures live in the source repository and are not in the npm package.

## Invariants

- No System One failure reaches a turn. Every runner, factory and host entry point catches and returns `null`.
- The main model never falls back to interpreting the turn when the `turn` site is silent.
- A verdict is advice. Only `consult` returns a distribution to the agent, and it never returns a chosen option.
- Safety sites only tighten. A site cannot remove a confirmation, clear a deterministic flag or unblock a call. The gate and the result screen only record.
- Redaction happens once before the request is built, so what a hosted engine receives and what is recorded start from the same text. The dataset then applies its own second pass to its copy.
- A request leaves only when the information-flow check allows its destination for the restrictions the evidence carries.
- Workers record nothing and never receive `consult`.

## Source map

| Component | Source | Key contracts |
| :--- | :--- | :--- |
| Contract | [types.ts](../../src/domains/system-one/types.ts), [contract.ts](../../src/domains/system-one/contract.ts) | `SiteDefinition`, `DecisionEngine`, `SystemOne`, `DecisionRecord`, `SITE_TASKS`, `thresholdIdentity` |
| Questions and answers | [questions.ts](../../src/domains/system-one/questions.ts), [answers.ts](../../src/domains/system-one/answers.ts) | `noul`, `choice`, `score`, `certaintyFromMass` |
| Calibration | [calibration.ts](../../src/domains/system-one/calibration.ts) | `FITTED_CUTS`, `FITTED_CONTRACTS`, `cutsFor`, `temperatureFor` |
| Runner and factory | [runner.ts](../../src/domains/system-one/runner.ts), [factory.ts](../../src/domains/system-one/factory.ts) | `createRunner`, `createSystemOne` |
| Engines | [systemone.ts](../../src/domains/system-one/engines/systemone.ts) and [llm.ts](../../src/domains/system-one/engines/llm.ts) | `createSystemOneEngine`, `createLlmEngine` |
| Profiles and renderers | [profiles.ts](../../src/domains/system-one/profiles.ts), [julia-tokenizer.ts](../../src/domains/system-one/julia-tokenizer.ts) | `PROFILES`, `render`, `engineWindow` |
| Catalog hierarchy and ranking | [hierarchy.ts](../../src/domains/system-one/hierarchy.ts), [rank.ts](../../src/domains/system-one/rank.ts) | `groupByCategory`, `createRelevanceRanker` |
| Wire | [systemone-wire.ts](../../src/domains/providers/runtimes/common/systemone-wire.ts), [systemone.ts](../../src/domains/providers/runtimes/protocol/systemone.ts) | `postSystemOne`, the `systemone` runtime |
| Doctor rows | [doctor.ts](../../src/domains/lifecycle/doctor.ts) | `systemOneFindings`, `systemOneEngineFindings` |
| Sites | [turn.ts](../../src/domains/system-one/sites/turn.ts), [tool-call.ts](../../src/domains/system-one/sites/tool-call.ts), [tool-result.ts](../../src/domains/system-one/sites/tool-result.ts), [turn-end.ts](../../src/domains/system-one/sites/turn-end.ts), [relevance.ts](../../src/domains/system-one/sites/relevance.ts), [consult.ts](../../src/domains/system-one/sites/consult.ts), [drafts.ts](../../src/domains/system-one/sites/drafts.ts), [steer.ts](../../src/domains/system-one/sites/steer.ts) | `TURN_SITE`, `TOOL_CALL_CARD_SITE`, `TOOL_CALL_GATE_SITE`, `TOOL_RESULT_SITE`, `TURN_END_SITE`, `RELEVANCE_SITE`, `consultSite`, `DRAFTS_SITE`, `STEER_SITE` |
| Outcomes | [outcomes.ts](../../src/domains/system-one/outcomes.ts) | `observePermissionOutcomes`, `createFollowUpTracker`, `draftTakenOutcome` |
| Recorder | [index.ts](../../src/domains/system-one/recorder/index.ts), [dataset.ts](../../src/domains/system-one/recorder/dataset.ts) | ledger rows, dataset writer, export, `describeBindings` |
| Host | [system-one-host.ts](../../src/entry/system-one-host.ts) | `createSystemOneHost` |
| Consult tool | [consult.ts](../../src/tools/consult.ts) | `createConsultTool`, `CONSULT_LIMITS` |
| CLI | [system-one.ts](../../src/cli/system-one.ts) | `systemone status`, `systemone export` |
