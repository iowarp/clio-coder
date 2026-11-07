---
title: "Run evidence, trust status, and redaction"
summary: "How a finished run's evidence is read, judged, projected for operator surfaces, and redacted. Use this page when changing trust axes, verdict tiers, run assessment, gate-review composition, provenance display, or secret redaction in src/domains/evidence."
sources:
  - "src/domains/evidence/index.ts"
  - "src/domains/evidence/trust-status.ts"
  - "src/domains/evidence/trust-projection.ts"
  - "src/domains/evidence/run-trust.ts"
  - "src/domains/evidence/assessment.ts"
  - "src/domains/evidence/redact.ts"
  - "src/domains/evidence/run-evidence.ts"
  - "src/domains/evidence/provenance.ts"
symbols:
  - "composeTrustStatus"
  - "adaptRunTrustStatus"
  - "inspectRunTrustStatus"
  - "adaptGateDecisionReviewStatus"
  - "trustVerdict"
  - "summarizeTrustStatus"
  - "formatTrustSummaryLine"
  - "readRunTrust"
  - "assessRun"
  - "runEvidence"
  - "admitRunProvenance"
  - "redactSecretsText"
  - "redactSecretsDeep"
  - "redactKnownSecrets"
tests:
  - "tests/extended/evidence-integrity.test.ts"
  - "tests/contracts/evidence-tool.test.ts"
invariants:
  - "A canonical trust status has exactly five axes (artifactIntegrity, validationGrounding, independentReview, contextProvenance, completionEvidence); normalization rejects unknown or missing fields and any state not in the axis vocabulary."
  - "A compatibility source may only establish unknown or not_applicable; normalization rejects any other state from that source."
  - "Run validation and context axes are read only when the run seal verifies; an unsealed or failed run reads them as absent with reason not_observed."
  - "trustVerdict returns compromised whenever integrity failed, validation failed or ungrounded, review failed or not_independent, or context invalid, regardless of other axes."
  - "Provenance (pipeline, persona override, escalation counts) is shown only when the artifactIntegrity axis is verified, or when no status is supplied to admitRunProvenance."
  - "redactSecretsDeep replaces credential-shaped substrings with [redacted:<kind>] and tallies each replacement; plain prose such as 'a bearer credential is required' is left unchanged."
  - "Gate review verdicts compose over a sealed assessment only when the gate's subject digest equals the sealed run.settled digest; a mismatched digest is not admitted as that run's review."
validate:
  - "pnpm run test:file -- tests/extended/evidence-integrity.test.ts"
  - "pnpm run typecheck"
---

# Run evidence, trust status, and redaction

This area turns a finished run into an inspectable record. It decides which claims about a run are established, how those claims are named for operators, which runs are shown as trustworthy, what provenance a run may display, and how secret-shaped text is removed before it leaves the process. Read this page before changing any trust axis, verdict tier, assessment finding, gate review composition, or redaction pattern.

## What the area does

The area has four cooperating layers:

1. **Canonical trust model** (`src/domains/evidence/trust-status.ts`). A run's trust is a `CanonicalTrustStatus` with five axes: `artifactIntegrity`, `validationGrounding`, `independentReview`, `contextProvenance`, and `completionEvidence`. Each axis is either `absent` with a reason, or an attributed state carrying a `source`, an `authority`, and up to 16 typed artifact references. The model deliberately has no score and no overall verdict.
2. **Projection** (`src/domains/evidence/trust-projection.ts`). Operator and machine surfaces read the canonical model only through this module. It fixes the words for each state, the clause order of the human summary, a four-level verdict tier, and a bounded machine record.
3. **Run assessment and reads** (`src/domains/evidence/assessment.ts`, `src/domains/evidence/run-trust.ts`, `src/domains/evidence/run-evidence.ts`). `assessRun` judges a run once after it settles and produces journaled data. `readRunTrust` and `runEvidence` read that sealed assessment back, composing later gate reviews over it when they cite the run's settlement digest.
4. **Provenance and redaction** (`src/domains/evidence/provenance.ts`, `src/domains/evidence/redact.ts`). Provenance is the pipeline, persona-override, and escalation facts of a receipt, shown only under a verified seal. Redaction removes secret-shaped values by pattern and, for known values, by exact match.

`src/domains/evidence/index.ts` re-exports the public surface of these modules. Consumers import from `src/domains/evidence/index.ts` or from the specific module.

## Trust axes and their composition

`TRUST_STATUS_AXES` and `TRUST_STATUS_STATES` come from `src/core/telemetry/trust-vocabulary.ts`. `src/domains/evidence/trust-status.ts` builds on them with per-axis allowed states and per-axis allowed source kinds (`AXIS_SOURCES`), plus allowed authority kinds per source kind (`SOURCE_AUTHORITIES`).

`composeTrustStatus(...projections)` starts every axis at `absent` with reason `not_recorded`, then copies each defined axis from each projection in order. A later projection replaces an earlier one on the same axis only. The result is passed through `normalizeTrustStatus`, so the composed output is validated again.

`normalizeTrustStatus` and `validateTrustStatus` are the boundary for persisted or extension input. The former throws on any structural violation; the latter returns `{ ok: false, reason }` instead. Normalization enforces these conditions in `normalizeAttributedStatus`:

- `source` must have exactly the keys `kind` and `id`, and the source kind must be allowed for that axis.
- `authority.kind` must be allowed for the source kind.
- A `compatibility` source may only establish `unknown` or `not_applicable`; any other state throws.
- Artifact references are bounded to `TRUST_STATUS_MAX_ARTIFACT_REFERENCES` (16), are sorted, and duplicates throw.
- Identifiers are bounded to `TRUST_STATUS_MAX_IDENTIFIER_LENGTH` (512) and may not contain control characters.

Digests are restricted to SHA-256 hex strings, and `normalizeAttributedStatus` normalizes `gate_decision` authority ids through `normalizeYoloGateAuthority`.

## Building a run's trust

`adaptRunTrustStatus(facts, integrity)` builds a run's status from its settled facts (`RunTrustFacts`: the `run.settled` fields plus `runId` and `digest`). If `facts` is null, every axis is `absent` with `artifact_missing`. When `integrity.state` is `verified`, the validation and context axes are read from the facts. Otherwise they are `absent` with `not_observed`. Independent review and completion evidence are `absent` with `not_recorded` at this level; later steps fill them in.

Validation is decided in `runValidationStatus` in a fixed priority order. The first matching branch wins:

1. A host verification with status `rejected`. If every failing check also failed on the task base, the result is `unknown` under authority `host-verification-baseline-failed`; otherwise it is `failed`.
2. Host verification `verified` gives `validated`. `not_implicated` gives `unknown`.
3. Observed command results (typed validations whose source id carries `OBSERVED_COMMAND_PREFIX`) decide `failed` or `validated` under authority `host-observed-command`, unless the settled quality fails for a reason other than those commands.
4. Settled quality failures give `failed` under `result-quality`.
5. A grounding record with basis `no-command-executed` and ungrounded claims gives `ungrounded`.
6. Settled quality validating gives `validated`.
7. The descriptive `verification` marker: `verified` gives `validated`, `unverified` gives `absent`, `not_applicable` gives `not_applicable`, and anything else gives `unknown`.

Context provenance is read in `runContextStatus` from the settled `contextProvenance` verdict and from hash records whose subjects map to `briefing`, `worker_context`, or `project_context` artifacts.

`inspectRunTrustStatus(record)` is the read-model entry. It takes a `RunTelemetryV1`-shaped `{ row, settled, seal }` and returns `{ integrity, status }`. A scope whose seal failed keeps a `failed` integrity even when `settled` is missing; its validation and context axes are `absent`.

`runIntegrityOfSeal` maps the seal verdict to `RunIntegrity`: `verified` (by `seal`), `unsealed` (with a reason), or `failed` (with a mismatch description from `describeSealMismatch`).

## Gate reviews

`adaptGateDecisionReviewStatus(gate, subjectRunId, verification)` maps one `gate.decided` fact to an `independentReview` state for one subject run.

- No gate: `absent` with `artifact_missing`.
- The gate has no subject for this run: `absent` with `not_recorded`.
- Verification is missing or not ok: `unknown`, with `unauthenticated-gate-artifact` authority if verification was supplied and failed, or the historical compatibility authority if it was not supplied.
- No `decider` or no `independent` field: `not_applicable` for operator-confirmed or YOLO-applied outcomes, otherwise `inconclusive`.
- `independent === false`: `not_independent`.
- Outcome `pass` gives `passed`, `fail` gives `failed`, and `winner` gives `passed` only when the winner is this run.

`readRunTrust` in `src/domains/evidence/run-trust.ts` composes gate reviews over the sealed assessment. Only gates whose subject digest equals the sealed `run.settled` digest are admitted, and each decision is applied once. The seal's integrity replaces the producer's integrity in the composed status. When a later review changes the independent-review state, the sealed independent-review finding is replaced by one produced from `reviewFinding`.

`readGateReviews` and `readRunGateIndex` gather gate facts from sealed scopes. `gateReviewsOf` follows the run's `parentRunId` chain up to `MAX_LINEAGE` (32) and reads the sessions the run and its ancestors belong to. A run whose own scope does not verify has no admitted lineage. The code comment states that gate artifact files are not a source here.

## Assessment

`assessRun(runId, input)` in `src/domains/evidence/assessment.ts` takes the run's journal records, an optional `RunAssessmentContext`, the gate reviews naming the run, and an optional decision map. It returns `null` when the journal has no `run.settled` record. Otherwise it:

- Chooses the latest `run.settled` by timestamp and computes its digest with `runSettledDigest`.
- Builds the initial trust with integrity `{ state: "verified", by: "producer" }`. The comment states the seal later supplies the authoritative integrity.
- Composes completion evidence from the latest `completion.evaluated` record at or before settlement.
- For each gate whose subject names this run, checks the subject digest against the run digest. A mismatch produces an unverified gate that yields `unknown` review under the mismatch reason. Each gate's review is composed in.
- Produces findings through `runFindings`, then adds one `context-provenance` finding per decision ref, `info` when it resolves and `warn` when it does not.
- Sets `firstPassSuccess` only when the outcome succeeded, the attempt is 0, and no `no-validation` finding exists.
- Attributes failure cause through `attributeEvidenceFailure` when the exit code is non-zero.

`runFindings` raises these finding tags, among others: `no-validation`, `proxy-validation`, `blocked-tool`, `escalation`, `external-bypass`, `context-provenance`, `completion-evidence`, and a failure-cause tag. Each has a fixed severity. The `external-bypass` finding is raised when the settled `toolGovernance` is `agent-managed`.

`gatherRunAssessment` is the async wrapper that reads gate decisions via `readGateReviews` and the session's active decision path via `activeDecisions` before calling `assessRun`. Read failures are caught, and the affected part is left unresolved.

## Verdict tiers and projection

`trustVerdict(status)` in `src/domains/evidence/trust-projection.ts` returns one of `reviewed`, `grounded`, `unverified`, `compromised`, or `unknown`. The checks run in this order (read from source; no focused test asserts the full ordering directly):

1. `compromised` if integrity is `failed`, validation is `failed` or `ungrounded`, review is `failed` or `not_independent`, or context is `invalid`.
2. `unknown` if integrity is not `verified`.
3. `reviewed` if review is `passed`.
4. `grounded` if validation is `validated`.
5. Otherwise `unverified`.

`formatTrustSummary` joins five clauses with `"; "` in a fixed order: integrity, validation, independent review, context, completion. Word choices come from `TRUST_STATE_WORDS`. `trustStateWord` falls back to the `unknown` word for an unrecognized state. `validationClause` names the claimant for validated and failed states. `formatTrustSummaryLine` prefixes the verdict word and `trust v1:`.

`summarizeTrustStatus` returns a `TrustSummaryProjection` containing version, verdict, text, axis states, a `claimant` string, the list of unanswered axes (absent or unknown), and up to `TRUST_SUMMARY_MAX_REFS` (8) sorted `<kind>:<id>` references.

The compromised tier is exercised indirectly by `tests/contracts/evidence-tool.test.ts`, which imports `evidenceDetailSnapshot` from `src/domains/evidence/detail.ts`; its case `withholds a tampered run's facts and ungrounded counts` runs a tampered fixture and asserts `evidenceDetailSnapshot("fixture").verdict` equals `compromised` and that a `run-seal` finding is present. That case does not isolate the other tiers or the clause order of `formatTrustSummary`.

Callers in the repository include `src/cli/fleet-view.ts` (`formatTrustSummaryLine`), `src/tools/monitor.ts` and `src/tools/dispatch-runner.ts` (`summarizeTrustStatus`), `src/interactive/exit-summary-collector.ts` (`summarizeTrustStatus(...).verdict`), and `src/domains/session/view-artifacts.ts` (`formatTrustSummaryLine`, `trustStateWord`).

## Provenance

`extractRunProvenance(receipt)` reads optional `pipeline`, `personaOverride`, and escalation counts from a receipt-shaped object. `escalationCountsFrom` returns `null` unless `safety.decisions.escalationRequested` is defined; missing counters default to zero.

`admitRunProvenance(view, status?)` returns the view unchanged only when `status` is undefined or its `artifactIntegrity.state` is `verified`. Otherwise it returns `{}`. The focused test in `tests/extended/evidence-integrity.test.ts` asserts this: an unsealed status from `inspectRunTrustStatus(null)` admits an empty object for a view containing a pipeline and a persona override.

`provenanceTranscriptLines` and `provenanceCompactSuffix` render admitted fields. The persona prompt hash is clipped to `PERSONA_HASH_PREFIX_CHARS` (12) characters followed by `...`.

## Redaction

`src/domains/evidence/redact.ts` defines a `RedactionTally` counter and a fixed list of value-shaped patterns in `SECRET_PATTERNS`: URL userinfo (shared with display redaction through `URL_USERINFO_RE` from `src/domains/safety/redaction.ts`), PEM private key blocks, AWS access keys, GitHub tokens, `sk-` keys, Slack tokens, Google API keys, GitLab tokens, Slack and Discord webhook URLs, Telegram bot tokens, AWS secret keys (with a randomness check), JWTs, `authorization` headers or scheme values, and a generic key/token/secret/password assignment.

`redactSecretsText(text, tally, options?)` applies each pattern in order. URL userinfo is replaced only when `urlUserinfoHoldsSecret` confirms the value. For the `assignment`, `authorization`, and `jwt` kinds, the key, separator, or leading run is kept and only the value is replaced. An optional `keepAssignmentValue` callback can keep an assignment value.

`redactSecretsDeep` walks strings, arrays, and plain objects. `secretRedactingReplacer` is a `JSON.stringify` replacer that also redacts the whole value of a property whose name matches a credential word.

`redactKnownSecrets(text, values)` replaces exact occurrences of known values, longest first, and only values at least `KNOWN_SECRET_MIN_LENGTH` (8) characters long. The regex is cached on the joined value set.

`redactSecretSegments(segments, tally)` applies the same patterns across display-frame boundaries by matching the joined string and mapping ranges back to segments.

The focused tests in `tests/extended/evidence-integrity.test.ts` exercise `redactSecretsDeep` with these inputs:

- An `Authorization: Bearer` header holding an opaque canary token, a prose sentence `sent bearer abcdef123456 upstream`, and a reference `Authorization: Bearer $TOKEN`. The header and scheme are redacted, the variable reference and the prose sentence `a bearer credential is required` are unchanged, and the tally is 2.
- A GitHub token `ghp_...` inside prose and `API_KEY=hunter2hunter2hunter2`. Both are removed, the clean string is unchanged, and the tally is 2.

Callers that redact include `src/tools/result-disposition.ts`, `src/tools/consult.ts`, `src/tools/dispatch-run-events.ts`, `src/domains/memory/secret-text.ts`, and `src/tools/bash.ts` (through `redactKnownSecrets`).

## Run evidence reads

`runEvidence(runId, record, gates)` in `src/domains/evidence/run-evidence.ts` builds a `RunEvidence` from `readRunTrust`. When integrity is not verified, it adds a `run-seal` finding (`warn` for failed, `info` otherwise). It copies the sealed assessment's findings, decisions, and provenance only when the assessment exists. It fills `totals` and `settled` only when the seal verifies and settlement exists.

`inspectRunEvidence(stateDir, runId)` reads the run record and its gate index. `listRunEvidence(stateDir, skip?)` lists runs under the telemetry runs directory with `listStateDirectory`, sorts them by settlement time newest first, and skips unreadable scopes.

## Coverage notes

The gate-review digest check in `assessRun` (`src/domains/evidence/assessment.ts`) and in `readRunTrust` (`src/domains/evidence/run-trust.ts`) was read from source. The search of `tests/` for the mismatch reason string `gate subject run digest mismatched` and for `digest mismatched` found no focused case, so the mismatch branch is described from source only.

## Things to watch when editing

- Trust axis states, source kinds, and authority kinds are defined in `src/core/telemetry/trust-vocabulary.ts`. Adding a state requires a matching entry in the word table in `src/domains/evidence/trust-projection.ts`, which is typed against `TRUST_STATUS_STATES`.
- `trustVerdict` and `trustVerdictWord` decide what an operator sees first. Changing their branch order changes which axis the compromised word names.
- `assessRun` uses the producer's integrity, and `readRunTrust` replaces it with the seal's integrity. A change that reads integrity from the producer alone would lose the seal's authority.
- Redaction patterns must stay linear in their input, as the file header states, because redaction runs synchronously during live turns.
- The gate-review digest check is what prevents a decision about one settlement from composing over another. Removing it would change which reviews a run shows.

## Decisions

No recorded decision refs were supplied to this page, so none are cited.
