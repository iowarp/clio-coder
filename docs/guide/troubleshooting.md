# Troubleshooting & Error Remediation

Diagnose errors, permission refusals, target connection failures, and runtime anomalies. Quoted messages match source strings; `<...>` denotes runtime-interpolated values.

## First problems

Run `clio-coder doctor` first ([doctor.md](doctor.md)): its `chat` row identifies missing prerequisites and prints `` ; next: `<command>` `` when a direct fix exists.

| Symptom | Remediation | Reference |
| --- | --- | --- |
| `clio-coder: command not found` right after install | Open a new shell or run the `export PATH=...` line printed at the end of install (`~/.local/bin`). | [Installation](installation-and-lifecycle.md#install-clio-coder) |
| `<target> at <url> did not answer (<detail>). Start the server, or change the address with /config.` | Start the model server or update its URL with `/config`. Re-run `clio-coder doctor`. | [Configuration and targets](configuration-and-targets.md#configure-targets) |
| `<provider> has no key or sign-in stored. Run: clio-coder auth login <provider>`, or `connection <id>` HTTP 401/403 | Run the named `clio-coder auth login` command or fix credentials in `/config`. | [Doctor](doctor.md#core-install-rows) |
| `orchestrator model '<model>' on target '<id>' reports no tool support; CLIO Coder drives every agent role through typed tools.` | Pick a tool-capable model via `/model` or `clio-coder targets use <id> --model <model>`. | [Configuration and targets](configuration-and-targets.md#chat) |
| `shell sandbox` row WARN: `<reason>; <yoloState>; default-autonomy shell commands run uncontained and keep the approval rails` | Host lacks OS sandboxing (`bubblewrap` on Linux, plus unprivileged user namespaces inside containers). CLIO Coder works uncontained with tighter approval prompts. | [Sandbox and safety](sandbox-and-safety.md) |
| Final reply names an open decision; call denied without answer | An interactive approval card exceeded `safety.unattendedAfterSeconds` (default `300` s). Name the needed action in your prompt so the safety judge can evaluate it, or set `0` to wait indefinitely. | [Sandbox and safety](sandbox-and-safety.md#how-each-level-treats-an-escaping-command) |

## Install and startup

### Node runtime and startup checks

- **`clio-coder requires Node.js >=22.19.0; this is <version>.`** (exit `1`, or npm `EBADENGINE` warnings on older Node such as Node 18) — Install with the managed runtime (`curl -fsSL https://coder.iowarp.ai/install.sh | sh`) or point CLIO Coder at a supported runtime with `CLIO_CODER_NODE=/path/to/node/bin/node`. See [HPC clusters](hpc-clusters.md).
- **`No model target is configured.` / `No usable default target is configured.`** — Bare `clio-coder` found no saved or detected chat route and launches `clio-coder configure`. Finish setup or run `clio-coder targets use <id> --model <model>`.
- **`Target '<id>' has no chat model. Run: clio-coder targets use <id> --model <model>` / `Target '<id>' runs on '<runtime>', which cannot drive the main agent.`** (exit `2`) — Saved chat route cannot run the orchestrator (`Your saved chat route is kept and no other target is used.`). Repair via `clio-coder configure` or `clio-coder targets use <id> --model <model>`.
- **`Chat: <target> / <model> is unavailable. <what is missing> Your saved chat route is kept.`** — Opens the TUI with credentials missing. Fix in `/config`, set the named env var, or run the printed `clio-coder auth login <provider>`.
- **``configuration cancelled; no target saved. Run `clio-coder configure` when you are ready.``** (exit `130`) — Setup aborted before saving; rerun `clio-coder configure`.
- **`This home was last used by CLIO Coder <newer>; you are running <version> (<path>).`** (exit `2` on decline or headless) — Older binary on a newer home. Run the newer binary (`clio-coder doctor` `state metadata` lists `clio-coder` copies on `PATH`), confirm interactively, or set `CLIO_CODER_ALLOW_OLDER=1` for headless `run` or ACP.
- **`clio-coder: a task on stdin needs a subcommand; use: clio-coder run -`** (exit `2`) — Piped non-empty stdin into bare `clio-coder` without `CLIO_CODER_INTERACTIVE=1`. Pipe into `clio-coder run -`, or pass the task as `clio-coder run "<task>"`.
- **`CLIO Coder: terminal panes unavailable (...). Continuing in this terminal.`** — Pane host socket path exceeded 100 bytes or no writable owner-only directory was found (`$XDG_RUNTIME_DIR/clio-coder`, `TMPDIR`, `<state>/mux/run`, `<cache>/run`, `/run/user/<uid>/clio-coder`, `/tmp`). Session continues single-pane; export a shorter `XDG_RUNTIME_DIR` or `TMPDIR` as named after `to fix,`.
- **``CLIO Coder: terminal panes unavailable (<why>). Continuing in this terminal; run `clio-coder panes install` to retry.``** — After an upgrade moved the pane host pin, launch tried to install the new pin and failed. Launch does not retry for 24 hours; run `clio-coder panes install` to retry now.

### Installer and update errors

| Message | Cause | Fix |
| --- | --- | --- |
| `[install] error: do not run this installer with sudo; it installs into your home directory. Rerun the same command without sudo, or set CLIO_CODER_INSTALL_ALLOW_SUDO=1 to install for root on purpose.` | `install.sh` run with `SUDO_USER` set | Rerun without `sudo`, or set `CLIO_CODER_INSTALL_ALLOW_SUDO=1` for root installs. |
| `[install] error: refusing to overwrite <launcher>, which this installer did not write; move it aside, choose another --bin-dir, or rerun with --force` / `refusing to replace <launcher>; it points to <target> (a source-checkout launcher, perhaps). Rerun with --force to replace it, or choose another --bin-dir.` | Non-installer binary or external symlink at `--bin-dir` | Move existing file, choose another `--bin-dir`, or pass `--force`. |
| `[install] error: installation locked at <root>/.install-lock by pid <pid> on <host>. ...` (exit `75`) | Concurrent installer/rollback/uninstall/update, or stale lock (`> 10` min with dead local PID is reclaimed automatically as `reclaimed stale installation lock`) | Wait for owner; remove only `.install-lock` if the owning local process died recently. Background updaters retry exit `75`. |
| `[install] error: only <N> MB free under <root>; CLIO Coder and its runtime need about 732 MB.` | Less than `750000` KB free under install root | Free space or pass `--install-dir` on a larger filesystem. |
| Checksum / OpenPGP signature mismatch on `SHASUMS256.txt` or Node archive | Corrupt download, missing `gpgv`, or bad `CLIO_CODER_NODE_MIRROR` | Retry or fix mirror. `CLIO_CODER_REQUIRE_SIGNATURE=0` skips missing-`gpgv` checks (checksum over HTTPS still runs); a bad signature or checksum always stops. |
| `[install] error: neither curl nor wget was found; install one, or fetch Node and the package by hand and pass --node-tarball and --package` | Missing downloader | Install `curl` or `wget`, or pass `--node-tarball` and `--package`. |
| `[install] error: the <channel> channel resolved to <version>, older than the active <active>; the installation was left unchanged. To leave the pre-release for stable <version>, pass --leave-prerelease; to return to the previous install, use --rollback.` (or `To install <version>, pass --version <version>; to return to the previous install, use --rollback.`) | Channel points older than installed version | Use `clio-coder upgrade --channel latest` (passes `--leave-prerelease`), pass `--version <version>`, pass `--rollback`, or check `~/.npmrc` / `npm_config_registry`. |
| `[install] error: npm could not install <spec>. Common causes: no route to the registry (set https_proxy, or npm_config_registry for a mirror), an unknown version, or a full disk under <root>.` | Proxy, registry, unknown version, or disk full | Fix `https_proxy` / `npm_config_registry` / version and rerun. |
| `[install] error: package is installed, but local migrations/initialization need attention; run: <launcher> upgrade --post-install.` | Post-install migrations failed (`install.ps1` prints the equivalent with `clio-coder upgrade --post-install`) | Inspect output above the line, run `<launcher> upgrade --post-install` then `clio-coder doctor`, or `--rollback`. |
| `[install] error: candidate checks failed; previous install remains active` | New version failed startup check | Read errors above line, fix, and rerun; previous version remains active. |
| `[install] error: glibc <version> is older than 2.28, which official arm64 Node.js builds need, and no older-glibc arm64 build exists.` / `glibc <version> is older than 2.17, the oldest any Node.js 22+ build supports` | System glibc too old for official Node binaries | Install conda-forge `nodejs` (`conda create -n node -c conda-forge 'nodejs>=22'`) and `npm install -g @iowarp/clio-coder`. |
| `Native Windows managed lifecycle requires 0.6.0 or later` / `[install] error: CLIO Coder <version> is unsupported` | Target release `< 0.6.0` | Specify `>= 0.6.0`. |
| `clio-coder: upgraded <from> → <to>. What changed is in CHANGELOG.md, section <to>.` | First interactive launch after version change | Informational (printed once per version). |
| `Installation changed · /quit, then run clio-coder --continue` / `build replaced · /restart` | Files or dev build replaced under live session | `/quit`, then `clio-coder --continue` (or `/restart` after dev rebuild). |
| `v<version> available · installs after you quit[; the last attempt waited for <pid@host,...>]` / `v<version> available · <command>` / `v<version> available · clio-coder upgrade[ --channel=<channel>] to install` / `v<version> available · installing in the background` | Update check found newer release | Quit live sessions (pm updates), run printed command / `/upgrade` / `clio-coder upgrade`. Silence with `CLIO_CODER_UPDATE_CHECK=0` or `interface.autoUpdate: false`. |
| `Updated to v<version> · restart clio-coder to use it; this session keeps v<running>; upgrade --rollback undoes` / `Updated to v<version> · installed by <manager> after your last session` / `background update to v<version> failed (<detail>); log: <path>; run <command>` / `v<version> available · background update failed: <detail>; run clio-coder upgrade` | Background or after-quit update settled or failed | Restart with `clio-coder --continue` (`clio-coder upgrade --rollback` undoes); on failure, read `<log>` and run the printed upgrade command. |
| `Other CLIO Coder processes of this install are running; nothing was replaced` (exit `75`) | Live sessions hold package lease | Quit listed `<pid>@<host>` processes and rerun, or use `/upgrade` in a session. |
| `clio-coder: the update is still running after 120 s; see <log>` (exit `75`) | Concurrent package-manager update took `> 120` s | Wait for completion and inspect `<log>`. |
| `[install] error: CLIO_CODER_INSTALL_GUI must be 1 or 0, got '<value>'` | Invalid `CLIO_CODER_INSTALL_GUI` | Set `1`, `0`, or unset for prompt. |
| `[install] warning: the desktop app runs as a login service on Linux and macOS only; start it here with: clio-coder gui` | `--gui` / `CLIO_CODER_INSTALL_GUI=1` on another system | Run `clio-coder gui` in your session. |
| `[install] warning: the desktop app was not set up. Retry with: clio-coder doctor --fix` | Missing systemd user session or active background service handover | Finish active work, ensure a systemd user session exists, run `clio-coder doctor --fix`. |
| `[install] error: no installer manifest at <root>/install.json; nothing to roll back` | `--rollback` on non-installer root | Pass the matching `--install-dir` or reinstall. |
| `This install is pinned to <version> since <date> (<origin>); release with clio-coder upgrade --channel <channel>. Upgrade and background updates leave it there.` | Pinned by `--version` or `--package` | Run the printed installer command (`--version <channel> --auto-update`) to unpin. |

## Lifecycle commands

- **`This installation needs a package-manager update; no package was replaced.`** (`upgrade`, exit `1`) — Run the printed package-manager command, then `clio-coder upgrade --post-install`.
- **`Rollback works only for native installer installs, made by install.sh or install.ps1`** (`upgrade --rollback`, exit `2`) — Use your package manager (`npm`/`pnpm`/`bun`) to downgrade.
- **`No previous version is installed, so there is nothing to roll back to`** (`upgrade --rollback`, exit `1`) — Pass `--version <ver>` to the installer instead.
- **`Rollback failed; the active version is unchanged`** (`upgrade --rollback`, exit `1`) — Inspect installer output; active install was preserved.
- **`migration manifest is unreadable`** (`upgrade`, exit `1`) — Repair/restore `migrations.json` or pass `clio-coder upgrade --skip-migrations`.
- **`installation integrity check failed`** (`upgrade`, exit `1`) — Run `clio-coder doctor --fix`, then `clio-coder upgrade --post-install`.
- **`built for an older CLIO Coder: <package> declares resources.fleets, and playbooks replaced fleets`** — Plugin uses retired `fleets` layout and does not load; update the plugin (`resources.playbooks`, `playbooks/`).
- **`unsafe directory layout`** (`doctor`/`uninstall`/`reset`, exit `2`) — Four XDG roots overlap, nest, are relative, or point at/above `$HOME`. Set four distinct non-nesting absolute paths below `$HOME` via `CLIO_CODER_*_DIR`, then verify with `clio-coder paths` and `clio-coder doctor`.
- **`not a CLIO Coder-only directory (...); remove CLIO Coder's files inside it by hand`** (`reset` exit `1`, or `uninstall` `Kept, and why`) — Override root cannot be proven owned by CLIO Coder (contains foreign entries or misses `settings.yaml` / `home.json` / `.clio-coder-root`). Clean manually or use a dedicated directory.
- **`` `clio-coder reset` needs a terminal to confirm; pass --yes to skip the prompt ``** (same for `uninstall`, exit `2`) — Pass `--dry-run` to preview or `--yes` to execute non-interactively.
- **`Another native session (pid <N>) is still running; close it before uninstalling`** / **`Native installation is locked; retry after the installer exits`** — Stop the listed PID or wait for `.install-lock`.
- **`Reset stopped; CLIO Coder state was preserved.` / `Could not stop the graphical installation; CLIO Coder state was preserved.`** — Run `clio-coder gui background uninstall && clio-coder gui launcher uninstall`, then retry.
- **`Background service belongs to another installation; CLIO Coder state was left unchanged.`** (`reset`/`uninstall`, exit `1`) — Run `reset`/`uninstall` (or `clio-coder gui background uninstall`) from the owning installation.
- **`CLIO Coder background app is running but did not prove it is this installation's app, so it was left running. See clio-coder gui background status.`** (`gui background restart --if-idle`) — Check `clio-coder gui background status`, then run `clio-coder gui background restart` once active work is finished.
- **`<N> path(s) could not be removed:`** — Fix file permissions or close processes holding handles, then rerun the printed command.

## Claude Agent SDK

- **`CLAUDE_AGENT_SDK_UNAVAILABLE`** (`The Claude SDK runtime needs @anthropic-ai/claude-agent-sdk@0.3.292. Run: clio-coder tools install claude-sdk.`) — Install `@anthropic-ai/claude-agent-sdk@0.3.292` under `<dataDir>/components/claude-agent-sdk/0.3.292` via `clio-coder tools install claude-sdk` (uses paired `npm`, or `npm` on `PATH` for unmanaged Linux installs).
- **`The Claude SDK runtime needs a separate component. Install it now?`** — Choosing **Not now** disables `claude-sdk` targets until restart; choose **Install now** or run `clio-coder tools install claude-sdk`.
- **`No @anthropic-ai/claude-agent-sdk in prepared prefix <dir>.`** — `CLIO_CODER_CLAUDE_SDK_DIR` lacks `node_modules/@anthropic-ai/claude-agent-sdk`. Populate that prefix or unset `CLIO_CODER_CLAUDE_SDK_DIR` and run `clio-coder tools install claude-sdk`.

## Project files ignored for lack of trust

Project settings, hooks, and `safety.yaml` require SHA-256 approval of their exact file bytes; project extensions and plugins require approval of package identities in `.clio-coder/extensions/state.json` or `.clio-coder/plugins/state.json`. Unapproved surfaces are ignored (ACP surfaces them in `_meta["clio-coder/trust"]` on `session/new`, `session/load`, `session/resume`).

- **`[clio-coder:trust] <file> is untrusted; project <surface> ignored. Review with clio-coder config trust <surface>.`** (or **`is changed;`**) — `<surface>` is `settings`, `hooks`, `safety`, `extensions`, or `plugins`. Run `clio-coder config trust <surface>` to inspect files and digest, approve with `clio-coder config trust <surface> --hash <sha256>`, then restart or reload (`/reload extensions`, `/reload library`). `--revoke` removes approval.
- **`project <surface> changed since review; inspect it again before approving`** (exit `1`) — Re-run `clio-coder config trust <surface>` and approve the updated digest.
- **`no readable project <surface> files to approve`** (exit `1`) — File missing/unreadable or no project package installed yet.
- **`extensions list` shows `untrusted` / `library list` shows `invalid` or `requires trust`** — In-session diagnostics report `project extensions are not trusted for this workspace and are not loaded; review with clio-coder config trust extensions` ([state.ts](../../src/domains/extensions/state.ts)) or `project plugins are not trusted for this workspace and are not loaded; review with clio-coder config trust plugins, then run /reload library` ([state.ts](../../src/domains/plugins/state.ts)). Approve `.clio-coder/extensions/state.json` or `.clio-coder/plugins/state.json` via `clio-coder config trust extensions|plugins`, then reload. Packages installed by `library import`, `interop adopt`, `share import`, `/archive import`, or skill install offers never auto-trust the workspace; hand-created `git worktree` directories never inherit trust.
- **`usage: clio-coder config trust ...`** (exit `2`) — Supply a valid surface and, for `--hash`, the full 64-hex SHA-256 digest.
- **`credentials are not allowed in project settings; key ignored`** — Move secrets to `clio-coder auth` or user settings.
- **`project autonomy may only tighten the level in user settings; project value ignored`** / **`autonomy is set only in user settings or by the operator; project value ignored`** / **`trustedUnmediated is set only in user settings; project value ignored`** — Configure looser `safety.autonomy` or `trustedUnmediated` in user `settings.yaml` (or pass `--autonomy` / session toggle).

## Policy, approval, and sandbox refusals

Refused tool calls start with `Refused by CLIO Coder policy`, `Refused by operator approval`, or `Refused by MCP server policy`, and print a `To allow it:` line ([denial.ts](../../src/domains/safety/denial.ts)). Within a turn, identical repeats of policy/MCP refusals are cached and denied without re-execution; attended operator refusals can re-prompt.

| Message / Failure | Cause | Remediation |
| --- | --- | --- |
| `CLIO Coder's safety judge blocked this <tool> call (rule <rule>): <reason>` | At `default` autonomy, safety judge saw no user authorization (reviews only operator messages + call). After `3` consecutive or `20` total blocks, the next call escalates to the operator; approving resets review. | Explicitly ask for the action in your prompt, or configure `safety.judge.environment` / `safety.judge.allow` in user settings ([Choosing an autonomy level](commands-and-modes.md#telling-the-safety-judge-about-your-environment)). |
| Remedy reads `nothing within this run; it is the yolo floor, which holds at every autonomy level.` | Yolo floor hit (e.g., wiping `/`, `$HOME`, system trees, `mkfs`/`wipefs`, block-device writes, fork bombs, writing CLIO Coder config, state or trust files, reading credential store). | Run manually outside CLIO Coder if genuinely required. |
| `<tool> blocked: no workspace snapshot` | Snapshot required to admit destructive action at `default` failed. | Fix the reported Git error, run manually, or set `safety.snapshots: off` (switches calls to ask). |
| `The operator did not answer this <tool> approval within <n> s, so CLIO Coder denied it automatically; the call did not run.` | Approval card timed out on `safety.unattendedAfterSeconds` (default `300`). | Raise `safety.unattendedAfterSeconds` (`0` disables timeout). Inspect with `/decisions`. |
| `sandbox: this command could write only to <roots> ...` | Contained command wrote outside writable roots (`~/.cache`, `~/.npm` are read-only; sandbox sets `XDG_CACHE_HOME`, `npm_config_cache`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `PLAYWRIGHT_BROWSERS_PATH`). | Rerun with `unsandboxed: true` (safety-judge reviewed) or add writable path to `safety.scratchRoots` in user settings. |
| `Operation not permitted` (EPERM) opening Unix sockets (Docker, `tsx`, X11/D-Bus, Python `forkserver`) | `safety.sandboxUnixSockets: block` blocks new Unix-domain sockets (`socketpair`, pipes, TCP remain open). | Rerun with `unsandboxed: true`, set Python multiprocessing to `spawn`, or set `safety.sandboxUnixSockets: owned` or `allow` in user settings. |
| Empty `GITHUB_TOKEN`/`NPM_TOKEN` or blocked `.env`/keys in sandbox | Sandbox strips credential env vars by name/value and masks secret files (`.env.example` and unmodified tracked files stay readable). | Rerun with `unsandboxed: true` or whitelist specific vars in `safety.sandboxPassEnv` in user settings. |
| `safety.sandbox is "required" and no OS sandbox is available, so yolo does not run this command; ...` | Under `safety.sandbox: required`, outward `git push`/`gh`/`ssh`/`rsync` commands only leave containment alone on a line with literal args from workspace repo; `scp`, masked secrets, local pushes, or modified git hooks stay contained (`this one stays inside because <reason>`). | Put outward command alone on its own line (use `--body-file`), restore modified hooks/config, or set `safety.sandbox: auto`. See [Safety model](../architecture/safety-model.md#sandbox-questions-and-turns). |
| `safety.sandbox is "required", so yolo does not run this command outside the sandbox; drop unsandboxed: true, ...` | Requested `unsandboxed: true` at unconfined yolo while `safety.sandbox: required`. | Drop `unsandboxed: true` or set `safety.sandbox: auto` in user settings. |
| `<tool> needs operator approval: git hooks or executable git config changed during this session` | Git hooks or executable git config changed mid-session; safety judge never auto-approves. | Inspect changed files/config; approve interactively or revert changes. |
| `sandbox: the main-session sandbox is unavailable (<reason>); the command was not run` | Sandbox backend answered at admission but failed at spawn. | Check `shell sandbox` row in `clio-coder doctor`. |
| `yolo is refused: CLIO Coder runs as root outside a container, ...` | Effective UID `0` with no detected container (`run --autonomy yolo` exits `2`). | Run as non-root user, run in a container, or set `CLIO_CODER_SANDBOXED=1` inside custom sandboxes. |

## Cost shows "not measured" (pricing unknown)

- **Cost omitted, `not measured`, or `$<amount> +?`** — Model call has no rate (no `targets[].pricing`, not a local-native runtime, not in Pi catalog). Declare `targets[].pricing: free` or USD per million tokens; local-native runtimes report `$0.00 local`, catalog entries report `~$<amount> est`.
- **`Tracked spending` `$<amount> per session; unpriced usage is not covered`** — `safety.limits.sessionCostUsd` tracks priced spend only; unpriced calls never trip the ceiling.
- **`no session ceiling` / `Session cost limit: none` / `ceiling none`** — `safety.limits.sessionCostUsd` is `0` (disables cap enforcement while still tracking usage).
- **`budget_ceiling: session priced spend $<spent> reached the $<ceiling> ceiling; raise safety.limits.sessionCostUsd`** (`run` exits `4`) — Raise `safety.limits.sessionCostUsd` or set `0` for uncapped.
- **`settings.yaml failed validation:` `safety.limits.sessionCostUsd: expected a number >= 0, got <val>` / `budget: ceiling must be >= 0`** ([budget.ts](../../src/domains/scheduling/budget.ts)) — Set a non-negative number in `settings.yaml`.

## Headless runs and dispatched workers

- **`clio-coder run cannot confirm permission requests; rerun interactively to approve this action.`** — Headless run hit an ask with no judge verdict (judge off, escalated, or operator-only action). State required actions explicitly in the task prompt, whitelist commands in approved `.clio-coder/safety.yaml`, run interactively, or run unconfined yolo (`--autonomy yolo` with `safety.yoloConfinement: unconfined` and `safety.yoloUnconfinedAccepted: true` in user settings) inside a container.
- **`permission refusal limit reached: the worker ended after 3 refused commands with no approval route: ...`** (`run` exits `3`, outcome `failed/permission_required`) — Whitelist needed commands in `.clio-coder/safety.yaml` + `clio-coder config trust safety`, adjust task, or run attended. See [Exit codes and output](exit-codes-and-output.md).
- **`permission required for <tool> (<class>); fleet.permissions.mode=fail ends this run`** — Switch `fleet.permissions.mode` to `judge` (default) or `deny`, or adjust permissions.
- **`clio-coder run: output token limit reached (stopReason=length)`** (exit `1`) — Narrow task, lower reasoning effort, or raise output limit.
- **`clio-coder run: [CLIO Coder] the model spent its whole output budget thinking and stopped before acting or answering, twice in this turn.`** (exit `1`) — The first such stop in a turn is retried once with a reminder and thinking one step lower where the route controls thinking. Lower `--thinking` or raise `chat.maxOutputTokens`.
- **`clio-coder run: provider stream ended without an assistant response or terminal tool result`** (exit `1`) — Probe target (`clio-coder targets --probe`) and retry.
- **`clio-coder run: the agent recorded an explicit limitation; the task is incomplete`** (exit `1`) — Read reported limitation and supply missing input/permissions. A `no-runner` limitation never raises it.
- **`clio-coder run: no-op: <N> tool calls were blocked without recovery and no write succeeded`** / **`no-op under --fail-on-noop`** (exit `1`) — Resolve blocked call or pass `--turn-mode answer` for read-only Q&A tasks.
- **`clio-coder run: <N> dispatched worker(s) did not deliver: <runId> (<agent>, <outcome>): <detail>`** (exit `1`, detail clipped to 600 chars) — Inspect full settled record with `clio-coder fleet view <runId>` or `monitor(run_id="<id>", mode="record")`.
- **`clio-coder run: timed out after <N>s (--timeout)`** (exit `124`) — Increase `--timeout` or split the task.
- **`worker_final_output_missing`** (`terminalReason: final_output_missing_no_repair`, [outcome.ts](../../src/domains/dispatch/outcome.ts)) — Two paths trigger it: (1) the worker process exited **`1`** and logged `[worker] worker loop ended without a final assistant output (last role=<role>, stopReason=<reason>)` ([worker-runtime.ts](../../src/engine/worker-runtime.ts)); (2) the worker exited `0` without a sealed, durable final output, so the host failed the run with detail `worker loop ended without a sealed final assistant output` ([extension.ts](../../src/domains/dispatch/extension.ts)). Inspect settled run with `clio-coder fleet view <runId>`.
- **`[worker] bulk output incomplete: <reason>`** — Worker failed writing stdout event frames (frame `> 4 MiB`, backlog `> 16 MiB`, write/drain failure) and exited nonzero. Check orchestrator for stalls; inspect settled run.
- **`[worker] bulk evidence incomplete: <reason>`** — Orchestrator detected truncated/unparsable/overflowing worker event frames or unread stdout `> 1` s after exit; forces exit `1` and marks tool telemetry `partial`.
- **`worker_turn_timeout` / `worker_output_cap_exhausted`** — Worker round exceeded `safety.limits.workerResponseSeconds` or output token cap. Deterministic (no automatic retry or breaker penalty). Narrow task, raise `safety.limits.workerResponseSeconds`, or change model.
- **`result_contract_exhausted`** — Worker exhausted repair attempts without satisfying the result contract (`terminalReason: contract_exhausted_after_repair`). Deterministic (no retry). Simplify task or pick a stronger model.
- **`result_contract_invalid`** — Worker finished, but host validator rejected result (`result contract failed: <reason>`). Classified `model-quality`, eligible for retry on another agent/model without target breaker penalty. Inspect with `clio-coder fleet view <runId>`.
- **`vram_capacity_fit_failure`** — Emitted when the model residency sink reports `will-not-fit` for the requested model/context allocation on the target endpoint. Choose a smaller quantization, reduce context size, or target a higher-VRAM host.
- **`loop_guard_tools_disabled_exhausted`** — Loop guard locked tools after repeated identical calls and asked for text-only synthesis, but the model kept emitting tool calls instead of text. Tighten prompt instructions or inspect tool failures.

## Settings, targets, proxies, and skills

| Error / Symptom | Cause | Fix |
| --- | --- | --- |
| `fleet.decisionProfiles` / `turnControl.interpretation` / `turnControl.orientation` / `fleet.speculativeDispatch` / old `systemOne` keys reported as `unknown key` | Retired keys in a `settings.yaml` no upgrade has rewritten | Run `clio-coder upgrade --post-install`, or delete the key; configure active engine via `systemOne.use`. |
| ``runtime 'lmstudio-native' was removed in 0.5.6; set `runtime: lmstudio` on this target in settings.yaml`` (or `ollama-native` -> `ollama`) | Unaliased retired runtime ID | Replace with `lmstudio` or `ollama` in `settings.yaml`. |
| `ai.iowarp.clio key 'evals' was removed in 0.7.0; delete it from the package manifest and reinstall` | Legacy manifest key | Delete `evals` from plugin manifest and reinstall. |
| `The 'github-copilot' login is retired ...` (`auth login github-copilot`, exit `2`) | Retired impersonation flow | Run `copilot login` and use a `copilot-sdk` target. |
| `systemOne.engines.<name>.target: target '<id>' is not defined in targets` / absent `consult` | Missing target definition, key, open breaker, or window overflow | Define target under `targets`, inspect `clio-coder systemone status` and `clio-coder systemone check <engine> --live`. |
| Judge screen never parks anything | Engine uses `generic` profile (no token probabilities), judge disabled, or no recent web/MCP result | Configure `jev` or a non-`generic` engine profile ([Judge screen](system-one.md#judge-screen)). |
| `safety.autonomy: expected one of default \| yolo, got "auto-edit"` (plus `suggest`, `read-only`, `full-auto`, `clio-managed`, `clio-policy`) | Retired enum value blocks validation | Run `clio-coder doctor --fix` (rewrites enums in place, preserving comments). |
| `<arg> is a global option and must come before the subcommand: clio-coder <usage> <command> ...` (exit `2`) | `--api-key`, `--no-context-files`, or `-nc` placed after a subcommand (note: `--skill` and `--no-skills` work in either position on `run`) | Move `--api-key`/`--no-context-files`/`-nc` before the subcommand (`clio-coder --api-key <key> run ...`). |
| `<flag> applies only to the interactive session, clio-coder run, and clio-coder acp; clio-coder <cmd> does not honor it.` / `--allow-tools and --delegate-tools apply to the interactive session, clio-coder run, and clio-coder acp; clio-coder <cmd> does not honor them.` (exit `2`) | `--api-key`, `--no-context-files`/`-nc`, `--skill`, or `--no-skills` (first form), or `--allow-tools`/`--delegate-tools` (second form), passed before a subcommand other than `run`/`acp` | Omit the flag for `<cmd>`, or run interactive / `run` / `acp`. |
| `--autonomy before a subcommand applies to the interactive session only. For a headless turn use: clio-coder run --autonomy <level> "<task>"` (exit `2`) | `--autonomy` placed before a subcommand | Move `--autonomy <level>` *after* `run` (`clio-coder run --autonomy <level> "<task>"`). |
| `--autonomy before a subcommand applies to the interactive session only; pass it after it: clio-coder acp --autonomy <level>` (exit `2`) | `--autonomy` placed before `acp` | Move it after `acp` (`clio-coder acp --autonomy default`). |
| `--allow-tools and --delegate-tools before a subcommand apply to the interactive session only; pass them after it: clio-coder <run\|acp> --allow-tools <names>` (exit `2`) | `--allow-tools`/`--delegate-tools` placed before `run` or `acp` | Move them *after* `run` or `acp`. |
| `--demo and --no-demo apply to interactive sessions only; start clio-coder without a subcommand.` / `--session-file applies to the interactive session only; start clio-coder without a subcommand.` / `--with-panes applies only to the interactive session; ...` (exit `2`) | Interactive-only startup flag used with a subcommand | Remove subcommand to run interactively (`clio-coder --with-panes`), or drop the interactive-only flag. |
| `no target with id <id>` / `unknown target or runtime: <id>` | Unknown target ID in `settings.yaml` | Inspect with `clio-coder targets` or add via `clio-coder configure`. |
| `context-window-unverified`: `This model's context window is unknown, so CLIO Coder compacts at its token budget instead.` | Target probe did not report window size; compaction uses `context.compaction.maxTokens` (default `400000`) | Probe loaded server (`clio-coder targets --probe`) or set `targets[].capabilities.contextWindow`. |
| `Connection error. (through proxy <url>)` / `clio-coder: proxy variables ignored (<error>); requests go direct` | Request routed via `HTTPS_PROXY`/`HTTP_PROXY` (only `localhost`, `127.0.0.1`, `[::1]` bypass automatically) or malformed proxy URL | Fix proxy env vars or add host/CIDR to `NO_PROXY` (`NO_PROXY=*` disables proxy). Verify active routing via `clio-coder doctor` `proxy` row. |
| `Sign-in cancelled` | OAuth flow dismissed in wizard | Rerun `clio-coder auth login <target>` or `clio-coder configure`. |
| `no local skill marketplace catalog or index configured` | No skill catalog/index found on disk or via env overrides | Set `CLIO_CODER_SKILL_CATALOG_DIR` or `CLIO_CODER_SKILL_MARKETPLACE_INDEX`, install locally (`clio-coder library install <path>`), or import (`clio-coder library import <github-tree-url>`). |

## Telemetry, sessions, and local model servers

- **`unsealed <path>: no bundle.json (live or never sealed)`** (`telemetry verify`, exit `1`) — Process still live or crashed before sealing. Re-verify once exited; `clio-coder telemetry doctor` summarizes live vs sealed scopes.
- **`failed <path>: <mismatch>`** (`telemetry verify` / `telemetry doctor`, exit `1`) — Post-seal modification detected; treat scope as untrusted.
- **`session was written by a newer CLIO Coder (format version <N>, this build reads version 7): <path>. Upgrade clio-coder to resume this session.`** — The session was written or resumed by a newer CLIO Coder. Since 0.8.4 sessions use format 7: a format 6 session opens unchanged and is restamped to 7 when it is resumed, after which 0.8.3 refuses it. Upgrade, or resume the session with the newer version. ACP `session/load` returns the same text without the path as error `-32602` with `code: "session_format"`.
- **`session metadata has an unsupported format version (expected version 7, got <N>): <path>. Remove the session directory to start a new session.`** — The session predates format 3, the oldest format this build reads. Start a new session.
- **`the session recorded no working directory` / `no longer exists` / `is not a directory`** (`/resume`) — Recorded path missing; pick **Continue here** or cancel.
- **`Copy unconfirmed: <reasons>; OSC 52 sent` / `Sent to terminal clipboard (OSC 52)`** — Terminal clipboard integration used OSC 52 fallback (expected over non-X11 SSH). Locally on Linux, install `wl-copy`, `xclip`, or `xsel`, or enable X11 forwarding/OSC 52 in your terminal/multiplexer.
- **LM Studio notices**:
  - `LM Studio instance '<id>' is also loaded on <peers>` — Informational; footer and ledger show which LM Link peer served the request. Check via `clio-coder targets --probe`.
  - `LM Studio resolved '<model>' to loaded instance '<instance>' on target '<id>'.` — Informational; reused resident instance.
  - `LM Studio target '<id>' does not advertise model '<model>'. Resident instances: <ids or none>.` — Pick a listed model or add an explicit load profile.
- **`400 model is already running`** (llama.cpp router) — Another client loaded/kept slots active or router slot state is stale; inspect router slots before evicting.

## Reading a cold cache

Use `/context` to inspect cache hit telemetry, compiled-prompt reuse, and prefill timing. If CLIO Coder knows why the prefix went cold, `/context` displays it (e.g., `prompt read again after trimmed tool output (reuse measured separately)`).

For finished runs, inspect `current.jsonl` under the session store (`clio-coder paths`): check `promptCache.expectedColdReasons` (`working_set_evict`, `compaction`, `dispatch`, `residency`, `thinking_change`, `tool_surface_change`, `prompt_recompiled`, `system_prompt_changed`, `background_memory`, `model_changed`, `transport_reset`, `input_changed`, `tool_choice_change`, `observation_aging`, `step_checkpoint`), `promptCache.backendVerdict`, and `promptCache.backend`. Run summaries via:

```bash
clio-coder doctor
clio-coder telemetry cache <session>
clio-coder usage report
```

If compiled prompts were identical yet the backend missed cache, check:
1. **Server lifetime and sleep settings**: a restart, unload, or router sleep can discard resident cache state.
2. **Idle-slot caching & slow hits**: cache hits can still show long time-to-first-token while restoring slots from host memory or queuing behind another request; llama.cpp routers can toggle idle-slot caching with `--no-cache-idle-slots` / `cache-idle-slots = false`.
3. **Hybrid/recurrent models**: recurrent-state models may reprocess from a context checkpoint when earlier history changes; check serving checkpoint settings.
4. **Concurrent traffic / residency swaps / prompt identity**: compare `clio-coder targets --probe` slot availability, router model residency, and `promptHash`/`toolSignature` across `context.snapshotted` records.

## A TUI that stops answering the keyboard

Interactive sessions buffer the last `256` input-ingress events and `256` committed stdout frames in memory, writing `<stateDir>/input-wedge/<ISO timestamp>-<pid>.json` on `SIGTERM` (keeps newest `5` dumps):
- `classification`: `input-not-committed` (renderer stuck), `no-input-recorded` (stdin reader stuck), `input-committed` (pipeline moving; check `msSinceLastInputIngress`, `msSinceLastCommittedFrame`, `inputIngress`, `frames`).
- Full live trace: `CLIO_CODER_RENDER_TRACE=/path/to/trace.jsonl` (takes a file path, not `1`).

## Report a problem to the maintainers

`/report` (TUI/ACP/desktop) and `clio-coder report` (shell) draft bugs, features, or questions for `github.com/iowarp/clio-coder` (`--dry-run` previews locally without network calls):

- **Draft & mask**: `/report bug|feature|question [summary]` or `clio-coder report ... [--title <t>] [--body-file <f>|-] [--last|--session <id>]`. Masks local paths, external URLs, user/host/repo/branch/remote/target names, emails, IPs, and process API keys; refuses send (even `--yes`) if unmasked identifiers or hidden control characters remain.
- **Confirm & exit codes**: TUI sends only on `s` (`e` edits, `m` toggles masks); ACP/desktop require `/report send <id>` matching the exact shown text. Shell requires terminal confirm or `--yes` (`2` on usage / non-TTY without `--yes`, `0` sent/opened/previewed, `1` send error/refused bundle). Signed-in `gh` checks duplicates (`--on-duplicate comment|new|stop`; `stop` saves draft and exits `3`; a closed match with a newer release out suggests upgrading first and also exits `3`); without `gh`, opens browser URL or writes local file. `--credit` requests release-note credit. Security issues use `/report security` or `clio-coder report security`.
- **Manage & replies**: `clio-coder report status|show <id>|send <id>|forget <id>`. Reply checks (`--reply-check` / `r`) run `<= 1/day` via `gh` for open reports `< 90` days old (off in CI or `CLIO_CODER_UPDATE_CHECK=0` / `NO_UPDATE_NOTIFIER`).
- **Diagnostic bundle** (shell only): `--bundle mechanics --consent debug|dataset` (`--last`/`--session <id>`, `--transcript [N]` default `3` max `10`, `--with-tool-output`, `--anonymize-models`). Stored mode `0600` in `<stateDir>/reports/bundles/`, auto-deleted `30` days after send (or immediately via `forget <id>`). `clio-coder report selftest [--session <id>]` verifies zero leaks; dataset builds (`scripts/report-dataset.ts`) require `dataset` consent (`>= 20` traces, re-keyed, `2000-01-01` epoch).
- **Agent limits**: At most 1 session draft via `report` capability (3 unsent max, control chars stripped); agent **never** sends (`--yes` refused on agent drafts and tool shells).
- **Crashes & offers**: Crashes write `<stateDir>/reports/crashes/` (`settings.yaml` validation excluded); headless faults print `clio-coder: this looks like a CLIO Coder fault; ...` to `stderr` (unless CI, `--output-format json|stream-json`, `report.offers: off`). Report offers fire `<= 1/session` and `<= 1/week`, never in first session, mid-turn, or unattended yolo (2 min idle), and lapse after 2 min (`REPORT_OFFER_TAKE_MS`) or session change (`report.offers: off` disables; [offers.ts](../../src/domains/report/offers.ts), [extension.ts](../../src/domains/report/extension.ts)).

### Share with the maintainers

Opt-in, operator-only client-side encryption (X25519 + HKDF-SHA256 + AES-256-GCM) uploaded as a secret gist via `gh` (`gh auth refresh -s gist` if lacking `gist` scope):

```bash
clio-coder report bug --title "..." --last --bundle mechanics --consent debug --share
clio-coder report send <id> --share
clio-coder telemetry share --session <id> --send --consent debug
clio-coder telemetry share list
clio-coder telemetry share forget <shareId>
```

- **Payloads**: `report ... --share` attaches `bundle: gist:<id>#<shareId>` (or writes `<stateDir>/reports/bundles/<id>.box` if `gh` is missing); bug titles prefix `fix:`. `telemetry share --send` opens a `Telemetry shares` discussion on `iowarp/clio-coder` (`content-free`, `structural`, or `research` profile).
- **Deletion & constraints**: `report forget <id>` / `telemetry share forget <shareId>` deletes the secret gist; `report` / `telemetry share` prune gists in `<stateDir>/reports/shares.json` after `180` days. `dataset` consent cannot be recalled once published. Agents must never pass `--share` or `--send` (refused from tool shells and non-TTY without `--yes`).

## Diagnostic Commands

| Check | Command |
| --- | --- |
| System & workspace health (add `--fix` for safe repairs) | `clio-coder doctor [--fix]` |
| Endpoint reachability & auth probes | `clio-coder targets --probe` |
| Full settled run ledger, display feed & diagnostic text | `clio-coder fleet view <runId>` |
| Session model calls, stop reasons & cold-cache breakdown | `clio-coder telemetry calls <session>`, `why-stopped <session>`, `cache <session>` |
| Verify sealed telemetry integrity | `clio-coder telemetry verify <scope-dir>`, `clio-coder telemetry doctor`, `clio-coder fleet verify <runId> --json` |
