# GUI parity matrix — part 3: runtime domain roster and implementation plan

> **Reference Design & Planning Blueprint**: This document is an architectural reference blueprint recovered from the deleted `apps/workbench` prototype. It specifies design doctrine, target parity, and inspection layouts for the early GUI preview (`apps/clio-coder-gui`), not verified runtime features of the core v0.5.0 terminal engine.

## A. Runtime domain roster (18 rows)

One row per directory under `src/domains/`. Verified: all 18 named directories still exist, plus `evidence`, `evolution`, `gateway`, `plugins`, `user-tasks` which the audit has no rows for.

| # | Harness domain | Operator-facing responsibility | GUI verdict | Gap |
| -: | --- | --- | --- | --- |
| 1 | Config | Layered settings, sources, reload class, safe edits | **Partial** | Effective graph and four safe edits are present; most groups and live reload events are absent. |
| 2 | Extensions | Package resources and precedence | **Partial** | Inventory is present; lifecycle and runtime activation controls are absent. |
| 3 | Interop | Compatibility detection and import hints | **Partial** | Path-free detection, ACP adapter state, and standing accept/decline answers reach Settings; wiring a peer and adopting foreign context remain terminal operations. |
| 4 | Resources | Skills, prompts, library catalogs | **Partial** | The skill catalog crosses whole, with its validity verdict; library inventory is present; prompts and lifecycle operations are incomplete. |
| 5 | Share | Project/resource archives and worker-result sharing | **Absent** | **deferred-by-design**: No bounded preview or confirmed operation exists. |
| 6 | Context | Project context, codewiki, working set, recall, compaction inputs | **Partial** | Effective context sources and replay are present; live accounting and mutations are absent. |
| 7 | Providers | Targets, models, auth, capability and residency | **Partial** | Target probe, model selection, and offline inventory exist; auth, authoring, and live runtime notices are absent. |
| 8 | Toolchain | Pinned optional external programs | **Partial** | The machine-readable inventory is adapted without native paths; status detail, installation, and Yazi profile reset remain terminal workflows. |
| 9 | Safety | Autonomy, permissions, loop guard, budgets, protected artifacts | **Partial** | Autonomy, mediated approval, and loop blocks are present; wider policy and budget facts are absent. |
| 10 | Prompts | Saved prompt discovery and expansion | **Absent** | Effective roots alone do not provide prompt listing or invocation. |
| 11 | Agents | Recipe discovery and execution identity | **Partial** | Reference inventory and observed attribution exist; direct execution and status are absent. |
| 12 | Middleware | Hooks, safety registrations, nudges, receipts, watchdog | **Partial** | Effective hook configuration is visible; live failures, receipts, nudges, and watchdog state are absent. |
| 13 | Session | Lifecycle, replay, branches, task and decision ledgers | **Partial** | Core lifecycle and replay are present; branches and ledgers are absent. |
| 14 | Observability | Usage, cost, durable trace, run facts | **Present** | Visible tokens, historical usage, trace accounting to the phase, and event and process shapes all cross through bounded fixed reads. |
| 15 | Scheduling | Capacity, admission, worker placement | **Partial** | Aggregate admission and heartbeat counts are present; capacity, placement, and controls are absent. |
| 16 | Mux | Pane host, pane inventory, viewer presets, Yazi bridge | **Absent** | **blocked-on-phase4** until the owning work exposes a fixed typed status read. |
| 17 | Dispatch | Worker runs, fleets, councils, compete, journals, receipts | **Partial** | Live lifecycle, aggregate status, run journals, receipt trust, fleet-root step indexes, on-demand verification, council topology, sealed gate verdicts, and local narrowing of the durable window exist; steering is absent. |
| 18 | Lifecycle | Boot, diagnostics, version, upgrade, reset, shutdown | **Partial** | Process state, recovery inspection, and the About version record exist; reviewed mutations are incomplete. |

### Domains with no row (add these)

`src/domains/evidence`, `src/domains/evolution`, `src/domains/gateway`, `src/domains/memory`, `src/domains/plugins`, `src/domains/user-tasks`. Note the audit's "Resources" row predates the split of `plugins` out of `resources`, which is what the `library` command rewrite rides on.

## B. Verdict summary (as recorded)

| Verdict | Count |
| --- | --: |
| Present | 22 |
| Partial | 61 |
| Absent | 29 |
| Total | 112 |

The four tables physically hold 113 rows (32 + 32 + 31 + 18). Treat the summary as approximate and recount after the stale rows above are corrected.

## C. Ordered implementation plan (8 items, verbatim, with a current verdict on each)

1. **Implemented:** bounded fixed-argv fleet-run inspection, recent durable event journals, receipt trust, explicit truncation, manual refresh, and automatic refresh while a displayed run remains active.
   - *Now:* the shape is right and the new app should keep automatic refresh while displayed work is nonterminal. Its `/api/traces/runs/:runId/live` SSE stream is the better mechanism.

2. **Implemented:** fixed `tools list --json` projection and searchable Toolchain Settings instrument with pinned version, license, platform support, source, found and minimum versions, install state, and no native binary or install paths.
   - *Now:* the new app went further and added install/remove. The "no native paths" clause is the part worth re-deciding rather than inheriting.

3. Add pane/mux mode, health, inventory, and status only after the phase-4 owner publishes a fixed structured read; retain `blocked-on-phase4` and do not reach into mux state, terminal environment, or process inspection.
   - *Now:* **still blocked.** Verified: `src/cli/panes.ts` exposes `--json` only on `panes install`.

4. **Implemented:** fleet-root step indexes inside the same fixed run inspection, ordered newest first, bounded to **four roots and twenty-four steps**, linking a step only to a run inside the same window. Receipt verification is done: `fleet verify <runId> --json` re-authenticates the sealed bytes on demand, reached through the host-served-id allowlist. Council topology is done too, and by grouping rather than by a new command: a council owns no durable record, so the same fixed read scans a wider slice of the same ledger and groups rows by their council provenance into **at most four councils of five voices and three rounds each**, carrying the roster, routes, rounds, plan approval, and synthesis shape but never a member's answer. Compete and review gate outcomes are done too, through a separate fixed `fleet decisions --json` read over the sealed decision store: a gate seals an integrity-covered artifact rather than mutating the receipts it grades, and the projection carries the verdict, the graded runs, the winner, and the decider's independence from the route it graded, classifying the stored reason line instead of quoting it.
   - *Now:* `src/cli/fleet-decisions.ts`, `fleet-verify.ts`, `fleet-inspect.ts` all still exist. **The bounds (4 roots / 24 steps / 4 councils / 5 voices / 3 rounds / 8 runs / 16 phases / 12 bundles) were workbench presentation bounds, not harness limits.** A GUI with real pagination should page rather than truncate, and should say what page it is on instead of saying it truncated.

5. **Partly implemented:** durable trace runs and phases reach the GUI through the fixed `trace inspect --json` read, bounded to **eight runs and sixteen phases**, carrying no request text, description, error prose, or database path; durable evidence bundles reach it through the fixed `evidence inventory --json` read, bounded to **twelve bundles**, carrying provenance, tags, totals, redaction counts, and a per-bundle trust verdict but no task text, working directory, or bundle file name; one bundle opens to its per-run trust axes through the host-served-id allowlist. Still to come: trace event tails and process views, through fixed read commands rather than arbitrary SQL, native paths, or raw payloads. **The tail is queued for the harness owner as a bounded, newest-first per-run event tail inside `trace inspect --json` (at most 32 events with start, end, and type, and either a closed-vocabulary class or a 64-byte sanitized name; row prose and process rows stay host-only).** That same change has to settle the Durable trace row, which calls row tails host-only-by-design while this item says they are still to come. The GUI does not build glue around `trace tail <runId>`, because the fixed-argv rule bars it. Building a bundle is a mutation and belongs with item 6.
   - *Now:* **superseded.** The new app reads the trace store server-side (`server/services/traces.ts`) and serves full events with `payload_json` and processes with `command`. The internal contradiction the item flags is resolved in the opposite direction from the one it proposed. Keep the rowid-cursor pagination it implies (`TraceEventsQuery`/`TraceEventsPage`/`RowCursor` already exist).

6. **Partly implemented:** every doctor check crosses as its **name, section, and verdict**, so a failing check names its subject instead of adding one to a category tally. Finding detail stays on the host permanently. External coding agent detection reaches Settings through the fixed `interop inspect --json` read: which agents this machine has, the version Clio Coder last recorded for each, whether its ACP adapter can start offline, whether a delegation entry already names it, and whether the operator's standing accept or decline still holds. The read runs no foreign executable and carries no resolved binary or agent home directory. The installed skill catalog crosses whole through the fixed `skills inventory --json` read, which reports every skill rather than only the ones the model may load, says which are which, and carries the loader's own validity verdict from the rule `skills validate` shares with it. This project's verification checks reach the atlas through the fixed `verifiers inspect --json` read: which checks exist, where each was declared, the toolchain it drives, whether verify pins its argv, and whether the project catalog parses at all. A check's exact argument vector is host-only by design, because the schema permits its entries to be absolute paths, so the executable crosses as a toolchain class and the rest crosses as a count. Still to come: safe ACP settings and operations for target/auth lifecycle, memory review, resource installation, verifier authoring and dry-run, share import/export, doctor repair, and fleet admission, each with preview, confirmation, progress, and recovery.
   - *Now:* `skills inventory --json` **moved** to `library inventory --json`. Everything else verified present.

7. Expand sanitized ACP events for context pressure and working-set activity, safety budgets and protected artifacts, provider retry/runtime notices, agent status, cost budgets, config reload, middleware failures, and shutdown phases.
   - *Now:* still open. See the event-bus artifact for the exact channels and payload types.

8. Add the remaining session-native surfaces: task and decision ledgers, branch tree/fork, side questions, handoff review, saved prompts, and transcript export. **Saved prompts wait on a fixed `prompts inventory --json` read modelled on `skills inventory --json` (name, description, argument hint, scope, source, trusted, unavailable, and diagnostic counts; no bodies, paths, or diagnostic prose), owned by the harness; no Catalog stub that lists prompt roots as present is built before it.** Contextual help is implemented for the desktop app as the searchable reference; Clio Coder's own command reference stays terminal.
   - *Now:* still open, and the `prompts inventory --json` field list is a ready-to-implement harness ticket. Note the last clause is **stale**: the new app has `/api/docs/tree|page|search` and a docs page, so Clio Coder's reference no longer stays terminal.
