# System One Architecture

System One is an experimental, opt-in seam to a fast decision model. A decision point names one object, a typed question set about it is answered by a pluggable engine, and the point's pure reader turns the answers into a typed value. Nothing runs unless `systemOne.use` names a route. The domain is `src/domains/system-one/`. This page describes the contract and its invariants. For configuration and operation, see the [System One guide](../guide/system-one.md).

## Contract in one paragraph

`SystemOne.ask(point, object, options)` is the one seam ([factory.ts](../../src/domains/system-one/factory.ts)). It walks the named routes in order and returns a `Verdict` or `null`, and `null` always means the caller behaves as if System One did not exist, so nothing in it throws ([runner.ts](../../src/domains/system-one/runner.ts)). An engine declares what it can read and where its requests go, and formation reads only that declaration, so no point or runner branch names a vendor. The types are in [types.ts](../../src/domains/system-one/types.ts): `DecisionPoint`, `Answer`, `DecisionEngine`, `EngineCapabilities`, `EngineDestination`, `Verdict` and `RouteAttempt`.

## Questions and answers

A question is one of three types ([questions.ts](../../src/domains/system-one/questions.ts)).

| Type | Criteria | Answer |
| --- | --- | --- |
| `noul` | What true and false each look like | Probability of true |
| `choice` | Option key to when it applies | Most probable key and mass per option |
| `score` | Levels from lowest to highest | Expected level and mass per level |

A question also carries answer semantics ([contract.ts](../../src/domains/system-one/contract.ts)): `boolean` for one claim about one state, `exclusive` for a choice, `ordinal` for a level, and `independent` for one item of a filter, whose number does not compete with any other item's. Every answer carries `certainty`, an engine-neutral peakedness recomputed from the mass ([answers.ts](../../src/domains/system-one/answers.ts)), and `readout`, which names what the number is: `server` (a typed wire's own value), `softmax-binary`, `softmax-exclusive`, `sigmoid-independent`, `ordinal-expectation` or `categorical` (a label with no probability scale). A readout is not a calibration claim. A missing answer is an abstention on that question alone.

## Decision points

A point declares `id`, a `version`, a hard `deadlineMs`, optional `requires` and `optional` flags, and pure functions: `state(object)` builds the bounded state or returns `null` to ask nothing, `questions(object)` gives every question about that state and `read(answers, object)` returns the typed value or `null`. There is no table of thresholds. A point that reads a yes/no uses `p >= 0.5`, the question's own boundary. Definitions live under `src/domains/system-one/points/`, with shared caps in [bounds.ts](../../src/domains/system-one/points/bounds.ts).

| Point | Asked by | Object | Deadline | Flags |
| --- | --- | --- | --- | --- |
| `consult` | The [consult tool](../../src/tools/consult.ts), questions form ([consult.ts](../../src/domains/system-one/points/consult.ts)) | The agent's state and file heads | 45 s | |
| `consult` (filter) | The consult tool, filter form | One independent yes/no per item | 45 s | |
| `judgeScreen` | The safety judge ([judge-screen.ts](../../src/domains/system-one/points/judge-screen.ts)) | One tool result as `{source, content}` | 10 s | `requires.probabilities`, `optional` |
| `triage` | The chat loop ([triage.ts](../../src/domains/system-one/points/triage.ts)) | The task, the latest reply and the queued entries | `chat.steering.triage.timeoutMs` | `optional` |

`requires.probabilities` skips a route whose engine does not declare real probabilities, before any byte leaves. `optional` means the point is not worth waiting for: a route on a destination the ask avoids or with no free endpoint slot is skipped as `busy`. Deadlines are bounds derived from the kind timeouts, not fits to recorded latency.

A filter's items live in the question head, so a point's state stays small and only ids and scores cross back to the agent. A file item is a digest read with regular expressions, because `code_nav`'s index is a built artifact a filter must not wait on. The judge screen sends one result per ask rather than one filter over four, because a bounded renderer refuses text in the question head and the approval card has to name which result fired.

## Engines

The defaults bind nothing: `systemOne.use` is null and `systemOne.engines` is empty ([defaults.ts](../../src/core/defaults.ts)). [selection.ts](../../src/domains/system-one/selection.ts) resolves each named route to an engine. The alias `jev` comes from a runtime's `decisionAlias` descriptor, mirrored in the boot manifest so a process with no hydrated providers resolves it too. A route that cannot run reports a problem and nothing borrows another route.

[engine-kinds.ts](../../src/domains/system-one/engine-kinds.ts) is the table resolution, status and the runner read. A new kind is one row there and one module under `engines/`.

| Kind | Per-route timeout | Module | How it asks |
| --- | --- | --- | --- |
| `systemone` | 5 s | [systemone.ts](../../src/domains/system-one/engines/systemone.ts) | A runtime's `decide` verb. `typesafe-jev` and `systemone` post to `POST /v1/systemone`, and `inception` posts the same `{model, state, questions}` body to `POST /v1/decisions`, answered only by `mercury-decide`. |
| `llm` | 30 s | [llm.ts](../../src/domains/system-one/engines/llm.ts), [llm-batch.ts](../../src/domains/system-one/engines/llm-batch.ts) | Every question of an ask in one schema-bound request at temperature 0. Answers are one-hot with readout `categorical`, and an abstention leaves a question unanswered. |

An engine declares `capabilities` (semantics, readout, whether its numbers are real probabilities, renderer, option bounds, window and whether that window counts per question or over the whole request) and a `destination`. A null destination sends no byte, which is what a bundled in-process model would declare. Nothing is bundled today.

The build is what the server reported on that response. A `systemone` server that reports none, or `unknown`, gets the build `<target id>/<requested model or default>`. An `llm` build names the runtime, host, reported model, fingerprint and prompt version, and a response that names no model fails the call.

Every request an `llm` engine sends passes the composition root's paid-request admission ([side-request-admission.ts](../../src/entry/side-request-admission.ts)). A request is refused once the session's spend has reached the cost ceiling, whatever the pricing of its own target, and never waits for a raise. A request to an unpriced target adds nothing to that spend. Usage is recorded under the `system-one` label. `safety.limits.sessionCostUsd: 0` means no ceiling, so `sessionCeilingReached` in [budget.ts](../../src/domains/scheduling/budget.ts) never refuses a request for cost.

A `systemone` engine's window is `engineWindow(profile, declared)` in [profiles.ts](../../src/domains/system-one/profiles.ts): the target's `capabilities.contextWindow` (or the runtime default, 480 on `systemone` and 32,000 on `typesafe-jev`) bounded by the profile's ceiling. An engine has no placement. The processor a model runs on belongs to the server behind the target.

`createSystemOne` in [factory.ts](../../src/domains/system-one/factory.ts) fixes which routes exist at startup, because `use` also decides whether the tool registers. What each name means is resolved from live settings on every ask, one engine is memoized per name and rebuilt when a digest of its configuration, target and runtime changes, and a route the settings stop naming is dropped at once.

## Capability profiles

A profile is a declared contract for a served model, not a measurement ([profiles.ts](../../src/domains/system-one/profiles.ts)). It says which answer semantics the model may be asked, the limits its publisher declares and how its numbers are read. A question outside them is abstained on with a reason before any byte leaves. A bounded renderer keeps option keys and order and abstains when a wording does not provably fit. It never cuts text to make a question fit.

| Profile | Renderer | Real probabilities | Semantics | Options | Window ceiling | Window counts |
| --- | --- | --- | --- | --- | --- | --- |
| `generic` | `systemone-v1` | no | all | 1 to 255 | none | per question |
| `jev` | `systemone-v1` | yes | all | 1 to 255 | none | whole request |
| `laya` | `systemone-v1` | yes | all | 1 to 255 | 512 | per question |
| `laya-multilingual` | `systemone-v1` | yes | all | 1 to 255 | 1024 | per question |
| `julia-1` | `julia-compact-v1` | yes | all | 2 to 20, 48 tokens each, 512-token question head | 8192 | per question |
| `gliner2.5-small` | `gliner-label-v1` | yes | `exclusive`, `independent` | 2 to 255 | none | per question |
| `gliner2.5-decide` | `gliner-label-v1` | yes | all | 2 to 255 | none | per question |
| `strands-decider` | `systemone-v1` | yes | all | 1 to 255 | 4096 | per question |
| `llm-structured` | `llm-prompt` | no | all | 1 to 255 | none | whole request |

A profile describes a model family and ships no server for it. A typed profile such as `julia-1` is answered by a `systemone` server the operator supplies, for Julia-1 an operator-run adapter, and Clio Coder ships only the client and the profile. `llm-structured` is what any chat target declares and is not chosen by hand. `generic` declares no real probabilities because nothing says what an unnamed server's numbers are. The `systemone-v1` renderer sends each question as the point wrote it, and the semantic kind and renderer revision stay in Clio Coder and are not sent. Julia-1 options are proven to fit by UTF-8 bytes until [julia-tokenizer.ts](../../src/domains/system-one/julia-tokenizer.ts) has fetched the model's tokenizer, pinned by revision and SHA-256, into the Clio Coder cache.

## Formation

[formation.ts](../../src/domains/system-one/formation.ts) is the one place a question becomes a request. It reads only what an engine declares and never truncates. A yes/no or filter item goes as a yes/no when the engine declares `independent` or `boolean`. An engine with only an exclusive choice reads it as a two-label choice per item (`match` or `other`), and the mass of `match` comes back as the yes/no, because one choice across all items would make them compete. Windows use the same estimate as the rest of the harness, one token per four characters. Under a per-question window a row too large abstains alone, and under a whole-request window a request too large is refused as `overflow`. The consult tool fits a filter to the smallest whole-request window among usable routes, so failover still has somewhere to go.

## The runner

[runner.ts](../../src/domains/system-one/runner.ts) owns everything that must hold for every engine.

1. **State.** The point builds it, and the runner redacts it once before any request exists, so every engine kind sees the same scrubbed state ([scrub.ts](../../src/domains/system-one/scrub.ts)). Question text is redacted by value too, while ids and option keys stay exact.
2. **Routes.** Routes are tried in order until one answers. One engine answers one ask, and verdicts are never merged across engines.
3. **Formation.** A route that cannot carry the ask ends as `unsupported` or `overflow`.
4. **Avoidance.** An `optional` point skips a route the caller's `avoid` names or whose endpoint has no free slot, as `busy`. The judge screen avoids the judge's own destination.
5. **Breaker.** Three consecutive timeouts on one engine configuration open a breaker for five minutes, then exactly one call probes. Only timeouts trip it. An answer or a refusal proves the engine responds and resets it. A server that answers 400 unknown model is recorded as refused, because no retry can change that, and is shown by status.
6. **Information flow.** The composition root supplies a content-blind check that judges the restrictions the evidence inherited against the engine's destination (target, runtime, URL, model). A refusal ends that route as `flow-denied` and nothing is sent. A configured check that cannot answer is not a permit. See the [information flow guide](../guide/information-flow.md).
7. **Deadline.** Each route runs under its kind's timeout inside the point's total, counted from the ask's start. A caller's own signal cancels the ask.
8. **Read.** `read` is wrapped, so an exception in a point becomes a failed ask, not a failed turn.
9. **Record.** One content-free `system_one.decided` record per ask, at kind version 2, carrying the point, question-set version, `ref`, outcome (`answered`, `failed`, `timeout`, `canceled`, `overflow`, `breaker-open`, `unsupported`, `flow-denied` or `busy`), latency, deadline, token counts, counts of questions asked and abstained, and one row per route. A kind 1 line from an older journal reads as retired. No state, question text or answer is kept, and there is no decision dataset or recorder.

## Where points are read

| Point | Reader | Degrades to |
| --- | --- | --- |
| `consult` | The `consult` tool, registered in the session registry at startup when a route is named. It waits, because the agent chose to ask. | Tool absent, or `answered: false` with a note to proceed |
| `judgeScreen` | `createJudgeScreen` in [safety-judge-host.ts](../../src/entry/safety-judge-host.ts), run beside a main-session judge round. Up to 4 newest results since the operator last spoke, read one per ask, including web and MCP capabilities called through the gateway. Finished readings are kept by call id until the operator speaks. The judge's verdict aborts a reading still running. | The judge's verdict stands |
| `triage` | `runTriageRound` in [steering-triage.ts](../../src/session-control/steering-triage.ts), detached, on a settled queue. A verdict that lands after the queue changed is dropped. | The side-model round, then the queue as the operator left it |

The screen and triage are the only harness uses. Nothing else in the turn path reads System One: no point holds up tool admission, tool-result delivery, turn settlement or prompt composition, and none adds prompt text.

## Invariants

- Unbound, Clio Coder sends no System One request and the tool registry, gateway listing and prompt are what they would be without System One.
- An ask returns a verdict or `null` and never throws into the caller.
- A verdict is advice. `consult` returns a distribution or ids with scores, and never a chosen option.
- The screen only tightens. It can turn a judge allow into a park, except under the operator-named rule, and it can never admit anything.
- A label cannot interrupt. A route without real probabilities gives a triage verdict no confidence, so a stop stays a mark, and it never reaches the screen.
- Redaction happens before the request is built.
- A request leaves only when the information-flow check allows its destination for the restrictions the evidence carries.
- Workers never receive `consult`, and the screen does not run on a worker's review.

## Source map

| Component | Source | Key contracts |
| :--- | :--- | :--- |
| Contract | [types.ts](../../src/domains/system-one/types.ts), [contract.ts](../../src/domains/system-one/contract.ts) | `DecisionPoint`, `DecisionEngine`, `SystemOne`, `Verdict`, `SemanticKind`, `ReadoutKind` |
| Questions and answers | [questions.ts](../../src/domains/system-one/questions.ts), [answers.ts](../../src/domains/system-one/answers.ts) | `yesNo`, `pick`, `rate`, `filterQuestions`, `certaintyFromMass` |
| Formation | [formation.ts](../../src/domains/system-one/formation.ts) | `formRequest`, `estimateTokens` |
| Runner and factory | [runner.ts](../../src/domains/system-one/runner.ts), [factory.ts](../../src/domains/system-one/factory.ts) | `createRunner`, `createSystemOne` |
| Engines | [engine-kinds.ts](../../src/domains/system-one/engine-kinds.ts), [systemone.ts](../../src/domains/system-one/engines/systemone.ts), [llm.ts](../../src/domains/system-one/engines/llm.ts) | `ENGINE_KINDS`, `createSystemOneEngine`, `createLlmEngine` |
| Profiles and renderers | [profiles.ts](../../src/domains/system-one/profiles.ts), [julia-tokenizer.ts](../../src/domains/system-one/julia-tokenizer.ts) | `PROFILES`, `render`, `engineWindow` |
| Points | [consult.ts](../../src/domains/system-one/points/consult.ts), [judge-screen.ts](../../src/domains/system-one/points/judge-screen.ts), [triage.ts](../../src/domains/system-one/points/triage.ts) | `consultPoint`, `consultFilterPoint`, `JUDGE_SCREEN_POINT`, `triagePoint` |
| Wire | [systemone-wire.ts](../../src/domains/providers/runtimes/common/systemone-wire.ts), [systemone.ts](../../src/domains/providers/runtimes/protocol/systemone.ts), [inception.ts](../../src/domains/providers/runtimes/cloud/inception.ts) | `postSystemOne`, `postTypedDecisions`, the `systemone` runtime, `mercury-decide` |
| Doctor rows | [doctor.ts](../../src/domains/lifecycle/doctor.ts) | `systemOneFindings`, `systemOneEngineFindings` |
| Opt-in | [selection.ts](../../src/domains/system-one/selection.ts) | `routeNames`, `resolveChoice`, `effectiveSystemOne` |
| Consult tool | [consult.ts](../../src/tools/consult.ts) | `createConsultTool`, `CONSULT_LIMITS` |
| CLI and status | [system-one.ts](../../src/cli/system-one.ts), [status.ts](../../src/domains/system-one/status.ts), [system-one-control.ts](../../src/entry/system-one-control.ts) | `systemone status`, `use`, `off`, `check`, `describeStatus`, `/usage health` |
