# Changelog

Notable changes to Clio Coder, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## 0.6.2-rc.2 - 2026-10-06

Clio Coder 0.6.2-rc.2 fixes the Materio lab flow and the release publisher, both found while shipping 0.6.2-rc.1. Everything else is as described for 0.6.2-rc.1 below.

### Fixes

- Materio confirm cards no longer fail on long drafts. A draft too long for the card is saved whole to `.research/drafts/<form>.md` and the card shows an excerpt, so `define-virtual-lab` and `define-research-tasks` can publish their documents. The corrections field starts at `none`, which accepts the draft, because Clio's interview refuses an empty answer. A workflow template longer than an option allows shows a shortened name with the full description beside it. The Materio extension is now 0.2.1.
- The release workflow finds the draft GitHub release it has just created, so a release no longer stops after uploading its assets.

## 0.6.2-rc.1 - 2026-10-06

Clio Coder 0.6.2-rc.1 is the release candidate for 0.6.2, published on the `beta` channel. Clio Coder 0.6.2 separates plugins from extensions. A plugin is an Agent Plugin that carries content; an extension is Clio code that runs in its own sandboxed process, declares everything it may do, and loads only after you approve those capabilities, with Materio and WTF-P as the first plugin and extension pairs. Fleet contracts are now playbooks, authored with `clio-coder playbook`, and the upgrade converts an existing home and each workspace once. Proactive memory runs on the chat route when it has no route of its own, within that route's cost, quota or speed budget, and reviews repository activity between turns. Library lifecycles leave receipts, extension and package activity is attributed in sessions and traces, `/loop` schedules turns and command polls, `/reload` and `/restart` apply changes in place, and the desktop app gains an integrated window title, Manage context and a denser layout.

### Plugins, extensions and the Library

- Plugins and extensions are separate Library packages. A plugin carries content, an extension carries Clio code that runs in its own process, and an extension names the one plugin it serves with `plugin:`. The terminal Library gains an Extensions tab, `clio-coder library` accepts `extension:<id>`, and package details say which extension serves a plugin and whether each is installed. Installing a plugin never installs its extension.
- Extension runtime API 2 (`runtime.api: 2` in `clio-coder-extension.yaml`) declares everything a package may do in its manifest: commands, hooks, tools, interface slots, workspaces, watched files, content access, file roots, programs and network. A runtime whose code registers other commands, events, hooks or tools than its manifest declares does not start.
- Before an extension is installed or updated, `clio-coder extensions install`, `clio-coder library install|update extension:<id>`, the Library review and a share import plan list what it would be allowed to do, and an update leads with what reaches further than the installed copy. The install records a digest of those capabilities, and an installed extension whose declared capabilities no longer match the record stays unloaded until you reinstall it.
- An extension runtime runs inside bubblewrap on Linux or Seatbelt on macOS when the backend is available. Its writes land only in its declared workspace roots and its own store, Clio's settings, state, trust records, installed packages and `.git` stay read-only, secrets are masked, and the network is cut unless the manifest declares it. Without a backend, including on Windows, only Node's permission flags apply, which are a seat belt rather than a boundary, and the Confinement line in `/extensions` says which applies.
- Extension hooks run at prompt submit, before and after each tool call, and at turn start and end. Each has a deadline from 50 to 2000 ms and a declared pass or block policy for a missed deadline or an error, and a hook that misses three deadlines in a row stays off until the next reload.
- A `before_tool` hook can refuse a call or, with `tool-args` access, rewrite its input. A rewritten call must match the tool's schema and goes through the same checks as the original call, protected paths and other extensions' gates included. A `prompt_submit` hook with `prompt` access can rewrite or block your prompt, and the capability review says which hooks can refuse and which can rewrite.
- Extension tools reach the model through the gateway as `extension_<id>__<name>`, checked against their declared input schema and the usual approvals. A tool can pause on an interview card, and your answers become its result.
- Extensions can show status lines, bands, cards, toasts, panels and docks. A workspace takes over the screen with a header, board, islands, rail and footer, leader-menu keys and a colour skin that must pass a contrast check and cannot restyle safety colours. `/workspace` shows the active workspace, `/workspace off` leaves it, and `/restart` returns to it.
- Extensions can run on a timer between 5 seconds and 1 hour, react to watched workspace files and to turn and tool events, and keep per-session state and a cross-session store that Clio holds, so a reload loses neither.
- An extension command can take over one of its served plugin's prompts (`replaces: prompt`) while that plugin is in effect, and the takeover is listed among the capabilities you approve.
- A package folder under `.clio-coder/dev/extensions/<id>/` in a workspace whose project extensions you approved, or one named with `/extensions dev <folder>`, is a dev extension for the terminal session. It loads only after you approve its capabilities for that session, each later save reloads at the next idle moment without asking while it stays within what you approved, a save that does not build keeps the previous copy running, and one session at a time develops a folder. `/extensions mute <id>` silences any extension for the session and `/extensions unmute <id>` restores it.
- `clio-coder extensions init <id> --template status|hook|panel|tool|workspace` scaffolds a package, `clio-coder extensions validate <path>` checks it and prints its capabilities with their digest, and `clio-coder extensions test <path>` runs its tests against a test host with a virtual clock. The `extension-authoring` Library skill and the `local-status` example extension teach the API.
- `/extensions` shows each package's served plugin, muted state, capability digest, confinement, why a listed runtime is not running, its last Library lifecycle event and its recent activity. `clio-coder extensions list` adds a plugin column.
- Library installs, updates, enables, disables, removals, registrations and imports, share imports included, write a lifecycle receipt with the content and capability digests, scope, source, operation and who acted: you, the model after your confirmation, or an upgrade. `library-receipts.json` in the state directory keeps the latest 512, and the Library detail shows a package's last lifecycle event.
- Extension tool calls, hook runs, skill loads and prompt expansions name the package that owns them, with its version and digest, in the session record and in `clio-coder trace`.
- Extension installs hash the source before staging, refuse a linked managed directory, a linked or hard-linked `state.json` and file names that collide by case, and keep files that differ from the install record as a recovery copy on update and remove. A project copy waiting on workspace trust reads untrusted instead of invalid.
- Share import writes context entries only under instruction file names, refuses links and colliding targets below its destination, and checks each path again before writing.
- Library and skill Git clones run with Git hooks and terminal prompts off and under a timeout, and helper processes a clone leaves behind are stopped.
- A plugin and an extension may share a name, as Materio's do: each keeps its own identity in the Library, and a lifecycle command given only the bare name asks you to choose `plugin:<name>` or `extension:<name>`. Installing, updating, enabling, disabling or removing an extension from the Library reloads extensions in the running session.
- Materio is now a plugin and a separate lab extension. The extension runs the lab bench as a workspace with its own commands, cost display and guardrails, and both packages require Clio Coder 0.6.2.
- Limits: API 2 hooks, tools, workspaces and dev extensions run only in the terminal. `clio-coder run`, ACP editors and the desktop app start no API 2 runtime, so an extension's blocking hook does not apply there.

### Agent core: memory, context, sessions and ACP

- With no memory route of its own, proactive memory runs on the active chat route and stays within that route's real budget: the session cost ceiling on metered API routes, the warning level of the provider's quota window on subscription routes, and a deadline derived from the endpoint's measured speed on local and unpriced routes, where it also yields to your own requests. `/memory` shows a skipped step's reason and when it lifts.
- Proactive memory reviews repository activity between turns in attended sessions. It reads completed work and earlier sessions of this checkout and its linked worktrees in short excerpts, and reaches older sessions the longer the session stays idle. Its requests yield to your own turns on a shared endpoint, and the footer, the desktop app and ACP telemetry show its state.
- A turn-end lesson pass records repository facts a future session would need. A repository lesson that quotes an exact successful command, or a passage the checkout still holds, is approved automatically once a later session shows it held, and is withdrawn when a later session contradicts it. Lessons with global, runtime or agent scope, and lessons without that evidence, wait for your approval.
- `/memory` lists pending and rejected records beside approved lessons and names the active memory route. `a` approves and `x` rejects the selected record.
- The read-only `memory_recall` capability searches the session's task memory and the approved durable memory that applies to the current repository and runtime.
- `/resume` restores a parked session's task memory, and durable memory records are shared between a repository's main checkout and its linked worktrees.
- `clio-coder context map` writes a standalone interactive HTML codebase map, by default `.clio-coder/artifacts/maps/<repo>.html`, with no model call. Up to eight areas expand to their files, declared symbols, import evidence and external imports, and `--json` prints a receipt with the size and SHA-256.
- Map source links pin a GitHub revision only when the working tree is clean and the indexed files match Git, and the map's own outputs no longer make a clean checkout read as dirty. The `map-codebase` library skill has Clio explain and refine the map.
- `/context init`, `refresh`, `reset`, `recall`, handoff recovery and compaction each end in one result card with the outcome, what was created, indexed, preserved or removed, estimated tokens before and after, and any warnings. The card stays in the session and shows again on resume, the CLI commands print the same summary, and `context init --json` includes it as `operation`.
- A running `/context init`, `refresh` or `reset` can be stopped. Indexing stops its worker, and the result card names the changes committed before the stop.
- A draft typed while Clio prepares a turn or compacts shows `HOLD` on the composer rail and is sent in order once that ends.
- `/loop <interval> <task>` runs a task as a fresh turn in the current conversation on a schedule. A bare loop runs five times, the first after one interval; `--count`, `--for` (a deadline up to seven days) and `--timeout` set other bounds, and the creation line shows every bound and which ones are defaults.
- `/loop <interval> --command <program> [args...]` polls a command directly with no shell and no model call. `--until 'json.status == "completed"'` ends the loop when the command's JSON output matches, which posts a notice by default; `--on-match main_turn --follow-up <text>` starts one turn that receives the result as untrusted data instead.
- A loop runs only while its conversation is idle and never replays missed runs. Unchanged poll results stay out of the transcript, failures back off up to five minutes, three infrastructure failures in a row pause the loop, and each run rechecks permissions, project trust and the command's executable.
- `/loop list`, `status`, `pause`, `resume`, `stop` and `cancel` control a session's loops; `stop` lets the current run finish and `cancel` aborts it. Switching session or branch, or `/new`, pauses a loop until `/loop resume`, quitting cancels it, and headless `clio-coder run` refuses loops. Clio can schedule the same loops itself, and `monitor`, ACP clients and the desktop app see them.
- On Linux and macOS, bare `clio-coder` asks once whether to open Clio in a per-project workspace beside terminal panes for files, workers and shells, powered by herdr. Quitting Clio returns you to your terminal, and `clio-coder panes workspace on|off|ask|status` changes or shows the remembered answer. The workspace is never offered inside tmux, Zellij, screen or herdr, with `--no-panes`, without a terminal, or on Windows.
- `/peer clio` opens a second Clio in a pane, and Clio can send that peer a prompt, wait for it to settle and read its output. The prompt arrives through a session-bound inbox and is never typed into the peer's terminal. It is refused while the peer waits on its operator, and the receiving transcript names the pane it came from.
- `/reload` reloads settings, Library resources and extension runtimes, or one of them with `settings`, `library` or `extensions`, and prints one report of what changed, which settings still need a restart, what applies next turn and what failed.
- `/restart` saves the session and restarts Clio Coder into the same session and workspace. It refuses while a turn, dispatch, reload, shell line or queued message is pending. `/reload` and `/restart` are terminal-only.
- A saved chat route that cannot be used is kept instead of being replaced for the session by another reachable target. A missing credential opens the session with the route unavailable and a line naming the fix. A route with no model, or a runtime that cannot drive chat, stops startup with exit 2 and points at `clio-coder configure`.
- The terminal and ACP share one resume path. A transcript that fails to replay leaves the next turn on the resumed session with empty context, never on the session you left.
- `clio-coder run --json` streams start with a `session` header carrying `schemaVersion: 1` and `mode`, and `clio-coder run --agent --json` names the agent, run id and version in that header and ends with one `{"type":"receipt",...}` line. Under `--json`, help and slash-command output go to stderr, so stdout stays JSON.
- `clio-coder run --agent coder --read-only` is admitted, and asking for an agent reserved for internal orchestration exits 2 without a model call.
- Editors switch the session's target through a `target` config option. `session/list` rows carry creation and end times, route, a first-message preview and the message count, and `_clio-coder/targets/list` adds the endpoint without credentials, default model, availability, health, tier and context window.
- ACP `_clio-coder/context/status` returns the active and latest context operation, `context.activity` events carry its progress, and `session/cancel` with `_meta["clio-coder/context"].operationId` stops one operation. A stopped context command reports as cancelled, not failed. `_clio-coder/jobs/list` lists the session's loops.
- Sessions on a Claude 5.5 model carry the vendor's published working notes for that model in the system prompt; other models, and targets that cannot call tools, get none.
- The agent names itself Clio Coder, uses Clio as the conversational short form, and uses the full name in receipts, reports, commit messages and handoffs. Prompts, built-in agents and interface text use no gendered pronouns.
- Read-only inspection commands with unquoted `*` or `?` globs, such as `cat src/*.ts`, run without an approval ask once every match passes the zero-access and workspace checks. `**`, brackets, braces, extglobs, variables and dot-leading globs still ask.
- `grep -r` over workspace paths runs without an ask when its walk cannot reach a zero-access file; `grep -R` still asks. A bash command that does need approval names the step that needed it, such as a glob, a redirection, too many steps or an unrecognized command, so a headless denial says what to change.
- `clio-coder tools install claude-sdk` installs the pinned Claude Agent SDK as a separate component in Clio's data directory, where upgrades and rollbacks keep it. `CLIO_CODER_CLAUDE_SDK_DIR` points Clio at an administrator-prepared prefix instead, and an attended session that needs the SDK asks once before installing it.
- A consent-gated conversational easter egg shows nothing until you accept its interview card, grants no tool action and stays off in headless runs. `/eggs` shows it or turns it off.
- Fixed: a headless run no longer fails on an unresolved block when the loop guard only withheld a repeat of a read that had already succeeded.
- Fixed: workers dispatched by a session can write the extension dev folders that session registered, while other sessions' workers stay blocked.

### Performance and runtime

- Long sessions no longer slow down as they grow. Clio keeps an index of the session ledger that is updated as entries are written, instead of re-reading and re-parsing the whole session file several times per turn. In a 300-turn local session on one Linux machine, the time each turn spent outside the model call fell from about 132 ms to 13 ms by the end, and shutting down after it from 437 ms to 157 ms.
- Stop ends the work it interrupts. A Stop during turn preparation, a retry countdown, compaction or a provider continuation starts no further model request and publishes nothing into the session afterwards, and a context overflow cancelled during recovery ends the turn as cancelled.
- A cancelled MCP tool call that already reached the server stops the server process Clio started and reports only after it is gone, closed MCP connections no longer leave a listener behind, and a discovery cancelled at its last page publishes no tools.
- Shutdown waits for the cleanup each resource needs: budgets derive from the real process grace periods, an expired budget aborts the work it was waiting for, worker descendants that outlive a normal exit are cleaned up, and a session drain can run more than once.
- `monitor` waits and collects wake as soon as a dispatched run changes state, instead of polling every 250 ms or 1 s, and Stop ends a wait at once.
- Worker start skips a safety policy compile it never used, about 50 ms per worker.

### Desktop app

- An installed Chrome or Edge app window can hide its title bar. Clio Coder then draws its own title area, and the system keeps its minimize, maximize and close buttons.
- Under WSL, Settings, General offers Install integrated app window when the browser allows it, which installs Clio Coder as an app in its managed browser profile. Once it is installed, the Start Menu shortcut opens the installed app, and reopening it keeps the title bar choice.
- `Ctrl/Cmd+/` opens Shortcuts & help with the cursor in one search box that covers shortcuts and help. Its topics are Shortcuts, Using Clio and Documentation, and shortcuts are grouped as Tasks & workspace, Conversation, Approvals & interviews, and Moving around.
- The app uses a smaller, denser type scale and a narrower conversation column.
- The app opens in the saved light or dark theme without first painting the other one, and the browser window colour follows the theme.
- In the Session column, App activity, Health, Usage, Artifacts and any section with nothing to show yet fold to a one-line summary and open on click. Health and Project trust move to the top when they need attention.
- Menus wrap long entries instead of cutting them off.
- The Context view adds Manage context, a form for the terminal's context actions: initialize or adopt project context, refresh the source index, compact history, recall an evicted result, recover a handoff, or reset generated context. Reset runs only after its confirmation box is ticked.
- The Context view shows workspace evidence and project-instruction coverage beside the context window breakdown.
- Context work shows a card above the composer with its stage, progress, elapsed time and a Stop button. A finished card says what was created, updated, indexed or removed, with any warnings, until you dismiss it.
- While context work runs, the composer keeps your draft and holds sending until the work finishes, and the task reads as working in the rail.
- Recurring `/loop` jobs appear at the live edge of the conversation, one row per loop with its schedule, runs started, next due time, last outcome and cost. Pause and Resume act at once; Stop and Cancel ask first.
- A `/loop` task typed in the composer may be wrapped in one pair of quotes.
- The conversation header shows Memory reviewing, Memory waiting or Memory unavailable while memory review works, waits for room on its model endpoint, or cannot run.
- A link to a saved task the app has not opened finds the project that holds it and offers Resume task. When no project has it, the page says so, counts projects that could not be read, and offers Look again.
- The composer's model picker can switch the connection as well as the model and thinking level, for this conversation only.
- On the Connections page, Probe checks only the selected connection and reports whether it is reachable, with its latency. A connection whose health was never checked reads Availability unknown.
- Library calls fleet workflows playbooks: the Playbooks tab, the Run a playbook panel and the `/fleet run` dialog, which read `.clio-coder/playbooks`, and the Playbook roots entry of the configuration map.
- A Library package copy blocked by project trust reads Requires trust.
- Extension rows in the Library show the terminal command for each lifecycle action instead of offering actions the desktop app cannot perform; extensions are reviewed and installed in the terminal.

### Installation, release and docs

- `install.ps1` adds the launcher directory to your user `PATH` and to the current PowerShell session by default, so `clio-coder` runs right after setup, including in a terminal opened before an earlier install. `-NoModifyPath` or `CLIO_CODER_MODIFY_PATH=0` leaves `PATH` alone, and the installer then prints the full launcher path to run.
- On Linux and macOS, `install.sh` prepares the herdr pane host behind the per-project workspace. A usable `herdr` on `PATH` is used as is; otherwise Clio Coder downloads and verifies its pinned copy. `--no-workspace` or `CLIO_CODER_INSTALL_WORKSPACE=0` skips it, and a failure never fails the install: Clio offers it again on first launch, or run `clio-coder panes install`.
- npm, pnpm and Bun installs no longer download the Claude Agent SDK (about 224 MB), because it is no longer an optional dependency of the package. The installers' `--include-claude-sdk` (`-IncludeClaudeSdk`) runs `clio-coder tools install claude-sdk` after installing, and a provisioning failure stops the install with the previous launcher still active.
- The Ollama client is bundled into the package instead of installed beside it. The desktop app's HTML sanitizer, including the copy Mermaid diagrams use, moves to DOMPurify 3.4.16 for GHSA-p98j-92pf-mc4p, and the package records its version and checksum with the third-party notices.
- Release qualification is one manually started run. It checks, builds and packs the package once, tests selected terminal, protocol, desktop-app and installed-package behavior against that archive, and boots the same archive on Node 24, with Windows and macOS boots on request. The minimum Node 22.19.0, the Windows subprocess contracts and the native Windows installer flows are not part of it.
- Publication waits for the owner's approval in GitHub, publishes the qualified bytes to npm with provenance, then creates the GitHub release with the tarball and the four installers, fast-forwards `main` and deploys the website built from the same commit. A partial failure resumes with the same archive instead of a rebuild.
- Clio Coder publishes on three channels: `latest` for stable releases, `beta` for release candidates such as this one, and `dev` for snapshots of the development branch. `install.sh --channel beta|dev`, `install.ps1 -Channel beta|dev`, `npm install -g @iowarp/clio-coder@beta` and `clio-coder upgrade --channel <name>` choose one, an install keeps following its channel, and a channel always resolves to the newest of itself and the stabler channels. `clio-coder upgrade --channel latest` returns a pre-release install to stable even when that is a lower version, and says when the newer version already ran migrations.
- The hosted installers pass `--channel` through and run the release candidate's own installer for `beta` and `dev`.
- The MCP SDK that Google's client brings in moves to 1.32.1 for GHSA-6qxp-vccf-f47h, and its `proxy-addr` to 2.0.8 for GHSA-jqcg-44mw-7w3h.
- Guides, architecture pages and the website name the product Clio Coder and refer to it without gendered pronouns, and the glossary records the origin of the name.

### Upgrade notes

- Running the hosted installer again without flags now moves an install pinned with `--version` to the latest release. Pass `--version <x.y.z>` to keep a pin.
- A plugin built for an older Clio, one that still declares `resources.fleets`, a `fleet` kind or a `fleet:` requirement, is refused with a diagnostic that names the fix: its author renames them to `playbooks`, `playbook` and `playbook:`. For WTF-P, run `wtf-p install clio`. `clio-coder upgrade`, the installers and the first start after a background update convert your home once: `fleets/` directories merge into `playbooks/` without overwriting, plugin install records and Library plugins take the new names, and any other package that still needs the fix is listed. Each workspace's `.clio-coder/` converts once on first open with one notice. Share archives from earlier releases still import.
- Library commands use the new names: `clio-coder library recipes` is now `clio-coder library components`, `--kind fleet` is `--kind playbook`, the terminal Library's Fleets tab is Playbooks, and `clio-coder share export --fleets` is `--playbooks`.
- A package can no longer be both a plugin and an extension. An extension root that holds `plugin.json` is invalid and a plugin root that holds an extension manifest fails validation, so publish two packages and link the extension to its plugin with `plugin:`.
- The upgrade replaces an installed Materio plugin with the current Library copy but never installs an extension. The lab bench is now `extension:materio`; `clio-coder library install extension:materio` shows what it may do before installing it.
- A model-run `clio-coder share import` (or `clio-coder import`), `extensions test` or `extensions validate` now asks for your approval like `library install`, so headless `clio-coder run` denies it. `extensions install` stays refused to the model.
- No core settings keys were added, renamed or retired. Two defaults changed, described in the next two notes.
- With no `context.memory.target` or `context.memory.model` set, proactive memory now uses the active chat route instead of staying rules-only. Attended sessions therefore make background model calls on the chat route after turns and while idle, including reviews of earlier sessions, within the budget described above. The "Rules only" choice is gone from `clio-coder configure` and `/settings`. Set `context.memory.enabled: false` to stop background memory, or set a dedicated memory target and model to move it off the chat route.
- `interface.panes.enabled` now defaults to `embedded`, which opens the pane workspace after your one-time yes. `auto` joins a pane host only when Clio starts inside one and never starts one. A settings file holding `off`, as the 0.6.1 template wrote, is respected: no invitation and no herdr download. Set `embedded` or run `clio-coder panes workspace on` to opt in. Changes take effect at the next start.
- After 0.6.2 records an approval or observation on a durable memory record, 0.6.1 can no longer read the memory store, so `clio-coder upgrade --rollback` leaves sessions without durable memory until you upgrade again. Durable records that 0.6.1 approved under a linked worktree's own path no longer apply; approve them again from the main checkout.
- The Claude Agent SDK is no longer an optional dependency of the npm package, and an SDK installed beside 0.6.1 does not carry over. Run `clio-coder tools install claude-sdk`, or accept the one-time prompt, before using a `claude-sdk` target. Shipped runtime dependencies are pinned to exact versions.
- `clio-coder run --agent --json` no longer prints a blank line and an indented receipt; the receipt arrives as one `{"type":"receipt","receipt":{...}}` line, so check `schemaVersion` in the header. `clio-coder run --agent` now exits 3 when the worker stopped on a refused permission (`permission_required`), where it exited 1 before.
- Picking a model with `/model` or over ACP also sets a thinking level that model supports and saves it at the scope you chose, so a saved pick of a non-reasoning model writes `chat.thinkingLevel: off`.
- What a fleet runs is now called a playbook. Authoring moves to `clio-coder playbook new|validate|graph|list|commands`, which writes to `.clio-coder/playbooks/` and your config directory's `playbooks/`; `clio-coder fleet run|status|view|verify|drain|resume|nodes`, `/fleet run <playbook>` and the `fleet.*` settings keep their names, and `fleet validate` and friends now exit 2. Old `fleets/` directories are converted by the upgrade as described above; Clio no longer reads them.
- `clio-coder context map` writes HTML instead of `<repo>.architecture.json`, and the `archify` skill is retired in favour of `map-codebase`. Catalog skills are renamed: `grill-me` is now `plan-interview`, `cut-it` is `sprint-plan`, `workflow-distiller` is `workflow-capture` and `skill-craft` is `skill-authoring`, and `herdr` is retired because the panes capability now sends, waits and reads directly. Copies installed under the old names keep loading but no longer update from the catalog.
- The desktop app's model picker no longer offers Apply to Every project or an unlisted model id. It changes only the current conversation; change saved defaults, including an unverified model id, in Settings or Connections.
- Under WSL, the integrated app window needs this release's Windows launcher scripts. An installer upgrade refreshes them the next time the app opens while idle; an npm or source-checkout install keeps the earlier scripts until you run `clio-coder gui background install` again.
- `install.ps1` and `install.cmd` now add the launcher directory to your user `PATH` by default, and `install.ps1` also adds it to the current PowerShell session. Pass `-NoModifyPath` or set `CLIO_CODER_MODIFY_PATH=0` to leave `PATH` alone. When the window cannot use the new `PATH` yet, the closing `Run:` line names the launcher by its full path.
- Running `install.sh` for 0.6.2 or newer on Linux or macOS downloads Clio Coder's pinned herdr when no usable copy is on `PATH`, and background updates from 0.6.2 onward do the same. Pass `--no-workspace` or set `CLIO_CODER_INSTALL_WORKSPACE=0` to skip it; a declined workspace or `interface.panes.enabled: off` also skips it.

## 0.6.1 - 2026-10-03

Clio Coder 0.6.1 brings a desktop app (alpha) with a setup wizard, a task rail and a Session column. A new installer brings its own Node.js to Linux, macOS and Windows. Approvals say what a command would do, and dispatched workers run under immutable permits, with OS sandboxing for native worker commands when a backend is available. Queued messages are held in Clio, where you can reorder, edit or send them now. Editors get live usage, plan and workspace telemetry over ACP. Experimental additions are SSH worker nodes, docks for workers, files and music, and steering triage. The Pi SDK moves to 1.0.0. This release supersedes 0.6.0, whose installer failed on native Windows and refused some upgrades.

### Installation and upgrade

- A native Windows install of 0.6.0 stopped at activation with `EPERM`. The installer helper now flushes its launcher record through a writable handle, and file edits on Windows no longer carry a durability warning on every call.
- Native Windows installers stage local tarballs before npm, including packages accessed through WSL UNC paths. Installer validation reports incomplete records and rejects malformed Node tarball names before writes. Concurrent desktop setup gives a retry instruction; configure keeps plaintext-key warnings inside its frame, and lifecycle commands consistently name managed installs as installer installs.
- The website installer bootstraps follow the latest GitHub release, and the release installer assets come from the same qualified tarball published to npm.
- A settings file holding a key that was retired without a replacement no longer refuses to load, which had blocked upgrades of 0.5.x homes with an interop setup. The key is ignored and `clio-coder doctor` names it as a warning.
- An upgrade refused over a setting the installed version cannot repair, such as `safety.autonomy: auto-edit` from 0.4.x, was a dead end, because the advised `clio-coder doctor --fix` ran the old version. The installer now prints the new version's own repair command.
- Installers direct a failed candidate check to `clio-coder doctor --fix` instead of reset, and explain how to keep a source-checkout launcher or replace it with a managed release.
- Linux installers reclaim unused refused candidates and versions older than seven days while retaining the active version, rollback version and versions used by live sessions. If process ownership cannot be checked, versions are retained. Replacing an npm-linked launcher names the npm prefix to uninstall from.
- `clio-coder doctor --fix` repairs file modes, removes retired settings keys, corrects YAML on/off booleans, and asks before replacing a stale model ID with the nearest provider catalog match.
- Every doctor warning or failure names a concrete next command, including the sign-in command for expired credentials.
- Doctor detects missing checkout build files and running sessions that need a restart after a rebuild, and `clio-coder doctor --fix` rebuilds an incomplete checkout.
- `clio-coder gui background install --handover`, the installer's `--gui`, and `clio-coder doctor --fix` can transfer a verified idle background service between installations while preserving its address and credentials.
- `clio-coder gui background restart --if-idle` restarts while conversations are resting and preserves active work. The app and doctor show when a session is still using a version replaced by upgrade or rollback.
- Under WSL, Windows shortcuts call the stable `clio-coder` launcher. Opening the app selects the activated service executable after upgrade or rollback, restarts only when idle, and reports browser launch failures.
- Background apps keep their web manifest available to installed browser apps. Hiding the manifest did not prevent duplicate browser installations. WSL shortcuts now open one managed desktop identity using a dedicated Chrome or Edge profile; repeated or simultaneous launches focus the existing window. Launch failures display the captured error; uninstall removes the owned Windows launch scripts, shortcuts and browser profile. Taskbar pinning remains a user action.
- Desktop app launches deliver the current address and token, and reconnecting with a fresh local launch link moves the browser to the correct port.
- Windows uninstall removes the private runtime and installed versions after Clio exits, and uninstall reports the shell configuration lines left for manual removal.

### Upgrade notes

- Settings from 0.5.9 load unchanged and no key is retired. New keys include `safety.sandbox`, `safety.sandboxNetwork`, `interface.exitSummary`, `integrations.music.*`, `chat.steering.triage.*` and `fleet.defaultNode`, and `fleet.permissions.mode` accepts `main`. `settings.yaml` is now written owner-only, and `clio-coder doctor` warns about a wider mode that `doctor --fix` tightens.
- Project extensions and plugins load only after the workspace is approved with `clio-coder config trust extensions` or `plugins`. An unapproved project copy stays listed but unloaded and no longer shadows your own copy. Your first project install approves its own surface; later installs, enables and removes ask again.
- A dispatched worker's own commands (`bash`, `run_script`, verification) run under an OS sandbox when `safety.sandbox` is `auto` (the default) and a backend exists, which is bubblewrap on Linux and Seatbelt on macOS. Writes land only in the worker's roots, `.git` and `.clio-coder` stay read-only, and network is off unless the run holds `web_fetch` or `safety.sandboxNetwork` is true. `required` refuses commands without a backend and `off` disables it. Main-agent commands are not sandboxed. A worker confined to narrow write roots loses `bash` and `verify` when no sandbox is active.
- External agents that run their own tool loop (the Claude Code, Codex, OpenCode, Pi and Antigravity runtimes, and ACP peers with `toolGovernance: agent-managed`) are refused write-capable work unless the target or entry sets `trustedUnmediated: true`. Read-only runs are unaffected.
- Under the default `fleet.permissions.mode: deny`, a worker's refused command returns to the model, and the third refusal ends the run as `permission_required` naming every refused command. The denial names the tool, the command (clipped, secrets redacted) and the rule. The Claude SDK runtime still ends at its first refusal. A worker change that removes existing test cases or deletes a test file is withheld from the merge (`merge_withheld`), and a current-tree run fails with `worker_removed_tests`, unless the task asked for the removal.
- `Ctrl+Q` no longer queues for the end of the turn and `clio-coder.message.followUp` is retired. A keybindings file that names it reports the replacement. Enter queues for the next slot, `Alt+K` opens the queue navigator, `Alt+S` sends now, and `Alt+A` toggles the music dock. `Alt+E` and `Alt+W` now hide and show docks, and a second tap within 400 ms closes them.
- A clean interactive exit prints a session summary. `interface.exitSummary` is `auto` by default and follows `interface.outputDetail`; `brief`, `standard`, `report` and `off` override it.
- `safety.limits.sessionCostUsd: 0` means no session ceiling in every path, including dispatch plans, fleet previews and `clio-coder configure`.
- The installer no longer fetches the Claude Agent SDK. Pass `--include-claude-sdk`, or accept the one-time prompt on first use, which installs it into Clio's own package root or prints the package-manager command.
- On sessions that attach `bash`, `find` and `ls` sit behind the gateway, and bash output keeps 16 KiB in model context, split between its head and tail.
- Prompt templates follow Pi 1.0 argument semantics (`$1`, `$@`, `${@:N}`, `${N:-default}`), and bare `$ARGUMENTS` inserts the text after the command unchanged.
- The packaged local model catalog now holds five profiles checked against their upstream Hugging Face model cards and templates: gpt-oss-20b, Qwen3.8-27B, Gemma 4 26B-A4B, Nemotron 3.5 Lightning 30B-A3B and Qwen3.5-4B. These are upstream capability and thinking-control records, not runtime benchmarks. Earlier profiles for finetunes are no longer packaged; keep any you rely on in your config directory's `model-profiles.yaml`, which merges over the packaged entries by id.

### Desktop app (alpha)

- The app is organized as a rail of tasks per project and one Session column holding the chat's model and health, context and spend, branches, sealed evidence, artifacts and workers. A first run goes through a setup wizard. A machine that has used Clio, with a provider key in the environment, a stored login or a local server on a default port, lands in chat with a notice naming the route.
- Any number of tasks stay open. A task idle for 5 minutes is parked and resumes when shown again, and at most 4 turns run at once, with later turns shown as "Waiting for a slot". Closed tasks stay in the rail as saved tasks.
- One app window: launching focuses the open window, in an installed Chrome or Edge app and through the Start Menu shortcut under WSL, and "Open in new window" or `Ctrl/Cmd+Shift+N` opens another on purpose. `clio-coder gui background install` keeps the app on port 4343, or 7373 while another program holds it.
- In the composer, `@` completes workspace files, `↑` recalls earlier messages, `/commands` complete from their grammar, and `@agent text` steers a running worker. A message that starts with `!` runs as a shell line between turns, and `!!` keeps its output out of Clio's context. Each queued message has Send now, move, Now or After, Edit and Remove.
- Worker blocks, the Agents view and Evidence show each run's receipt outcome, contract conformance, trust verdict and validation, and an Artifacts page lists a session's `/view` artifacts. Ignored untrusted project surfaces appear under Project trust in the Session column with the trust command to run. `Esc` twice in the composer stops the running turn.
- Tool output keeps the colours a command printed, tables keep their header and offer "Copy table", diffs mark the changed part of a line, and a wide Mermaid diagram offers "Full size". Images embedded in a reply as data are drawn; images at a web address are never loaded.
- Session notices move out of the conversation into the Session column: thinking guidance sits with the model, project-instruction coverage with context, and other notices under Session notes.
- Settings is rebuilt as a few pages, Library has its own page, and "Sign out" under Settings, Models removes the credential Clio stored for a connection. A settled turn closes with one line: Done, Failed or Stopped, then duration, tool calls and tokens.
- Limits: on native Linux the desktop launcher still opens a browser tab per launch, because focusing an existing window needs the installed Chrome or Edge app, and the limit of 4 running turns has no setting.

### Install, upgrade and first run

- `install.sh` installs a private Node.js 24 and the package under a versioned prefix with no root and no system Node. Downloads are checked against Node.js's published checksums; release-signature verification is attempted when `gpgv` or `gpg` is present, with a warning if it cannot be completed and a hard failure for a bad signature. Older x64 Linux gets a glibc 2.17 build, Alpine a musl build, and `--modify-path` is the only way it edits a shell startup file. `install.ps1` and `install.cmd` do the same on Windows, where support remains best effort and the native Windows installed-package flow is not CI-verified.
- `install.sh` offers the desktop app at the end (`--gui` or `--no-gui`). `clio-coder` checks the Node version before loading and honours `CLIO_CODER_NODE` for hosts whose default `node` is too old.
- `clio-coder upgrade --rollback` restores the previous version. A pinned install shows its pin, and `/upgrade` follows the recorded channel, leaves a pin alone and tells a source checkout to update through Git. Pre-release builds name their commit and say they are unreleased, and they hear about newer beta and latest releases.
- A new home starts directly at "Welcome to Clio Coder" and the first question. A home with no usable chat route tries configured targets, environment keys, Clio's stored logins and local servers on default ports, and saves a route only when none exists. `/config` runs configure inside the TUI and applies saved routing live. Peer agents enlist through current ACP recipes, including `@agentclientprotocol/claude-agent-acp` for Claude and `copilot --acp`.
- `clio-coder reset` and `uninstall` also remove the desktop app, and `uninstall` reports `.zshrc` and fish config lines that mention clio-coder. After a native upgrade, `clio-coder gui` and `gui background restart` accept the desktop app the previous version installed.
- `clio-coder doctor` leads with whether chat can run. `clio-coder library register|pin|drift` print text unless `--json`, and `clio-coder tools list|status` say when a pin bump superseded a vendored tool.

### Release qualification and platforms

- A manually dispatched release workflow gates the selected commit on CI and exact-package qualification, verifies the tarball checksum, publishes those bytes to npm with provenance, and creates the GitHub release and tag last. A failed qualification leaves the release tag unused.
- CI gates root contract and smoke tests, GUI checks and tests, maintenance checks, and installed-package tests on Linux with Node 22. The platform matrix builds and boots on macOS and Windows with Node 22, and Linux with Node 24 and the minimum Node 22.19.0; installed-package checks also run on those macOS and Linux legs. Windows runs selected subprocess contracts but explicitly skips the installed-package test. Node 24 also runs lifecycle, provider-transport and session-durability contracts.

### Approvals, trust and worker safety

- A permission approval renders inside the editor's own rails. The top rail names the decision and its kind, the card lists tool, target, effect, requester and worker authority, and `Alt+T` opens the full terms and `Alt+V` the full invocation. Bash approvals state what the command would do. A draft you were typing stays editable under the card.
- Every worker attempt runs under an immutable permit that fixes its asks, tools and Git allowance. `clio-coder run --delegate-tools` sets what dispatched workers may hold, separately from the main agent's `--allow-tools`.
- `fleet.permissions.mode: main` is a new opt-in. The main agent grants ordinary worker asks on native local workers at `yolo` and forwards them to you at any other autonomy level. Asks that need operator authority always reach you, and an ask no one can answer is denied.
- Workers in a task worktree commit on their task branch through a typed `git` capability (`status`, `diff`, `log`, `show`, `add`, `commit`) that refuses fields an operation does not take. Clio asks an attached operator before withholding a task worktree merge. A task worktree Clio created inherits package trust while its package state is unchanged. Model-run `clio-coder library import`, `push` and `remote` ask for confirmation like other library mutations, and `--dry-run` never asks.
- Information flow (advanced and opt-in) keeps named content with the models you chose. Source rules in `.clio-coder/safety.yaml` under `informationFlow` name paths or tools and their allowed recipients, and `clio-coder config trust safety` approves them. Refusals hold at `yolo`, restrictions travel through workers, resume and compaction, and a project with no rules behaves as before. The policy format may change.

### Terminal

- Partial project-instruction coverage appears once per workspace as an expiring footer notice, instead of a persistent welcome row.
- Messages sent during a run are held in Clio and handed over at the next steering slot. The queue navigator (`Alt+K`) reorders, edits, removes, switches an entry to end-of-turn and sends it now, and `Alt+S` interrupts the run with your draft. `/resume <id>` resumes a session directly, and a clean exit prints the resume line. CLI `--resume` and `--continue` stay refused (#191).
- The exit summary shows identity, model, tokens, cost provenance, wall time and resume instructions in brief form, and adds turns, files changed, tools, worker outcomes and compactions in standard and report form.
- An edit's diff shows once its arguments close, before the call runs. `/compact <instructions>` binds the summarizer and keeps the instructions verbatim. The wheel scrolls the transcript while an overlay is open and never moves list choices.
- Each substantive turn ranks installed skills, gateway capabilities and agents, and the reminder names up to five likely skills and three capabilities without changing the tool set between turns. `clio-coder fleet view <runId>` shows the requested model beside the provider-reported one, with cost provenance, and `--json` prints the snapshot with its authenticated receipt.

### Fleet and tools

- `clio-coder fleet nodes add|list|remove|test|discover|install` manages SSH worker nodes (experimental). `install <id> --yes` installs the exact client build you run, `discover` lists Tailscale peers, and a node needs a passing recorded `test --record` before dispatch. `fleet.defaultNode` sets a standing preference, and edits from a separate checkout return through isolated task branches. `clio-coder fleet cancel <runId>` cancels a run from any terminal.
- `read` lists zip and tar archives and reads one text member, extracts PDF text by page (needs poppler's `pdftotext` and `pdfinfo`), and renders Jupyter notebooks. The `data` tool reads SQLite databases read-only.
- The per-turn observation pool scales with the active context window. Automatic compaction pauses after three consecutive failures, while `/compact` and overflow recovery still run. A fleet loop's check step also runs the test files its workspace changed, and a failure feeds the repair loop.
- Headless runs and the coder agent map each task clause to evidence before finishing. Unattended runs and workers install only dependencies that were never installed and report failures confined to files they did not touch. When Clio needs one-off routing for a dispatch, she pins the dispatch's `target` and `model` fields instead of editing routing settings.
- Headless `clio-coder run --agent` prints a "Not verified:" block from the sealed result. Codex, OpenAI Responses and Azure Responses calls record the model the provider reports.

### Editors and ACP

- ACP pushes `usage_update` (at most one per model response), `plan` after board changes and `_meta["clio-coder/workspace"]`, so clients stop polling. It serves `/view` artifacts through `_clio-coder/artifacts/list` and `read`, sealed receipt facts on terminal fleet frames and replay, and ignored untrusted project surfaces in `_meta["clio-coder/trust"]`.
- `_clio-coder/session/shell` runs an operator shell line with the terminal's `!` and `!!` semantics, and `_clio-coder/session/queue_edit` removes, restores, moves, retypes and sends queued entries, with `_clio-coder/session/queue_changed` notifications for clients that opt in. Worker permission asks, `ask_user` and harness cards reach an attended ACP client, and bash asks carry the command's consequence line. `session/load` replay does not yet show shell lines.

### Experimental

- Docks need Herdr and are off by default. `Alt+W` opens a live workers dashboard (`clio-coder fleet view --watch`), `Alt+E` the Yazi files pane (`interface.panes.files.enabled`), and `Alt+A` the music pane. A hidden dock keeps running, and a second tap within 400 ms closes it. `/panes` and `/files` report and control docks.
- `/music` and the opt-in `music` tool drive cliamp 1.63.2 as focus radio. They need `integrations.music.enabled: true`, `integrations.music.agentControl` for the tool, and `clio-coder tools install cliamp` or a package-manager install.
- System One gains per-model capability profiles (`systemOne.engines.<name>.profile`), per-task routing under a site binding, a `steer` site and category hierarchies for recipes and catalogs. Its sites, keys and cuts may change between releases.
- `chat.steering.triage` (off by default) lets a side model read queued messages once the queue settles and relabel them. An unrelated task waits for the end of the turn, and a confident stop may interrupt the run. `fleet.speculativeDispatch` stays experimental.

### Fixed

- A turn that only writes Markdown, reStructuredText, AsciiDoc or Mermaid source finishes as prose-only instead of "change not verified". Stopping at an approval card says the turn stopped and the tool did not run.
- Redaction no longer treats code such as `token = getToken()` or a pure `$NAME` reference in an assignment as a credential, while literal secrets still redact, and durable trace payloads stay valid JSON after redaction.
- Python verification resolves `python` or `python3` once, refuses a uv project without `.venv`, and recognizes `PYTHONPATH=<relative paths>` test forms. A check that cannot start is reported as unavailable and not retried.
- Typed Git refuses fields an operation does not take, and the loop guard keys repeated Git calls on the arguments that run.
- A new desktop task opens when its model target is down instead of failing with "Clio ACP process is unavailable".

## 0.6.0 - 2026-10-03

Superseded by 0.6.1, which carries everything below and repairs the installer. Install 0.6.1.

Clio Coder 0.6.0 brings a desktop app (alpha) with a setup wizard, a task rail and a Session column. A new installer brings its own Node.js to Linux, macOS and Windows. Approvals say what a command would do, and dispatched workers run under immutable permits, with OS sandboxing for native worker commands when a backend is available. Queued messages are held in Clio, where you can reorder, edit or send them now. Editors get live usage, plan and workspace telemetry over ACP. Experimental additions are SSH worker nodes, docks for workers, files and music, and steering triage. The Pi SDK moves to 1.0.0.

### Upgrade notes

- Settings from 0.5.9 load unchanged and no key is retired. New keys include `safety.sandbox`, `safety.sandboxNetwork`, `interface.exitSummary`, `integrations.music.*`, `chat.steering.triage.*` and `fleet.defaultNode`, and `fleet.permissions.mode` accepts `main`. `settings.yaml` is now written owner-only, and `clio-coder doctor` warns about a wider mode that `doctor --fix` tightens.
- Project extensions and plugins load only after the workspace is approved with `clio-coder config trust extensions` or `plugins`. An unapproved project copy stays listed but unloaded and no longer shadows your own copy. Your first project install approves its own surface; later installs, enables and removes ask again.
- A dispatched worker's own commands (`bash`, `run_script`, verification) run under an OS sandbox when `safety.sandbox` is `auto` (the default) and a backend exists, which is bubblewrap on Linux and Seatbelt on macOS. Writes land only in the worker's roots, `.git` and `.clio-coder` stay read-only, and network is off unless the run holds `web_fetch` or `safety.sandboxNetwork` is true. `required` refuses commands without a backend and `off` disables it. Main-agent commands are not sandboxed. A worker confined to narrow write roots loses `bash` and `verify` when no sandbox is active.
- External agents that run their own tool loop (the Claude Code, Codex, OpenCode, Pi and Antigravity runtimes, and ACP peers with `toolGovernance: agent-managed`) are refused write-capable work unless the target or entry sets `trustedUnmediated: true`. Read-only runs are unaffected.
- Under the default `fleet.permissions.mode: deny`, a worker's refused command returns to the model, and the third refusal ends the run as `permission_required` naming every refused command. The denial names the tool, the command (clipped, secrets redacted) and the rule. The Claude SDK runtime still ends at its first refusal. A worker change that removes existing test cases or deletes a test file is withheld from the merge (`merge_withheld`), and a current-tree run fails with `worker_removed_tests`, unless the task asked for the removal.
- `Ctrl+Q` no longer queues for the end of the turn and `clio-coder.message.followUp` is retired. A keybindings file that names it reports the replacement. Enter queues for the next slot, `Alt+K` opens the queue navigator, `Alt+S` sends now, and `Alt+A` toggles the music dock. `Alt+E` and `Alt+W` now hide and show docks, and a second tap within 400 ms closes them.
- A clean interactive exit prints a session summary. `interface.exitSummary` is `auto` by default and follows `interface.outputDetail`; `brief`, `standard`, `report` and `off` override it.
- `safety.limits.sessionCostUsd: 0` means no session ceiling in every path, including dispatch plans, fleet previews and `clio-coder configure`.
- The installer no longer fetches the Claude Agent SDK. Pass `--include-claude-sdk`, or accept the one-time prompt on first use, which installs it into Clio's own package root or prints the package-manager command.
- On sessions that attach `bash`, `find` and `ls` sit behind the gateway, and bash output keeps 16 KiB in model context, split between its head and tail.
- Prompt templates follow Pi 1.0 argument semantics (`$1`, `$@`, `${@:N}`, `${N:-default}`), and bare `$ARGUMENTS` inserts the text after the command unchanged.
- The packaged local model catalog now holds five profiles checked against their upstream Hugging Face model cards and templates: gpt-oss-20b, Qwen3.8-27B, Gemma 4 26B-A4B, Nemotron 3.5 Lightning 30B-A3B and Qwen3.5-4B. These are upstream capability and thinking-control records, not runtime benchmarks. Earlier profiles for finetunes are no longer packaged; keep any you rely on in your config directory's `model-profiles.yaml`, which merges over the packaged entries by id.

### Desktop app (alpha)

- The app is organized as a rail of tasks per project and one Session column holding the chat's model and health, context and spend, branches, sealed evidence, artifacts and workers. A first run goes through a setup wizard. A machine that has used Clio, with a provider key in the environment, a stored login or a local server on a default port, lands in chat with a notice naming the route.
- Any number of tasks stay open. A task idle for 5 minutes is parked and resumes when shown again, and at most 4 turns run at once, with later turns shown as "Waiting for a slot". Closed tasks stay in the rail as saved tasks.
- One app window: launching focuses the open window, in an installed Chrome or Edge app and through the Start Menu shortcut under WSL, and "Open in new window" or `Ctrl/Cmd+Shift+N` opens another on purpose. `clio-coder gui background install` keeps the app on port 4343, or 7373 while another program holds it.
- In the composer, `@` completes workspace files, `↑` recalls earlier messages, `/commands` complete from their grammar, and `@agent text` steers a running worker. A message that starts with `!` runs as a shell line between turns, and `!!` keeps its output out of Clio's context. Each queued message has Send now, move, Now or After, Edit and Remove.
- Worker blocks, the Agents view and Evidence show each run's receipt outcome, contract conformance, trust verdict and validation, and an Artifacts page lists a session's `/view` artifacts. Ignored untrusted project surfaces appear under Project trust in the Session column with the trust command to run. `Esc` twice in the composer stops the running turn.
- Tool output keeps the colours a command printed, tables keep their header and offer "Copy table", diffs mark the changed part of a line, and a wide Mermaid diagram offers "Full size". Images embedded in a reply as data are drawn; images at a web address are never loaded.
- Session notices move out of the conversation into the Session column: thinking guidance sits with the model, project-instruction coverage with context, and other notices under Session notes.
- Settings is rebuilt as a few pages, Library has its own page, and "Sign out" under Settings, Models removes the credential Clio stored for a connection. A settled turn closes with one line: Done, Failed or Stopped, then duration, tool calls and tokens.
- Limits: on native Linux the desktop launcher still opens a browser tab per launch, because focusing an existing window needs the installed Chrome or Edge app, and the limit of 4 running turns has no setting.

### Install, upgrade and first run

- `install.sh` installs a private Node.js 24 and the package under a versioned prefix with no root and no system Node. Downloads are checked against Node.js's published checksums; release-signature verification is attempted when `gpgv` or `gpg` is present, with a warning if it cannot be completed and a hard failure for a bad signature. Older x64 Linux gets a glibc 2.17 build, Alpine a musl build, and `--modify-path` is the only way it edits a shell startup file. `install.ps1` and `install.cmd` do the same on Windows, where support remains best effort and the native Windows installed-package flow is not CI-verified.
- `install.sh` offers the desktop app at the end (`--gui` or `--no-gui`). `clio-coder` checks the Node version before loading and honours `CLIO_CODER_NODE` for hosts whose default `node` is too old.
- `clio-coder upgrade --rollback` restores the previous version. A pinned install shows its pin, and `/upgrade` follows the recorded channel, leaves a pin alone and tells a source checkout to update through Git. Pre-release builds name their commit and say they are unreleased, and they hear about newer beta and latest releases.
- A new home starts directly at "Welcome to Clio Coder" and the first question. A home with no usable chat route tries configured targets, environment keys, Clio's stored logins and local servers on default ports, and saves a route only when none exists. `/config` runs configure inside the TUI and applies saved routing live. Peer agents enlist through current ACP recipes, including `@agentclientprotocol/claude-agent-acp` for Claude and `copilot --acp`.
- `clio-coder reset` and `uninstall` also remove the desktop app, and `uninstall` reports `.zshrc` and fish config lines that mention clio-coder. After a native upgrade, `clio-coder gui` and `gui background restart` accept the desktop app the previous version installed.
- `clio-coder doctor` leads with whether chat can run. `clio-coder library register|pin|drift` print text unless `--json`, and `clio-coder tools list|status` say when a pin bump superseded a vendored tool.

### Release qualification and platforms

- A manually dispatched release workflow gates the selected commit on CI and exact-package qualification, verifies the tarball checksum, publishes those bytes to npm with provenance, and creates the GitHub release and tag last. A failed qualification leaves the release tag unused.
- CI gates root contract and smoke tests, GUI checks and tests, maintenance checks, and installed-package tests on Linux with Node 22. The platform matrix builds and boots on macOS and Windows with Node 22, and Linux with Node 24 and the minimum Node 22.19.0; installed-package checks also run on those macOS and Linux legs. Windows runs selected subprocess contracts but explicitly skips the installed-package test. Node 24 also runs lifecycle, provider-transport and session-durability contracts.

### Approvals, trust and worker safety

- A permission approval renders inside the editor's own rails. The top rail names the decision and its kind, the card lists tool, target, effect, requester and worker authority, and `Alt+T` opens the full terms and `Alt+V` the full invocation. Bash approvals state what the command would do. A draft you were typing stays editable under the card.
- Every worker attempt runs under an immutable permit that fixes its asks, tools and Git allowance. `clio-coder run --delegate-tools` sets what dispatched workers may hold, separately from the main agent's `--allow-tools`.
- `fleet.permissions.mode: main` is a new opt-in. The main agent grants ordinary worker asks on native local workers at `yolo` and forwards them to you at any other autonomy level. Asks that need operator authority always reach you, and an ask no one can answer is denied.
- Workers in a task worktree commit on their task branch through a typed `git` capability (`status`, `diff`, `log`, `show`, `add`, `commit`) that refuses fields an operation does not take. Clio asks an attached operator before withholding a task worktree merge. A task worktree Clio created inherits package trust while its package state is unchanged. Model-run `clio-coder library import`, `push` and `remote` ask for confirmation like other library mutations, and `--dry-run` never asks.
- Information flow (advanced and opt-in) keeps named content with the models you chose. Source rules in `.clio-coder/safety.yaml` under `informationFlow` name paths or tools and their allowed recipients, and `clio-coder config trust safety` approves them. Refusals hold at `yolo`, restrictions travel through workers, resume and compaction, and a project with no rules behaves as before. The policy format may change.

### Terminal

- Partial project-instruction coverage appears once per workspace as an expiring footer notice, instead of a persistent welcome row.
- Messages sent during a run are held in Clio and handed over at the next steering slot. The queue navigator (`Alt+K`) reorders, edits, removes, switches an entry to end-of-turn and sends it now, and `Alt+S` interrupts the run with your draft. `/resume <id>` resumes a session directly, and a clean exit prints the resume line. CLI `--resume` and `--continue` stay refused (#191).
- The exit summary shows identity, model, tokens, cost provenance, wall time and resume instructions in brief form, and adds turns, files changed, tools, worker outcomes and compactions in standard and report form.
- An edit's diff shows once its arguments close, before the call runs. `/compact <instructions>` binds the summarizer and keeps the instructions verbatim. The wheel scrolls the transcript while an overlay is open and never moves list choices.
- Each substantive turn ranks installed skills, gateway capabilities and agents, and the reminder names up to five likely skills and three capabilities without changing the tool set between turns. `clio-coder fleet view <runId>` shows the requested model beside the provider-reported one, with cost provenance, and `--json` prints the snapshot with its authenticated receipt.

### Fleet and tools

- `clio-coder fleet nodes add|list|remove|test|discover|install` manages SSH worker nodes (experimental). `install <id> --yes` installs the exact client build you run, `discover` lists Tailscale peers, and a node needs a passing recorded `test --record` before dispatch. `fleet.defaultNode` sets a standing preference, and edits from a separate checkout return through isolated task branches. `clio-coder fleet cancel <runId>` cancels a run from any terminal.
- `read` lists zip and tar archives and reads one text member, extracts PDF text by page (needs poppler's `pdftotext` and `pdfinfo`), and renders Jupyter notebooks. The `data` tool reads SQLite databases read-only.
- The per-turn observation pool scales with the active context window. Automatic compaction pauses after three consecutive failures, while `/compact` and overflow recovery still run. A fleet loop's check step also runs the test files its workspace changed, and a failure feeds the repair loop.
- Headless runs and the coder agent map each task clause to evidence before finishing. Unattended runs and workers install only dependencies that were never installed and report failures confined to files they did not touch. When Clio needs one-off routing for a dispatch, she pins the dispatch's `target` and `model` fields instead of editing routing settings.
- Headless `clio-coder run --agent` prints a "Not verified:" block from the sealed result. Codex, OpenAI Responses and Azure Responses calls record the model the provider reports.

### Editors and ACP

- ACP pushes `usage_update` (at most one per model response), `plan` after board changes and `_meta["clio-coder/workspace"]`, so clients stop polling. It serves `/view` artifacts through `_clio-coder/artifacts/list` and `read`, sealed receipt facts on terminal fleet frames and replay, and ignored untrusted project surfaces in `_meta["clio-coder/trust"]`.
- `_clio-coder/session/shell` runs an operator shell line with the terminal's `!` and `!!` semantics, and `_clio-coder/session/queue_edit` removes, restores, moves, retypes and sends queued entries, with `_clio-coder/session/queue_changed` notifications for clients that opt in. Worker permission asks, `ask_user` and harness cards reach an attended ACP client, and bash asks carry the command's consequence line. `session/load` replay does not yet show shell lines.

### Experimental

- Docks need Herdr and are off by default. `Alt+W` opens a live workers dashboard (`clio-coder fleet view --watch`), `Alt+E` the Yazi files pane (`interface.panes.files.enabled`), and `Alt+A` the music pane. A hidden dock keeps running, and a second tap within 400 ms closes it. `/panes` and `/files` report and control docks.
- `/music` and the opt-in `music` tool drive cliamp 1.63.2 as focus radio. They need `integrations.music.enabled: true`, `integrations.music.agentControl` for the tool, and `clio-coder tools install cliamp` or a package-manager install.
- System One gains per-model capability profiles (`systemOne.engines.<name>.profile`), per-task routing under a site binding, a `steer` site and category hierarchies for recipes and catalogs. Its sites, keys and cuts may change between releases.
- `chat.steering.triage` (off by default) lets a side model read queued messages once the queue settles and relabel them. An unrelated task waits for the end of the turn, and a confident stop may interrupt the run. `fleet.speculativeDispatch` stays experimental.

### Fixed

- A turn that only writes Markdown, reStructuredText, AsciiDoc or Mermaid source finishes as prose-only instead of "change not verified". Stopping at an approval card says the turn stopped and the tool did not run.
- Redaction no longer treats code such as `token = getToken()` or a pure `$NAME` reference in an assignment as a credential, while literal secrets still redact, and durable trace payloads stay valid JSON after redaction.
- Python verification resolves `python` or `python3` once, refuses a uv project without `.venv`, and recognizes `PYTHONPATH=<relative paths>` test forms. A check that cannot start is reported as unavailable and not retried.
- Typed Git refuses fields an operation does not take, and the loop guard keys repeated Git calls on the arguments that run.
- A new desktop task opens when its model target is down instead of failing with "Clio ACP process is unavailable".

## 0.5.9 - 2026-09-29

A `v0.5.8` tag was published on 2026-09-29 and withdrawn before the package reached npm. Its changes ship in 0.5.9.

- Experimental System One decisions: typed decision calls served by a hosted engine, a self-hosted `systemone` server or a configured chat model, bound through `systemOne.engines` and `systemOne.sites`. An unfitted build runs in shadow, and a non-empty `fleet.decisionProfiles` or `turnControl.interpretation` is retired in favor of them.
- Model knowledge comes from the serving server first, then the packaged `models/profiles.yaml`, with labeled estimates where no window is reported. The Pi SDK moves to 0.99.1, adding GPT-6.1 Sol through `openai-codex` and Sonnet 5.5 through `anthropic-max`.
- `clio-coder doctor` previews and `doctor --fix` repairs settings files that stopped loading on a retired value such as `safety.autonomy: auto-edit`. Session cost ceilings apply before paid requests, and `/upgrade` upgrades npm installs in session.

## 0.5.7 - 2026-09-27

- Main sessions attach `read`, `write`, `edit`, `gateway` and `dispatch`, and other capabilities are found through the gateway, where `gateway(op="chain")` composes bounded dependent steps. Repository tours go to the read-only Scout recipe.
- Repository quality policies in `.clio-coder/quality.yaml` select required checks by changed path, and receipts distinguish executed checks from denied ones. The structural index becomes the codemap in `.clio-coder/codemap.json`, and session format 6 cannot be reopened by format-5 readers.
- The browser app gains first-run model setup and redesigned conversation and inspection pages, and `/usage` gains an Activity heatmap. `clio-coder docs` and its documentation server are removed.

## 0.5.6 - 2026-09-25

- **Breaking:** `safety.autonomy` accepts only `default` and `yolo`, and a user `settings.yaml` holding `auto-edit`, `full-auto`, `suggest` or `read-only` refuses to load. Project settings can no longer set autonomy, and workers and peers always run at `default`.
- **Breaking:** ACP custom methods moved under `_clio-coder/`, error codes follow ACP v1, and the custom session list, delete and autonomy methods are gone in favor of `session/list`, `session/delete` and `session/set_mode`.
- **Breaking:** The read-time aliases for old `clio` names are removed, along with `CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS` and the unread keys `integrations.externalAgents.entries[].permissionTimeoutMs`, `integrations.externalAgents.entries[].labels` and `fleet.decisionProfiles.routing`.

## 0.5.5 - 2026-09-24

- Managed Codex, OpenCode and Pi CLI runtimes join Claude Code and Antigravity in dispatch. `/peer` opens any of them in an owned Herdr pane, and `/run --worktree` keeps a task branch.
- Image admission follows the resolved route's live capability, and an optional `fleet.profiles.vision` sidecar describes images for text-only routes.
- `verify` runs Python, Cargo, Go, CMake, Makefile and justfile checks, and fleet workers receive the project handbook rules that apply to them. Source builds work on case-insensitive filesystems (#397).

## 0.5.4 - 2026-09-23

- `clio-coder upgrade --restart` upgrades and resumes the last session, and a quiet update hint can be disabled with `CLIO_CODER_UPDATE_CHECK=0`. Dispatch runs and receipts carry their owning session, and `fleet` commands default to the current project (`--all` for machine-wide) (#392 to #396).
- A unified transcript grammar covers worker cards, compact folding and `/view`, and the instant shell answers the keyboard while the interface loads.
- Adds `/draft`, experimental `fleet.speculativeDispatch` and more System One decision sites. The `eval` command suite is removed.

## 0.5.3 - 2026-09-22

- Inception Mercury diffusion models run through the `inception` runtime (`INCEPTION_API_KEY`) and stream frame by frame in the terminal.
- A `typesafe-jev` runtime and the `decide()` primitive let System One decision sites bind through `fleet.decisionProfiles`.
- `gateway(op="find")` and `describe` answer from a persistent MCP tool metadata cache instead of launching servers.

## 0.5.2 - 2026-09-21

- `self_compact`, `/context recover` and strict input and reserved-output budgets across tool continuations, with session format 5.
- Skill discovery pages and detects drift, and the `clio-coder-dev` and `clio-coder-test` skills are redesigned.

## 0.5.1 - 2026-09-21

- `/usage` replaces `/cost` with Accounts, Session, Models and Workers views and subscription quota readers for Claude Code, `anthropic-max`, Codex CLI and Antigravity.

## 0.5.0 - 2026-09-20

- Public launch with the CLI, interactive TUI, headless `clio-coder run` with sealed receipts, and a bundled browser application.
- Safety admission for tools and shell commands, automatic compaction with working-set retention, session format v4, and `doctor --deep`.
- Fleet dispatch with automatic concurrency, a circuit breaker with failover, isolated task worktrees and optional Slurm dispatch, plus `clio-coder library` packages.

## 0.4.9 - 2026-09-17

- Hardened `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `run_script`, `verify`, `data` and MCP gateway tools with bounds, atomic writes and sandboxed shell execution.
- Web extraction, artifacts, terminal pane docking and subprocess cleanup on SIGINT and SIGTERM.

## 0.4.8 - 2026-09-12

- A Linux systemd background service and installable web app for the browser app, with one web build that retires the standalone trace viewer.
- An exact-package qualification script, and output limits, thinking settings and history retention applied at their declared boundaries.

## 0.4.7 - 2026-09-10

- Installable plugins, skills, agents, prompts and fleets unify into `library/` packages managed by `clio-coder library` and `/library`.
- Operator extension runtimes with namespaced slash commands, harness extensions for contained Node.js and Python tools, and a compact three-row welcome header.

## 0.4.6 - 2026-09-08

- Compact, Standard and Detailed output styles toggled with Alt+O, and a Quick Connect launcher option.
- Defaults to a single worker with prompt prewarm off and automatic TTY streaming.

## 0.4.5 - 2026-09-07

- `CLIO-CODER.override.md`, worker task timeouts, dynamic tool-result truncation, and `/context inspect` and `/context prune`.

## 0.4.4 - 2026-09-05

- MCP protocol v3 with bidirectional tool routing, `clio-coder trace`, and settings moved to `~/.config/clio-coder/settings.yaml`.

## 0.4.3 - 2026-09-05

- Remote marketplace skills, `clio-coder context map`, a read-only `world-knowledge` agent and `context.compaction.model` overrides.

## 0.4.2 - 2026-09-02

- A `/files` pane, `context.toolResultMaxBytes` (65,536 bytes by default), `chat.thinkingLevel` defaulting to `low`, and Pi SDK 0.84.4.
- Documentation restructured into `docs/guide/` and `docs/architecture/`.

## 0.4.1 - 2026-09-01

- Version-2 `settings.yaml` organized around `chat`, `fleet`, `targets`, `context` and `safety`, with machine-facing names consolidated under `clio-coder`.
- Panes, docks and Yazi integration marked experimental, and `clio-coder doctor` runs read-only unless `--fix` is given.

## 0.4.0 - 2026-08-31

- `clio-coder tools list|status|install|remove`, Herdr pane integration, a first-class LiteLLM runtime and run event journals.
- `@anthropic-ai/claude-agent-sdk` moves to `optionalDependencies`.

## 0.3.9 - 2026-08-30
Execution envelopes binding prompt fragment ids to results, a bounded SQLite trace mirror with `clio-coder trace prune` (#226), and `clio-coder config validate`.

## 0.3.8 - 2026-08-29
`clio-coder evidence` inspects, validates and exports evidence bundles with deterministic SHA-256 hashes.

## 0.3.7 - 2026-08-24
Typed dispatch intent with host-run verification (#155), `/btw` side questions (#41), opt-in desktop notifications (#204), and single-writer leases with task worktrees (#207).

## 0.3.6 - 2026-08-23
A `/tasks` board overlay, multi-stage prompt caching with prefix stabilization, and per-turn cost estimates from target pricing.

## 0.3.4 - 2026-08-22
Session format v4 with context eviction and recall records, `context.workingSet` settings, and policy-gated `verify(check=<id>)`.

## 0.3.3 - 2026-08-21
Transcript detail unified under `/output` with per-block folding, folded Bash bodies and stream-ordered thinking segments.

## 0.3.2 - 2026-08-20
Fullscreen mode with native Mermaid and LaTeX, HTML transcript export, Git commit attribution, Pi SDK 0.84.0 and hardened worker and ACP safety policy.

## 0.3.1 - 2026-08-16
Live worker transcript blocks, receipts and replay for `/run` and `/delegate`, interoperability discovery for external coding agents, and a redesigned TUI.

## 0.3.0 - 2026-08-14
First npm-published `clio-coder` command, with agent ledgers, durable capacity leases and receipt-backed dispatch plans.

## 0.2.9 - 2026-08-05
Deterministic fleet code steps with bounded check and repair loops, shipped SDLC fleets, a durable trace store and typed worker result contracts.

## 0.2.8 - 2026-07-07
A consolidated seven-plane tool surface, task tracking, codewiki v4 and multi-model local residency, with legacy tools such as `glob` and `dispatch_batch` removed.

## 0.2.7 - 2026-07-02
Reviewed marketplace skills, credential damage control, usage reports, headless receipts and secret redaction in evidence bundles.

## 0.2.6 - 2026-06-24
VRAM-aware local-model residency, layered settings, path-scoped rules, operator profiles, hooks and configuration inspection.

## 0.2.5 - 2026-06-23
The `alcf` runtime for Argonne ALCF Sophia and Metis targets with Globus OAuth.

## 0.2.4 - 2026-06-23
Fleet management with agent and profile bindings, fault-tolerant dispatch and a `/fleet` overlay.

## 0.2.3 - 2026-06-17
Declarative slash commands and hubs, enforced autonomy notices, codewiki indexing, live steering and richer receipts, with legacy slash commands retired.

## 0.2.2 - 2026-06-11
Context engine with compaction and bounded tool results, ACP support, a curated skills marketplace and local install and uninstall scripts.

## 0.2.1 - 2026-06-05
Live token-throughput telemetry, prompt-envelope hashes and `clio run --json` prompt diagnostics.

## 0.2.0 - 2026-06-03
First community alpha for source-checkout users, with JIT skills, stronger compaction, durable sessions and diagnostics.

## 0.1.9 - 2026-05-17
First-class fleet `dispatch`, frontend artifact validation, typed finish evidence and local-model capability improvements.

## 0.1.8 - 2026-05-11
Extensions, share archives, a redesigned welcome dashboard and a Claude Code SDK safety bridge.

## 0.1.7 - 2026-05-11
A shared safety-policy engine, strict project command policies and typed execution tools; default Bash denies ordinary execution unless allowed.

## 0.1.6 - 2026-05-04
`clio --print` and `clio -p` run one non-interactive turn.

## 0.1.5 - 2026-05-03
Public alpha for source-install developers and research-software teams, with `clio init`, `CLIO.md` parsing and codewiki indexing.

## 0.1.4 - 2026-04-30
Evolution tooling for inventories, evidence, evaluations, memory, middleware and protected artifacts.

## 0.1.3 - 2026-04-27
Live tool output, Bash echo, thinking expansion and a Git-branch footer slot, with `CLIO.md` as the canonical project file.

## 0.1.2 - 2026-04-25
Visible retries for transient provider and stream failures, and many interactive fixes.

## 0.1.1 - 2026-04-24
Deterministic loading of project context files from the working directory upward.

## 0.1.0-exp - 2026-04-24
Initial experimental public release with the interactive TUI, lifecycle CLI, target-first configuration, dispatch workers, receipts and safety modes. Windows support was best effort.
