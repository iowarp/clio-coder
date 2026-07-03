# Evidence Corpus and Long-Term Memory

> [!TIP]
> **Interactive Spec Available:** An interactive memory lifecycle dashboard and simulator is located at [docs/html/memory_blueprint.html](html/memory_blueprint.html) (Version: 0.2.7). Use it to design, validate, and simulate memory proposals, approval loops, pruning rules, and token budgets.

Clio Coder treats run claims and agent lessons as structured artifacts to support reproducibility and scientific provenance. In evaluations such as [SWE-bench](https://www.swebench.com), capturing granular execution evidence is essential for validating agent claims. Evidence corpora are deterministic directories built from run ledgers, receipts, sessions, audits, and eval artifacts. In v0.2.7, forensic evidence auto-builds on dispatch run completion: when a run finalizes, the observability domain automatically compiles the evidence bundle under `<dataDir>/evidence/run-<id>/` and updates a compact sidecar index row in `<stateDir>/evidence-index.json`. Long-term memory records are local, evidence-linked, and only injected after explicit approval. Use the TUI [`/view`](observability.md) command for interactive inspection of receipts, dispatch output, durable tool output, compaction summaries, and session accountability before building or citing evidence.

Source of truth: `src/domains/evidence/**`, `src/domains/memory/**`, `src/cli/evidence.ts`, and `src/cli/memory.ts`.

---

## Evidence CLI

```bash
clio evidence build --run <runId>
clio evidence build --session <sessionId>
clio evidence build --eval <evalId>
clio evidence inspect <evidenceId>
clio evidence list
```

Evidence IDs are deterministic:

| Source | ID shape |
| --- | --- |
| Run | `run-<runId>` |
| Session | `session-<sessionId>` |
| Eval | `eval-<evalId>` |

Rebuilding the same evidence ID rewrites the same directory under `<dataDir>/evidence/`.

---

## Evidence directory layout

Run/session evidence files:

```text
<dataDir>/evidence/<evidenceId>/
├── overview.json
├── transcript.md
├── trace.raw.jsonl
├── trace.cleaned.jsonl
├── tool-events.jsonl
├── audit-linked.jsonl
├── receipt.json
├── protected-artifacts.json
├── findings.json
└── findings.md
```

Eval evidence adds `eval-result.json` and uses empty receipt/protected-artifact placeholders when no linked receipts exist.

### Core files

| File | Purpose |
| --- | --- |
| `overview.json` | Stable summary: source, runs, sessions, statuses, tasks, models, totals, tags, and file list. |
| `transcript.md` | Human-readable run/session/eval transcript. |
| `trace.raw.jsonl` | Raw run ledger/receipt/eval rows. |
| `trace.cleaned.jsonl` | Compact normalized rows plus findings. |
| `tool-events.jsonl` | Tool summaries from session entries, audit rows, receipts, or eval commands. |
| `audit-linked.jsonl` | Audit rows linked to run/session context when available. |
| `receipt.json` | Receipt bundle (`{ version: 1, receipts: [...] }`). |
| `protected-artifacts.json` | Protected artifact state/events. |
| `findings.json` / `findings.md` | Structured and readable findings. |

When a run was chained (pipeline), composed with a persona override, or escalated for a permission, `transcript.md` and `trace.cleaned.jsonl` surface the receipt's provenance field sets, and `clio evidence inspect` prints them as a `provenance <runId>:` block. The field paths, types, and stability labels are documented in the [receipt provenance schema](./observability.md#receipt-fields-for-dispatch-provenance).

---

## Evidence Tag Taxonomy and Failure Causes

Clio Coder classifies every run, session, and eval record using a closed set of 23 canonical tags. These tags distinguish general execution characteristics (such as lineage linkages) from actual failure causes.

### Complete Taxonomy

| Tag | Category | Trigger / Meaning |
| --- | --- | --- |
| `audit-linked` | Provenance | Audit logs successfully linked to this run or session. |
| `audit-missing` | Provenance | No matching audit logs were found. |
| `best-effort-link` | Provenance | Inspection commands or logs linked via heuristics. |
| `timeout` | Failure | Execution exceeded the maximum duration limit. |
| `context-overflow` | Constraint | Model context limit was exceeded. |
| `provider-transient` | Transient | Temporary API or model gateway connection error. |
| `missing-dependency`| Failure | Python, Node, or system package dependency was missing. |
| `wrong-runtime` | Configuration | Execution failed due to incorrect compiler or runtime environment. |
| `proxy-validation` | Validation | Weak validation (e.g. only file-presence check rather than execution). |
| `no-validation` | Validation | Succeeded turn or run did not execute any verification commands. |
| `destructive-cleanup`| Precaution | Clean-up rules triggered to prevent workspace pollution or damage. |
| `blocked-tool` | Failure | The safety net blocked a tool call requested by the model. |
| `escalation` | Precaution | A worker permission escalation timed out or was denied; see the receipt provenance schema below. |
| `receipt-integrity` | Security | Forensic verification detected receipt modification or checksum mismatch. |
| `protected-artifact`| Precaution | Mutating a path protected by project or system safety policies. |
| `tool-loop` | Constraint | The model repeatedly called the same tool with identical arguments. |
| `test-failure` | Failure | A verification command containing test/lint keywords exited non-zero. |
| `build-failure` | Failure | A verification command containing build keywords exited non-zero. |
| `cwd-missing` | Configuration | The directory target specified for execution did not exist. |
| `session-linked` | Provenance | The run is linked back to its originating parent session. |
| `session-missing` | Provenance | No parent session could be resolved for this run. |
| `auth-failure` | Failure | Missing or invalid credentials/API keys. |
| `unknown` | Undefined | Unclassified execution failure. |

---

### Failure-Cause Tag Subset

A subset of the taxonomy represents actual failure causes (governed by the `FAILURE_CAUSE_TAG_ORDER` array). These are the only tags included in the receipt summaries and TUI observability histograms:

1. **`timeout`**: Triggered if the run outcome is `"timed_out"` or `"stalled"`, or if the error/failure text contains `"timed out"` or `"timeout"`.
2. **`auth-failure`**: Triggered if failure text contains keywords like `"auth"`, `"api key"`, `"credential"`, or `"unauthorized"`.
3. **`missing-dependency`**: Triggered if failure logs contain `"module not found"`, `"missing package"`, or `"missing dependency"`.
4. **`build-failure`**: Triggered in receipt summaries when a non-zero receipt exit is paired with build tool names in `toolStats` (e.g. `build`, `compile`, `make`, `cmake`, `cargo`, `gradle`, `ninja`, `tsc`). Forensic evidence can also classify a non-zero run from build language in the recorded task text.
5. **`test-failure`**: Triggered in receipt summaries when a non-zero receipt exit is paired with test or lint tool names in `toolStats` (e.g. `pytest`, `ctest`, `jest`, `vitest`, `test`, `lint`, `typecheck`). Forensic evidence can also classify a non-zero run from validation language in the recorded task text.
6. **`blocked-tool`**: Triggered if tool execution statistics show a blocked count greater than `0`.

---

## Receipt findingsSummary

Each run receipt (persisted under `<stateDir>/receipts/<runId>.json`) carries an optional `findingsSummary` block. This block provides a cheap, integrity-covered summary of the run's findings:

```json
"findingsSummary": {
  "tags": ["test-failure"],
  "firstPassSuccess": false,
  "findingCount": 1
}
```

### Computation and Lifecycle
- **Circular Dependency Prevention**: To prevent circular dependencies, `findingsSummary` is calculated **cheaply in-memory** at receipt-record time using the draft envelope and tool statistics (in `src/domains/dispatch/receipt-findings.ts`). It never reads from disk or calls `buildEvidence`.
- **First-Pass Success**: Calculated as `true` only if the terminal outcome was `"succeeded"`, the lineage attempt was `0` (no dispatch retries), the tool stats confirm at least one successful validation tool was executed, and no failure-cause tags were detected.
- **Cryptographic Coverage**: The `findingsSummary` is protected under version 3 of the receipt integrity digest (`RUN_RECEIPT_INTEGRITY_VERSION = 3`). Any attempt to alter the findings summary will invalidate the receipt's integrity check. Pre-existing v2 receipts remain valid without this summary.


---

## Memory CLI

```bash
clio memory list
clio memory propose --from-evidence <evidenceId>
clio memory approve <memoryId>
clio memory reject <memoryId>
clio memory prune --stale
```

Memory records live in:

```text
<dataDir>/memory/records.json
```

The store is capped at `500` records and is sorted by scope, key, creation time, and id for stable writes.

---

## Memory record lifecycle

```mermaid
stateDiagram-v2
    evidence --> proposed: propose --from-evidence
    proposed --> approved: approve <id>
    proposed --> rejected: reject <id>
    approved --> rejected: reject <id>
    proposed --> pruned: prune --stale after 30 days
    rejected --> pruned: prune --stale after 30 days
    approved --> pruned: prune --stale after 180 days since lastVerifiedAt/createdAt
```

Records must cite at least one evidence ID to be considered for prompt injection. Rejected records remain in the store until stale pruning so the same bad lesson is not immediately re-proposed from the same evidence.

---

## Prompt injection rules

The chat loop loads memory synchronously from the bounded local store and calls `buildMemoryPromptSection()`.

Defaults:

| Constraint | Default |
| --- | --- |
| Scopes | `global`, `repo` |
| Token budget | `400` estimated tokens |
| Max records | `5` |
| Required status | `approved: true` |
| Required provenance | At least one `evidenceRefs[]` entry |
| Suppression | Records with active `regressions[]` entries are skipped |

Rendered memory lines always cite record ID, scope, lesson, and evidence IDs. The prompt tells the model not to extrapolate beyond cited findings.

---

## Recommended workflow

1. Build evidence from the run/session/eval that taught the lesson.
2. Inspect the evidence and findings.
3. Propose memory from the evidence.
4. Review the proposed lesson for correctness and scope.
5. Approve only if it is durable and useful.
6. Reject incorrect or overbroad records.
7. Prune stale records periodically.

Memory is meant to reduce repeated mistakes, not to become an unreviewed second instruction system.
