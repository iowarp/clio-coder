# CLI surface inventory and GUI routing

> **Reference Design & Planning Blueprint**: This document is an architectural reference blueprint recovered from the deleted `apps/workbench` prototype. It specifies design doctrine, target parity, and inspection layouts for the early GUI preview (`apps/clio-coder-gui`), not verified runtime features of the core v0.5.0 terminal engine.

The promise this table makes, verbatim: *"Every currently registered user or harness command is accounted for here. 'No core GUI' means the capability is not forgotten; it is routed to a later bounded surface or an upstream interface request."*

Keep that promise. When a command family is added to `src/cli/index.ts`, add a row here.

## THE ORIGINAL TABLE (28 rows, verbatim)

| # | Command family | Subcommands / significant knobs | GUI routing |
| -: | --- | --- | --- |
| 1 | Bare interactive | `--api-key`, `--no-context-files`, hidden `--no-skills` / explicit skill paths | The GUI uses ACP instead; project-context and skill policy need typed settings, while **API keys must stay host-side**. |
| 2 | `acp` | One stdio agent process pinned to a cwd | Core transport; wired. |
| 3 | `run` | target/model/thinking/autonomy, sampler controls, context/KV controls, JSON modes, steering, resume, agent/profile/runtime/tool profile, capability requirements, skills | Later reproducible Run Lab. Interactive work remains the notebook. |
| 4 | `configure` | Runtime/URL/model/capability setup and default routing | Setup surface; needs typed secret-safe host operations. |
| 5 | `targets` | list/probe/add/use/fleet/profile list/set/remove/rename/bind/unbind/bindings, convert, remove, rename | List/probe, next-turn routing, profile inventory, and agent bindings wired; authoring remains absent. |
| 6 | `models` | List/search models for configured targets | Offline bounded inventory wired; online/global discovery and authoring remain absent. |
| 7 | `auth` | list/status/login/logout by target/runtime | Setup/security surface; upstream typed operation preferred. |
| 8 | `config inspect` | Effective customization graph, JSON | Effective Clio Coder provenance map wired. |
| 9 | `doctor`, `paths` | Diagnose/fix; resolve directories with JSON | Redacted Recovery check wired in Settings; repair remains separate. |
| 10 | `reset`, `uninstall`, `upgrade` | State/config reset, full removal, binary unlink, upgrade/migrations | Separate destructive/installation surface. |
| 11 | `context` | status, init, refresh, wiki, reset, index, replay, working-set | Context Observatory; read-only JSON adapters first, mutations after typed progress/events. |
| 12 | `agents` | User-facing/all recipes, JSON | Read-only catalog wired; addressable execution still needs typed dispatch operations and events. |
| 13 | `fleet` | list/new/validate/graph/commands init/run/status/drain/resume | Installation-wide read-only status aggregate wired; plans, runs, mutations, and live events remain absent. |
| 14 | `evidence` | build by run/session/eval, inspect, list | Evidence library after stable machine projection. |
| 15 | `eval` | validate/run/report/compare/gate | Experiment surface. |
| 16 | `memory` | list/propose/promote/approve/reject/prune | Memory review inbox. |
| 17 | `usage report` | repository/window filters, JSON facts and opportunities | Project-filtered 30-day Usage record wired; broader audit and evidence discovery remain absent. |
| 18 | `trace` | runs/phases/tail/procs/sql/ui | Bounded trace explorer; **never expose arbitrary SQL as the default non-engineer path.** |
| 19 | `extensions` | list/discover/install/enable/disable/remove, scopes, JSON | Installed inventory wired; reviewed lifecycle mutations remain absent. |
| 20 | `skills` | list/search/inspect/validate/install/update/sync/eval | Installed inventory wired; deeper inspection and reviewed lifecycle mutations remain absent. |
| 21 | `library` | list/search/add/use/sync/push/remote confirm | Inventory and the reviewed lifecycle (install, update, enable, disable, remove) are wired for catalog refs. Import, register, pin, drift, sync and push remain terminal operations. |
| 22 | `verifiers` | discover/author/validate/dry-run/add/edit/rename/remove | Typed discovery is absent; the GUI names this boundary and does not scrape formatted output. |
| 23 | `docs` | topic server, no-open | The desktop app carries its own searchable reference (views, keys, vocabulary); Clio Coder topic docs stay external. |
| 24 | `dev components` | list/snapshot/diff | Developer instrument, not core GUI. |
| 25 | `dev evolve` | manifest init/validate/summarize | Developer instrument. |
| 26 | `dev share`, `export`, `import` | inspect/export/import portable resources | Separate reviewed transfer surface. |
| 27 | `version` | Version fact | Shown: the About record and status bar carry the ACP initialize version beside the GUI's own and doctor's. |
| 28 | `worker` | Internal NDJSON worker server | **Never directly exposed as an operator control.** |

## DRIFT, verified against `src/cli/index.ts` COMMAND_HANDLERS (2026-09-20)

The live registry, in registration order: `acp, auth, config, configure, targets, models, agents, components, evidence, eval, memory, usage, trace, evolve, dev, extensions (alias ext), fleet, library, tasks, mcp, verifiers, gui, docs, share, export, import, context, run, tools, interop, panes, doctor, paths, reset, uninstall, upgrade, version, worker`.

Plus `dev` re-dispatches to `components`, `evolve`, `share`.
Plus three **retired subcommand tombstones** that are deliberately not dispatchable but stay command-shaped "so top-level value flags cannot consume them and accidentally boot another mode": `context-init`, `context-index`, `context-clear`.

### Removed

| Row | What happened |
| --- | --- |
| 20 `skills` | **Gone as a top-level family.** Absorbed into `library`. The reads are now `library skills [--all] [--json]` (discovered runtime skills, including unmanaged local files), `library inventory --json` (the fixed, body-free skill read **explicitly labelled "for GUI hosts"**), and `library validate <package-path\|SKILL.md> [--json]`. |

### Added — six rows the audit has no entry for

| Command family | Subcommands / knobs | Proposed GUI routing |
| --- | --- | --- |
| `tools` | list/status/install | **Already partly wired in the new app**: `/api/toolchain/tools`, `/install`, `/remove`, driven through `/api/operations/:id`. (The audit mentions `tools` in the parity matrix but omits it from this inventory.) |
| `interop` | detect/inspect (`interop inspect --json`), wire a peer | Settings; detection wired, wiring remains an explicit terminal review. (Same omission.) |
| `panes` | `panes install [--force] [--json]` | Separate toolchain mutation; runtime status still **blocked-on-phase4**. (Same omission.) |
| `tasks` | the user-task ledger (`src/cli/tasks.ts`, also `/tasks` add/hand/done/drop) | **No `--json` yet.** Route to a task-board surface once a typed read exists; this is the same blocker shape as `memory`. |
| `mcp` | list/trust/untrust (`/mcp` mirrors it); **7 `--json` call sites** | **Buildable today.** An MCP server panel with a closed-vocabulary trust toggle is one of the safest first write surfaces in the whole app. |
| `gui` | the GUI's own install/upgrade/uninstall/launch | This is the app's own lifecycle, replacing the workbench's `scripts/gui-lifecycle.ts`. Never expose it from inside the running GUI as anything but a version/About fact. |

### Rewritten — row 21 `library` is now the marketplace

The audit recorded seven subcommands. The live surface (`src/cli/library.ts` HELP, verbatim) is:

```
One library of packages: plugin, skill, agent, prompt, fleet.

  library list      [--kind <kind>] [--user|--project] [--json]
  library search    [query] [--kind <kind>] [--json]
  library recipes   [query] [--kind skill|agent|prompt|fleet]
                    [--source core|package|user|project|compat] [--all] [--json]
  library register  <path> [--user|--project] [--force] [--json]
  library inspect   <path|kind:name|name> [--user|--project] [--json]
  library install   <path|kind:name|name> [--user|--project] [--force]
                    [--with-requirements] [--dry-run] [--json]
  library import    <path|github-tree-url> [--user|--project]
                    [--format claude|codex] [--dry-run] [--json] [--yes]
  library update    <kind:name|name> [--user|--project] [--force] [--dry-run] [--json]
  library enable    <kind:name|name> [--user|--project] [--dry-run] [--json]
  library disable   <kind:name|name> [--user|--project] [--dry-run] [--json]
  library remove    <kind:name|name> [--user|--project] [--dry-run] [--json]
  library pin       <kind:name|name> [--user|--project] [--json]
  library drift     [kind:name|name] [--user|--project] [--json]
  library reload    [--json]
  library skills    [--all] [--json]
  library inventory --json
  library validate  <package-path|SKILL.md> [--json]
  library sync
  library push
  library remote confirm <url>
```

**The semantics that make this directly buildable as a GUI marketplace, verbatim from the HELP:**

> Install and register default to user scope. Other mutations select the project copy when present; an explicit scope selects exactly that copy. List includes both scopes and all installed states. `--from <index.yaml>` selects an index. **Every mutation builds one reviewed plan, rechecks it inside the package lock, refuses to break enabled dependents, and reports per-package outcomes with disk, recipe-admission and host-refresh facts separately; `--dry-run` prints the plan and writes nothing. A CLI never refreshes a running session.**
>
> Import reviews a portable, Claude Code or Codex plugin from a path or GitHub tree URL, normalizes supported recipes into a foreign-trust package, and **never activates hooks, MCP, LSP or scripts.**
>
> List and search are package-oriented; `--kind` and a query also match the recipes a bundle provides, **returning the owning package as the install target.**
>
> Recipes is the versioned, body-free read of actual discovered recipes across core, installed packages and loose user/project files, with owner, origin, availability and invocation; `--all` adds internal diagnostic agents. **Nothing in these reads fetches a remote source or activates a recipe.**
>
> Skills lists discovered runtime skills, including unmanaged local files. **Inventory is the fixed, body-free skill read for GUI hosts.**
>
> Package evals run with `clio-coder eval run --package <kind:name> --eval <name>`.

**Design consequences for the GUI marketplace page:**

1. **`--dry-run` is the preview stage the coverage table kept demanding.** Every mutation the audit called "needs preview, confirmation, progress, recovery" already has the preview half for free. Build: *plan → show the plan → confirm → apply → show per-package outcomes*. The plan is a first-class object, not a guess.
2. **The plan distinguishes three outcome facts** — disk, recipe-admission, and host-refresh — and reports them separately. Render all three; collapsing them into "installed ✓" throws away the distinction between "the bytes landed" and "the running session sees it".
3. **"A CLI never refreshes a running session."** So after a mutation the GUI must explicitly tell the operator whether the open session sees the change, and offer `library reload`. Do not silently imply it took effect.
4. **Scope is a real axis** (`--user` / `--project`) and list shows both scopes and all installed states. The page needs a scope column, not a scope filter that hides half the truth.
5. **`library drift`** is the "is my installed copy still what the catalog says" read — a natural per-row badge.
6. **`library import` from a GitHub tree URL is the one network-reaching read on this surface**, and it never activates hooks, MCP, LSP or scripts. Say so at the point of import; that sentence is the whole trust story.
7. The network kill switch is the setting `integrations.library.sync` (see the settings artifact), and sync additionally refuses until `integrations.library.confirmedRemote` equals `integrations.library.remote`.

**What the app ships (v0.5.0):**

The Library page opens on a Catalog collection built from `packages` in `GET /api/workspaces/:id/library`, which is `discoverLibrary` joined with every installed copy. The earlier page filtered that list to `kind === "plugin"`, so 34 of the 35 bundled rows never appeared. Both scopes show on every row with the copy's state, and an install is offered only for the scope that has no copy.

Mutations cross through three routes. `POST /api/workspaces/:id/library/plans` stages a plan and writes nothing. `POST …/plans/:planId/apply` commits that exact plan. `DELETE …/plans/:planId` releases it. The adapter `server/clio/adapters/library-lifecycle.ts` calls `planLibraryLifecycle` and `applyLibraryLifecycle` in the single ops lane and holds staged plans in memory for ten minutes, eight at most. A plan applies once; a second apply, an expired plan, or a plan from another workspace answers 404 and the page plans again.

The request body admits only `kind:name` refs. Root resolution tries a local path before the catalog, so the adapter also refuses a ref that names an existing path under the workspace. Paths and GitHub URLs therefore never originate in the browser, and `force` is accepted by the contract but has no control on the page yet.

The outcome view reports disk and recipe admission per package, and always states that open conversations have not reloaded. The web server holds no agent session, so `refresh` is `not-applicable` by construction; the page tells the operator to run `/library reload` or start a new conversation. Consuming `plugins.reloaded` to confirm the reload remains open.

`Dialog` now portals to `document.body`. The shell marks `.workspace` inert while any layer is claimed, which disabled the first dialog ever opened from inside a page.

### Expanded — rows whose subcommand lists grew

| Row | Additions verified in the HELP strings |
| --- | --- |
| 13 `fleet` | `inspect --json`, `decisions --json`, `verify <runId> --json`, `view <runId\|fleetRootId>`, `preflight`. Full list: list, new, validate, graph, commands init, run, status, inspect, decisions, view, verify, preflight, drain, resume. |
| 14 `evidence` | `evidence inventory --json` (plus `src/cli/evidence-detail.ts`). |
| 15 `eval` | `eval skill <name\|path>`, `--package <path\|kind:name>`, `--suite`, `--task-file`, `--trials/--repeat`, `--format text\|json\|md\|swe-jsonl\|junit`, `compare … [--allow-config-drift]`, `gate --baseline --thresholds`, `inventory --json`. |
| 18 `trace` | `inspect --json` ("a fixed bounded window with no request text"), `code-steps <rootId> --json` ("deterministic code steps of one fleet root"), `prune [--max-age-days N] [--max-bytes N] [--json]`. |
| 19 `extensions` | `extensions run <id> <command> [--json] -- [arguments]`. |
| 22 `verifiers` | `inspect --json`, `baseline <id>`. |
| 9 `doctor` | nine specialized modules: deep, hpc, naming, panes, slurm, state-size, task-worktrees, toolchain, validation-contract. |

### Row 23 `docs` — decision reversed

The audit routed docs out of the app: "Clio Coder topic docs stay external." The new app implements `/api/docs/tree`, `/api/docs/page`, `/api/docs/search` and ships `client/pages/docs.tsx`. This is a deliberate product change, not drift. The audit's underlying worry — don't turn the main shell into a documentation browser — should be answered with navigation (docs as a peer route, not the default view) rather than by removing the feature.
