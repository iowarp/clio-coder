# Battletest fixes and verification — 2026-09-20

> [!NOTE]
> **Historical Record**: This document is a dated historical record of the Pi 0.86.1 battletest verification and defect resolution campaign conducted on 2026-09-20. It records candidate-specific test environments, findings, and verification outcomes, not active operator or contributor workflows. Current architecture and contracts are maintained in `docs/architecture/` and `docs/guide/`.

This is the follow-up implementation campaign for the Pi 0.86.1 battletest.
It fixes reproducible runtime and evaluation defects, and records the model
failures that remain. A passing result schema or successful worker process is
not treated as delivery of the requested task.

## Routes and isolation

- OpenAI subscription: `openai-codex`, `gpt-5.6-luna`, `xhigh`.
- Anthropic subscription: `anthropic-max`, `claude-haiku-4-5`, thinking off.
- Local Qwopus: Blade route `mini/qwopus3.8-27b-dense`, requested thinking high.
  Only one Mini workload ran at a time. Dynamo was stopped when the operator
  reserved it for another project, and was not resumed.

Tests used the production CLI, real providers, disposable projects, normal tool
admission and receipts. Multi-turn tests restarted the CLI with `--continue`;
fork tests used native `context: {"mode":"fork"}`. These were headless tests,
not a new terminal-overlay or GUI test campaign. Earlier interactive tree,
compaction, fork, restart/resume, Deny, and Stop evidence remains in the original
campaign. No GUI source was edited or staged. Production bundles were built into
isolated directories without running the GUI asset-build hook.

Working evidence: `/tmp/clio-fix-retest-p3kgk22k`.
Durable archive: `$XDG_DATA_HOME/clio-coder/evidence/battletest-fixes-20260920`
(default `~/.local/share/clio-coder/evidence/battletest-fixes-20260920`).
The archive excludes provider configs and credentials. `source-v*.patch`, lane
metadata, suite YAML, receipts, event streams, grader output and command logs
identify the candidate behind each attempt. Absolute paths inside the original
artifacts preserve provenance; use the corresponding archived lane when a
scratch path has expired.

## Source fixes

| Finding | Change and verification |
| --- | --- |
| BT-01: dispatch objects became JSON strings on Anthropic | Pi's non-strict Anthropic serializer drops root `$defs`; Clio's shared references therefore lost their definitions. Dispatch now carries self-contained nested schemas. A no-network test captures the actual Pi payload and validates single/batched objects and rejection of string encodings. Haiku's live fork changed from two rejected string-encoded calls to one admitted object-valued call. No SDK patch was added. Descriptions were shortened to retain the existing attached-schema size gate. |
| BT-03: gateway execution disappeared from metrics | Metric capture retains bounded gateway operation/capability identity. A capability call contributes its native metric while aggregate model tool-call counts remain unchanged. The web-fetch grader accepts direct and gateway execution. Luna, Haiku and Mini passed the real invalid-scheme case. An expected refusal can pass only when the suite explicitly enables `allowNoop` and an independent grader passes. |
| BT-04 / BT-08: skills and delegation overrode operator scope | Operating guidance honors no-tools/no-delegation and explicit tool lists; small cohesive multi-file changes no longer mandate delegation. Declined installation stays declined, and no-ready-skill reminders do not prescribe unavailable activation. Proposal work must remain blocked. All three models implemented the small multi-file fixture without dispatch. Proposal-only compliance remains inconsistent; see below. |
| BT-05: native-read recovery still sealed as no-op | A successful native observation can recover denied shell execution. It cannot clear an unresolved write block. Both cases are covered, and all three providers passed the real denied-shell/native-read scenario. |
| BT-06: grader evidence and metrics disappeared | Preserve grader stdout/stderr and bounded `proposal.*`, `memory.*`, `scope.*`, `explanation.*` facts, including explicit null for unmeasured values. Reserved host metrics remain protected. |
| BT-07: shipped coding skills blocked verification | `fix-issue` and `ship` admit `verify`; package versions and all library/skill digest indexes were updated together. Compatibility-discovery tests now reflect the already-committed explicit-import policy. |
| BT-09: empty stream blamed an unrelated notice | Headless failure now identifies an ended provider stream without an assistant response or terminal result. It does not claim that a thinking-level notice caused the failure. |
| BT-10: forked workers followed the parent's dispatch request | Fork assignment messages explicitly distinguish inherited background from the current worker assignment. Worker guidance preserves operator constraints. Luna, Haiku and Mini all admitted a real fork and produced passing verifier reports. |
| BT-11: final synthesis repeated tool-shaped output | Final-only contract repair uses a new user directive to break the tool-exchange pattern; active revision retains the paired exchange and its cache behavior. Locked markup reprompt uses the same terminal-direction approach. Repair/synthesis regressions pass. The new fork fixtures did not exhaust repair. A separate accepted-result/capture mismatch was subsequently reproduced and fixed, as described below. |
| BT-12: interruption lost completed grades | Atomically checkpoint results after each case, with explicit incomplete/completed status. A real CLI suite was terminated during case two: case one's passing grade survived and no finished artifact was produced. |
| New: read-only `code_nav` wrote project files | Reconcile a bounded in-memory snapshot using the existing codewiki worker, without taking a writer lease or persisting `.clio-coder/codewiki.json`/`state.json`. Freshness checks and a real no-edit run prove zero workspace changes. |
| New: bounded console output corrupted grader evidence | Stream complete runner stdout to a private capture before grading; retain it separately from bounded console excerpts. Fail closed at 64 MiB. Drop opaque Pi replay signatures from the presentation JSON stream only, retaining canonical session data. The previously failing Luna scout pipeline passed with complete event capture. |
| New: board follow-up hid an already delivered proposal | Proposal grading checks delivered assistant text across the turn while retaining final board-state and tool-scope assertions. Mini's original compliant stream passes regrading; the violating Haiku stream still fails. A later fresh Mini run independently violated scope and remains failed. |
| New: parent confused host checks with worker claims | Dispatch output now explains each separate host check and whether it executed or reused evidence. Luna originally denied that a recorded host check existed; the live follow-up correctly distinguished the worker check and the separate host execution. |
| New: accepted Scout report disappeared before sealing | Worker validation accepted reports larger than the parent’s 8 KiB capture limit; the parent silently discarded them. Structured helpers now share a 32 KiB acceptance/capture ceiling, including canonicalized salvage. A live Scout report of 9,519 bytes now seals intact with passing conformance/quality. Oversized reports are rejected while worker repair remains possible. |

BT-02 remains an inconclusive interaction observation: the original conditional
prompt during generation was ambiguous. Earlier unconditional replacement and
queued-prompt controls passed. No speculative input-routing change was made.

## Real model evidence

This campaign contains 38 graded attempts across successive candidates:

| Route | Graded attempts | Raw passes | Raw failures |
| --- | ---: | ---: | ---: |
| Luna | 26 | 13 | 13 |
| Haiku | 5 | 3 | 2 |
| Mini Qwopus | 7 | 4 | 3 |

These are audit counts, **not a final-candidate success rate**: they include
reproductions, old graders, repeated failing cases, and different targeted
subsets. No original failure was overwritten by a later retry or regrade.
An early generated test-config error prevented 13 additional attempts from
calling any model; those are archived separately as invalid configuration.
The stopped Dynamo attempts are excluded from these model counts.

The separate production multi-turn sequence was:

1. Read a small project, implement `mean`, cover empty and populated arrays,
   update the test script, run verification, and obey no delegation/commit.
2. Restart with `--continue`; dispatch one native-fork verifier and await its
   receipt. Run an independent host check as declared in dispatch intent.
3. Restart again; recall the marker, `mean([]) === null`, and verification facts
   without any tool use.

All three routes produced independently passing implementations, zero
implementation dispatches, one admitted fork, and zero recall tool calls.
Haiku receipt `1x89cztrglle` and Mini receipt `17m8ayhmicpf` each record exactly
one successful worker `verify` call plus separate passing host execution.
Luna receipt `1ranswsbn842` records two successful `verify` tool calls; the
aggregate does not distinguish check discovery from execution, so this report
does not certify an exact execution count for that earlier worker. Its report
and host check passed. Luna's first recall misstated host provenance; after the
output-label fix it correctly reported both executions. See
`conversation-results.json` and `host-recall-progress.log` plus the retained
`fork-after-label`/`recall-after-label` streams.

## Remaining failures and limits

1. **Proposal scope is not reliable on Haiku or Mini.** Haiku made seven
   unauthorized discovery calls in the latest proposal run and left the board
   pending. Mini had one compliant run (confirmed by regrading its complete
   original stream), then made one out-of-scope call on a fresh run. The
   grader still fails these attempts. Natural-language scope guidance is not
   equivalent to a structured tool allowlist enforced by the registry.
2. **Luna's no-edit memory answer is incomplete.** It now leaves the entire
   workspace unchanged and acknowledges that retention was not performed,
   but omits the supported proposal/approval workflow. No persistence or
   fresh-session memory delivery is claimed by this single-turn case.
3. **Long source explanations still fail.** The original folded YAML prompt
   ambiguously placed parent coordination text beside the exact worker task;
   explicit `<worker-task>` boundaries corrected that ambiguity without
   loosening task equality. The new Coder run preserved the task and produced
   a conforming 1,016-word report, but used basename-only citations for three
   nested source files, failing the full-path citation requirement. The new
   Scout run (`2es91b4wog6c`) failed with missing final output after 12
   successful read/grep calls. Investigation reproduced the accepted-result/
   capture-size mismatch, and the corrected rerun (`1hz4db3f2xaj`) successfully
   sealed a 9,519-byte, 1,167-word structured report. That new report passes
   conformance and quality, but still fails the corpus's per-source structured
   citation requirement: `tests/test_coefs.py` appears in prose citations, not
   as a finding's `path`. This is distinct from losing the terminal report.
4. **Synthesis evidence remains bounded.** Forked verifiers and the corrected
   long Scout now return intact results, and repair regressions pass. These
   cases do not establish universal model adherence or successful completion
   of every report requested in prose.

No further model jobs were left running. No new model calls are needed to
inspect the preserved evidence.

## Verification

- Root typecheck, Biome and all 17 hygiene checks passed; Pi surface matches.
- Production isolated build and the existing Stage 0 import/byte budget passed.
- Full root contract/smoke gate: 1,099 passed, one skipped, zero failed.
- Focused worker/context, codewiki, eval capture, headless and keyboard batch:
  109 passed. Skill/import batch: 27 passed. Repair/result-contract batch:
  36 passed. Host-evidence/batch-settlement batch: 30 passed. The helper-size,
  native terminal-handoff and source-explanation batch passed all 33 checks;
  its exact-boundary follow-up also passed. Additional schema
  wire, provider-boundary and changed-case checks passed. Counts overlap and
  must not be added into one unique-test total.
- All 25 eval suites validate through the production loader.
- Tests extend existing files; no new test suite files were added.

A full gate caught the inline schema's byte growth. The implementation was
shortened to pass the existing ceiling; the ceiling was not raised. The final
build remains isolated so this campaign does not replace GUI build artifacts
being maintained by the concurrent GUI agent.

## Implementation commits

- `47a08d88`: read-only code navigation.
- `a6183249`: provider-compatible dispatch schemas, fork assignment boundaries,
  final-only repair and explicit host-check evidence.
- `6deea2a0`: native-read recovery and empty-stream diagnostics.
- `07e9e245`: operator scope, ready-skill policy and verification permissions.
- `91ecd5ab`: complete eval evidence, checkpoints and grading corrections.
- `12de54a8`: retain the existing prompt byte budget with inline schemas.
- `72bf2ece`: align helper acceptance and receipt capture limits, including
  canonicalized salvage at the boundary.
