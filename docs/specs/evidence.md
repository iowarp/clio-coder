# Evidence Corpus Builder

Date: 2026-04-29
Status: shipped in v0.1.4

## Goal

The evidence domain normalizes existing receipts, run ledger entries, session JSONL, audit JSONL, and eval artifacts into a single inspectable evidence corpus per source. Each corpus is a directory keyed by a deterministic `evidenceId` and contains a stable JSON overview, a Markdown transcript, raw and cleaned trace files, linked tool events, linked audit rows, copied receipts, and a tagged findings file. v0.1.4 ships a deterministic, model-free build path; no summarization calls are made. The CLI surface is `clio evidence build`, `clio evidence inspect`, and `clio evidence list`.

## Data layout

Each evidence corpus lives under:

```
<dataDir>/evidence/<evidenceId>/
  overview.json
  transcript.md
  trace.raw.jsonl
  trace.cleaned.jsonl
  tool-events.jsonl
  audit-linked.jsonl
  receipt.json
  findings.json
  findings.md
  protected-artifacts.json   # only when protection events were recorded
```

Inputs are read from the standard XDG layout: `<dataDir>/receipts/<runId>.json`, `<dataDir>/state/runs.json`, `<dataDir>/sessions/<sessionId>.jsonl`, and `<dataDir>/audit/YYYY-MM-DD.jsonl`. Eval-sourced corpora additionally read the persisted artifact at `<dataDir>/eval/<evalId>/artifact.json`. The builder strips or truncates very large outputs and preserves command, exit code, duration, blocked status, and validation hints.

## Public CLI surface

- `clio evidence build --run <runId>` builds a corpus rooted at one run id. It locates the run envelope in the run ledger, the matching receipt, and any session entries or audit rows that reference the run id.
- `clio evidence build --session <sessionId>` builds a corpus rooted at a session id. It collects every run that wrote into the session and links them through the session entry stream.
- `clio evidence build --eval <evalId>` rebuilds a corpus from a persisted eval artifact. It is the same path the `clio eval run` flow takes after each suite finishes.
- `clio evidence inspect <evidenceId>` prints the overview block: source kind and id, generation timestamp, run count, receipt count, tool-call total, blocked-tool total, tag list, finding count, and emitted file list.
- `clio evidence list` prints one row per persisted corpus with id, source descriptor, run count, and tag list.

Build accepts exactly one of `--run`, `--session`, or `--eval`; multiple selectors are rejected at parse time.

## Public types

Types live in `src/domains/evidence/types.ts` and are re-exported from `src/domains/evidence/index.ts`.

- `EvidenceSource` is a discriminated union over `{ kind: "run" | "session" | "eval"; <id> }`.
- `EvidenceOverview` carries `version: 1`, `evidenceId`, `source`, `generatedAt`, run/session/agent/endpoint/runtime/model id arrays, status and timestamp ranges, an `EvidenceTotals` block, the active `EvidenceTag[]`, and the file list emitted into the directory.
- `EvidenceTotals` carries 13 deterministic counters: `runs`, `receipts`, `toolCalls`, `toolErrors`, `blockedToolCalls`, `sessionEntries`, `auditRows`, `toolEvents`, `linkedToolEvents`, `protectedArtifacts`, `tokens`, `costUsd`, `wallTimeMs`.
- `EvidenceFinding` carries `id`, `severity` (`info` or `warn`), `tag`, optional `runId`, and a one-sentence `message`. Findings are persisted in `findings.json` and rendered in `findings.md`.
- `EvidenceTag` enumerates the failure taxonomy plus link-quality tags. The closed list is: `audit-linked`, `audit-missing`, `best-effort-link`, `timeout`, `context-overflow`, `provider-transient`, `missing-dependency`, `wrong-runtime`, `proxy-validation`, `no-validation`, `destructive-cleanup`, `blocked-tool`, `protected-artifact`, `tool-loop`, `test-failure`, `build-failure`, `cwd-missing`, `session-linked`, `session-missing`, `auth-failure`, `unknown`.
- `EvidenceToolEvent` carries normalized tool-call rows with `source` (`session-entry`, `audit-row`, `receipt-aggregate`, `eval-command`), counts, durations, optional link metadata, and capped argument and result previews.
- `EvidenceAuditLinkedRow` carries the resolved audit row plus `linkKind`, `confidence` (`exact` or `best-effort`), and the reasons used to link the row.
- `EvidenceProtectedArtifactsFile` carries the persisted protection state and event log when the source session recorded any.

## Invariants

1. The build path is deterministic and model-free. Two invocations against the same inputs produce byte-identical files.
2. Evidence ids are derived from the source kind and id; the same source always produces the same `evidenceId` so rebuilds overwrite the previous corpus.
3. Tool events are linked back to a run id by exact match (run id, tool call id, timestamp) when available; otherwise a `best-effort-link` confidence is recorded and the row is tagged.
4. Audit rows that cannot be linked to any run id are still preserved with an `audit-missing` tag instead of being dropped.
5. Findings are tagged using the closed `EvidenceTag` enumeration; new failure classes require a tag enum entry.
6. Receipt copies in `receipt.json` carry the original receipt verbatim, including the integrity hash. Truncation only happens in the cleaned trace and previews.
7. Protected-artifact events are only emitted when the source session contains protection entries. Their absence is not an error.

## Status and scope notes

v0.1.4 ships the deterministic builder, the inspect and list commands, the eval rebuild path, and the protected-artifacts export. No model summarization is performed. The taxonomy is closed: adding a tag requires editing `EVIDENCE_TAGS` and re-running the suite. Cross-corpus aggregation is the M9 `memory-curator` and `attributor` recipes' job; the evidence domain itself reports per-source numbers only.

## References

- `src/domains/evidence/types.ts`: type surface.
- `src/domains/evidence/build.ts`: builder for run-rooted and session-rooted corpora.
- `src/domains/evidence/eval.ts`: builder for eval-rooted corpora.
- `src/domains/evidence/store.ts`: filesystem layout and inspect/list helpers.
- `src/domains/evidence/index.ts`: public domain entry.
- `src/cli/evidence.ts`: CLI wiring.
- `tests/unit/evidence-builder.test.ts`, `tests/unit/eval-evidence.test.ts`: regression coverage.
- `docs/.superpowers/IMPROVE.md` section M3: roadmap entry.
