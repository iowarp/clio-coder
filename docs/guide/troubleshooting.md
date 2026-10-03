# Troubleshooting & Error Remediation

This guide provides concrete, actionable remediation procedures for
operational errors, permission denials, target connection failures, and system
diagnostics in the current source tree. Each quoted message exists in source;
`<angle brackets>` mark values Clio fills in.

---

## Install and startup

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `clio-coder requires Node.js >=22.19.0; this is <version>.` | The Node on `PATH` is older than the floor. The package's `clio-coder` command checks before it loads anything else. | Install with the managed runtime: `curl -fsSL https://coder.iowarp.ai/install.sh \| sh`. Or point Clio at a newer Node with `CLIO_CODER_NODE=/path/to/node/bin/node`. See [HPC clusters](hpc-clusters.md). |
| `No model target is configured.` followed by ``Starting `clio-coder configure`.`` Variants: `Target '<id>' has no chat model configured.`, `Target '<id>' runs on '<runtime>', which cannot drive the main agent.`, `No usable default target is configured.` | A bare `clio-coder` found no usable chat route and detected none. | Finish the configure flow it starts, or run `clio-coder targets use <id> --model <model>`. A returning user with a detectable route is not sent here: Clio prints `Chat: <runtime> / <model> from <source>. Change it with /config.` and starts chat. See [configuration and targets](configuration-and-targets.md). |
| ``configuration cancelled; no target saved. Run `clio-coder configure` when you are ready.`` | Setup was left before any target was saved. The command exits 130. | Run `clio-coder configure` again. |
| `[install] error: do not run this installer with sudo; it installs into your home directory.` | `install.sh` was started under `sudo` with `SUDO_USER` set. | Rerun the same command without `sudo`. `CLIO_CODER_INSTALL_ALLOW_SUDO=1` installs for root on purpose. |
| `[install] error: refusing to overwrite <launcher>, which this installer did not write; ...` or `refusing to replace <launcher>; it points to <target> ...` | A `clio-coder` that the installer did not create sits at the launcher path, or a symlink points outside the install. | Move it aside, choose another `--bin-dir`, or rerun with `--force`. |
| `[install] error: installation locked at <root>/.install-lock (owner <pid>). ...` | Another installer, rollback or uninstall holds the lock, or a killed one left it. | Wait for the owner. If that process has exited, remove only that lock directory and retry. |
| `[install] error: only <N> MB free under <root>; Clio Coder and its runtime need about 732 MB. ...` | Not enough free space at the install root. | Free space or pass `--install-dir` on a larger filesystem. |
| `[install] error: checksum mismatch for <file> ...`, `the OpenPGP signature on SHASUMS256.txt is BAD; refusing to install ...`, or `CLIO_CODER_REQUIRE_SIGNATURE=1, but no verified signature covers SHASUMS256.txt` | The Node download or its mirror does not verify. The installer fails closed. | Retry, or fix the mirror (`CLIO_CODER_NODE_MIRROR`). Do not bypass: only drop `CLIO_CODER_REQUIRE_SIGNATURE` when a missing `gpgv` is the only problem. See [HPC clusters](hpc-clusters.md). |
| `[install] error: neither curl nor wget was found; ...` | The installer has no downloader. | Install one, or pass `--node-tarball` and `--package`. |
| `[install] error: npm could not install <spec>. Common causes: no route to the registry (set https_proxy, or npm_config_registry for a mirror), an unknown version, or a full disk under <root>.` | The package install failed. | Fix the proxy, registry or version named, then rerun. |
| `[install] error: package is installed, but local migrations/initialization need attention; run: <launcher> upgrade --post-install. ...` | The post-install step failed after the package landed. `install.ps1` words it `package installed, but local migrations/initialization need attention. Run clio-coder upgrade --post-install; the previous version remains available with: clio-coder upgrade --rollback`. | Read the lines above it, run the printed command, then `clio-coder doctor`. `--rollback` restores the previous version. |
| `[install] error: candidate checks failed; previous install remains active` | The new version failed its startup check, so the manifest was not switched. | Nothing is lost. Read the output above this line, fix what it names, and rerun. |
| `[install] error: glibc <version> is older than 2.28, which official arm64 Node.js builds need, and no older-glibc arm64 build exists. ...` | Linux arm64 with an old glibc has no supported Node build. | Use conda-forge `nodejs` and `npm install -g @iowarp/clio-coder` with it. |
| `Native Windows managed lifecycle requires 0.6.0 or later; registry returned <version>. ...` | `install.ps1` fetched a package older than 0.6.0. | The active launcher is unchanged. Install a 0.6.0 or later version. |
| `clio-coder: upgraded <from> → <to>. What changed is in CHANGELOG.md, section <to>.` | The first interactive launch after the recorded version changed. It shows once per version. | Informational. Read the shipped `CHANGELOG.md` section. |
| `Installation changed · /quit, restart clio-coder, then /resume` | The installed files changed while this session ran. | Leave with `/quit`, start `clio-coder` and `/resume`. |
| `v<version> available · /upgrade to review` (or `clio-coder upgrade --channel=beta to install`) | The update monitor found a newer release. | `/upgrade` in the TUI, or `clio-coder upgrade`. Set `CLIO_CODER_UPDATE_CHECK=0` to silence it. |
| `Updated to v<version> · current session preserved; restart then /resume to use it; upgrade --rollback to undo` | A background update installed a new version beside the running one. | Restart and `/resume`. `clio-coder upgrade --rollback` undoes it and turns background updates off. |
| `[install] error: CLIO_CODER_INSTALL_GUI must be 1 or 0, got '<value>'` | `install.sh` read another value from `CLIO_CODER_INSTALL_GUI`. | Set it to `1` or `0`, or unset it to be asked on a terminal. |
| `[install] warning: the desktop app runs as a login service on Linux only; start it here with: clio-coder gui` | `--gui` or `CLIO_CODER_INSTALL_GUI=1` on a system other than Linux. | Informational. Run `clio-coder gui` to start the app for this terminal. |
| `[install] warning: the desktop app was not set up (it needs a systemd user session). Retry later with: clio-coder gui background install` | The Linux login service could not be installed. The install itself succeeded. | Start a systemd user session, then run the printed command. |
| `[install] error: <message>` (`install.ps1`) | Every `install.ps1` failure prints this line, and an unexpected exception adds the failing script position. Run with `-File` or through `install.cmd` the process exits 1; under `irm \| iex` the shell stays open and sets no exit status. | Fix what the message names and rerun. `-DryRun` previews a run without changing anything. |
| `[install] error: no installer manifest at <root>/install.json; nothing to roll back` | `--rollback` or `-Rollback` against a root the installer never wrote. | Pass the right `--install-dir`, or reinstall. |
| `This install is pinned to <X>, so upgrade and background updates leave it there.` (`upgrade`) or `This install is pinned to <X>, so /upgrade leaves it there. To follow its channel again, run:` | The install was made with an exact `--version` or a `--package`, so it keeps that version. A rollback of a pinned install moves the pin to the restored version. | Run the installer command printed beneath it, which passes `--version <channel> --auto-update` (`-Version <channel> -AutoUpdate`). |

## Lifecycle commands

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `This installation needs a package-manager update; no package was replaced.` (`upgrade`, exit 1) | A pnpm, Bun, Homebrew, WinGet, local or unknown layout. | Run the printed command with the manager that owns the install, then `clio-coder upgrade --post-install`. |
| `Rollback works only for native installer installs, made by install.sh or install.ps1` (`upgrade --rollback`, exit 2) | Only installer installs keep a previous version. An npm, pnpm or Bun layout also gets the manager command for a chosen version. | Use the owning package manager to install an older version. |
| `No previous version is installed, so there is nothing to roll back to` (`upgrade --rollback`, exit 1) | An installer install that has never had a second version installed. | Install the version you want with the installer's `--version`. |
| `Rollback failed; the active version is unchanged` (`upgrade --rollback`, exit 1) | The installer's rollback did not finish, for example the previous version did not start. | Read the installer output under it. Nothing was switched. |
| `migration manifest is unreadable` (`upgrade`, exit 1) | `migrations.json` has invalid JSON, shape, duplicates or size. | Restore it from backup or review it. `clio-coder upgrade --skip-migrations` updates the package only. |
| `installation integrity check failed` (`upgrade`, exit 1) | A core row failed after the install step. | `clio-coder doctor --fix`, then `clio-coder upgrade --post-install`. |
| `unsafe directory layout` / `uninstall refused an unsafe directory layout: ...` / `reset refused an unsafe directory layout: ...` (exit 2) | The four roots are relative, equal or nested, for example through overrides. | Set four absolute, distinct, non-nesting roots, then `clio-coder paths` and `clio-coder doctor`. |
| `` `clio-coder reset` needs a terminal to confirm; pass --force to skip the prompt `` (same for `uninstall`, exit 2) | No terminal and no `--force` or `--dry-run`. | Pass `--dry-run` to preview or `--force` to proceed. |
| `Another native session (pid <N>) is still running; close it before uninstalling` | `uninstall` found a live session of the same installer install. | Close that session and rerun. |
| `Native installation is locked; retry after the installer exits` | The install root's lock is held. | Wait, or remove a stale `.install-lock` as in the installer row above. |
| `Reset stopped; Clio state was preserved.` or `Could not stop the graphical installation; Clio state was preserved.` | An owned background app could not be verified or stopped. | Run `clio-coder gui background uninstall && clio-coder gui launcher uninstall` from a build that includes the app, then retry. |
| `Background service belongs to another installation; Clio state was left unchanged.` (`reset` or `uninstall`, exit 1) | The background app was installed by a different Clio installation. An earlier version of this same installer install does not count as different. | Run `reset` or `uninstall` from the installation that owns the app, or remove the app with that installation's `clio-coder gui background uninstall`. |
| `<N> path(s) could not be removed:` | A partial delete: some paths resisted. | Fix the permission or close the holding process, then run the printed command again. It resumes. |

## Claude Agent SDK

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `The Claude SDK runtime needs @anthropic-ai/claude-agent-sdk (about 224 MB). Run: <command>` | A `claude-sdk` target was configured or a `claude-sdk` worker was dispatched, and the optional package is not in the install's package root. Nobody could be asked, or the offer was declined. | Run the printed command. It matches the install method: the managed Node and npm for an installer install, `pnpm --dir <root> add --save-optional --prod ...`, `bun add --cwd <root> --optional --production ...`, or `npm install --prefix <root> --no-save --omit=dev --include=optional ...`. |
| `The Claude SDK runtime needs @anthropic-ai/claude-agent-sdk (about 224 MB). Install it now?` with **Install now** / **Not now** | An installer install with an attended operator reached a `claude-sdk` target. | **Install now** installs the package into the current version's package root, which takes up to 10 minutes. **Not now** fails the run with the message above. A version installed later by `upgrade` asks again. |

## Project files ignored for lack of trust

Project settings, hooks, safety policy, extensions and plugins carry authority, so Clio loads them only after the operator approved their exact bytes. For extensions and plugins the approved file is the project's install state, `.clio-coder/extensions/state.json` or `.clio-coder/plugins/state.json`. Until then the files are ignored and the session starts without them, and the project's packages of that kind stay unloaded while user-scope packages load normally.

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `[clio-coder:trust] <file> is untrusted; project <surface> ignored. Review with clio-coder config trust <surface>.` (`<surface>` is `settings`, `hooks`, `safety`, `extensions` or `plugins`) | `.clio-coder/settings.yaml`, `settings.local.yaml`, `hooks.yaml`, `hooks.local.yaml`, `safety.yaml` (for `safety`, the nearest one in the workspace or an ancestor), `extensions/state.json` or `plugins/state.json` exists and no approval is recorded for this workspace. | `clio-coder config trust <surface>` prints the captured files and a digest. Approve exactly those bytes with `clio-coder config trust <surface> --hash <sha256>`, then restart (reload extensions for hooks and extensions, `/library reload` for plugins). `--revoke` withdraws it. |
| The same notice with `is changed;` | The file's bytes differ from the approved digest. | Review the new bytes and approve them again. |
| `project <surface> changed since review; inspect it again before approving` (exit 1) | The digest passed to `--hash` no longer matches the files. | Run `clio-coder config trust <surface>` again and approve the new digest. |
| `no readable project <surface> files to approve` (exit 1) | The surface has no readable files. For `extensions` or `plugins`, the project has no install state yet. | Create or fix the file, or install the package first, then review it. |
| `extensions list` shows `untrusted`, or a package carries `project extensions are not trusted for this workspace and are not loaded; review with clio-coder config trust extensions`. The plugin form reads `project plugins are not trusted for this workspace and are not loaded; review with clio-coder config trust plugins`, and `library list` shows the copy as `invalid` or a skill package as `requires trust`. | The project's install state is unapproved or changed, so every project copy is blocked. A user copy with the same ID still loads. | Review with `clio-coder config trust extensions` or `plugins`, approve the digest with `--hash`, then run `/extensions reload` or `/library reload`. |
| Project packages stopped loading after an install, update, enable, disable or remove | Each of those rewrites the install state, so the approval no longer matches and the surface reads `changed`. Only a workspace's first project install approves itself. | Review the new state with `clio-coder config trust <surface>` and approve it. |
| A package installed with `library import`, `interop adopt`, `share import`, `/archive import` or a skill install offer into a project does not load | Those paths never approve workspace trust, including for the workspace's first project install. | Approve the project's install state with `clio-coder config trust extensions` or `plugins`. |
| A dispatched worker's task worktree reports its project packages as untrusted | The worktree inherits its origin's approval only while its install state is byte-identical to the origin's approved file and the origin's approval is current. A hand-made `git worktree` never inherits. | Approve the origin again, make the worktree state match it, or approve the worktree directly. |
| `usage: clio-coder config trust safety\|hooks\|settings\|extensions\|plugins [--json \| --hash SHA256 \| --revoke]` or `trust expects --json, --revoke, or --hash followed by the full reviewed SHA-256 digest` (exit 2) | Wrong arguments. | Pass a surface and, to approve, the full 64-character digest. |
| `credentials are not allowed in project settings; key ignored` | A project settings layer names a credential key. | Move credentials to `clio-coder auth` or user settings. |
| `project autonomy may only tighten the level in user settings; project value ignored` or `autonomy is set only in user settings or by the operator; project value ignored` | A project layer asked for a looser or invalid `safety.autonomy`. | Set autonomy in user settings, `--autonomy`, or the session toggle. |
| `trustedUnmediated is set only in user settings; project value ignored` | A project layer set `trustedUnmediated` on a target or external agent. | Set it in user `settings.yaml`. |

ACP clients receive the ignored files in `_meta["clio-coder/trust"]` on `session/new`, `session/load` and `session/resume`, each with the `clio-coder config trust <surface>` command that fixes it.

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
| `clio-coder run cannot confirm permission requests; rerun interactively to approve this action.` | A tool call required manual permission confirmation during a non-interactive headless `clio-coder run` execution. | Run interactively in the TUI (`clio-coder`) to review and approve the request, or review the workspace policy in `.clio-coder/safety.yaml`. `--autonomy yolo` removes ordinary confirmation prompts; damage-control rules can still require approval. Put decisions in the task prompt. |
| `permission refusal limit reached: the worker ended after 3 refused commands with no approval route: 1) <tool> `<command>` refused by rule <rule>; ...` (receipt exit 3, outcome `failed/permission_required`) | A dispatched worker kept proposing execute commands that nobody could approve. | Read the named commands and rules. Declare the commands in `.clio-coder/safety.yaml` (approved with `clio-coder config trust safety`), change the task, or run it attended. See [Exit codes and output](exit-codes-and-output.md). |
| `permission required for <tool> (<class>); fleet.permissions.mode=fail ends this run` | `fleet.permissions.mode` is `fail` and the worker hit its first refusal. | Use `deny` so refusals return to the worker, or grant the work. |
| `clio-coder run: output token limit reached (stopReason=length); generation incomplete. ...` | The provider stopped on its output limit (exit 1). | Narrow the task, lower reasoning effort, or raise the output budget. |
| `clio-coder run: provider stream ended without an assistant response or terminal tool result` | The stream closed with no answer (exit 1). | Check the target with `clio-coder targets --probe`, then retry. |
| `clio-coder run: the agent recorded an explicit limitation; the task is incomplete` | The agent called `limitation` (exit 1). | Read the stated limitation and supply what it lacked. |
| `clio-coder run: no-op: <N> tool calls were blocked without recovery and no write succeeded`, or `clio-coder run: no-op under --fail-on-noop: <N> tool calls ran and none succeeded` | A block stayed unresolved, or with `--fail-on-noop` every tool call failed (exit 1). | Fix the blocked action or its policy. |
| `clio-coder run: <N> dispatched worker(s) did not deliver: <runId> (<agent>, <outcome>): <detail>` | A worker the main agent dispatched ended without delivering (exit 1). The detail is clipped at 600 characters. | `clio-coder trace tail <runId>` or the receipt has the full text. |
| `clio-coder run: timed out after <N>s (--timeout)` | `--timeout` elapsed (exit 124). | Raise `--timeout` or narrow the task. |
| `worker_final_output_missing` | A worker process completed execution with exit code 0 but failed to emit a valid final answer before the stream closed. | Check the worker event log using `clio-coder trace tail <runId>` or inspect the receipt via `monitor(run_id="<id>", mode="receipt")`. |
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
| `Serving context window is unknown. Probe the target or configure its deployment limit; threshold compaction is disabled until a limit is known.` | No probe, loaded-model state or setting reported the route's serving window. `/context` shows `context window unknown` and threshold compaction is off. A server overflow still triggers one compact-and-retry. | Run `clio-coder targets --probe` with the model loaded, or set `targets[].capabilities.contextWindow` to the deployment's limit. See [configuration and targets](configuration-and-targets.md). |
| `Sign-in cancelled` | An OAuth sign-in prompt in the configure wizard was dismissed before a credential was entered. | Re-run `clio-coder auth login <target>` or the configure wizard to restart the sign-in. |
| `no local skill marketplace catalog or index configured` | No catalog directory (`CLIO_CODER_SKILL_CATALOG_DIR`, a `library/skills/` folder in the working tree, or the installed package's own `library/skills/` catalog) and no JSON index (`CLIO_CODER_SKILL_MARKETPLACE_INDEX`, `<configDir>/skill-marketplace.json`, or the package's `library/skills/skill-marketplace.json`) was found. On an npm install this means the package is incomplete; check `clio-coder doctor`. | Point `CLIO_CODER_SKILL_CATALOG_DIR` at a `library/skills/` catalog or `CLIO_CODER_SKILL_MARKETPLACE_INDEX` at a valid `skill-marketplace.json`, or install a skill from a local package directory with `clio-coder library install <path>`. A GitHub source goes through `clio-coder library import <github-tree-url>`. |

## Traces, sessions and servers

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `no trace database yet at <path>` | The trace mirror database has not been initialized because no interactive sessions or dispatches have executed yet. | Execute a turn or dispatch a task. In SQLite trace commands, this notice is informational (exit code `0`). |
| `trace database not found: <path>` | An explicit `--db <path>` flag was provided pointing to a nonexistent database file (exit 1). | Verify the database path or omit `--db` to use the default state directory database (`<stateDir>/trace.sqlite`); the next line prints that default path. |
| `Node.js ExperimentalWarning: SQLite is an experimental feature` | Node.js emitted an experimental feature warning for `node:sqlite`. | Clio suppresses this one warning with a scoped filter when it loads the trace database. The filter stands down when Node runs with `--trace-warnings`, so that flag makes the warning visible again. |
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

When Clio records a cause for a cold prefix, `/context` names it, for example:

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
  slot information; fleet settings show Clio's active endpoint allocations.
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
them into a frame on stdout. Clio keeps that evidence without being asked. Every
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
4. **Receipt Validation**: Run `clio-coder evidence inspect <evidenceId>` or `/view verify <runId>` to check cryptographic integrity and execution telemetry. Build the evidence id first with `clio-coder evidence build --run <runId>`.
