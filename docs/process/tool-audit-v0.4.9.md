# Individual Tool Audit for v0.4.9

> [!NOTE]
> **Historical Record**: This document is a point-in-time architectural audit of tool placement, contracts, and dispositions conducted during the v0.4.9 cycle. For active, authoritative tool contracts and argument specifications, refer to [Tool Usage](../guide/tool-usage.md) and [Prompt Envelope and Tools](../architecture/prompt-envelope-and-tools.md).

This is the landed disposition of each builtin tool and each dynamic capability family. It replaces the pre-implementation findings with the current contract, without treating placement as proof of correctness. Source references name the implementation; [Tool usage](../guide/tool-usage.md) supplies detailed arguments and examples. `src/tools/surface.ts` owns placement and `src/tools/policy.ts` owns action class/concurrency. There are 30 builtin names, plus extension and MCP families whose individual schemas are discovered at runtime.

The implementation commits are on the candidate branch; this document does not claim that the version has been published. Scientific integrity below describes evidence and limits, not an empirical certification of each tool. Existing orchestration and interaction behavior was checked for its documentation contract; no new scientific benchmark or full source re-audit is claimed.

## read

- **Purpose:** Retrieve cited text windows or supported images from a known file.
- **Placement:** Direct OBSERVE, read class, parallel.
- **Contract:** `path`, `offset`, `limit`, `tail`, `line_numbers`; bounded text and file identity/change details; refuse binary or invalid UTF-8 with byte offsets.
- **Implementation:** `src/tools/read.ts` uses bounded fd windows and backward tail scans. Exact counts stop above 32 MiB; images keep a 20 MB (20000000 bytes) ceiling. Observation bytes and lines are bounded. Tail numbering is refused when the total is unknown.
- **Scientific integrity:** `N+` and continuation distinguish a window from a dataset. Observed changes do not create snapshot isolation; unread bytes are not validated.
- **Disposition:** Redesign the whole-file reader; retain explicit pagination and image behavior.

Status: landed in `30826041`.

## write

- **Purpose:** Create or regenerate a complete UTF-8 file.
- **Placement:** Direct MUTATE, write class, sequential.
- **Contract:** `path`, `content`; byte count, eligible diff, paths, before/after identity, and possible durability warning. Existing targets are overwritten.
- **Implementation:** `src/tools/write.ts` and `src/tools/file-mutation-queue.ts` serialize same-target writes and publish by temporary file, fsync, and real-target rename. Previous-content comparison is bounded; either version above 1 MiB skips diff generation. Symlink targets and mode bits are preserved.
- **Scientific integrity:** No partial publication before rename, but external writers are unlocked and last rename wins. Ownership, ACLs, xattrs, and original timestamps are not preserved. A write is not data validation.
- **Disposition:** Repair publication and evidence; retain full-file replacement semantics.

Status: landed in `82ebee28`.

## edit

- **Purpose:** Apply disjoint targeted replacements to one existing text file.
- **Placement:** Direct MUTATE, write class, sequential.
- **Contract:** `path`, `edits`; refuse absent/ambiguous matches, overlaps, no-ops, NUL, invalid UTF-8, mixed endings, and bare CR. Preserve BOM and uniform LF/CRLF.
- **Implementation:** `src/tools/edit.ts`, `edit-diff.ts`, and `file-mutation-queue.ts`. Small files try exact, normalized punctuation/whitespace, then indentation-relaxed matching. Above 1 MiB only exact matching is allowed. Atomic publication and identity reporting match write; large diffs are skipped before construction.
- **Scientific integrity:** Invalid bytes are never silently repaired. Editing still holds source/replacement in memory; file identity does not enforce an earlier-read precondition or lock external writers.
- **Disposition:** Repair encoding, publication, and large-file allocation behavior.

Status: landed in `82ebee28`.

## bash

- **Purpose:** Execute shell workflows that require shell semantics.
- **Placement:** Direct EXECUTE, execute class, sequential; command classification can escalate authority.
- **Contract:** `command`, `cwd`, `timeout_ms`, `output_policy`; combined result with separate termination and disposition facts. The combined 16 MiB output ceiling stops the child.
- **Implementation:** `src/tools/bash.ts`, `src/core/bash-exec.ts`, and result shaping retain the existing process lifecycle and login-environment snapshot. Cap handling distinguishes raw observed and retained bytes, decoded retention, actual offload, and discarded bytes.
- **Scientific integrity:** Summary and metadata-only projections preserve failure/retrieval facts. A cap is unsuccessful partial execution, not a complete dataset; use run_script for streaming.
- **Disposition:** Retain the cap and repair diagnostic and retention honesty.

Status: landed in `bde78f76`.

## grep

- **Purpose:** Locate content matches with source-line citations.
- **Placement:** Direct OBSERVE, read class, parallel.
- **Contract:** Pattern/path, content/files/count modes, glob, context, limits, and ignore options; partial results carry `details.search` completeness, reason, skipped counts/samples, and unknown coverage.
- **Implementation:** `src/tools/grep.ts` and `spawn-hygiene.ts` preserve collected native results on timeout, cancellation, and recoverable errors. Native diagnostics have bounded decoding; fallback traversal/read work is asynchronous and skips oversized, binary, or unreadable inputs explicitly.
- **Scientific integrity:** Complete empty and incomplete searches are distinct. Native `.gitignore` and fallback generated-directory-only semantics are disclosed; counts never imply unseen paths were searched.
- **Disposition:** Repair completeness, diagnostics, and responsiveness.

Status: landed in `17e2de0b`; ignore-policy clarification in `bde78f76`.

## find

- **Purpose:** Locate paths using filename/glob or bounded recent-change selection.
- **Placement:** Direct OBSERVE, read class, parallel.
- **Contract:** `pattern`, `path`, `order`, `limit`, `include_ignored`; paths, continuation, candidate bounds, and `details.search`.
- **Implementation:** `src/tools/find.ts` keeps fd's glob/smart-case filtering and native result cap. The fallback is asynchronous. Mtime selection stats only a bounded candidate set; neither traversal follows symlinked directories.
- **Scientific integrity:** Mtime order can be approximate. Native skipped symlink-directory counts are explicitly unavailable (`counted=false`); fallback counts them. Native and fallback matching/ignore semantics are not guaranteed identical.
- **Disposition:** Retain native filtering and repair incomplete-search evidence.

Status: landed in `17e2de0b`.

## ls

- **Purpose:** Inspect one directory, including symlinks and broken entries.
- **Placement:** Direct OBSERVE, read class, parallel.
- **Contract:** `path`, `limit`; alphabetical entries, `name@ -> target` or `name@ (broken)`, failure markers, `details.skipped`, and `details.selection`.
- **Implementation:** `src/tools/ls.ts` asynchronously enumerates, keeps O(limit) selected names in a heap, and stats only selected entries. Case-insensitive ties preserve enumeration order. Listing still scans the directory to select its prefix.
- **Scientific integrity:** Broken or unreadable entries do not disappear silently. Bounded retained state is not a claim of constant total work.
- **Disposition:** Repair link truthfulness and selection allocation.

Status: landed in `17e2de0b`.

## code_nav

- **Purpose:** Retrieve indexed repository symbols, paths, outlines, dependencies, entries, and generated wiki context.
- **Placement:** Direct OBSERVE, read class, parallel; worker profile/recipe policy can omit it.
- **Contract:** Mode, query, and bounded limit select structured index results with citations, omissions, and continuation; unavailable index/invalid queries return actionable failures.
- **Implementation:** `src/tools/codewiki/code-nav.ts` and `code-nav-surface.ts` use the codewiki index and a 16KB observation cap. Result selection is bounded, but the loaded index and index searches are not a streaming live filesystem scan.
- **Scientific integrity:** Index freshness and source citations bound the claim. Navigation is neither executed validation nor evidence that a dataset is complete.
- **Disposition:** Retain the existing indexed navigation contract; no release-specific numerical processing is added.

Status: unchanged in v0.4.9 because the existing indexed navigation and freshness contract remains appropriate.

## context

- **Purpose:** Retrieve workspace state, activate installed skills, and recall persisted observations.
- **Placement:** Direct OBSERVE, read class, parallel.
- **Contract:** `scope=workspace|skills|recall`; skill name/tree and recall query/ref/limit/offset arguments. Workspace needs session wiring; skill activation obeys operator and recipe policy.
- **Implementation:** `src/tools/context/surface.ts` and `index.ts` retain existing engines with the narrower permanent schema. Workspace/skills use the observation envelope; recall resolves persisted evidence.
- **Scientific integrity:** Recall identifies historical observations without presenting them as current file reads. Skill availability is separate from permission to activate or install.
- **Disposition:** Redesign the permanent schema; move secondary docs/library retrieval to named gateway capabilities.

Status: landed in `021ec049`.

## verify

- **Purpose:** Execute declared checks and inspect explicit validation judgements.
- **Placement:** Direct EXECUTE, execute class, sequential.
- **Contract:** Package scripts, strict project catalog entries, or frontend verification. Numeric checks use explicit tolerance combination/non-finite policy; performance checks use budgets or baselines. Execution failure prevents judgement.
- **Implementation:** `src/tools/verify/numeric.ts`, `perf.ts`, and `scripts.ts` cap judged capture and references at 32 MiB; ULP tolerance cannot exceed Number.MAX_SAFE_INTEGER. Version-2 baselines record environment; direct and host paths retain provenance and judgement axes.
- **Scientific integrity:** Non-finite report values serialize by name. Hashes identify reference/actual bytes; environment mismatches are informational. `scientificValidity` stays `not established by this check` even on pass.
- **Disposition:** Repair mathematical policy and evidence instead of equating execution with scientific validity.

Status: landed in `2968271a`; host-verification parity and authoring/help closures in `bde78f76`.

## evidence

- **Purpose:** Inspect canonical bundles, per-run trust axes, gate decisions, and findings.
- **Placement:** Gateway OBSERVE, read class, sequential.
- **Contract:** `mode=list|inspect|run`, `id` or `runId`; bounded JSON. Run mode may build a missing bundle; absent ledger runs report artifact absence.
- **Implementation:** `src/tools/evidence.ts` shares evidence-domain projections and caps the result at 16KB with valid JSON preview on truncation. Sequential execution protects materialization ordering; gateway evidence export resolves the underlying identity.
- **Scientific integrity:** Integrity, validation grounding, provenance, and completion remain separate axes. A trusted bundle does not establish the truth of every worker claim.
- **Disposition:** Retain the bounded evidence engine and repair routing/consumer identity for gateway invocation.

Status: placement and evidence projection landed in `021ec049`.

## credential_present

- **Purpose:** Check credential availability without returning its value.
- **Placement:** Gateway OBSERVE, read class, parallel.
- **Contract:** Credential `name`, optional environment/file source and file path; booleans, checked sources, and missing-file state. Invalid names or unusable reads fail.
- **Implementation:** `src/tools/credential-present.ts` returns a small presence projection rather than the observation envelope. File access remains subject to the capability's admitted read contract.
- **Scientific integrity:** Presence does not validate a credential, establish external access, or expose secret contents. No numerical interpretation occurs.
- **Disposition:** Retain the minimal result and move its schema off the permanent direct surface.

Status: placement landed in `021ec049`.

## git

- **Purpose:** Inspect repository status, diffs, and history without a free-form shell.
- **Placement:** Gateway EXECUTE plane, read class, parallel.
- **Contract:** `op=status|diff|log`, optional path/cwd, diff flags, log limit, timeout, and output cap. Nonzero, capped, timed-out, or aborted execution returns failure facts.
- **Implementation:** `src/tools/safe-exec.ts` builds fixed git argv vectors on safe-exec; default timeout 120000 ms and capture 600000 bytes, followed by bounded result shaping. Log count caps at 200.
- **Scientific integrity:** Command/argv/cwd/exit/timing identify the observation; truncation is not a complete change inventory. Git inspection does not validate scientific output.
- **Disposition:** Retain fixed-vector inspection and preserve recipe attestation through gateway placement.

Status: placement/attestation landed in `021ec049`; shared safe-exec cleanup strengthened in `4ef9277e`.

## web_fetch

- **Purpose:** Make full HTTP requests and retrieve bounded textual content.
- **Placement:** Gateway RETRIEVE, read base class, parallel; non-GET or body requests retain outward-action classification.
- **Contract:** URL, method, headers, body, format, timeout, and byte limit. Unsupported/binary content and disallowed private-network targets are refused.
- **Implementation:** `src/tools/web-fetch.ts` and its helpers share the existing fetcher, default 600KB read allowance, 5MB hard read cap, and 16KB shaped result. Abort/timeout and network policy remain in force.
- **Scientific integrity:** HTML conversion and arXiv/repository summaries are derived views, not raw source identity or independent corroboration. Request success is not evidence that a remote claim is correct.
- **Disposition:** Retain full requests behind the gateway and split GET-only reading into web_read.

Status: landed in `021ec049`.

## web_read

- **Purpose:** Read public web content without full-request argument authority.
- **Placement:** Gateway RETRIEVE, read class, parallel.
- **Contract:** `url`, `timeout_ms`, `max_bytes`, `format`; GET only, without headers, method, or body arguments.
- **Implementation:** `src/tools/web-fetch.ts` and `web-fetch-surface.ts` delegates to the existing web fetch implementation and inherits its byte caps, cancellation, conversion, and private-network policy.
- **Scientific integrity:** Bounded/converted content must be distinguished from the complete original. A GET-only tool is not a guarantee that remote content is trustworthy.
- **Disposition:** Split the read-only request surface from full web_fetch while sharing implementation.

Status: landed in `021ec049`.

## artifact

- **Purpose:** Publish a requested terminal plan, review, or report.
- **Placement:** Gateway ARTIFACT, write class, sequential.
- **Contract:** `kind`, `content`, optional title/path; default `.clio-coder/artifacts/{PLAN,REVIEW,REPORT}.md`, workspace-contained overrides, and terminal turn completion.
- **Implementation:** `src/tools/artifact.ts` uses the atomic publisher. Gateway preserves `terminate`, `details.kind`, and `details.paths`; ledger/artifact consumers unwrap capability identity. Post-publication durability warnings remain visible.
- **Scientific integrity:** Successful publication establishes document delivery, not correctness of its claims. Pre-rename failure is not presented as an artifact; terminal content must contain the full answer.
- **Disposition:** Retain the terminal document contract, repair publication, and move behind gateway.

Status: landed in `021ec049` using publisher from `82ebee28`.

## clio_docs

- **Purpose:** Retrieve cited bundled documentation on demand.
- **Placement:** Gateway OBSERVE, read class, parallel.
- **Contract:** Optional query and section limit (default 5, max 12); omitted query lists corpus; searches return ranked cited sections and follow-up guidance.
- **Implementation:** `src/tools/gateway/clio-context-tools.ts` reuses `src/tools/context/docs-engine.ts`, with a 16KB observation cap and valid JSON offload behavior. It reads the shipped corpus without network access.
- **Scientific integrity:** Rankings are retrieval hints, not proofs. File/section/line citations let callers inspect the source; omitted sections remain explicitly omitted.
- **Disposition:** Move the existing docs engine out of context's permanent schema.

Status: landed in `021ec049`.

## clio_library

- **Purpose:** Inspect loaded recipes and installable package claims without activation or installation.
- **Placement:** Gateway OBSERVE, read class, parallel; unavailable inside workers.
- **Contract:** Query, kind, ref, limit (20 default, 50 max), offset; tagged resource/hint/package rows with continuation and lower-bound totals where needed.
- **Implementation:** `src/tools/gateway/clio-context-tools.ts` and `src/tools/context/library.ts` reuse bounded inventory and fit pages to a 16KB observation allowance. No recipe body or installation side effect is returned.
- **Scientific integrity:** Installed resources have real invocation information; catalog hints do not pretend to be loaded tools. Availability does not confer trust or validate a package's scientific claims.
- **Disposition:** Move read-only catalog browsing out of the permanent context schema.

Status: landed in `021ec049`.

## data

- **Purpose:** Inspect, select, or validate explicitly supported structured formats without rewriting them.
- **Placement:** Gateway OBSERVE, read class, parallel.
- **Contract:** CSV/TSV/JSON/JSONL op/path, format-specific selectors, sample/scan limits; view flags, schema/counts, precision issues, and actionable refusals.
- **Implementation:** `src/tools/data/` streams with bounded CSV field/record, JSON depth/capture, and JSONL line budgets. `src/tools/gateway/data-tool.ts` normalizes the protected read path before admission and applies a 32 KiB observation cap.
- **Scientific integrity:** Preserve numeric literals and sentinels; disclose sampling, approximate extrema, duplicate-tracking limits, and cut values. `exact=false, sampled=false` denotes a complete scan with a value cut to budget, not a complete selection. Validation is format validation only.
- **Disposition:** Add bounded structured-data inspection; refuse unsupported binary formats and direct them to a supplied script/library.

Status: readers landed in `7623ce27`; gateway/admission integration in `021ec049`.

## dispatch

- **Purpose:** Run explicitly bounded tasks on fleet workers and collect durable receipts.
- **Placement:** Direct ORCHESTRATE, dispatch class, sequential; requires a dispatch contract.
- **Contract:** Singular/batch tasks, recipe/route, typed intent, budgets, timeout, topology, and optional detach. Nonzero terminal attempts fail; detached ids require collection before final synthesis.
- **Implementation:** `src/tools/dispatch.ts` delegates to the dispatch domain's admission and lifecycle. Summaries are bounded; cancellation and receipts are owned there. Gateway capabilities remain in the admitted worker list while schemas and attestation use the direct projection.
- **Scientific integrity:** Receipt integrity, worker evidence, host verification, and project/briefing provenance remain distinct. Worker prose is advisory; successful execution alone is not a scientific result.
- **Disposition:** Retain orchestration and direct placement; adapt worker capability projection and host evidence integration.

Status: gateway worker integration landed in `021ec049`; host verification closures in `bde78f76`. Existing dispatch workflow is retained.

## monitor

- **Purpose:** Observe dispatched runs and collect detached results.
- **Placement:** Direct ORCHESTRATE, read class, parallel; requires dispatch wiring.
- **Contract:** List/status/peek/receipt/wait/collect/tools, run/batch identifiers and bounded waiting. Wait never cancels; collect resolves terminal attempts.
- **Implementation:** `src/tools/monitor.ts` uses the dispatch ledger and live snapshot. Peek uses bounded in-process tails (100 events/run, 64 runs, 8KB output); receipts are bounded projections with retrieval paths.
- **Scientific integrity:** Process-local event absence is disclosed, not treated as proof of no tool activity. Receipt integrity and validation evidence are separate, and an unfinished run is never a completed result.
- **Disposition:** Retain observation and collection; it does not process scientific values.

Status: unchanged in v0.4.9 because existing bounded run observation and collection remain the required contract.

## steer

- **Purpose:** Correct or cancel a worker with an already-known run id.
- **Placement:** Direct ORCHESTRATE, dispatch class, sequential.
- **Contract:** `run_id`, `action=guide|cancel`, message for guide. Unsupported live-input runtimes and terminal-run cancellation return structured failures.
- **Implementation:** `src/tools/steer.ts` uses the dispatch contract's stdin steer/cancel path. Guidance acknowledgement follows runtime acceptance; parent-model mid-run control needs detached ids.
- **Scientific integrity:** Guidance records ordered byte/hash/timestamp and acknowledgement provenance, not validation of the changed work. Cancellation yields a cancelled outcome instead of a successful deliverable.
- **Disposition:** Retain the explicit control surface and supported-runtime boundary.

Status: unchanged in v0.4.9 because existing steering/cancellation contracts suffice.

## tasks

- **Purpose:** Maintain a session work board and linked operator-task state.
- **Placement:** Direct ORCHESTRATE, read class, sequential bookkeeping.
- **Contract:** plan/add/pick/start/done/block/drop/list with title, tasks, id, and note. Done requires evidence text; block requires a reason. Invalid state transitions fail.
- **Implementation:** `src/tools/tasks.ts` updates the board and durable full-snapshot task ledger; operator inbox reconciliation/pick/done can update Clio-owned state. Sequential execution prevents interleaved board changes.
- **Scientific integrity:** A completion note is an attributable claim, not an executed check or operator authorization. Linked operator status must be inspected before claiming completion.
- **Disposition:** Retain the explicit bookkeeping exception to read-class semantics; do not equate it with source mutation authority.

Status: unchanged in v0.4.9 because the existing board and operator correlation contract is retained.

## ledger

- **Purpose:** Exchange typed claims, findings, and reviews among peer workers.
- **Placement:** Direct ORCHESTRATE, read class, sequential; only workers with a bound agent-ledger port.
- **Contract:** Read with filters/watermark or post required kind-specific fields. Each run is limited to 20 posts; duplicate posts are not retry-safe.
- **Implementation:** `src/tools/ledger.ts` reads a local mirror and posts through the dispatch control lane, returning a bounded board and sequence watermark. It does not mutate the source workspace.
- **Scientific integrity:** Peer state may be stale. Findings and reviews carry provenance but remain untrusted data, not instructions or independent empirical proof.
- **Disposition:** Retain typed coordination and its explicit availability/post bounds.

Status: unchanged in v0.4.9 because coordination does not require scientific-data processing changes.

## panes

- **Purpose:** Display Clio-owned runs and fixed utility panes.
- **Placement:** Direct ORCHESTRATE, read class, sequential; requires detected host and live mux.
- **Contract:** show/open/close/list, target, and fixed files/logs/shell presets. Arbitrary argv stays operator-only; close is limited to owned panes.
- **Implementation:** `src/tools/panes.ts` and `panes-surface.ts` delegate to the mux. Sequential calls protect pane inventory; an unavailable host omits the tool rather than advertising a working pane layer.
- **Scientific integrity:** Display visibility is not execution evidence or validation. Pane operations cannot justify claims about worker completion beyond the displayed run facts.
- **Disposition:** Retain the bounded owned-pane interface and direct placement.

Status: unchanged in v0.4.9 because no data or evidence interpretation change is required.

## limitation

- **Purpose:** Record a typed statement of what could not be verified.
- **Placement:** Direct ORCHESTRATE, read class, parallel.
- **Contract:** Scope, enumerated reason, optional paths; successful receipt is its effect. Empty/invalid calls do not count.
- **Implementation:** `src/tools/limitation.ts` is pure and runs no process or file mutation. The finish contract recognizes its successful ledger receipt within the mutation window.
- **Scientific integrity:** It explicitly marks absent validation; it never converts missing or failed checks into a pass. Free-form final prose is not an equivalent receipt.
- **Disposition:** Retain the precise limitation-evidence boundary.

Status: unchanged in v0.4.9 because the existing receipt already preserves uncertainty honestly.

## decide

- **Purpose:** Record an agent-authored design choice beside operator decisions.
- **Placement:** Direct ORCHESTRATE, read class, sequential; needs a session decision board.
- **Contract:** Key, value, alternatives, rationale, optional label with byte/count bounds. A repeat agent key supersedes; an operator-owned key cannot be overwritten; worker calls are refused.
- **Implementation:** `src/tools/decide.ts` appends a decision-ledger entry. Sequential lookup/write prevents supersede races; dispatch and commit seams carry active decision references.
- **Scientific integrity:** Provenance records who chose what and why. It does not grant authorization, independently review the choice, or establish scientific validity.
- **Disposition:** Retain bounded decision provenance and direct placement.

Status: unchanged in v0.4.9 because the existing decision-board contract remains suitable.

## ask_user

- **Purpose:** Resolve missing operator choices through host-owned interviews.
- **Placement:** Direct INTERACT, read class, sequential; interactive handler required.
- **Contract:** Ask/complete, round/single-question mode, questions/options, decisions, summary, round bound, and local/outward exposure. Cancellation is an explicit host outcome.
- **Implementation:** `src/tools/ask-user.ts` bounds questions/rounds and records interview decisions. Exposure participates in autonomy admission; caller prose cannot choose authority or consequence tier.
- **Scientific integrity:** An operator answer establishes an attributed decision, not validation of a scientific claim. Missing answers and cancelled interviews are not fabricated approval.
- **Disposition:** Retain the direct host interaction surface and its admission boundary.

Status: unchanged in v0.4.9 because the operator explicitly retained INTERACT placement and the existing interview contract.

## gateway

- **Purpose:** Discover secondary capabilities without attaching every schema to every turn.
- **Placement:** Direct GATEWAY, read outer class, sequential.
- **Contract:** Find/describe/call with query/capability/args. Bounded listings, full described schemas, and capability results; unavailable/disallowed/invalid calls fail explicitly.
- **Implementation:** `src/tools/gateway/index.ts`, `registry.ts`, and `surface.ts` reuse inner admission, cancellation, authority decisions, result shaping, terminal propagation, and effective evidence identity. Nested accounting counts one model call; worker allowlists apply to discovery and invocation.
- **Scientific integrity:** Gateway success retains the underlying operation's facts instead of hiding them. The 31,272-byte measurement covers 19 attached fixture tools excluding ask_user/panes; a derived full-surface total is not comparable measurement evidence for overall shrinkage.
- **Disposition:** Add a stable router without introducing new authority or sandbox claims.

Status: landed in `021ec049`.

## run_script

- **Purpose:** Execute an inspectable scientific script with large logs streamed to disk and bounded model progress.
- **Placement:** Direct EXECUTE, execute class, sequential.
- **Contract:** Allowlisted PATH interpreter, workspace script/cwd, explicit argv/env, positive-integer timeout capped at six hours, and provenance-only input/output declarations. Records logs, manifest, identities, output states, and honest unsuccessful outcomes.
- **Implementation:** `src/tools/run-script.ts`, `src/core/safe-exec.ts`, and `run-records.ts` reuse the execution substrate with streaming sinks, 250 ms progress, bounded tails/hashes, and retention of 100 completed runs. Retention metadata reads cap at 64 KiB and skip nonregular entries explicitly.
- **Scientific integrity:** `exitCode` is effective status while `leaderExit` is observed process status. Original-group cleanup and one-second pipe draining can fail independently; escaped processes remain outside containment. ESRCH permanently closes ownership, but the probe-to-signal race remains accepted. Logs/argv can carry literal secrets; env values are omitted from manifest. Execute success is not scientific validation.
- **Disposition:** Add the streaming provenance contract; no installs, automatic retries, script-to-tool calling, or OS sandboxing.

Status: execution landed in `4ef9277e`; direct registration/policy integration in `021ec049`.

## extension_<id>__<name>

- **Purpose:** Expose operator-installed command capabilities under declared schemas.
- **Placement:** Gateway dynamic extension family; execute class and sequential command execution.
- **Contract:** Each installed descriptor supplies its schema; JSON arguments go to the command and bounded JSON/text results return. Invalid trust/digest, arguments, execution, or output fail rather than fabricating capability availability.
- **Implementation:** `src/tools/harness-extensions.ts` freezes schemas at registry construction, re-verifies the extension digest per call, projects safety through command argv, and uses safe-exec with timeout/output bounds and cancellation.
- **Scientific integrity:** Installation/trust and provenance identify the extension but cannot certify its scientific implementation. Each capability's described contract must state its own precision and validation semantics.
- **Disposition:** Retain existing command execution and move discovery/attestation to the gateway. This family record cannot pre-audit arbitrary future installed commands.

Status: placement and worker integration landed in `021ec049`; existing command engine retained.

## mcp_<id>__<tool>

- **Purpose:** Call explicitly trusted local stdio MCP capabilities.
- **Placement:** Gateway dynamic MCP family, session-owned; action class comes from trust, not server annotations.
- **Contract:** Discover/describe server schemas and call with validated arguments; bounded normalized results, protocol errors, timeouts, and cancellation. Project declarations cannot spawn without digest-bound operator trust.
- **Implementation:** `src/domains/gateway/mcp/` bounds framing, outbound queues, result text, stderr, pages/tools, and config/trust reads. `src/tools/gateway/mcp-capabilities.ts` bounds one call result to 16 KiB in model context (offloading larger results to external artifacts) and shares connection/close ownership. Discovery cancellation closes the shared connection without session restart; shutdown awaits teardown, and the client owns exit cleanup. ESRCH and bounded release permanently end signalling ownership.
- **Scientific integrity:** Trust authorizes launching an unsandboxed local process, not trusting its results. Incomplete cleanup is reported; residual PGID reuse and escaped-process limitations remain. Unknown external numerical semantics must be checked in each discovered capability's contract.
- **Disposition:** Add local stdio integration with explicit trust and bounded lifecycle; defer remote MCP/OAuth and OS isolation.

Status: client/config/trust landed in `d7b0edee`, CLI/slash in `bde78f76`, gateway cancellation/shutdown/exit ownership in `021ec049`.
