# Changelog

Notable changes to Clio Coder, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## Unreleased

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
