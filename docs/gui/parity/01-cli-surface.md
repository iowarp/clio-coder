# GUI parity matrix — part 1: command-line surface

Extracted verbatim from `apps/workbench/PARITY.md`. Original audit anchor: commit `d41e7dd1` (`v0.4.0`), 2026-08-31, comparing `src/cli/index.ts`, `src/interactive/slash-commands.ts`, and `src/entry/orchestrator.ts` against the protocol-v4 GUI at `apps/workbench`.

## Verdict vocabulary (load-bearing — do not soften)

- **Present** — the GUI renders or drives the same authoritative fact or operation.
- **Partial** — a useful, truthful subset crosses a typed boundary.
- **Absent** — there is no GUI surface, even when a formatted terminal command exists.
- A graphical substitute is NOT claimed for destructive administration, developer-only instruments, or terminal presentation that should deliberately stay outside the app.

## Marker vocabulary

- **host-only-by-design** — a payload the workbench would not carry in any form, as distinct from one it had not carried yet. Members at audit time: event payloads, event names, process command lines, a council's deliberation, a gate's reasoning, a verification check's argument vector, an eval report's runner attachments. Bounded aggregates, topologies, classifications, and verdicts over them cross; the rows and prose never do, and the panel says so on screen rather than leaving the absence to be inferred.
- **deferred-by-design** — the remaining gap is a *mutation*, not a missing read. The workbench was read-only by decision: every adapter ran a fixed, argument-free command and changed nothing. Rows whose gap mixes a missing read with a missing mutation are deliberately left unmarked so the read half stays visible as work the GUI can still do.
- **blocked-on-phase4** — the owning surface publishes no fixed typed read command, so parity cannot be claimed honestly.

## STALENESS NOTE FOR THE NEW APP (verified 2026-09-20 against `src/` and `apps/clio-coder-gui/`)

`host-only-by-design` is **workbench policy, not a universal rule**, and the replacement app has already decided otherwise on purpose. `apps/clio-coder-gui/contracts/traces.ts` carries `payload_json` on `TraceEvent` and `command` + `command_digest` on `TraceProcess`, served over `/api/traces/runs/:runId/events` and `/api/traces/runs/:runId/processes`. The threat model changed: the workbench shipped a browser talking to a bounded ACP child over a validated protocol, the new app is a localhost server the operator started against their own machine. Do not "restore" the exclusion rule. Keep the *reasoning* (§ the exclusion-vs-redaction doctrine artifact) and re-derive the verdict per field.

## Row-count correction

The file's own verdict summary claims Present 22 / Partial 61 / Absent 29 / **Total 112**. The four tables physically contain **113** rows (32 + 32 + 31 + 18). The discrepancy is the corrupt `Worker result and archive sharing` row (part 2), whose Gap cell was eaten by an unescaped pipe.

## The table (32 rows)

| # | Harness capability | Harness operation | GUI verdict | Gap | Obsolete for the new app? |
| -: | --- | --- | --- | --- | --- |
| 1 | Interactive repository chat | Bare `clio-coder` starts the full TUI | **Partial** | ACP conversation, tools, approvals, and session replay are present, but many TUI overlays and side workflows are not. | No — still the core parity target. |
| 2 | ACP agent server | `acp` serves Clio Coder over stdio | **Present** | The GUI launches and binds one real ACP child per open project. | No — `apps/clio-coder-gui/server/acp/` keeps this. |
| 3 | Headless turn | `run` with route, autonomy, session, sampling, output, and context flags | **Partial** | The GUI drives interactive ACP turns but has no headless job form or print, JSON, JSONL, and JSON-stream output modes. | No. A "Run Lab" remains unbuilt. |
| 4 | First-run configuration | `configure` interactive wizard | **Partial** | **deferred-by-design**: The GUI edits four safe settings and probes targets; it cannot author a complete installation. | Partly — the four-key limit is superseded; see the settings artifact. |
| 5 | Target management | `targets` list/add/use/profile/remove/rename and probe | **Partial** | **deferred-by-design**: Target listing, selection, offline models, worker profiles, bindings, and explicit probes are present; lifecycle mutations are absent. | **STALE** — the new app already exposes `POST /api/workspaces/:id/targets/:targetId/use` and `/remove` alongside `/probe`. |
| 6 | Model discovery | `models [search]`, online and offline JSON inventories | **Partial** | Offline model capability inventory is present; online discovery, selection breadth, favorites, and load controls are absent. | No — favorites now have a real settings home at `chat.modelPicker.favorites`. |
| 7 | Authentication | `auth list/status/login/logout` | **Absent** | **deferred-by-design**: No credential-status or reviewed login/logout operation crosses the GUI boundary. | No. Still the right call; never route secrets through the renderer. |
| 8 | Diagnostic sweep | `doctor [--fix]` | **Partial** | **deferred-by-design**: Every check reaches Settings by name, section, and verdict; finding details, repair preview, `--fix`, and focused checks are absent. | No. Note `src/cli/` now has nine doctor modules (deep/hpc/naming/panes/slurm/state-size/task-worktrees/toolchain/validation-contract) the audit predates. |
| 9 | Resolved installation paths | `paths [--json]` | **Partial** | Recovery reports a root-resolution count but intentionally withholds native paths and has no path reference surface. | Revisit — a localhost app that already shows the workspace path has no reason to withhold install roots. |
| 10 | State reset and recovery | `reset` | **Partial** | **deferred-by-design**: Read-only installation recovery inspection is present; previewed repair, selective reset, and wipe operations are absent. | No. |
| 11 | Project context | `context` status/init/refresh/wiki/reset/index/replay/working-set | **Partial** | Effective context sources and earlier replay are visible; authoring, indexing, working-set state, recall, and reset are absent. | No — but `context-init`/`context-index`/`context-clear` are now RETIRED subcommand tombstones (`src/cli/index.ts:333`); the live path is `context <sub>`. |
| 12 | Uninstall | `uninstall` | **Absent** | **deferred-by-design**: Destructive installation removal belongs in a separate confirmed lifecycle surface. | No. |
| 13 | Upgrade | `upgrade` | **Absent** | **deferred-by-design**: The GUI has no version comparison, migration preview, or upgrade operation. | No. |
| 14 | Agent reference | `agents [--json]` | **Present** | Capability atlas renders bounded discovered-agent recipes and provenance. | No — new app has `GET /api/workspaces/:id/library/agents`. |
| 15 | Fleet lifecycle | `fleet` list/new/validate/graph/commands/run/status/view/inspect/drain/resume | **Partial** | **deferred-by-design**: Recent run inspection, bounded journal follow, and the fleet-root step index are graphical; authoring, validation, admission control, and execution are absent. | No — and `fleet decisions --json` + `fleet verify` + `fleet preflight` now exist as separate modules. |
| 16 | Evidence artifacts | `evidence` build/list/inspect | **Present** | Runs lists recent bundles and opens one to its per-run trust axes. Building a bundle stays terminal, which is a mutation rather than a read. | **STALE** — the new app already has `POST /api/workspaces/:id/evidence/:runId/build`. Also `evidence inventory --json` exists now. |
| 17 | Evaluation | `eval` run/report/compare | **Partial** | Runs lists every stored report with its outcome, route, accounting, and per-scenario result. A report's runner attachments are the whole session transcript and are **host-only-by-design**. Running an eval is execution; comparison and per-trial metric distributions are absent. | Partly — `eval` now also has `skill`, `validate`, `gate`, `--package`, `--task-file`, `--format swe-jsonl\|junit`, and `eval inventory --json`. |
| 18 | Durable memory | `memory` list/propose/promote/approve/reject/prune | **Partial** | Effective configuration can report memory presence and the catalog can describe resources, but memory records and reviewed mutations are absent. | No. `src/cli/memory.ts` still has no `--json`; a typed read is still the blocker. |
| 19 | Historical usage | `usage report` | **Present** | The project-scoped 30-day Usage record projects bounded report rows and distinguishes a missing store from zero activity. | No — new app has `GET /api/workspaces/:id/usage`. |
| 20 | Durable trace | `trace` runs/phases/tail/procs/prune/sql/ui | **Partial** | Runs renders per-run and per-phase accounting plus event and process shapes. Row-level tails and process rows are **host-only-by-design**; pruning is deferred, and arbitrary SQL must never become the GUI boundary. | **STALE on host-only** — see the staleness note above. `trace code-steps <rootId> --json` is also new. The "never expose arbitrary SQL" clause still holds. |
| 21 | Extension packages | `extensions` list/discover/install/enable/disable/remove | **Partial** | Installed extension inventory, scope, precedence, resources, and diagnostics are present; lifecycle mutations are absent. | Partly — `extensions run <id> <command>` is new; `library` now overlaps this family heavily. |
| 22 | Skills | `skills` list/search/inspect/validate/install/update/sync/eval | **Present** | Every installed skill reaches the atlas with its trust, invocability, tool policy, provenance, and the loader's own validity verdict; installed search is the atlas filter and marketplace search is the library. Installing, updating, and evaluating are mutations rather than reads. | **STALE — the command family no longer exists.** `skills` was absorbed into `library`: the reads are `library skills [--all] [--json]`, `library inventory --json`, `library validate <SKILL.md> [--json]`; the mutations are `library install/update/enable/disable/remove/pin`. |
| 23 | Resource library | `library` list/search/add/use/sync/push/remote-confirm | **Partial** | Bounded available-resource inventory is present; search across remotes and reviewed lifecycle operations are absent. | **STALE — rewritten.** See the CLI-surface-inventory artifact for the current 20-subcommand surface. |
| 24 | Verifiers | `verifiers` discover/author/validate/dry-run/add/edit/rename/remove | **Partial** | **deferred-by-design**: The atlas renders the declared check plane and the catalog's parse verdict. Each check's argument vector is **host-only-by-design**; authoring, editing, and dry-run execution are absent. | Partly — `verifiers baseline <id>` is new. New app has `GET /api/workspaces/:id/library/verifiers`. |
| 25 | External toolchain | `tools` list/status/install | **Partial** | Settings renders a path-free pinned inventory with resolution and platform facts; per-tool status detail and reviewed installation are absent. | **STALE** — the new app already has `POST /api/toolchain/tools/:toolId/install` and `/remove`, driven through `/api/operations/:id`. |
| 26 | Pane installation | `panes install` | **Absent** | **deferred-by-design**: Installation is a consequential toolchain mutation and has no GUI operation. | No. `panes install [--force] [--json]` is still the only JSON on that family. |
| 27 | Documentation server | `docs [topic]` | **Absent** | There is no contextual documentation launcher or embedded operator reference. | **STALE** — the new app has `/api/docs/tree`, `/api/docs/page`, `/api/docs/search` and a `client/pages/docs.tsx`. |
| 28 | Effective configuration command | `config inspect --json` | **Present** | Effective Clio Coder uses its bounded projection for settings, sources, precedence, reload timing, and issues. | No — new app has `GET /api/workspaces/:id/config-graph`. |
| 29 | Portable sharing | `share`, `export`, and `import` | **Absent** | **deferred-by-design**: No archive inspection, export, dry-run import, confirmation, or conflict surface exists. | No. Note `share` is registered both top-level and under `dev`. |
| 30 | Component instrument | `dev components` list/snapshot/diff | **Absent** | This developer instrument is intentionally outside the core GUI and has no separate developer canvas. | No. |
| 31 | Evolution instrument | `dev evolve` init/validate/summarize | **Absent** | Change-manifest development remains a CLI workflow. | No. |
| 32 | Version | `--version` and `version` | **Present** | Settings opens with an About record: the version Clio Coder reported in the ACP handshake, the GUI's own version from an optional bootstrap field, the ten advertised capabilities in words, and doctor's Clio Coder, Node, and platform versions beside the handshake's, labelled by source and never reconciled. The status bar names the handshake version. | No — new app has `GET /api/meta`. Keep the "labelled by source and never reconciled" rule; it is the honest thing. |

## Missing rows the new app must add

The audit predates these command families entirely; each needs its own parity row:

| Harness capability | Harness operation | Starting verdict | Note |
| --- | --- | --- | --- |
| MCP servers | `mcp` (7 `--json` call sites in `src/cli/mcp.ts`) | **Absent** | Has machine-readable output already; a typed read is available today. |
| GUI lifecycle | `gui` (`src/cli/gui.ts`) | n/a | This is the launcher for the app itself; it replaces the workbench's `scripts/gui-lifecycle.ts`. |
| Task ledger (CLI) | `tasks` (`src/cli/tasks.ts`) | **Absent** | No `--json` yet — the typed read is the blocker, same shape as memory. |
| Fleet preflight | `fleet preflight` (`src/cli/fleet-preflight.ts`) | **Absent** | Admission dry-run; the natural first mutation-adjacent GUI surface. |
