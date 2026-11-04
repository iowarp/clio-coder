---
title: "Safety gates, admission and the safety judge"
summary: "How Clio Coder decides whether a tool call runs, asks, or is refused: the policy engine's net verdict, the shared admission evaluator, the safety judge at default autonomy, and the finish contract. Read this before changing any gate, autonomy level, or the judge."
sources:
  - "src/domains/safety/index.ts"
  - "src/domains/safety/policy-engine.ts"
  - "src/domains/safety/admission.ts"
  - "src/domains/safety/safety-judge.ts"
  - "src/domains/safety/finish-contract.ts"
symbols:
  - "evaluateAdmission"
  - "createSafetyPolicyEngine"
  - "createSafetyJudge"
  - "assessFinishContract"
  - "AdmissionDisposition"
  - "OperatorYoloScope"
  - "OperatorDefaultScope"
tests:
  - "tests/contracts/safety-gates.test.ts"
  - "tests/contracts/safety-judge.test.ts"
  - "tests/contracts/finish-contract-limitation.test.ts"
invariants:
  - "A hard block from the policy engine on any capability or effect denies the whole call before any ask or allow elsewhere is considered, as implemented in evaluateAdmission step 1."
  - "A worker's main-issued grant discharges only an ordinary worker autonomy ask; a safety-net or tool-confirmation rail returns an operator-approval ask that a main grant cannot clear."
  - "Under the operator's yolo scope with no authorization, evaluateAdmission returns allow after the hard limits, without consulting confirmation rails or autonomy mapping."
  - "The finish contract's decision uses receipts in the recent window only; a limitation receipt that is an errored tool result does not settle the contract."
  - "The safety judge returns a park with a no-verdict cause when it has no route, times out, is aborted, errors, or returns unparsable output; it never returns a verdict it did not parse."
validate:
  - "pnpm run test:file tests/contracts/safety-gates.test.ts"
  - "pnpm run test:file tests/contracts/safety-judge.test.ts"
  - "pnpm run test:file tests/contracts/finish-contract-limitation.test.ts"
---

# Safety gates, admission and the safety judge

This area decides, for every tool call, whether it runs, is parked for a person or for the main agent, or is refused. A reader needs it when changing a permission rule, an autonomy level, the path or command policy, the judge's behavior, or the end-of-turn validation gate.

## What this area does

Four cooperating layers make the decision:

1. The policy engine (`src/domains/safety/policy-engine.ts`) judges one call at a time and returns a net verdict of `allow`, `ask`, or `block`, together with classification, reason code and policy metadata.
2. The admission evaluator (`src/domains/safety/admission.ts`, `evaluateAdmission`) combines the net verdicts of a call's capability and effects, applies hard permit limits, confirmation rails and autonomy mapping, and returns an `AdmissionDisposition` of `allow`, `deny`, or `ask`. The module header states that native registry admission, the Claude SDK bridge and the ACP mediator all decide through this one evaluator.
3. The safety judge (`src/domains/safety/safety-judge.ts`, `createSafetyJudge`) is a model-based reviewer consulted for asks at default autonomy.
4. The finish contract (`src/domains/safety/finish-contract.ts`, `assessFinishContract`) decides, at turn end, whether a turn that mutated the workspace recorded validation evidence or a limitation receipt.

`src/domains/safety/index.ts` is the domain entry. It exports `SafetyDomainModule`, which pairs `SafetyManifest` with `createSafetyBundle` from `extension.ts`, and re-exports the autonomy, finish-contract, information-flow, path-policy, rigor and validation-contract surfaces. Among its importers are the CLI entries and the orchestrator under `src/entry/`.

## Policy engine

`createSafetyPolicyEngine(options)` builds an engine bound to a workspace cwd. Its options carry rule packs, a project policy, write roots and read-exempt roots. The returned `SafetyPolicyEngine` exposes `evaluate(call, posture?, scope?)`, `readablePath`, `writeTargetViolation`, `metadata`, `informationFlow` and `flowRestrictionsFor`.

The engine's own construction is central to its behavior. At build time it resolves the cwd's git control paths, reads the project policy and gates it through trust, compiles the path policy with Clio's credential store and skills root added as zero-access and read-only entries, and sources base damage-control rules once. Those are the inputs every later `evaluate` call uses.

The `scope` argument to `evaluate` is an `OperatorScope`: either `OperatorYoloScope` (`level: "yolo"`) or `OperatorDefaultScope` (`level: "default"`, with `sandbox` and `snapshots` booleans). Its interface comments describe what each scope changes. Under yolo, only the floor, operator-authored rules and run ceilings block, and nothing asks. Under default, the floor and path and authority rails still block, former damage-control blocks ask, and contained shell calls run without the asks their command text would raise. The `SafetyPolicyDecision` interface records `shellSandbox`, `recoverable`, `runsWorkspaceCode`, `readScope` and `gitControl` on decisions that a later step reads.

## Admission: the shared evaluator

`evaluateAdmission(input: AdmissionInput)` is the single decision function. Its input carries the `principal` (`"main"` or `"worker"`), the `effects` array (each a `ClassifierCall`, required to be non-empty), an optional `capability`, an explicit absolute `cwd`, the `safety` port, the autonomy level, the operator's scope objects, constraints, an optional `authorization` and the `hookDrift` guard.

Its branch order, read from the source, is:

1. The cwd must be absolute. A relative cwd returns a `context` deny.
2. Every effect is evaluated through `input.safety.evaluate`. A `block` on the capability or any effect returns a `safety_net` deny immediately. An empty effects list returns a `no_effects` deny.
3. Hard permit limits: a read-only run denies any call that is not a pure read, any confirmation rail, any outside-workspace read, any net ask, or a skill activation (`read_only`). A tool outside the turn's or run's allowed tools denies with `tool_scope`. Skill-disabled and skill-surface checks deny with `skills_disabled` and `skill_surface`.
4. Under true yolo (`operatorYolo` defined), the function returns `allow` at this point. The comment in the source says no confirmation rail, Git allowance or autonomy mapping asks at that level.
5. If the operator's default scope is set and the hook-drift guard reports a changed git hook for a call that runs hooks outside the sandbox, the call becomes an operator-only `git-hooks-changed` ask.
6. Confirmation rails. A net ask becomes a `safety-net` ask with `approvalAuthority: "operator"`. A `confirmationRuleId` becomes a `tool-confirmation` ask. Only an operator authorization for the same action class clears these.
7. A `git_destructive` effect that is not a snapshot-recoverable discard is either asked (under the operator's default scope, through a `safety-net` ask) or denied with `git_destructive`.
8. Autonomy mapping, per effect, in order. For a worker, `workerGitObligation` decides Git effects by the permit's Git allowance. Under the operator's default, snapshot-recoverable effects and contained effects are skipped. A worker's typed write to a git control path asks the main agent. Otherwise `mapAutonomy(level, actionClass, options)` decides; `allow` continues, and `ask` becomes an `autonomy` ask whose authority is `main` for a worker and `operator` for the main agent.
9. If every effect passes, the function returns `allow`, with `authorized` set when a main grant was honored.

The `authorization` argument is a structured `AdmissionAuthorization` with an `issuer` (`"main"` or `"operator"`) and an `actionClass`. The source notes that an authorization covers only the same action class, and that a `main` issuer does not clear operator rails.

Admission is exercised through the registry. The focused test `tests/contracts/safety-gates.test.ts`, case "keeps a safety-net confirmation rail operator-only so a main-issued grant cannot clear it", builds a worker registry at default autonomy and invokes `gcloud iam policies list` through bash. It asserts the park has `approvalAuthority` `"operator"`, that a `main` grant leaves the call parked with `executed` at 0, and that `evaluateAdmission` gives `ask` with `operator` authority for that call. For an ordinary worker call `frobnicate --all`, it asserts the ask is `autonomy:main`, and that a `main` grant for `execute` yields `allow`. A main-principal call to the same ordinary command asks with `operator` authority.

The yolo case in the same file, "yolo clears ordinary confirmation rails while damage control still decides", covers the other side of the same boundary (test body not read in full for this page).

## Safety judge

`createSafetyJudge(deps)` returns a `SafetyJudgeSeat` with a `review(subject)` method. It is consulted for an ask, not for every call. `review` returns `{ kind: "skip" }` when the judge is disabled in config or when `operatorOnlyAsk(subject)` applies. Otherwise it builds a prompt from operator messages, call arguments and consequence sentences, and calls `deps.complete` with `SAFETY_JUDGE_SCHEMA`, under a timeout (`SAFETY_JUDGE_TIMEOUT_MS`) and an output-token cap.

The outcomes are:

- No route (`config.target` null): `noVerdict("no-route")`, which parks.
- Timeout, abort, or error from `complete`: `noVerdict` with cause `timeout`, `aborted` or `error`, which parks.
- Output that `parseSafetyJudgeAnswer` cannot parse: `noVerdict("unparsable")`, which parks.
- Escalation state: after repeated blocks (`SAFETY_JUDGE_CONSECUTIVE_BLOCKS`, `SAFETY_JUDGE_TOTAL_BLOCKS`), the judge parks with `escalated` and does not consult again for that session.

Session state (consecutive and total block counts) resets when the session identifier changes. Journal and transcript hooks are wrapped so a failing `record` or `note` cannot change a verdict.

Focused test `tests/contracts/safety-judge.test.ts` covers this through the registry. Its case "an allow runs the call without parking it" stubs the judge with `answer("allow", "operator-named", ...)` and an unrecognized bash command, and asserts `verdict.kind` is `"ok"`, the command ran once and no park occurred. Its case "a block returns the judge's refusal and never parks or runs" stubs `answer("block", "publish", ...)` and asserts `verdict.kind` is `"blocked"`, `verdict.denial?.code` is `"safety-judge:publish"`, and nothing ran or parked. Later cases in the same file assert park counts, the number of prompts across repeated asks, and operator-message bounding.

Judge configuration is read through `resolveSafetyJudgeConfig(settings)`. `tests/contracts/safety-judge.test.ts` also asserts the `safety.judge` settings shape with an `allow` list and a `deny` list. The `allow` and `deny` lists are read as operator-authored rules.

## Finish contract

`assessFinishContract(input)` is a pure function over session ledger entries. Its doc comment fixes the decision order:

1. No mutating receipt in the recent window gives `ok` with `no_mutation`.
2. Validation evidence present gives `ok` with `validation_evidence` and a bounded scope advisory.
3. A successful `limitation` receipt gives `ok` with `explicit_limitation`.
4. Prose-only writes or only non-source removals give `ok` with `prose_only` or `deletion_only`.
5. Otherwise the result is `engage` with `unvalidated_mutation`, carrying `FINISH_CONTRACT_ADVISORY_MESSAGE`.

The window is capped by `DEFAULT_RECENT_ENTRY_LIMIT` (80 entries since the last user message). The source says the assistant's prose does not enter the decision.

Focused test `tests/contracts/finish-contract-limitation.test.ts` covers this. Its case "engages on prose such as 'not verified' when no limitation receipt exists" builds a mutation window followed by an assistant message reading "Edited src/thing.ts. Tests: not run. This change is not verified and could not be tested.", and asserts `kind` `engage` with reason `unvalidated_mutation`. Its case "still engages when the limitation call errored, so a rejected call leaves no receipt" asserts `engage` when the limitation tool result is an error. Its case "settles ok/explicit_limitation on a mutation plus a successful limitation receipt" asserts `ok`, with the evidence kind `limitation`.

## Things to watch when editing

- The autonomy level for a worker is taken from `workerExecuteAutonomy` only when it is `"yolo"`. Otherwise it is the default level. Main-principal autonomy comes from `input.autonomy`.
- Under true yolo, `evaluateAdmission` returns `allow` before the confirmation rails, Git allowance and autonomy mapping. Any new rail intended to ask under yolo must be placed before that return.
- `authorization.issuer` decides which rails a grant clears. Changing the `covers` or `authorized` logic in `evaluateAdmission` changes what an operator or main grant can discharge; the safety-gates test case above is the existing check on that boundary.
- The policy engine caches resolved git controls and recomputes them only after a call that may have rewritten git config (`gitControlsStale`). Changes to that path affect typed-write admission for workers.
- The judge's escalation counters and the finish contract's window both have fixed limits. Changing them changes when a session stops consulting the judge or which receipts count.
- Decision records referenced by the code were not inspected for this page, so no decision references are cited here.

## Coverage and limits of this page

The focused tests named above were read at the case level, but the bodies of several cases (for example the yolo case in `tests/contracts/safety-gates.test.ts`) were not read in full. The policy engine's evaluate body (`evaluateBashPolicy` and its path rails) and `mapAutonomy` in `autonomy.ts` were outlined but not traced line by line. Protected-artifact detection (`protected-artifacts.ts`), command consequence descriptions (`src/domains/safety/command-consequence.ts`) and information-flow compilation (`src/domains/safety/information-flow.ts`) are described here only at the level of their exported names. Their owning pages should be consulted for detail.
