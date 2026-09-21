# GUI parity matrix — part 2: slash-command families and interactive surfaces

> **Reference Design & Planning Blueprint**: This document is an architectural reference blueprint recovered from the deleted `apps/workbench` prototype. It specifies design doctrine, target parity, and inspection layouts for the early GUI preview (`apps/clio-coder-gui`), not verified runtime features of the core v0.5.0 terminal engine.

Extracted from `apps/workbench/PARITY.md`. Verdict and marker vocabulary is defined in part 1.

## A. Slash-command families (32 rows)

Two rows in the source are **corrupt Markdown**: an unescaped `|` inside the operation cell shifted the columns and destroyed the Gap cell. Both are reconstructed below and marked `[RECONSTRUCTED]`.

| # | Harness capability | Interactive operation | GUI verdict | Gap |
| -: | --- | --- | --- | --- |
| 1 | Quit | `/quit` | **Partial** | A browser can close or switch projects, but there is no explicit graceful child-shutdown control. |
| 2 | Help reference | `/help [query]` | **Partial** | A searchable desktop-app reference opens from the Observatory header and the status bar with no project and no connection: every view, every keybinding from the one typed table the handlers also read, working freedom, vocabulary, and boundaries. Clio Coder's own command list stays terminal. |
| 3 | Skill selection and invocation | `/skill [name] [task]` | **Partial** | Installed skills are searchable in the atlas, but explicit invocation and the selector workflow are absent. |
| 4 | Resource library | `/library [kind]` | **Partial** | Read-only library cards are present; install/use flows are absent. |
| 5 | Saved prompts | `/prompts` | **Partial** | Effective prompt roots are visible, but saved-prompt selection and expansion are absent. |
| 6 | Extensions | `/extensions` | **Partial** | **deferred-by-design**: Installed extensions are visible; interactive enablement and lifecycle controls are absent. |
| 7 | Interoperability | `/interop` | **Partial** | Settings names every detected coding agent, its version, its ACP adapter, and how far it is wired. Reviewing and wiring a peer stays an explicit terminal operation. |
| 8 | Worker result and archive sharing | `/share [runId]`, `/share export \| import` | **Absent** | `[RECONSTRUCTED]` — the source row is corrupt; the Gap cell was consumed by the unescaped pipe in `export \| import`. Reconstructed intent, cross-checked against the `Portable sharing` row in part 1: no archive inspection, export, dry-run import, confirmation, or conflict surface exists, and sharing a worker result is a mutation with no GUI operation. |
| 9 | Attributed worker run | `/run <agent> <task>` | **Partial** | ACP tools expose live attributed dispatch activity, but the operator cannot directly start an addressable worker run. |
| 10 | Delegation | `/delegate <agent> <task>` | **Partial** | Delegated tool calls are attributed when Clio Coder creates them; there is no direct operator control. |
| 11 | Side question | `/btw <question>` | **Absent** | The GUI has no isolated, non-transcript side-question round. |
| 12 | Oracle advisory | `/oracle <question>` | **Absent** | No read-only record-briefed advisory operation exists. |
| 13 | Council | `/council <task>` | **Partial** | Runs reconstructs the roster, plan approval, rounds, and synthesis shape from the ledger. Member voices are **host-only-by-design**; starting and sharing a council are absent. |
| 14 | Agent reference | `/agents` | **Present** | Capability atlas provides the graphical recipe reference. |
| 15 | Usage record | `/usage` | **Partial** | Exact tokens and historical reported cost exist, but live session cost, budget provenance, and provider-normalized totals are incomplete. |
| 16 | Context family | `/context view \| compact \| recall \| init \| refresh \| reset` | **Partial** | `[RECONSTRUCTED]` — the source row is corrupt for the same reason. Verified against `src/interactive/slash-commands.ts:1695-1705`, whose `kinds` are `context-view, compact, context-recall, init, context-clear, context-refresh`. Reconstructed gap, consistent with the `Project context` row in part 1 and the `Context meter and overlay` row below: effective context sources and earlier replay are visible; live window pressure, working-set state, compaction, recall, and reset have no GUI surface. |
| 17 | Fleet | `/fleet` settings and `/fleet run` preview/approval | **Partial** | Global dispatch status exists; fleet plan selection, variable binding, preview, approval, and run are absent. |
| 18 | Decision ledger | `/decisions` | **Absent** | No typed decision-board projection reaches the GUI. |
| 19 | Task ledger | `/tasks`, add/hand/done/drop | **Absent** | No user-task board or reviewed task mutations reach the GUI. |
| 20 | Memory | `/memory [seed]` | **Partial** | Configuration presence is visible, but lesson/bank/activity inspection and seeding are absent. |
| 21 | Fleet run board and verification | `/view [filter]`, `/view verify <runId>` | **Partial** | Recent durable runs, journals, sealed receipt trust, the fleet-root step index, and on-demand verification are present. The Runs board narrows the fixed eight-run window locally by outcome, agent, node, fleet lineage, receipt state, and prefix text, and its count sentence names the bound; nothing reaches the host and older runs stay outside the window. Terminal `/view` filters over history remain absent. |
| 22 | Panes and mux | `/panes`, show/open/close | **Absent** | No pane host health, inventory, presets, viewer focus, or close controls exist; status parity is **blocked-on-phase4** because the owning surface has no public typed read command. |
| 23 | Reasoning level | `/thinking [level]` | **Present** | The Settings instrument edits the safe next-turn thinking level. |
| 24 | Output verbosity | `/output [verbosity]` | **Absent** | Terminal transcript verbosity is presentation-specific and should not become a dead ACP setting. |
| 25 | Model picker | `/model [pattern]` | **Partial** | Settings selects configured target/model and shows offline inventory, but the richer recent/favorite/search picker is absent. |
| 26 | Settings center | `/settings [section]` | **Partial** | Four safe settings plus routing and recovery inventories are graphical; most root setting groups remain read-only or unavailable. |
| 27 | Resume | `/resume` | **Present** | The project rail lists, searches by visible labels, and resumes Clio Coder sessions with replay. |
| 28 | New session | `/new` | **Present** | New session creation is explicit and bound to the open project. |
| 29 | Handoff | `/handoff <goal>` | **Absent** | **deferred-by-design**: There is no extraction round, review editor, or new-session handoff operation. |
| 30 | Session tree | `/tree` | **Absent** | The GUI replays one active path but cannot inspect or switch branches. |
| 31 | Fork | `/fork` | **Absent** | **deferred-by-design**: No message picker or branch-from-turn operation crosses ACP. |
| 32 | Transcript export | `/export [path]` | **Absent** | No HTML transcript preview/export workflow exists. |

### Slash-command drift, verified against `src/interactive/slash-commands.ts` (2026-09-20)

The live registry is 40 commands: `background editor interrupt notifications quit help skill library skills prompts mcp doctor extensions share archive run delegate btw oracle council interop agents cost context fleet decisions tasks memory view panes files thinking model settings resume new handoff tree fork export`.

**Retired since the audit — delete row 24:** `/output` no longer exists. Transcript verbosity moved into the settings schema as `interface.outputDetail` (`compact|standard|detailed`), hot-reloadable, with Alt+O cycling it. The parity verdict text is now wrong in a way that matters: it says the switch "should not become a dead ACP setting", but it is a live settings key today and belongs on the settings write surface, not in this table.

**New since the audit — nine rows to add, all starting at Absent unless noted:**

| Harness capability | Interactive operation | Note for the new GUI |
| --- | --- | --- |
| Background work | `/background` | Detach the running turn. High value for a GUI that wants a non-blocking viewport. |
| External editor | `/editor [text]` | Deliberately out of scope for a browser app — keep Absent with the same reason as the `External editor and inline bash` row. |
| Steering | `/interrupt <text>` | Mid-turn steering injection. This is the missing half of "the operator can shape a running turn" and should be a first-class GUI composer affordance. |
| Notifications | `/notifications [dismiss [all]]` | Maps onto a GUI notification tray. |
| Skills (read) | `/skills` | Now distinct from `/skill`; reads the installed catalog. |
| MCP | `/mcp [list\|trust\|untrust] [id] [class]` | A trust mutation with a closed vocabulary — a good, bounded first write surface. |
| Doctor | `/doctor [deep]` | Interactive diagnostic sweep. |
| Archive | `/archive export\|import <path> [--dry-run] [--force]` | The reviewed transfer flow; `--dry-run` already gives the GUI a preview stage for free. |
| Files | `/files` | Yazi/pane file picker — **blocked-on-phase4**, same as `/panes`. |

## B. Interactive surfaces and instruments (31 rows)

This is the component-level checklist. Read it as the build list for the chat viewport, the dispatch board, and the evidence surfaces.

| # | Harness capability | TUI or harness surface | GUI verdict | Gap |
| -: | --- | --- | --- | --- |
| 1 | Main conversation | Streaming narrative, reasoning, tools, approvals, terminal outcome | **Present** | Conversation and Session Timeline project the same validated ACP evidence record. |
| 2 | Composer and stop | Multiline editor, submit, cancel | **Present** | The GUI has an isolated request editor, explicit send, and turn cancellation. |
| 3 | Tool activity | Running/completed/failed tool renderers and disclosure | **Present** | Folded activity groups preserve exact tool state and provenance. |
| 4 | Permission overlay | Consequential tool preview and explicit decision | **Partial** | Allow once/reject is present; richer policy, mutation diff, escalation provenance, and persistent rules are absent. |
| 5 | Ask-user interview | Structured options, free text, cancellation | **Partial** | Standard ACP permission is interactive, but the separate `ask_user` question protocol is not projected. |
| 6 | Session picker | Resume, label, delete, missing working directory recovery | **Present** | GUI sessions support resume/replay, rename, delete, close, and unknown-state disclosure. |
| 7 | Session tree and fork picker | Branch graph, switch, fork from message | **Absent** | ACP exposes neither branch topology nor switch/fork operations. |
| 8 | Welcome dashboard | Route, context, shortcuts, recent state | **Partial** | First-run guidance, current route, project atlas, and Observatory exist; command shortcuts and context health are narrower. |
| 9 | Footer and live status | Phase, route, context pressure, cost, tasks, notifications | **Partial** | Phase, route, autonomy, operation, tokens, and event counts exist; pressure, live cost, tasks, retry, watchdog, and capacity are absent. |
| 10 | Context meter and overlay | Window pressure, working set, prune/recall, compaction | **Absent** | Earlier replay is not a live context-pressure or working-set instrument. |
| 11 | Cost overlay | Session/model token and cost accounting | **Partial** | Visible usage, historical usage, and durable per-run and per-phase cost are present; live normalized cost and budget state are absent. |
| 12 | Dispatch board | Filterable run rows, progress, receipts, steering | **Partial** | ACP fleet activity, installation aggregate, durable run detail, journal, receipt trust, root step index, local filters over the durable window, and a running-only toggle on the live strip exist; steering is absent. |
| 13 | Run-event journal | Durable per-run NDJSON transcript and follow | **Present** | Runs renders a bounded event spine for the eight newest runs and refreshes while displayed work remains nonterminal. |
| 14 | Fleet root inspection | Planned step index and terminal run ids | **Present** | Runs indexes recent roots to their planned step order, terminal run ids, attribution, and failure reason, and links steps into the window. |
| 15 | Council | Roster preview, approval, rounds, member grid, synthesis | **Partial** | Runs groups the ledger into councils and renders the seated grid, each voice's route and rounds, and the synthesis shape. The voices are **host-only-by-design**. |
| 16 | Compete | Parallel candidates, judge/gate decision, winner, cleanup evidence | **Partial** | Runs renders the sealed gate verdict, the graded candidates, the winner, and the judge's independence. Candidate diffs and the judge's reasoning are host-only. |
| 17 | Receipt trust and verify | Sealed receipt status and `/view verify` host check | **Partial** | Runs projects sealed receipt trust, per-bundle evidence verdicts, and an on-demand re-check of the sealed bytes, all without native paths. |
| 18 | Task and decision boards | Inspect and mutate session ledgers | **Absent** | Neither ledger is part of protocol v4. |
| 19 | Memory overlay | Lessons, task bank, activity, promotion | **Absent** | Memory configuration facts do not expose records or mutations. |
| 20 | Resource overlays | Agents, skills, prompts, extensions, library | **Partial** | Agents, the full installed skill catalog with its verdict, extensions, and library inventories are present; prompts and reviewed mutations are incomplete. |
| 21 | Settings overlay | Effective values, sources, timing, routing, auth | **Partial** | Effective inspection and safe settings are strong; most settings, auth, and target authoring are absent. |
| 22 | Model selector | Search, recent/favorite, capability-aware selection | **Partial** | Configured model selection and offline capability search exist; recent/favorite and endpoint discovery are absent. |
| 23 | Auth dialog | Runtime credential connection | **Absent** | **deferred-by-design**: No typed credential mutation is exposed to the browser. |
| 24 | External editor and inline bash | Editor round trip and `!command` | **Absent** | The GUI intentionally does not become a terminal emulator or embedded IDE. |
| 25 | Notifications and retry | Notices, provider retry, stall and watchdog state | **Partial** | Command errors and operation states are visible; structured retry/watchdog/runtime notices are not public ACP facts. |
| 26 | Panes and mux inventory | Host detection, health, pane list, focus/open/close | **Absent** | **blocked-on-phase4**: no public fixed JSON read exists and this pane must not change `src/domains/mux` or `src/interactive`. |
| 27 | Yazi round trip | File picker pane, picked path return, focused context | **Absent** | The new terminal/mux round trip is not an ACP operation and is also **blocked-on-phase4** for GUI parity. |
| 28 | Toolchain inventory | Pinned versions, license, platform, source, resolution, install state | **Present** | Settings renders the fixed listing with version floors, found versions, licenses, platform support, resolution source, and install state. |
| 29 | Doctor and recovery | Categorized diagnostic sweep and repair | **Partial** | Per-check identity, section, and verdict sit under the bounded counts; finding detail and confirmed repair remain intentionally absent. |
| 30 | Usage and routing | Historical Usage, offline models, profiles, agent bindings | **Present** | Project scoping, independent failures, provenance, and missing-store states are explicit. |
| 31 | Catalog and config | Agent/skill/extension/library/check inventory and effective config | **Present** | Bounded projections and direct paths back to the conversation are present. |

### Rows verified stale against `apps/clio-coder-gui/` (2026-09-20)

- **Row 26/27 (panes, Yazi)** — still correctly `blocked-on-phase4`. `src/cli/panes.ts` has exactly one `--json`, on `panes install`. No typed status read exists. But note the settings schema now carries a full `interface.panes.*` subtree (`enabled`, `notifications`, `layout`, `workers.ratio`, `files.{enabled,mode,profile,followCwd,ratio}`), so the *configuration* half is reachable even while the *runtime status* half is not. Do not conflate them.
- **Row 12 (dispatch board)** — the new app already serves `/api/fleet/runs`, `/api/fleet/dispatches`, `/api/fleet/receipts/:id`, `/api/fleet/councils`, `/api/fleet/gates`. Steering remains absent, and `/interrupt` (new slash command) is the harness capability that would close it.
- **Row 17 (receipt trust)** — `POST /api/workspaces/:id/receipts/:runId/verify` exists in the new app.
- **Row 19 (memory overlay)** — still correct. `src/cli/memory.ts` has zero `--json`; the typed read remains the blocker.
- **Row 18 (task/decision boards)** — `/decisions` and `/tasks` are live slash commands and `src/cli/tasks.ts` is a registered CLI family, but neither emits JSON. Still correctly Absent, for the same reason.
