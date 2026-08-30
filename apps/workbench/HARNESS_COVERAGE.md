# Clio harness → Workbench coverage ledger

This is the working inventory for bringing the full Clio Coder harness into Clio Workbench without reimplementing the
harness in the GUI. It is deliberately stricter than a feature wish list: every row names the authoritative public
boundary that exists today, the UI coverage that actually exists, and the boundary that must be added before a truthful
control or visualization can exist.

Audit anchor: immutable harness commit `8874a3ff`, the 2026-08-29 `v0.3.9` sprint snapshot. Workbench protocol version:
3. The audit read Clio's CLI registry, default settings schema, change classifier, ACP server, canonical event bus, and
current Workbench host/renderer protocol. It made no changes under the repository's root `src/`.

## Status vocabulary

| Status                | Meaning                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Wired**             | A real Clio operation or fact crosses a validated Workbench boundary and has a usable graphical surface.     |
| **Partial**           | Part of the domain is real and graphical, but material controls, facts, or states are absent.                |
| **Workbench-ready**   | A public, structured Clio interface exists; a Workbench-only adapter and UI can be built without root edits. |
| **Upstream boundary** | Clio does not expose the required typed operation/fact to its ACP client; root harness work is required.     |
| **Separate surface**  | Real functionality, but destructive, administrative, or developer-oriented enough to stay out of the core.   |
| **Not applicable**    | The setting controls the terminal/TUI rather than an ACP client and should not be mirrored as a dead switch. |

“Workbench-ready” does not authorize parsing private state files. Prefer a documented JSON/JSONL command or a typed ACP
extension over coupling the GUI to a durable store's internal layout.

## Architectural finding

Workbench already owns a strong local application boundary: one validated WebSocket protocol, one bounded project, and
one real `clio-coder acp` child per selected project. Clio remains authoritative for the session and model work.

The limiting boundary is Clio's public ACP surface, not React:

- Standard/proposed ACP operations cover initialize, new/load/close session, prompt, cancel, and mediated permission.
- Clio extensions cover session list/label/delete, session autonomy, safe settings get/patch, and target list/probe.
- Terminal metadata carries the five exact token fields `input`, `output`, `cacheRead`, `cacheWrite`, and `reasoning`.
- The opt-in `clio-coder/event` stream currently exposes only `safety.loopBlocked`.
- The in-process harness bus has 41 canonical channels, including dispatch, context, capacity, cost, safety, config,
  compaction, middleware, status, and shutdown facts. Forty of those channels are not public ACP events today.

Therefore a graphical fleet board, live context-pressure instrument, capacity view, cost ledger, config-reload inbox, or
agent-status map would be fictional if built solely from today's Workbench protocol. Those surfaces need a sanitized,
versioned ACP event extension first. Workbench must never import root harness modules or infer those facts by process
inspection.

## Current Workbench protocol footprint

Workbench protocol v3 currently validates 25 client commands:

`project.browse`, `project.open`, `project.select`, `project.forget`, `fs.refresh`, `fs.create-file`,
`fs.create-folder`, `fs.move`, `fs.delete.prepare`, `fs.delete.confirm`, `session.new`, `session.load`, `session.close`,
`session.list`, `session.label`, `session.delete`, `turn.start`, `turn.cancel`, `permission.resolve`, `settings.get`,
`settings.patch`, `targets.list`, `targets.probe`, `autonomy.set`, and `config.inspect`.

It validates 23 server event kinds:

`connection.ready`, `project.browse.listing`, `project.opened`, `project.forgotten`, `project.snapshot`, `fs.changed`,
`fs.delete.challenge`, `clio.state`, `session.list`, `settings.state`, `targets.state`, `targets.probed`,
`config.state`, `turn.started`, `turn.text`, `turn.thought`, `turn.tool`, `turn.loop`, `turn.permission.requested`,
`turn.permission.resolved`, `turn.terminal`, `protocol.error`, and `command.error`.

That closed set is an asset. New harness areas should enter as small typed DTO families, not as a generic “run CLI” or
“render JSON” escape hatch.

## Human workflow coverage

| Harness area                               | Current GUI                                                                                       | Status                                                                                 | Real boundary and next honest step                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose and remember project folders        | Folder picker, recent projects, missing-folder recovery, guarded roots                            | **Wired**                                                                              | Workbench-local boundary; no Clio change required.                                                                                                                                                                                            |
| Bounded project files                      | Tree refresh, create file/folder, rename/move, version-aware confirmed delete                     | **Wired**                                                                              | Workbench-local boundary. Reading/editing file content remains Clio tool work, not an embedded IDE.                                                                                                                                           |
| Interactive main-agent turn                | Request composer, streamed narrative/reasoning, tool lifecycle, stop, terminal outcome            | **Wired**                                                                              | Standard ACP prompt/update plus strict presentation DTOs.                                                                                                                                                                                     |
| Turn token output                          | Five exact fields on outcome cards and a visible-record Observatory comparison                    | **Wired**                                                                              | Clio terminal `_meta["clio-coder/usage"]`; never converted to price or context pressure by Workbench.                                                                                                                                         |
| Session lifecycle                          | New, list, resume/replay, close, rename, delete, truncation and unknown-state handling            | **Wired**                                                                              | ACP plus the versioned `clio-coder/session` extension.                                                                                                                                                                                        |
| Session route                              | Bound target/model and next-turn target/model are distinguished                                   | **Wired**                                                                              | ACP session metadata plus safe settings extension.                                                                                                                                                                                            |
| Working freedom                            | Bound-session autonomy and next-session default are distinguished; per-session change is explicit | **Wired**                                                                              | ACP session autonomy plus safe settings extension.                                                                                                                                                                                            |
| Configured targets                         | List, model ids, selected target, explicit probe result/latency/time                              | **Partial**                                                                            | ACP target list/probe is real. Add/convert/remove/rename, capabilities, auth detail, fleet profiles, and richer model discovery are absent.                                                                                                   |
| Permissions                                | One-use allow/reject, expiry, cancellation semantics, locations, persistent banner, keyboard path | **Partial**                                                                            | Standard ACP permission is wired. Policy rule, action class, posture, rejection hints, worker escalation provenance, and “why” need a sanitized upstream DTO.                                                                                 |
| Loop safety                                | Repeated-call count, per-turn block budget, disposition, interruption                             | **Wired**                                                                              | The sole current `clio-coder/event` kind, `safety.loopBlocked`.                                                                                                                                                                               |
| Other safety                               | Tool-call soft/hard budgets, policy classifications/blocks/allows, run-abort source, budget alert | **Upstream boundary**                                                                  | Typed bus facts exist but are not exposed over ACP.                                                                                                                                                                                           |
| Context and compaction                     | Earlier session replay is visible and honestly marked                                             | **Partial**                                                                            | Status/init/refresh/wiki/reset/index, working-set state, pruning/recall, pressure, warnings, and compaction progress are not exposed to the ACP client. Several read-only CLI paths can seed later views.                                     |
| Prefix pre-warming                         | No GUI fact or control                                                                            | **Upstream boundary**                                                                  | `prewarm.enabled` exists at the audited harness commit, but safe settings and lifecycle outcomes do not cross ACP. Never infer a cache hit from latency.                                                                                      |
| Agents and recipes                         | No GUI catalog                                                                                    | **Workbench-ready**                                                                    | `clio-coder agents --json` provides a structured read-only catalog. Addressable execution still requires dispatch operations/events.                                                                                                          |
| Headless main-agent run                    | No separate GUI lab                                                                               | **Workbench-ready**                                                                    | `clio-coder run --json` exposes a structured stream, but the main notebook already serves interactive ACP. Add only for reproducible batch studies, with explicit run/session semantics.                                                      |
| Dispatch and fleet                         | No run board, graph, admission, retry, node, endpoint, or gate view                               | **Upstream boundary** for live state; **Workbench-ready** for some read-only snapshots | CLI has JSON for validate/graph/status and run receipts. Live enqueued/started/progress/completed/failed, endpoint slot limits, budgets, costs, nodes, councils, gates, retries, and skill activations exist only on the bus/durable ledgers. |
| Evidence artifacts                         | No evidence library                                                                               | **Workbench-ready** for basic build/list/inspect                                       | Public CLI exists, but it needs a stable machine schema before rich cards should depend on it. Do not scrape the formatted table.                                                                                                             |
| Evaluations                                | No suite runner or comparison surface                                                             | **Workbench-ready**                                                                    | Public validate/run/report/compare/gate commands exist; JSON, Markdown, SWE JSONL, and JUnit reports can support a dedicated Experiment surface.                                                                                              |
| Scoped memory                              | No review inbox                                                                                   | **Workbench-ready** for command orchestration; schema review needed                    | Public list/propose/promote/approve/reject/prune commands exist. Approval and evidence linkage should become a deliberate review surface, never an automatic side effect of opening Workbench.                                                |
| Cross-session usage/economics              | Per-turn token fields only                                                                        | **Partial**                                                                            | `clio-coder usage report --json` is read-only and cites facts/opportunities. A Workbench-only adapter can add a historical Usage notebook; costs must retain Clio's provenance.                                                               |
| Durable dispatch trace                     | No trace explorer                                                                                 | **Workbench-ready**                                                                    | `trace runs --json` is structured; phases/tail/procs/sql are read-only but not uniformly JSON. Prefer a bounded query DTO over exposing arbitrary SQL in the core GUI.                                                                        |
| Skills                                     | No discovery, inspection, trust, install, update, sync, or eval surface                           | **Workbench-ready** for catalog/inspection                                             | List/search/inspect/validate/eval have JSON paths. Install/update/sync mutate resources and need review/confirmation states. Skill activation during live worker runs still needs upstream events.                                            |
| Extensions                                 | No package manager                                                                                | **Workbench-ready**                                                                    | List/discover/install/enable/disable/remove support JSON. Keep supply-chain provenance, project/user scope, and force semantics visible.                                                                                                      |
| Library                                    | No agent/prompt/fleet/skill catalog                                                               | **Workbench-ready**                                                                    | List/search/add support JSON. Use/sync/push/remote confirmation need a separate reviewed resource surface.                                                                                                                                    |
| Project verifiers                          | No checks catalog/authoring UI                                                                    | **Workbench-ready** with schema work                                                   | Public discover/author/validate/dry-run/add/edit/rename/remove exists. Mutations already preview exact argv/cwd/timeout/tags/authority and should retain those facts graphically.                                                             |
| Config provenance                          | Effective Clio map plus four session-routing settings                                             | **Wired**                                                                              | A bounded host adapter runs fixed `clio-coder config inspect --json`, redacts values and unsafe paths, and projects provenance, trust, precedence, reload timing, context cost, and grouped issues into typed DTOs.                           |
| Harness components and evolution manifests | No developer instrument                                                                           | **Separate surface**                                                                   | `components list --json`, snapshots/diffs, and `evolve manifest` are harness-development tools; keep them out of the primary research notebook.                                                                                               |
| Portable share archives                    | No import/export flow                                                                             | **Separate surface**                                                                   | Public share inspect/import/export exists. Import is a consequential resource mutation and needs diff, scope, conflict, and confirmation stages.                                                                                              |
| Doctor and paths                           | Startup failures only                                                                             | **Partial**                                                                            | `doctor` and `paths --json` can support a Recovery panel. `doctor --fix` is a separate explicit repair action.                                                                                                                                |
| Configure/auth/models                      | No setup wizard beyond selecting existing target/model                                            | **Partial**                                                                            | Full configure, target authoring, model search, and auth login/logout are not ACP operations. A first-run setup surface needs typed APIs or carefully isolated CLI workflows. Never pass secrets through the renderer.                        |
| Upgrade/reset/uninstall                    | No GUI                                                                                            | **Separate surface**                                                                   | Destructive or installation-level operations. If added, resolve exact paths first, show recoverability, and require explicit confirmation outside the core notebook.                                                                          |
| Docs                                       | No embedded docs server                                                                           | **Separate surface**                                                                   | Link contextual help or launch the public docs surface; do not turn the main shell into a documentation browser.                                                                                                                              |

## CLI surface inventory

Every currently registered user or harness command is accounted for here. “No core GUI” means the capability is not
forgotten; it is routed to a later bounded surface or an upstream interface request.

| Command family                  | Subcommands / significant knobs                                                                                                                                          | Workbench routing                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Bare interactive                | `--api-key`, `--no-context-files`, hidden `--no-skills` / explicit skill paths                                                                                           | The GUI uses ACP instead; project-context and skill policy need typed settings, while API keys must stay host-side. |
| `acp`                           | One stdio agent process pinned to a cwd                                                                                                                                  | Core transport; wired.                                                                                              |
| `run`                           | target/model/thinking/autonomy, sampler controls, context/KV controls, JSON modes, steering, resume, agent/profile/runtime/tool profile, capability requirements, skills | Later reproducible Run Lab. Interactive work remains the notebook.                                                  |
| `configure`                     | Runtime/URL/model/capability setup and default routing                                                                                                                   | Setup surface; needs typed secret-safe host operations.                                                             |
| `targets`                       | list/probe/add/use/fleet/profile list/set/remove/rename/bind/unbind/bindings, convert, remove, rename                                                                    | List/probe and next-turn routing wired; authoring/profiles absent.                                                  |
| `models`                        | List/search models for configured targets                                                                                                                                | Model picker is partial; global discovery/search absent.                                                            |
| `auth`                          | list/status/login/logout by target/runtime                                                                                                                               | Setup/security surface; upstream typed operation preferred.                                                         |
| `config inspect`                | Effective customization graph, JSON                                                                                                                                      | Next read-only provenance surface.                                                                                  |
| `doctor`, `paths`               | Diagnose/fix; resolve directories with JSON                                                                                                                              | Recovery surface.                                                                                                   |
| `reset`, `uninstall`, `upgrade` | State/config reset, full removal, binary unlink, upgrade/migrations                                                                                                      | Separate destructive/installation surface.                                                                          |
| `context`                       | status, init, refresh, wiki, reset, index, replay, working-set                                                                                                           | Context Observatory; read-only JSON adapters first, mutations after typed progress/events.                          |
| `agents`                        | User-facing/all recipes, JSON                                                                                                                                            | Read-only catalog ready.                                                                                            |
| `fleet`                         | list/new/validate/graph/commands init/run/status/drain/resume                                                                                                            | Experiment/Fleet surface; live events require ACP expansion.                                                        |
| `evidence`                      | build by run/session/eval, inspect, list                                                                                                                                 | Evidence library after stable machine projection.                                                                   |
| `eval`                          | validate/run/report/compare/gate                                                                                                                                         | Experiment surface.                                                                                                 |
| `memory`                        | list/propose/promote/approve/reject/prune                                                                                                                                | Memory review inbox.                                                                                                |
| `usage report`                  | repository/window filters, JSON facts and opportunities                                                                                                                  | Historical usage/economics notebook.                                                                                |
| `trace`                         | runs/phases/tail/procs/sql/ui                                                                                                                                            | Bounded trace explorer; never expose arbitrary SQL as the default non-engineer path.                                |
| `extensions`                    | list/discover/install/enable/disable/remove, scopes, JSON                                                                                                                | Reviewed Extensions surface.                                                                                        |
| `skills`                        | list/search/inspect/validate/install/update/sync/eval                                                                                                                    | Skills laboratory and trust manager.                                                                                |
| `library`                       | list/search/add/use/sync/push/remote confirm                                                                                                                             | Resource library.                                                                                                   |
| `verifiers`                     | discover/author/validate/dry-run/add/edit/rename/remove                                                                                                                  | Graphical project-check catalog.                                                                                    |
| `docs`                          | topic server, no-open                                                                                                                                                    | Contextual help / external docs.                                                                                    |
| `dev components`                | list/snapshot/diff                                                                                                                                                       | Developer instrument, not core GUI.                                                                                 |
| `dev evolve`                    | manifest init/validate/summarize                                                                                                                                         | Developer instrument.                                                                                               |
| `dev share`, `export`, `import` | inspect/export/import portable resources                                                                                                                                 | Separate reviewed transfer surface.                                                                                 |
| `version`                       | Version fact                                                                                                                                                             | Agent version is already carried by ACP initialize and should be shown in diagnostics/about.                        |
| `worker`                        | Internal NDJSON worker server                                                                                                                                            | Never directly exposed as an operator control.                                                                      |

## Settings schema coverage

The root schema is strict and machine-owned. Workbench's current safe settings extension exposes exactly
`orchestrator.target`, `orchestrator.model`, `orchestrator.thinkingLevel`, and `autonomy`; the GUI must not pretend the
rest are editable merely because their YAML keys are known.

| Root setting group               | Current GUI                                    | Required graphical treatment / boundary                                                                                                               |
| -------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                        | Hidden                                         | Schema metadata, diagnostics only.                                                                                                                    |
| `autonomy`                       | **Wired**                                      | Plain-language default for the next session; bound-session autonomy stays separate.                                                                   |
| `targets`                        | **Partial**                                    | Read/probe/select exists. Full descriptors, capabilities, URLs, secrets, authoring, conversion, and removal need typed host operations.               |
| `runtimePlugins`                 | None                                           | Extensions/runtime setup; restart-required and supply-chain sensitive.                                                                                |
| `orchestrator`                   | **Wired**                                      | Target/model/thinking with next-turn timing.                                                                                                          |
| `background`                     | None                                           | Memory-maintenance route; needs safe ACP settings and cost explanation.                                                                               |
| `memory.intervention`            | None                                           | Enabled/cadence/window/max tokens/timeout; pair with observed memory steps, not controls alone.                                                       |
| `watchdog`                       | None                                           | Enabled/target/cadence. Harness documentation says ACP runs do not fire it, so a Workbench switch would currently be dead.                            |
| `workers`                        | None                                           | Default/profile/roster/bindings/retries/permission escalation/resilience; Fleet surface plus typed events.                                            |
| `fleet.nodes`                    | None                                           | SSH node identity, capacity, labels, residency; secret/path handling and preflight required.                                                          |
| `routing`                        | None                                           | Activated roles/postures and exact agent-role pairs; show shadow vs active decisions when events exist.                                               |
| `scope`                          | None                                           | Model-cycle scope; typed setting and model catalog required.                                                                                          |
| `modelSelector`                  | None                                           | Favorites/recent limit; useful in the graphical picker after safe settings expand.                                                                    |
| `budget`                         | None                                           | Session USD ceiling and concurrency. Needs live cost provenance and restart timing before controls.                                                   |
| `defaults.maxTokens`             | None                                           | Next-turn output bound; explain model/context clamps rather than promising the requested number.                                                      |
| `theme`                          | None                                           | Clio terminal theme, not Workbench's design tokens; **not applicable** to the browser shell.                                                          |
| `terminal`                       | Desktop notifications are Workbench-local only | Progress, transcript verbosity, TUI mode, scrollbar, and stream pacing are terminal presentation: **not applicable**. Never mirror dead TUI switches. |
| `skills.trustProjectCompatRoots` | None                                           | Trust boundary. Needs clear project/user provenance and next-turn timing.                                                                             |
| `library`                        | None                                           | Catalog/remote/confirmation/sync in the Resource library.                                                                                             |
| `attribution.gitCommits`         | None                                           | Commit evidence policy; safe setting plus commit-provenance output.                                                                                   |
| `delegation`                     | None                                           | External ACP agents, timeouts, tool governance, bounded context, labels; security-sensitive Agent setup.                                              |
| `keybindings`                    | Workbench owns its own shortcuts               | Clio TUI bindings are **not applicable**; Workbench shortcuts need their own accessible registry.                                                     |
| `compaction`                     | None                                           | Auto/threshold/recent protection/model/prompt; needs pressure and compaction events before a calibrated control.                                      |
| `context.workingSet`             | None                                           | Enabled/policy/target/recent protection/minimum size; pair controls with prune/recall ledger facts.                                                   |
| `prewarm.enabled`                | None                                           | Local-native only; needs safe setting and reported prewarm/cache outcome.                                                                             |
| `retry`                          | None                                           | Interactive provider retry/stall bounds; needs retry status events and next-turn setting.                                                             |
| `guardrails`                     | None                                           | Numeric behavioral backstops; safety surface with exact effective source and restart/turn timing.                                                     |

## Canonical event coverage

The event bus is grouped below so new upstream work can expose a small, sanitized projection rather than dumping raw bus
payloads across ACP.

| Bus group         | Channels                                                           | Workbench coverage                                                                                                    |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Session           | `session.start/end/parked/resumed/turn_switched`                   | Functional session operations are wired, but these lifecycle events are not public. Branch/turn switching has no GUI. |
| Domain            | `domain.loaded/failed`                                             | **Upstream boundary**; useful in diagnostics, not the notebook. Never forward raw `error`.                            |
| Config            | `config.hotReload/nextTurn/restartRequired/reloadFailed`           | Safe patch response is wired; live change/reload classification is absent. Sanitize settings out of the event.        |
| Permission        | `permission.requested/resolved`                                    | Standard ACP permission is partial; richer policy/escalation provenance is absent.                                    |
| Safety            | `safety.classified/blocked/allowed/loopBlocked/toolBudgetExceeded` | Only `loopBlocked` is public and wired.                                                                               |
| Provider          | `provider.health`                                                  | Explicit Workbench target probe is wired; unsolicited health transitions are absent.                                  |
| Runtime/residency | `runtime.notice`, `residency.mutation`                             | **Upstream boundary**; capacity/VRAM/degradation facts must retain source and numeric detail.                         |
| Dispatch          | `dispatch.scopeNotice/enqueued/started/progress/completed/failed`  | **Upstream boundary**. The desired graphical Fleet board depends on these sanitized events.                           |
| Compaction        | `compaction.begin/end`                                             | **Upstream boundary**; combine with token/pressure facts before visualizing.                                          |
| Middleware        | `middleware.hookFailed`                                            | **Upstream boundary**; diagnostics/inbox surface.                                                                     |
| Context           | `context.activity/warning/pruned/recalled`                         | **Upstream boundary**; ideal for a scientific context instrument once versioned.                                      |
| Agent             | `agent.status.changed`                                             | **Upstream boundary**; phase/watchdog facts can drive a truthful live status track.                                   |
| Run/budget        | `run.aborted`, `budget.alert`                                      | **Upstream boundary**; keep abort sources and cost provenance distinct.                                               |
| Shutdown          | `shutdown.requested/drained/terminated/persisted`                  | Workbench observes child/process loss, not these structured phases. Diagnostics only.                                 |

## Delivery order

1. **Reported token record — implemented in this audit slice.** Preserve terminal usage in the shared projection, render
   it per outcome, aggregate only visible terminal records, and say explicitly that Workbench does not infer price.
2. **Effective Clio map — implemented in this slice.** The Workbench host adapts fixed, read-only
   `config inspect --json` output into bounded DTOs and visualizes loaded settings, context, prompts, rules, agents,
   skills, extensions, hooks, trust, precedence, reload timing, and context cost. It answers “why is Clio behaving this
   way?” without asking the operator to read YAML or inspect directories, and without sending raw values to the browser.
3. **Catalogs without mutation.** Add read-only graphical Agents, Skills, Verifiers, and Library views from their public
   JSON commands. Keep exact provenance, scope, and trust facts accessible.
4. **Historical evidence and economics.** Add evidence, usage-report, eval-report, fleet-status, and trace-run adapters
   behind bounded Workbench DTOs. Never pass arbitrary CLI output to the browser.
5. **Expand the ACP event extension upstream.** Prioritize context activity/warning/pruned/recalled, tool budget, safety
   block, agent status, runtime notice, dispatch lifecycle, budget alert, and config-reload classification. Version and
   sanitize each DTO; do not expose raw `unknown` worker events or full settings snapshots.
6. **Expand safe settings upstream.** Add typed get/patch groups with allowed values, effective source, apply timing,
   capability flags, and secret redaction. Build graphical forms only after each group is real.
7. **Consequential operations.** Target authoring/auth, fleet run/drain/resume, memory approval, resource installation,
   verifier authoring, share import, doctor fix, and reset require preview, scope, confirmation, progress, terminal
   result, and recovery semantics before they enter the GUI.

## Coordination needed outside Workbench

Two workstreams cannot be completed honestly inside `apps/workbench` alone:

1. A harness owner must extend the opt-in ACP event surface beyond `safety.loopBlocked`, beginning with the prioritized
   sanitized events above.
2. A harness owner must expand the safe settings/operation extensions for config groups and consequential commands; the
   renderer must never receive credentials, raw environment values, arbitrary native paths, or unvalidated bus payloads.

Until those boundaries exist, Workbench can continue making substantial progress through the public read-only JSON
interfaces. The first such command now runs in a separate serialized read lane alongside ACP: a slow config inspection
cannot block turn cancellation or permission resolution, late results from a previously selected project are discarded,
and concurrency is covered by a host integration test. Future command adapters should retain that isolation and the same
fixed-argv, bounded-output, typed-projection discipline.
