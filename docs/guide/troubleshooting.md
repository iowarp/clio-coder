# Troubleshooting & Error Remediation

This guide provides concrete, actionable remediation procedures for
operational errors, permission denials, target connection failures, and system
diagnostics in the current source tree. Each quoted message exists in source;
`<angle brackets>` mark values Clio Coder fills in.

---

## Install and startup

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `clio-coder requires Node.js >=22.19.0; this is <version>.` | The Node on `PATH` is older than the floor. The package's `clio-coder` command checks before it loads anything else. | Install with the managed runtime: `curl -fsSL https://coder.iowarp.ai/install.sh \| sh`. Or point Clio Coder at a newer Node with `CLIO_CODER_NODE=/path/to/node/bin/node`. See [HPC clusters](hpc-clusters.md). |
| `No model target is configured.` followed by ``Starting `clio-coder configure`.`` Variant: `No usable default target is configured.` | A bare `clio-coder` found no saved chat route and detected none. | Finish the configure flow it starts, or run `clio-coder targets use <id> --model <model>`. A returning user with a detectable route is not sent here: Clio prints `Chat: <runtime> / <model> from <source>. Change it with /config.` and starts chat. See [configuration and targets](configuration-and-targets.md). |
| `Target '<id>' has no chat model configured.` or `Target '<id>' runs on '<runtime>', which cannot drive the main agent.` followed by `` Your saved chat route is kept and no other target is used. Run `clio-coder configure` to fix it. `` (exit 2) | An existing home's saved chat route names a target that cannot start a session. Clio does not borrow another target for it. | Run `clio-coder configure`, or `clio-coder targets use <id> --model <model>`, to repair the saved route. |
| `Chat: <target> / <model> is unavailable: <what is missing>. Your saved chat route is kept; fix the connection with /config.` | The saved chat route lacks its credential. The TUI still opens, and no other target is used. | Fix the connection with `/config`, set the environment variable the message names, or run `clio-coder auth login <target>`. |
| ``configuration cancelled; no target saved. Run `clio-coder configure` when you are ready.`` | Setup was left before any target was saved. The command exits 130. | Run `clio-coder configure` again. |
| `[install] error: do not run this installer with sudo; it installs into your home directory.` | `install.sh` was started under `sudo` with `SUDO_USER` set. | Rerun the same command without `sudo`. `CLIO_CODER_INSTALL_ALLOW_SUDO=1` installs for root on purpose. |
| `[install] error: refusing to overwrite <launcher>, which this installer did not write; ...` or `refusing to replace <launcher>; it points to <target> ...` | A `clio-coder` that the installer did not create sits at the launcher path, or a symlink points outside the install. | Move it aside, choose another `--bin-dir`, or rerun with `--force`. |
| `[install] error: installation locked at <root>/.install-lock by pid <pid> on <host>. ...` (exit 75) | Another installer, rollback, uninstall or background update holds the lock, or a killed one left it recently. A lock this machine wrote, whose pid is gone and which is older than 10 minutes, is reclaimed by the next run, which prints `reclaimed stale installation lock`. | Wait for the owner and retry. If a foreign or newer lock stays after its process has exited, remove only that lock directory and retry. A background update treats exit 75 as busy, not failed, and tries again later. |
| `[install] error: only <N> MB free under <root>; Clio Coder and its runtime need about 732 MB. ...` | Not enough free space at the install root. | Free space or pass `--install-dir` on a larger filesystem. |
| `[install] error: checksum mismatch for <file> ...`, `the OpenPGP signature on SHASUMS256.txt is BAD; refusing to install ...`, or `CLIO_CODER_REQUIRE_SIGNATURE=1, but no verified signature covers SHASUMS256.txt` | The Node download or its mirror does not verify. The installer fails closed. | Retry, or fix the mirror (`CLIO_CODER_NODE_MIRROR`). Do not bypass: only drop `CLIO_CODER_REQUIRE_SIGNATURE` when a missing `gpgv` is the only problem. See [HPC clusters](hpc-clusters.md). |
| `[install] error: neither curl nor wget was found; ...` | The installer has no downloader. | Install one, or pass `--node-tarball` and `--package`. |
| `[install] error: npm could not install <spec>. Common causes: no route to the registry (set https_proxy, or npm_config_registry for a mirror), an unknown version, or a full disk under <root>.` | The package install failed. | Fix the proxy, registry or version named, then rerun. |
| `[install] error: package is installed, but local migrations/initialization need attention; run: <launcher> upgrade --post-install. ...` | The post-install step failed after the package landed. `install.ps1` words it `package installed, but local migrations/initialization need attention. Run clio-coder upgrade --post-install; the previous version remains available with: clio-coder upgrade --rollback`. | Read the lines above it, run the printed command, then `clio-coder doctor`. `--rollback` restores the previous version. |
| `[install] error: candidate checks failed; previous install remains active` | The new version failed its startup check, so the manifest was not switched. | Nothing is lost. Read the output above this line, fix what it names, and rerun. |
| `[install] error: glibc <version> is older than 2.28, which official arm64 Node.js builds need, and no older-glibc arm64 build exists. ...` | Linux arm64 with an old glibc has no supported Node build. | Use conda-forge `nodejs` and `npm install -g @iowarp/clio-coder` with it. |
| `Native Windows managed lifecycle requires 0.6.0 or later; registry returned <version>. ...` or `[install] error: Clio Coder <version> is unsupported; this installer requires 0.6.0 or newer. The active installation was left unchanged.` | `install.ps1` or `install.sh` fetched a package older than 0.6.0. | The active installation is unchanged. Install a 0.6.0 or later version. |
| `clio-coder: upgraded <from> → <to>. What changed is in CHANGELOG.md, section <to>.` | The first interactive launch after the recorded version changed. It shows once per version. | Informational. Read the shipped `CHANGELOG.md` section. |
| `Installation changed · /quit, restart clio-coder, then /resume` | The installed files changed while this session ran. | Leave with `/quit`, start `clio-coder` and `/resume`. |
| `v<version> available · installs after you quit` | The update monitor found a newer release on a user-writable npm, pnpm, Bun or Volta install (Linux or macOS). The package manager runs after every session of this install has exited. A suffix `; the last attempt waited for <pid@host,...>` means an earlier attempt gave up on live sessions. | Quit every session of the install, or run `/upgrade` to arm it explicitly. Set `interface.autoUpdate: false` to keep the plain notice. |
| `v<version> available · <command>`, `v<version> available · clio-coder upgrade[ --channel=<channel>] to install`, or `v<version> available · installing in the background` | The update monitor found a newer release. The command is the exact upgrade command for this layout, or the install is an installer install that either updates itself or has background updates off. | Run the printed command, `/upgrade` in the TUI, or `clio-coder upgrade`. Set `CLIO_CODER_UPDATE_CHECK=0` to silence the monitor. |
| `background update to v<version> failed (<detail>); log: <path>; run <command>` or `v<version> available · background update failed: <detail>; run clio-coder upgrade` | A background update ran and failed today. | Read the log named in the notice, then run the command. |
| `Updated to v<version> · restart clio-coder to use it; this session keeps v<running>; upgrade --rollback undoes` | A background update installed a new version beside the running one. | Restart and `/resume`. `clio-coder upgrade --rollback` undoes it and turns background updates off. |
| `Updated to v<version> · installed by <manager> after your last session` | The after-quit package-manager update finished and this launch runs the new version. It shows once. | Informational. |
| `Other Clio Coder processes of this install are running; nothing was replaced` followed by `<pid>@<host>` lines (exit 75) | `clio-coder upgrade` on a user-writable npm prefix refuses to replace the package under live sessions or another update lease. | Quit the listed processes and rerun, or run `/upgrade` in a session to install after every session quits. |
| `Clio Coder is updating (<manager>); waiting…` then `clio-coder: the update is still running after 120 s; see <log>` (exit 75) | A launch found a package-manager update in progress and waited 120 seconds for it. | Retry once the update finishes. The log path names the wrapper's output. |
| `[install] error: CLIO_CODER_INSTALL_GUI must be 1 or 0, got '<value>'` | `install.sh` read another value from `CLIO_CODER_INSTALL_GUI`. | Set it to `1` or `0`, or unset it to be asked on a terminal. |
| `[install] warning: the desktop app runs as a login service on Linux only; start it here with: clio-coder gui` | `--gui` or `CLIO_CODER_INSTALL_GUI=1` on a system other than Linux. | Informational. Run `clio-coder gui` to start the app for this terminal. |
| `[install] warning: the desktop app was not set up. Retry with: clio-coder doctor --fix (verified service handover waits until active work finishes)` | The Linux login service could not be installed, or another installation's background app still has active work. The install itself succeeded. | Finish the active work and start a systemd user session if there is none, then run the printed command. |
| `[install] error: <message>` (`install.ps1`) | Every `install.ps1` failure prints this line, and an unexpected exception adds the failing script position. Run with `-File` or through `install.cmd` the process exits 1; under `irm \| iex` the shell stays open and sets no exit status. | Fix what the message names and rerun. `-DryRun` previews a run without changing anything. |
| `[install] error: no installer manifest at <root>/install.json; nothing to roll back` | `--rollback` or `-Rollback` against a root the installer never wrote. | Pass the right `--install-dir`, or reinstall. |
| `This install is pinned to <X>, so upgrade and background updates leave it there.` (`upgrade`) or `This install is pinned to <X>, so /upgrade leaves it there. To follow its channel again, run:` | The install was made with an exact `--version` or a `--package`, so it keeps that version. A rollback of a pinned install moves the pin to the restored version. | Run the installer command printed beneath it, which passes `--version <channel> --auto-update` (`-Version <channel> -AutoUpdate`). |

### npm EBADENGINE installation warnings on Node 18

An npm `EBADENGINE` installation warning on Node 18 means the Node version is below Clio Coder's required `>=22.19.0`. Use the managed installer, `curl -fsSL https://coder.iowarp.ai/install.sh | sh`, which brings its own Node runtime, or upgrade Node before installing `@iowarp/clio-coder` with npm. The launcher also checks the Node version and refuses to start on an older runtime; `CLIO_CODER_NODE` can point it at a supported Node executable.

## Lifecycle commands

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `This installation needs a package-manager update; no package was replaced.` (`upgrade`, exit 1) | A pnpm, Bun, Homebrew, WinGet, local or unknown layout. | Run the printed command with the manager that owns the install, then `clio-coder upgrade --post-install`. |
| `Rollback works only for native installer installs, made by install.sh or install.ps1` (`upgrade --rollback`, exit 2) | Only installer installs keep a previous version. An npm, pnpm or Bun layout also gets the manager command for a chosen version. | Use the owning package manager to install an older version. |
| `No previous version is installed, so there is nothing to roll back to` (`upgrade --rollback`, exit 1) | An installer install that has never had a second version installed. | Install the version you want with the installer's `--version`. |
| `Rollback failed; the active version is unchanged` (`upgrade --rollback`, exit 1) | The installer's rollback did not finish, for example the previous version did not start. | Read the installer output under it. Nothing was switched. |
| `migration manifest is unreadable` (`upgrade`, exit 1) | `migrations.json` has invalid JSON, shape, duplicates or size. | Restore it from backup or review it. `clio-coder upgrade --skip-migrations` updates the package only. |
| `installation integrity check failed` (`upgrade`, exit 1) | A core row failed after the install step. | `clio-coder doctor --fix`, then `clio-coder upgrade --post-install`. |
| `clio-coder changed this workspace to the playbooks layout. ... Left unchanged, needs you: ...` | The first open of a workspace, or the first `playbook` or `fleet run` command in it, converted `.clio-coder/fleets/` to `.clio-coder/playbooks/` once. The second sentence names anything the conversion left, for example a playbook that already existed under `playbooks/`. | Read the named paths and merge by hand. The conversion deletes nothing, and a leftover directory is moved aside with a dated suffix. |
| `built for an older Clio: <package> declares resources.fleets, and playbooks replaced fleets; ...` | A third-party plugin still declares the retired `fleets` layout. It stays installed and does not load. | Ask its author to rename `resources.fleets` to `resources.playbooks`, its `fleets` directory to `playbooks`, and fleet kinds and requirements to `playbook`. For WTF-P, run `wtf-p install clio`. |
| `unsafe directory layout` / `uninstall refused an unsafe directory layout: ...` / `reset refused an unsafe directory layout: ...` (exit 2) | The four roots are relative, equal or nested, for example through overrides. | Set four absolute, distinct, non-nesting roots, then `clio-coder paths` and `clio-coder doctor`. |
| `` `clio-coder reset` needs a terminal to confirm; pass --force to skip the prompt `` (same for `uninstall`, exit 2) | No terminal and no `--force` or `--dry-run`. | Pass `--dry-run` to preview or `--force` to proceed. |
| `Another native session (pid <N>) is still running; close it before uninstalling` | `uninstall` found a live session of the same installer install. | Close that session and rerun. |
| `Native installation is locked; retry after the installer exits` | The install root's lock is held. | Wait, or remove a stale `.install-lock` as in the installer row above. |
| `Reset stopped; Clio state was preserved.` or `Could not stop the graphical installation; Clio state was preserved.` | An owned background app could not be verified or stopped. | Run `clio-coder gui background uninstall && clio-coder gui launcher uninstall` from a build that includes the app, then retry. |
| `Background service belongs to another installation; Clio state was left unchanged.` (`reset` or `uninstall`, exit 1) | The background app was installed by a different Clio Coder installation. An earlier version of this same installer install does not count as different. | Run `reset` or `uninstall` from the installation that owns the app, or remove the app with that installation's `clio-coder gui background uninstall`. |
| `<N> path(s) could not be removed:` | A partial delete: some paths resisted. | Fix the permission or close the holding process, then run the printed command again. It resumes. |

## Claude Agent SDK

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `The Claude SDK runtime needs @anthropic-ai/claude-agent-sdk@0.3.292. Run: clio-coder tools install claude-sdk. This installs a separate component at <data>/components/claude-agent-sdk/0.3.292; it does not change Clio's installation.` (error code `CLAUDE_AGENT_SDK_UNAVAILABLE`) | A `claude-sdk` target was configured or a `claude-sdk` worker was dispatched, and the component is not installed. Nobody could be asked, or the offer was declined. | Run `clio-coder tools install claude-sdk`. It needs the npm paired with Clio Coder's Node, or an `npm` on `PATH` on an unmanaged Linux install; Clio Coder never downloads Node or npm. |
| `The Claude SDK runtime needs a separate component. Install it now?` with **Install now** / **Not now** | An attended operator reached a `claude-sdk` target: the configure wizard, the line-prompt target setup or an attended dispatch. | **Install now** provisions the component, which takes up to 10 minutes. **Not now** fails the run with the message above, and the decision holds until Clio Coder restarts. |
| `No @anthropic-ai/claude-agent-sdk in prepared prefix <dir>.` | `CLIO_CODER_CLAUDE_SDK_DIR` is set and the prefix holds no `node_modules/@anthropic-ai/claude-agent-sdk`. | Ask the prefix's administrator to provision it, or unset the variable and run `clio-coder tools install claude-sdk`. |

## Project files ignored for lack of trust

Project settings, hooks and safety policy require approval of their exact bytes. Project extensions and plugins instead require approval of the installed package identities recorded in `.clio-coder/extensions/state.json` or `.clio-coder/plugins/state.json`. Package identity includes the content digest, capability-envelope digest, source, origin and trust flag; plugins also include kind. Reinstall timestamps and the disabled flag do not change it. Unapproved project surfaces stay unloaded while user-scope packages load normally.

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `[clio-coder:trust] <file> is untrusted; project <surface> ignored. Review with clio-coder config trust <surface>.` (`<surface>` is `settings`, `hooks`, `safety`, `extensions` or `plugins`) | `.clio-coder/settings.yaml`, `settings.local.yaml`, `hooks.yaml`, `hooks.local.yaml`, `safety.yaml` (for `safety`, the nearest one in the workspace or an ancestor), `extensions/state.json` or `plugins/state.json` exists and no approval is recorded for this workspace. | `clio-coder config trust <surface>` prints the files, package identities where applicable, and a digest. Approve the reviewed surface with `clio-coder config trust <surface> --hash <sha256>`, then restart (reload extensions for hooks and extensions, `/library reload` for plugins). `--revoke` withdraws it. |
| The same notice with `is changed;` | The approved file bytes or package identities no longer match. | Review the new surface and approve its digest again. |
| `project <surface> changed since review; inspect it again before approving` (exit 1) | The digest passed to `--hash` no longer matches the files. | Run `clio-coder config trust <surface>` again and approve the new digest. |
| `no readable project <surface> files to approve` (exit 1) | The surface has no readable files. For `extensions` or `plugins`, the project has no install state yet. | Create or fix the file, or install the package first, then review it. |
| `extensions list` shows `untrusted`, or a package carries `project extensions are not trusted for this workspace and are not loaded; review with clio-coder config trust extensions`. The plugin form reads `project plugins are not trusted for this workspace and are not loaded; review with clio-coder config trust plugins`, and `library list` shows the copy as `invalid` or a skill package as `requires trust`. | The project's installed package identities are unapproved or changed, so project copies of that kind are blocked. A user copy with the same ID still loads. | Review with `clio-coder config trust extensions` or `plugins`, approve the digest with `--hash`, then run `/extensions reload` or `/library reload`. |
| Project packages stopped loading after an install, update, enable, disable or remove | A package identity changed without an applicable approval. Disabling, removing or reinstalling identical content preserves approval. An explicit operator install records approval for a new surface or an already trusted one; it does not approve unrelated existing changes. | Review changed identities with `clio-coder config trust <surface>` and approve the digest. |
| A package installed with `library import`, `interop adopt`, `share import`, `/archive import` or a skill install offer into a project does not load | Those paths never approve workspace trust, including for the workspace's first project install. | Approve the project's install state with `clio-coder config trust extensions` or `plugins`. |
| A dispatched worker's task worktree reports its project packages as untrusted | A Clio-created task worktree inherits its origin's current package approval only while the installed identities match the approved identities. A hand-made `git worktree` never inherits. | Approve the origin again, make the worktree package identities match it, or approve the worktree directly. |
| `usage: clio-coder config trust safety\|hooks\|settings\|extensions\|plugins [--json \| --hash SHA256 \| --revoke]` or `trust expects --json, --revoke, or --hash followed by the full reviewed SHA-256 digest` (exit 2) | Wrong arguments. | Pass a surface and, to approve, the full 64-character digest. |
| `credentials are not allowed in project settings; key ignored` | A project settings layer names a credential key. | Move credentials to `clio-coder auth` or user settings. |
| `project autonomy may only tighten the level in user settings; project value ignored` or `autonomy is set only in user settings or by the operator; project value ignored` | A project layer asked for a looser or invalid `safety.autonomy`. | Set autonomy in user settings, `--autonomy`, or the session toggle. |
| `trustedUnmediated is set only in user settings; project value ignored` | A project layer set `trustedUnmediated` on a target or external agent. | Set it in user `settings.yaml`. |

ACP clients receive the ignored files in `_meta["clio-coder/trust"]` on `session/new`, `session/load` and `session/resume`, each with the `clio-coder config trust <surface>` command that fixes it.

## Refused by Clio policy, operator approval or MCP server policy

If Clio refused to edit a file, read the refusal's `To allow it:` line before retrying. An edit can be blocked by tool policy or a run's read-only or tool-allowlist constraints; the refusal identifies the layer and its remedy.

A refused tool call identifies the refusing layer, Clio's action class and a separate remedy. The account starts with `Refused by Clio policy`, `Refused by operator approval` or `Refused by MCP server policy`, and the next line starts with `To allow it:`. An MCP server refusal may also name the server, its error code and its own annotation. A server's annotation does not override Clio's action class.

Follow the printed remedy before repeating the call. A Clio approval cannot override an MCP server's own policy; change the server policy or use an allowed operation. A headless run has no operator to approve an ask. The orchestrator remembers refusals within a turn and refuses identical repeats without execution, except for an attended operator's refusal. Worker calls and calls outside a turn do not use that repeat cache. An attended operator refusal lets a repeated call ask again.

The implementation and exact interpolated format are in [denial.ts](../../src/domains/safety/denial.ts). [Commands and modes](commands-and-modes.md) describes operator tool allowlists, read-only runs and cost caps.

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `Clio's safety judge blocked this <tool> call (rule <rule>): <reason>` | At autonomy `default` the safety judge found no operator message that authorizes that action. It reads only your messages and the call. | Name the action in a message of your own, such as "force-push this branch", or describe your machine with `safety.judge.environment` and add rules with `safety.judge.allow` in user settings. After three consecutive or twenty total blocks the judge hands the next call to you, and approving it turns review back on. See [Choosing an autonomy level](commands-and-modes.md#telling-the-safety-judge-about-your-environment). |
| A refusal whose remedy reads `nothing within this run; it is the yolo floor, which holds at every autonomy level.` | The call hit the yolo floor: deleting or overwriting `/`, the home directory or a system tree, `mkfs`, `wipefs`, a block-device write, a fork bomb, a write into Clio's own config, state or trust records, or a read of Clio's credential store. | Nothing in Clio approves it. Do it yourself outside Clio if it is really intended. |
| `<tool> blocked: no workspace snapshot` | The call was admitted at `default` only because a workspace snapshot would undo it, and the snapshot could not be taken; the refusal names why. | Fix the named Git problem, or run the discard or delete yourself. `safety.snapshots: off` makes such calls ask instead. |
| `The operator did not answer this <tool> approval within <n> s, so Clio denied it automatically; the call did not run.` | A TUI approval card waited past `safety.unattendedAfterSeconds`. | Raise the value, or set `0` to wait forever. `/decisions` and the exit summary's `Unattended` line show what Clio decided while you were away. |
| `sandbox: this command could write only to <roots> ...` | A contained command at `default` failed on a write outside the main-session sandbox's writable roots, or needed a hidden credential. | Clio can rerun it with `unsandboxed: true`, which the safety judge reviews. Add a directory scripts should always write to `safety.scratchRoots` in user settings. |
| `Operation not permitted` (`EPERM`) from a contained command that opens a local Unix socket: a database client, Docker, the `tsx` CLI, Python multiprocessing with the `forkserver` start method (the Linux default from Python 3.14), an X11 or D-Bus client, a program that listens on a socket path | The OS sandbox refuses new Unix-domain sockets (`safety.sandboxUnixSockets: block`), because a socket the command can reach, such as tmux's, can run commands outside the sandbox. `socketpair`, pipes and TCP still work. | Let Clio rerun the command with `unsandboxed: true`, which the safety judge reviews, or name the tool in your request so the judge allows it. For Python, set the `spawn` start method. `safety.sandboxUnixSockets: allow` in user settings turns the refusal off for every sandbox. |
| A contained command fails to authenticate, or a variable such as `GITHUB_TOKEN` or `NPM_TOKEN` is empty inside it | The sandbox removes credential variables by name and value before a contained command starts; unsandboxed and yolo commands keep them. | Let Clio rerun it with `unsandboxed: true` for the safety judge, or list the variable in `safety.sandboxPassEnv` in user settings to keep it inside the sandbox. |
| A contained command cannot open `.env`, a private key or a credentials file in the workspace (`Permission denied`, or files missing inside a masked directory such as `.terraform/`) | The sandbox masks secret files under the workspace and the scratch roots. Templates such as `.env.example` and unmodified tracked files stay readable. | Rerun with `unsandboxed: true` for the safety judge, or pass the value through `safety.sandboxPassEnv` instead of a file. |
| `<tool> needs operator approval: git hook files changed during this session` | A git hook file was added or changed since the session started, and this git command would run it outside the sandbox. Only the operator answers this ask; the safety judge never does, and a headless run denies it. | Inspect the named hook files. Approve the call to accept exactly those files, or deny it and remove the hook. |
| `sandbox: the main-session sandbox is unavailable (<reason>); the command was not run` | The sandbox backend answered at admission but not at spawn. | Check the `shell sandbox` row of `clio-coder doctor`. |
| `yolo is refused: Clio runs as root outside a container, ...` | `yolo` was requested with effective uid 0 and no detected container. The session stays at `default`, and `clio-coder run --autonomy yolo` exits 2. | Run as a regular user or inside a container, or set `CLIO_CODER_SANDBOXED=1` when the process already runs in a sandbox the detection does not recognize. |

## Cost shows "not measured" (pricing unknown)

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| The footer and `/usage` drop their cost field, a fixed-width table shows `not measured`, or a total reads `$<amount> +?` | The call's cost provenance is `unknown`: its target declares no `targets[].pricing`, its runtime is not a local-native runtime, and the Pi catalog has no rate for the model. LiteLLM and other protocol-tier proxies stay unknown until priced. Tokens are still counted. | Declare `pricing` on the target: `free` or a rate map in USD per million tokens. A local-native runtime (LM Studio, llama.cpp, Ollama, vLLM, SGLang, Lemonade) resolves to `$0.00 local` without a declaration, and a catalog match shows `~$<amount> est`. See [configuration and targets](configuration-and-targets.md). |
| A `Tracked spending` row reading `$<amount> per session; unpriced usage is not covered` (`configure --quick` review) | `safety.limits.sessionCostUsd` is positive and counts priced spend only, so unpriced calls never reach the ceiling. | Price the targets you want covered, or rely on other limits. |
| A `Tracked spending` row reading `no session ceiling` (`configure --quick` review), a `Session cost limit` row reading `none` (`clio-coder configure` review), or a `Clio ceiling` row reading `none` on the footer dashboard page | `safety.limits.sessionCostUsd` is `0`, which means no session ceiling. The session gate admits every paid request, dispatch plans and Scout continuations carry a ceiling of 0 that enforces nothing, and `fleet run` skips its remaining-budget check. Spend is still tracked and shown. | Intended when you want no cap. To bound priced spend, set a positive `safety.limits.sessionCostUsd`. |
| `budget_ceiling: session priced spend $<spent> reached the $<ceiling> ceiling; raise safety.limits.sessionCostUsd` (`run` exits 4) | A positive session ceiling was reached by priced spend. A ceiling of 0 never produces this. | Raise `safety.limits.sessionCostUsd`, or set it to `0` to remove the ceiling. |
| `settings.yaml failed validation:` followed by `safety.limits.sessionCostUsd: expected a number >= 0, got <val>`, or `budget: ceiling must be >= 0 (got <val>)` | A negative session cost ceiling. Settings validation rejects it at load, and the scheduling budget ([budget.ts](../../src/domains/scheduling/budget.ts)) throws the second message if a negative ceiling reaches it. | Set `safety.limits.sessionCostUsd` to a positive number, or to `0` for no ceiling, in `settings.yaml`, or edit Session cost limit in Settings → Permissions & Limits. |

## Headless runs and dispatched workers

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `clio-coder run cannot confirm permission requests; rerun interactively to approve this action.` | A headless `clio-coder run` at autonomy `default` reached a call that needs approval and the safety judge did not decide it: the judge gave no verdict, is turned off, has escalated after repeated blocks, or the ask is one only the operator answers, such as plan-scale dispatch or a project settings edit. A call the judge blocks returns the judge's own refusal instead. | Name the action the job needs in the task prompt, because the judge reads only the operator's messages; declare a routine command in `.clio-coder/safety.yaml`; run interactively in the TUI (`clio-coder`) to approve it; or run `--autonomy yolo` in a container, where nothing asks and only the yolo floor, rules in an approved `.clio-coder/safety.yaml` and the run's ceilings block. |
| `permission refusal limit reached: the worker ended after 3 refused commands with no approval route: 1) <tool> `<command>` refused by rule <rule>; ...` (receipt exit 3, outcome `failed/permission_required`) | A dispatched worker kept proposing execute commands that nobody could approve. | Read the named commands and rules. Declare the commands in `.clio-coder/safety.yaml` (approved with `clio-coder config trust safety`), change the task, or run it attended. See [Exit codes and output](exit-codes-and-output.md). |
| `permission required for <tool> (<class>); fleet.permissions.mode=fail ends this run` | `fleet.permissions.mode` is `fail` and the worker hit its first refusal. | Use `judge` (the default) or `deny` so refusals return to the worker, or grant the work. |
| `clio-coder run: output token limit reached (stopReason=length); generation incomplete. ...` | The provider stopped on its output limit (exit 1). | Narrow the task, lower reasoning effort, or raise the output budget. |
| `clio-coder run: provider stream ended without an assistant response or terminal tool result` | The stream closed with no answer (exit 1). | Check the target with `clio-coder targets --probe`, then retry. |
| `clio-coder run: the agent recorded an explicit limitation; the task is incomplete` | The agent called `limitation` (exit 1). | Read the stated limitation and supply what it lacked. |
| `clio-coder run: no-op: <N> tool calls were blocked without recovery and no write succeeded`, or `clio-coder run: no-op under --fail-on-noop: <N> tool calls ran and none succeeded` | A block stayed unresolved, or with `--fail-on-noop` every tool call failed (exit 1). | Fix the blocked action or its policy. |
| `clio-coder run: <N> dispatched worker(s) did not deliver: <runId> (<agent>, <outcome>): <detail>` | A worker the main agent dispatched ended without delivering (exit 1). The detail is clipped at 600 characters. | `clio-coder trace tail <runId>` or the receipt has the full text. |
| `clio-coder run: timed out after <N>s (--timeout)` | `--timeout` elapsed (exit 124). | Raise `--timeout` or narrow the task. |
| `worker_final_output_missing` | A worker process completed execution with exit code 0 but failed to emit a valid final answer before the stream closed. | Check the worker event log using `clio-coder trace tail <runId>` or inspect the receipt via `monitor(run_id="<id>", mode="receipt")`. |
| `[worker] bulk output incomplete: <reason>` | A worker could not write one of its event frames to stdout (a frame over 4 MiB, a stdout backlog past 16 MiB, a write error, or stdout that did not drain), so its trail has a gap. The worker aborted its run and exited nonzero. | Read the reason in the receipt's diagnostic text, rerun, and check the orchestrating process for stalls or a vanished reader. |
| `[worker] bulk evidence incomplete: <reason>` | The orchestrator knows the worker's event trail has a gap: an unparsable or oversized frame, a retention overflow, a detached consumer, a truncated final frame, a worker killed before it finished its output, or worker stdout the orchestrator itself did not read within 1 second of a clean exit. A clean exit becomes exit 1, and the receipt reports tool telemetry coverage `partial`. | Treat the run's tool history as incomplete, inspect it with `clio-coder trace tail <runId>`, and rerun when the result matters. |
| `worker_turn_timeout` or `worker_output_cap_exhausted` | A worker's model round passed the `safety.limits.workerResponseSeconds` deadline, or a locked round used up its output cap. Unfinished output stays partial. Deterministic: dispatch does not retry or fail over, and the target breaker is not penalized. | Narrow the task, raise `safety.limits.workerResponseSeconds`, or route to a faster model. |
| `result_contract_exhausted` | The worker spent its two repair rounds and its final result still missed the recipe's result contract. Deterministic: no retry. | Narrow the task or use a stronger model for that recipe. |
| `result_contract_invalid` | The worker exited successfully, but the host's validator found the final result nonconforming (`result contract failed: <reason>`). Classed `model-quality`, so it is retried on another agent or model, and the target is not penalized. | Read the reason in the receipt. If every retry fails, treat it like `result_contract_exhausted`. |
| `vram_capacity_fit_failure` | The model could not be scheduled or loaded due to insufficient GPU VRAM capacity on the target node. | Select a smaller quantized model variant, reduce context window size, or route to an alternative fleet node with greater memory capacity. |
| `loop_guard_tools_disabled_exhausted` | The loop detector identified repeated unproductive tool calls with identical arguments and disabled tool execution. | Inspect model prompts and provide clearer intermediate steering instructions to prevent recursive tool loops. |

## Settings, targets and CLI

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `fleet.decisionProfiles: retired without replacement: System One replaced decision profiles; bind an engine under systemOne.engines and systemOne.sites. Remove this key` | `settings.yaml` carries a non-empty `fleet.decisionProfiles` from the earlier decision layer. An empty `{}` is accepted. | Delete the key and bind an engine under `systemOne.engines` and `systemOne.sites`. See [System One](system-one.md). |
| `turnControl.interpretation: retired without replacement: the turn site (systemOne.sites.turn) reads the request and nothing falls back to the main model. Remove this key` | `settings.yaml` still has the retired `turnControl.interpretation` block. | Delete the `interpretation` block under `turnControl`. To let a decision model read the request, bind the `turn` site. |
| `systemOne.sites.<site>: engine '<name>' is not defined in systemOne.engines` or `systemOne.engines.<name>.target: target '<id>' is not defined in targets` | A site binds an engine that is missing, or an engine names a target that is not configured. | Declare the engine under `systemOne.engines` and the target under `targets`, then run `clio-coder doctor` and read the `system one <site>` rows. |
| A System One site is bound but nothing ever changes | Either the answering build has no fitted cut for that site, so the site runs in shadow (recorded while `systemOne.record` is on, no hint, ranking or act), or the site only records in this release (`toolResult`, `turnEnd` and the yolo gate), or a `turn` reading did not land before the prompt was built. LLM engines and unfitted Jev or Laya builds are always in shadow. | Read the build in `clio-coder systemone status` or the ledger, and fit cuts with `scripts/decision-probe.ts` from a source checkout, or set `systemOne.cuts`. See [System One](system-one.md). |
| `safety.autonomy: expected one of default \| yolo, got "auto-edit"; the retired value "auto-edit" becomes "default"` | The settings file uses a retired enum value, so every command stops at validation. Other retired values (`suggest`, `read-only`, `full-auto`, lifecycle `clio-managed`, tool governance `clio-policy`) fail the same way. | Run `clio-coder doctor` to preview the rewrite, then `clio-coder doctor --fix`, which replaces each retired value with the one the message names and keeps comments. |
| `<arg> is a global option and must come before the subcommand: clio-coder <usage> <command> ...` | A global CLI option (such as `--api-key`, `--no-context-files`, or `-nc`) was placed after the subcommand name. Directory roots are configured via `CLIO_CODER_*_DIR` environment variables. | Move the flag before the subcommand name (e.g. `clio-coder --api-key <key> run ...` instead of `clio-coder run --api-key <key> ...`). |
| `no target with id <id>` (from `clio-coder targets use`) or `unknown target or runtime: <id>` (from `clio-coder auth`) | The named target ID does not exist in `settings.yaml`. | Run `clio-coder targets` to view available targets, or configure a new target using `clio-coder targets add`. |
| `Serving context window is unknown. Compaction is bounded by the economic token ceiling; probe the target or configure its deployment limit for request-fit accounting.` | No probe, loaded-model state or setting reported the route's serving window. `/context` shows `context window unknown`. Automatic compaction still fires when the request reaches `context.compaction.maxTokens` (default 200,000 tokens), and a server overflow still triggers one compact-and-retry. The window-based threshold and request-fit accounting wait for a known limit. | Run `clio-coder targets --probe` with the model loaded, or set `targets[].capabilities.contextWindow` to the deployment's limit. See [configuration and targets](configuration-and-targets.md). |
| `Sign-in cancelled` | An OAuth sign-in prompt in the configure wizard was dismissed before a credential was entered. | Re-run `clio-coder auth login <target>` or the configure wizard to restart the sign-in. |
| `no local skill marketplace catalog or index configured` | No catalog directory (`CLIO_CODER_SKILL_CATALOG_DIR`, a `library/skills/` folder in the working tree, or the installed package's own `library/skills/` catalog) and no JSON index (`CLIO_CODER_SKILL_MARKETPLACE_INDEX`, `<configDir>/skill-marketplace.json`, or the package's `library/skills/skill-marketplace.json`) was found. On an npm install this means the package is incomplete; check `clio-coder doctor`. | Point `CLIO_CODER_SKILL_CATALOG_DIR` at a `library/skills/` catalog or `CLIO_CODER_SKILL_MARKETPLACE_INDEX` at a valid `skill-marketplace.json`, or install a skill from a local package directory with `clio-coder library install <path>`. A GitHub source goes through `clio-coder library import <github-tree-url>`. |

## Traces, sessions and servers

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `no trace database yet at <path>` | The trace mirror database has not been initialized because no interactive sessions or dispatches have executed yet. | Execute a turn or dispatch a task. In SQLite trace commands, this notice is informational (exit code `0`). |
| `trace database not found: <path>` | An explicit `--db <path>` flag was provided pointing to a nonexistent database file (exit 1). | Verify the database path or omit `--db` to use the default state directory database (`<stateDir>/trace.sqlite`); the next line prints that default path. |
| `Node.js ExperimentalWarning: SQLite is an experimental feature` | Node.js emitted an experimental feature warning for `node:sqlite`. | Clio Coder suppresses this one warning with a scoped filter when it loads the trace database. The filter stands down when Node runs with `--trace-warnings`, so that flag makes the warning visible again. |
| `session has no recorded cwd`, `session cwd <path> is missing`, or `session cwd <path> is not a directory` (the `cwd-fallback` overlay on `/resume`) | The session recorded in `meta.json` points to a workspace directory that has been deleted, unmounted, or renamed. | Choose **Continue** to use the terminal's current directory, or **Cancel** to return to the previous session. |
| `LM Studio instance '<id>' is also loaded on <peers>; a request may be served by that LM Link peer, and the footer and usage ledger name the id that answered when it differs.` | The model is resident on this server and on an LM Link peer. | Informational. The footer and the usage ledger name the instance that answered when it differs. Verify loaded instances with `clio-coder targets --probe`. |
| `LM Studio resolved '<model>' to loaded instance '<instance>' on target '<id>'.` | A bare model key matched a loaded instance, so Clio reuses it instead of loading another. | Informational. |
| `LM Studio target '<id>' does not advertise model '<model>'. Resident instances: <ids or none>. Configure an explicit LM Studio load before requesting an unlisted model.` | The requested model is not listed by the server. | Choose a listed model, or configure an explicit LM Studio load profile for it. |
| `400 model is already running` (llama.cpp router reply to a load request) | A load request reached a router whose model is idle or sleeping. | Clio does not post a load for a model it sees as loaded or sleeping, so this reply points at another client or a stale view of the slots. Verify router slots and the catalog before evicting anything. |

---

## Reading a cold cache

Prefix caching can reduce repeated prompt processing. Use `/context` to inspect
provider cache usage, compiled-prompt reuse, and any backend prefill timing.
Available fields depend on the serving runtime. A backend that omits cache-read
telemetry is shown without that observation.

When Clio Coder records a cause for a cold prefix, `/context` names it, for example:

```text
last cache-affecting events: working-set eviction (reuse measured separately)
```

The [context engine](../architecture/context-engine.md)
describes the eight recorded causes and the prompt layers they affect. Changes
to thinking settings, tool schemas, selected context, or model residency can
change the reusable prefix.

For a finished session, inspect the first assistant entry for each run in its
`current.jsonl`. `clio-coder paths` locates the session store. The
`promptCache.expectedColdReasons` field records causes;
`promptCache.backendVerdict` records the backend observation. Available backend
token counts and timing live under `promptCache.backend`. These commands provide
summaries:

```bash
clio-coder doctor
clio-coder usage report
```

If the compiled prompt was reused but the backend reports a cold prefix, check:

- **Server lifetime and sleep settings.** A restart, unload, or router sleep can
  discard resident cache state.
- **Other traffic on the endpoint.** Workers, another session, or another client
  can use the same cache slots. `clio-coder targets --probe` reports available
  slot information; fleet settings show Clio Coder's active endpoint allocations.
- **Model residency.** Switching a router to another model can replace the
  previous model's cache state.
- **Prompt identity.** Compare `promptHash` and `toolSignature` in
  `context-snapshots.jsonl`. Changes identify prompt or tool-surface updates;
  record the relevant diagnostics when reporting an unexplained cache miss.

Hybrid models with recurrent state can require processing from a context
checkpoint when earlier history changes. Check the serving runtime's checkpoint
configuration and the model's serving notes.

A cache hit can still have a long time to first token when the server restores
slots from host memory or waits for another request. For supported llama.cpp
router configurations, Doctor and target probes report idle-slot caching.
`--no-cache-idle-slots` or `cache-idle-slots = false` changes that behavior; choose
it according to the server's memory capacity and concurrent workload.

---

## A TUI that stops answering the keyboard

When an interactive session stops responding to typing, the question worth
answering before anything else is which half of the input pipeline stopped: the
stdin reader that hands bytes to the application, or the renderer that turns
them into a frame on stdout. Clio Coder keeps that evidence without being asked. Every
interactive process holds a bounded in-memory ring of the last 256 input-ingress
records and the last 256 committed frames, and writes it out when the process
receives `SIGTERM`, which is the signal a `kill` of the stuck pane sends.

The dump lands in the state directory `clio-coder paths` reports:

```text
<stateDir>/input-wedge/<ISO timestamp>-<pid>.json
```

The five newest dumps are kept and older ones are removed as new ones land.
Read `classification` first:

| `classification` | What it means |
| :--- | :--- |
| `input-not-committed` | Bytes reached the application and no frame carrying them ever reached stdout. The renderer is the stuck half. |
| `no-input-recorded` | Nothing was delivered at all. If the operator was typing, the stdin reader is the stuck half. |
| `input-committed` | Both halves were moving. Whatever the session was doing, it was not this pipeline. |

`msSinceLastInputIngress` and `msSinceLastCommittedFrame` say how long each half
had been quiet when the signal arrived, and the `inputIngress` and `frames`
arrays carry the records themselves. Frames are kept only when they reached
stdout, so an empty `frames` array is itself a finding.

For a full session trace rather than the tail, set `CLIO_CODER_RENDER_TRACE` to
a file path before starting the session. That writes every record, including
provider deltas and terminal writes, as JSONL. The ring is the always-on subset
of the same records, for the case where nobody armed the trace first.

---

## Diagnostic Commands

When encountering unexpected system behavior:

1. **System Health Check**: Run `clio-coder doctor` (or `clio-coder doctor --fix` to repair directory structure, credential permissions and retired or YAML 1.1 settings values, and record fleet preflight results).
2. **Target Connectivity Probe**: Run `clio-coder targets --probe` to verify authentication and reachability for all configured LLM providers.
3. **Trace Store Inspection**: Run `clio-coder trace runs` and `clio-coder trace tail <runId>` to inspect event logs, durations, and tool outputs.
4. **Receipt Validation**: Run `clio-coder evidence inspect <evidenceId>` or `/view verify <runId>` to check receipt integrity against the run ledger and execution telemetry. Build the evidence id first with `clio-coder evidence build --run <runId>`.
