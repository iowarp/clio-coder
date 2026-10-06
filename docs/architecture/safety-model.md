# Clio Coder Safety Model

`createSafetyPolicyEngine` in [policy-engine.ts](../../src/domains/safety/policy-engine.ts) decides what a tool call may do. One admission evaluator, `evaluateAdmission` in [admission.ts](../../src/domains/safety/admission.ts), applies that decision and then the autonomy mapping in [autonomy.ts](../../src/domains/safety/autonomy.ts). The native tool registry ([registry.ts](../../src/tools/registry.ts)), the Claude SDK bridge and the ACP delegation mediator all decide through it, each translating its transport into the same input. The [tool usage guide](../guide/tool-usage.md) shows the operator surface.

The registry enforces safety rules before admitted tool calls execute. The session prompt describes those rules to the model. Safety decisions, aborts and session park or resume events are appended to a daily NDJSON audit log at `<state>/audit/YYYY-MM-DD.jsonl`, named by local date ([audit.ts](../../src/domains/safety/audit.ts)).

## Execution boundary

Clio Coder gates tool calls before they run. Commands, hooks, and external agents run with the operator's operating-system permissions. Environment filtering controls inherited variables. Filesystem and process isolation require an external sandbox, except for the commands of a dispatched native worker, which can run under the [worker OS sandbox](#worker-os-sandbox) and the runtime child of an api 2 extension, which runs under the OS sandbox when one exists ([extensions and plugins](#extensions-and-plugins)).

## Autonomy

Autonomy is the operator's grant to the main agent. There are two levels:

- `default` runs workspace reads, edits and recognized commands. Other commands, outward actions, access outside the workspace, system changes and plan-scale dispatch ask the operator.
- `yolo` is the same agent without those ordinary stops. It never outranks the safety net: hard blocks, damage-control rules and protected paths hold at both levels.

Only the operator sets the level: the user `settings.yaml` (`safety.autonomy`, default `default`), `/settings`, `clio-coder configure`, `--autonomy` on `clio-coder` or `clio-coder run`, the leader-key toggle (`y`) in the TUI, or the session mode of an ACP client. No tool, skill, worker or model output can raise it, and `configure_clio` refuses `safety.autonomy`. A project settings layer can only tighten: a project `safety.autonomy` that would loosen the user level, or is not a valid level, is ignored and reported as a layer issue, so a repository can ask for `default` when the user runs `yolo` but never the reverse. Dispatched workers run under their own permits and take only the operator's execute authority from a `yolo` session; see [Worker permits](#worker-permits).

| Action | `default` | `yolo` |
| --- | --- | --- |
| Read, list, search or `data` inside the workspace or a [read-scope exemption](#read-scope) | runs | runs |
| Read, list, search or `data` outside the workspace | asks | runs |
| Write or edit inside the workspace | runs | runs |
| Write or edit a new file outside the workspace, or another `system_modify` action such as `sudo`, `apt`, `brew`, `pip install`, `npm install -g`, `systemctl` or `chown` | asks | runs |
| Write or edit that replaces an existing file outside the workspace (rule `outside-file-replacement`) | asks | asks, except for a file this session created and nothing else has written since |
| Model edit of `.clio-coder/settings.yaml` or `.clio-coder/settings.local.yaml` (rule `project-settings-confirm`), or `configure_clio` apply on `fleet.default`, `fleet.profiles`, `fleet.agentProfiles`, `fleet.rosters` or `fleet.adaptiveRouting` | asks | asks |
| [Recognized command](#recognized-commands) | runs | runs |
| Any other command: project build, lint, typecheck and CI scripts, `$(...)` and `<(...)`, shell variables and interpreter `-c` or `-e` source, an unquoted `~`, brace or glob operand, recursive `grep` or `ls -R`, `grep -f`, a symlink-following flag such as `find -L`, a redirect into a file, a step outside the recognized set | asks | runs |
| Outward action: `ask_user` with `exposure: outward`, a bash `git push` other than `--dry-run`, or `web_fetch` other than a bodiless GET or HEAD | asks | runs |
| Plan-scale dispatch: several tasks, a compete or council, a remote node, an approved failover, or applying a compete winner | asks once for the whole plan | runs, and the plan hash is sealed into each receipt |
| Damage-control confirmation rule | asks | asks |
| Hard block | blocked | blocked |

The `yolo` exception for `outside-file-replacement` tracks files by identity (device, inode, size and modification time) in memory, per session. A file that existed before the session, or that anything else wrote after the session's last write, asks again. The record is cleared when the session is parked.

A read-only run is a dispatch restriction, not a level. Reviewer, judge and council roles, `/oracle`, the watchdog verifier, fleet `scope: readonly`, recipes with `capabilityClass: read-only`, and the operator's `--read-only` flag set it. For mediated tools, the registry denies calls other than reads inside the workspace, including skill activation. Dispatch refuses a read-only request on an agent-managed ACP peer that cannot enforce the restriction; subprocess runtimes do not expose per-call registry mediation, and their read-only guarantees vary by runtime.

### Recognized commands

A bash command runs without an ask at `default` only when every step is recognized. Recognition is conservative. A word the shell would expand (an unquoted `~`, brace or glob, a `$'...'` or `$"..."` word), a substitution, or an option that can write, execute, name an input list or follow links leaves the whole command unrecognized, and the autonomy level decides it: ask at `default`, run at `yolo`, deny in a read-only run. The recognized set is:

- **Built-in test runners** with bare-word arguments only (`TEST_RUNNER_COMMANDS` in [policy-engine.ts](../../src/domains/safety/policy-engine.ts)): `npm`, `pnpm`, `yarn` and `bun` with `test`, `run test` or `run test:<name>`; `node --test`; `pytest`; `python -m pytest` and `python -m unittest`; `uv run --no-sync pytest` and `uv run --no-sync python -m pytest` (`--frozen` and `--locked` allowed, `--no-sync` required because a synchronizing `uv run` downloads dependencies); `cargo test`; `go test`; `ctest`; `make test` and `make check`; `ninja test`; `meson test`; `mvn test`; `gradle test` and `gradlew test`. They execute repository-authored code, which is the accepted cost of letting a headless run verify its own work. Quoting, substitution and operators fall through to the other rails.

  The Python runners (`pytest`, `python -m pytest`, `python -m unittest`, and the two `uv run --no-sync` forms) also accept a leading `PYTHONPATH=<entries>` for a src-layout project, as in `PYTHONPATH=src python3 -m pytest tests`. Every colon-separated entry must be a non-empty relative path made of word characters, `.`, `/` and `-`, with no `..` segment. An absolute entry, a `..` segment, any other leading variable assignment, or the prefix on a runner outside that list leaves the command unrecognized. The prefix is read only on a standalone command, never on a step inside a chain. It adds no reach, because the runner already executes the repository's code from the call's cwd and the relative entries keep the import roots inside it, and a worker that would otherwise be denied the unrecognized form runs the check its task named.
- **Project commands** declared in an approved `.clio-coder/safety.yaml`. An entry with `requireConfirmation: true` asks at `default` and runs at `yolo`.
- **Project scripts** `npm run lint`, `npm run build`, `npm run typecheck` and `npm run ci` pass the safety net but ask at `default` unless a project command declares them, and run at `yolo`.
- **Read-only inspection** on workspace paths: `cat`, `head`, `tail`, `wc`, `nl`, `ls`, `pwd`, `stat`, `basename`, `dirname`, `realpath`, `readlink`, `echo`, `printf`, `true`, `which`, `cut`, `tr`, `grep`, `egrep`, `fgrep`, `rg`, `find` and `sed -n` with a print-only line script. Each operand is held to the workspace as the `read` tool holds its path, and options that write, execute, read a list file or walk links are refused: `tail -f`, `wc --files0-from`, `ls -R`, `-L` and `-H`, `grep -f`, `printf -v`, `find -exec`, `-delete`, `-fprint` and `-L`, and every GNU long-option abbreviation of those.
- **`rg`** when it searches named regular files, a directory that a bounded walk proves holds no zero-access file (10,000 entries across the whole command, symlinks not followed), `--files` listings, or a pipe with no file operand. It is not recognized while the tool environment names `RIPGREP_CONFIG_PATH`, nor before the login environment has been captured, because a ripgrep config can add `--follow`, `--pre` and `-z`.
- **Git inspection**: plain `git`, optionally with leading `-C <dir>` options that stay inside the workspace, in the inspect class of the shared Git policy ([git-policy.ts](../../src/domains/safety/git-policy.ts)), such as `status`, `diff`, `log`, `show`, `rev-parse`, `rev-list`, `ls-files`, `ls-tree`, `describe` and the listing forms of `branch`, `tag` and `stash`. These can print the history of files already tracked in git. `git grep`, `git blame`, `git annotate` and `git cat-file` ask, as do helper-invoking flags such as `--ext-diff` and `--output`, and `git diff --check` is recognized only as a standalone command.
- **`cd <workspace directory>`** as a chain step outside a pipeline, when the target and its physical resolution stay inside the workspace and carry no expansion.
- **Chains** of up to 16 recognized steps joined by `&&`, `||`, `;` or `|`, with output redirected only to `/dev/null` or merged with `2>&1`. Every step is checked on its own and the chain takes the strictest verdict.

Commands that hide their content ask even when each word looks harmless. An uninspectable shell script, `$VAR` or interpreter source (`python -c`, `node -e`) asks under rule `bash-hidden-content` (at `default`; an uninspectable script asks at `yolo` too). Command substitution asks at `default` under `bash-command-substitution`. A bash `cwd` outside the workspace is blocked under `bash-cwd-escape`.

## The safety net

The policy engine checks a call in this order, and the first block wins:

1. Write-root confinement. When a run declares `write_roots`, a write outside them is blocked, and so are commands and dispatch, which could write anywhere. A native worker whose commands run under the OS sandbox (`safety.sandbox` not `off`, a usable bubblewrap backend, a local HTTP runtime, no `fleet.nodes`) keeps `bash`, `verify` and `run_script` because the sandbox binds their writes to the roots. Dispatch stays blocked.
2. Damage-control blocks from [damage-control-rules.yaml](../../damage-control-rules.yaml), any `git_destructive` command that no ask rule covers, and the delete-target rule below.
3. An approved `.clio-coder/safety.yaml` that is invalid. Execution tools fail closed until it is fixed.
4. Operator authority. A tool cannot grant workspace trust, change Clio Coder's `settings.yaml` or the workspace trust records, or change installed skills, plugins and extensions outside the operator CLI.
5. Path policy. Zero-access paths, such as `.env`, `~/.ssh/`, `*.pem`, `credentials.yaml` and `.git/config`, are neither read nor written, and a bash command that names one is blocked. Read-only paths, such as `.clio-coder/safety.yaml`, `.clio-coder/verifiers.yaml`, installed resource directories, system directories, shell rc and history files, build output (`dist/`, `build/`, `target/`), dependency trees (`node_modules/`, `.venv/`) and minified bundles, are never written.
6. Confirmation rails. A damage-control ask rule, `outside-file-replacement`, `project-settings-confirm` and `bash-hidden-quoting` ask at both levels. Library changes, system changes and the ordinary command rails ask at `default` and pass at `yolo`. A library change is a `clio-coder library` `install`, `import`, `update`, `remove`, `enable`, `disable`, `pin`, `register`, `sync`, `push` or `remote` run through a shell (reason `library-confirm`); a `--dry-run` of `install`, `import`, `update`, `enable`, `disable` or `remove` writes nothing and never asks.

The registry then applies the read-only restriction, the turn's allowed tools and any skill's tool narrowing, and last the autonomy mapping in the table above.

Paths are judged after links and a physical `..` are resolved, so a link cannot carry a read or a write out of scope unnoticed.

### Read scope

`read`, `ls`, `grep`, `find` and `data` are held to the workspace by [read-scope.ts](../../src/domains/safety/read-scope.ts). A target is judged on every spelling the tool can open: the path as given, the physical path after links, and the fallbacks the read tools try when the path does not exist. A path that resolves outside the workspace asks at `default` and runs at `yolo`, and a path that cannot be resolved counts as outside. Zero-access entries apply in every case.

Some trees outside the workspace are readable without an ask because Clio points the model at them: installed skills, plugins and extensions under the config directory, the user skill roots of interoperating agents, the offload scratch and receipts directories under the state directory, and the installed package's own `docs/`, `src/`, `README.md` and `CHANGELOG.md`. Roots the operator owns also admit a path that sits under the root as written, so a skill installed as a link into a dotfiles tree stays readable. A worker's sandbox read roots (the parent checkout and shared dependency trees of a task worktree) are exempt for that worker.

### Damage-control rules

Rules live in [damage-control-rules.yaml](../../damage-control-rules.yaml) and compile at load. A rule either blocks or asks, and a rule match is judged against each command a shell string would run, not only the string as a whole.

Hard blocks include `rm` of `/`, the home directory or everything in either, `sudo rm`, `rmdir --ignore-fail-on-non-empty`, `find -delete`, `rsync --delete`, `shred`, `chmod 777`, recursive `chmod` on system roots, recursive `chown` to root, `dd` to a device, `mkfs`, fork bombs, `kill -9 -1`, `killall -9`, `pkill -9`, clearing shell history, force pushes (`--force`, `-f` and `+` refspecs), `git reset --hard`, forced `git clean` without a preview flag, `git stash clear`, `git reflog expire`, `git gc --prune=now`, `git filter-branch`, `curl` or `wget` piped to a shell, writes to system roots through redirects or `tee`, cloud deletion commands (AWS, gcloud, Firebase, Vercel, Netlify, Wrangler), and SQL `DROP`, `TRUNCATE` and `DELETE` without a `WHERE`.

Confirmation rules ask at both levels: `git checkout -f`, `git checkout -- .`, `git restore .`, `git stash drop`, `git branch -d` or `-D`, deleting a remote branch with `git push`, `gcloud iam policies`, SQL `DELETE` by id, `truncate -s 0`, and `:>`. The whole-worktree spellings `./`, `:/` and a pathspec after `--` count as `.` for the two git rules.

Damage-control scans cover commands. A `write`, `edit`, `artifact`, `dispatch` or `tasks` call is scanned for its destination path alone, and a read-class call's payload is not scanned, so a file that documents `rm -rf /` can be written and a script that contains it is judged when it runs.

A project `.clio-coder/safety.yaml` can add path entries, but the built-in zero-access, read-only, no-write and no-delete defaults hold unless the project sets `disableDefaultPathPolicy: true`. The no-write defaults cover other agents' configuration directories, and the no-delete defaults cover `README*`, `LICENSE*`, `CLAUDE.md` and `~/.claude/`.

#### Delete targets

A shell delete is judged by where it lands, never by its flags. `rm -rf build` inside the workspace is an ordinary command that asks at `default` and runs at `yolo`. A delete is a hard block at both levels, under rule `delete-outside-workspace`, when it targets the workspace root, a path outside the workspace, the workspace's `.git`, or a path the shell names only at run time such as `$VAR` or a command substitution. Scratch roots (`/tmp`, `/var/tmp`, the system temp directory) are exempt, except for a checkout's own root and `.git`. Any spelling of the same delete is refused, and globs and brace expansions are judged by the directory before the first wildcard.

Every rule is matched against each command a shell string would run, so an operator cannot hide one: `git restore . && echo ok`, `git restore .; ls`, `sh -c "git restore ."` and `$(git restore .)` all ask. Command substitutions using `$(...)` or backticks are scanned inside double quotes too ([protected-artifacts.ts](../../src/domains/safety/protected-artifacts.ts)).

#### Matching details

The policy exempts rule matches only when every span is inside an inert quoted argument to `echo`, `printf`, `git commit` or `git tag` messages, or `grep` and `rg` patterns. Whole-command and segment scans remain active. SQL and operator matches, substitutions, pipelines, heredocs and executable wrapper words prevent the exemption. Each scan candidate must independently prove its matches inert before an exemption applies, so quoted prose cannot suppress a destructive normalized git command elsewhere in the same call. These checks inspect the shell command alone. A bash call's `cwd` is path metadata and cannot turn quoted documentation into shell execution.

Git damage-control scans also dequote simple-command words, join backslash-newline continuations, look through wrappers such as `env`, `sudo`, `nice` and `timeout` and through path-spelled `git`, and skip recognized git global options to find the subcommand. Original scans remain active, so normalization adds coverage without removing conservative matches. Combined short flags are expanded for `git clean`, `push` and `checkout`, and unique destructive long-option prefixes are expanded for `clean`, `checkout`, `reset` and `push`. Ambiguous prefixes and `--force-with-lease` are preserved.

- `git clean` previews with `-n` or `--dry-run` pass the safety net at both levels, including combined short flags and previews that also carry force flags, and then follow the ordinary command rails. Forced deletion without a preview flag stays blocked.
- `git push --force-with-lease`, including an explicit lease value, passes the safety net at both levels and then follows the outward-action row of the autonomy table. Unconditional `--force`, `-f` and plus-prefixed refspecs such as `git push origin +main` stay blocked.
- Whole-worktree `git checkout .` and forced checkout ask at both levels.
- Restoring a named file from an explicit `--source` is an ordinary single-path restore. Whole-worktree restores, including `--staged .`, and branch deletion with `-d` or `-D` ask at both levels because they change repository state across the selected scope.

## Project policy

A project `.clio-coder/safety.yaml` (found by walking up from the working directory, schema `version: 1`) can declare:

| Key | Purpose |
| --- | --- |
| `commands` and `tasks` | Commands that run without an ask, each with `id`, `command`, optional `cwd`, `timeoutMs`, `maxOutputBytes`, `actionClass`, `shellOperators` (`deny` or `allow`), `env` (`mode: none` or `allowlist`), `requireConfirmation`, `rationale`, `owner` and `comment`. |
| `zeroAccessPaths`, `readOnlyPaths`, `noWritePaths`, `noDeletePaths` | Extra path entries, relative to the policy root. |
| `disableDefaultPathPolicy` | Drops the built-in path defaults. |
| `informationFlow` | Source rules, recipient groups and pinned targets. See [information flow](../guide/information-flow.md). |

Unknown keys make the policy invalid. A policy takes effect only after the operator approves its exact bytes; see [Project trust](#project-trust). An unapproved policy grants nothing and its parse errors never block execution, but its `informationFlow` sources keep labeling what they name.

## Project trust

Five project surfaces carry privilege and are ignored until the operator approves their exact bytes for this workspace ([workspace-trust.ts](../../src/core/workspace-trust.ts)):

| Surface | Files |
| --- | --- |
| `safety` | The nearest `.clio-coder/safety.yaml`. |
| `settings` | `.clio-coder/settings.yaml` and `.clio-coder/settings.local.yaml`. |
| `hooks` | `.clio-coder/hooks.yaml` and `.clio-coder/hooks.local.yaml`. |
| `extensions` | `.clio-coder/extensions/state.json`, the install state of the project's extensions. |
| `plugins` | `.clio-coder/plugins/state.json`, the install state of the project's library packages. |

```bash
clio-coder config trust safety|hooks|settings|extensions|plugins  # print captured files and the SHA-256 digest (read-only)
clio-coder config trust <surface> --hash <reviewed-sha256>        # approve exactly those bytes
clio-coder config trust <surface> --revoke                        # remove the approval
```

Approval is per canonical workspace, pins the digest of the captured bytes (for `safety`, the digest includes the resolved source path), and is stored under `<state>/workspace-trust/`. A `safety.yaml` found in an ancestor directory still needs approval for each workspace that uses it. An edited file reads as `changed` and is ignored again until it is reviewed. The command exits 2 on a usage error and 1 when the files changed since review or none is readable. For `extensions` and `plugins` the pinned file is the install state, which records the content digest of every project package and which the loaders reverify, so one approval pins exactly the set of packages the operator reviewed. The digest also covers the state file's path, so a byte-identical copy of the file in another workspace needs its own approval. Approval takes effect on restart for `safety` and `settings`; hooks register on `/extensions reload`; `extensions` applies on `/extensions reload` and `plugins` on `/library reload`. A model cannot approve anything: tool calls that invoke the trust commands are blocked under `trust-authority`. See [Commands and modes](../guide/commands-and-modes.md) for the command reference.

An ignored surface is not silent:

- A TUI session shows a `[clio-coder:trust]` notice for each present, unapproved `safety`, `settings`, `extensions` or `plugins` file at start, naming the file (the `state.json` for the last two), its verdict (`untrusted` or `changed`) and `clio-coder config trust <surface>`. The line reads `<file> is <verdict>; project <surface> ignored. Review with clio-coder config trust <surface>.` The notice is held for the transcript and stays until read. A headless run prints the same line to stderr. Hook files report their own issue when loaded.
- An ACP client receives the same facts in `_meta["clio-coder/trust"].ignored` on `session/new`, `session/load` and `session/resume`, one entry per ignored file with `surface`, `file`, `verdict` and `fix`, covering all five surfaces including `hooks` ([trust-notice.ts](../../src/engine/acp/trust-notice.ts)).

Trust is not the only filter on a trusted project settings layer. A project layer cannot carry credentials, cannot set `trustedUnmediated` on a target or external agent, and cannot loosen `safety.autonomy`; each ignored key is reported as a layer issue.

### Project packages

Project extensions and library packages install from the repository's own state files, so their digest checks prove integrity and not consent. The `extensions` and `plugins` surfaces supply the consent.

- **What an unapproved workspace loads.** Each listing of the project's packages checks the surface. While it reads `untrusted` or `changed`, every project copy is blocked: it contributes no tools, hooks, runtime, skills, prompts, agents or playbooks, a blocked library package does not satisfy a dependency, and it neither shadows nor suppresses a user copy of the same ID, so the user copy keeps loading. User-scope packages never depend on workspace trust. A blocked copy stays listed. An enabled, valid, compatible one is marked `untrusted` in `extensions list`, or `requires trust` or `invalid` in the library views, and carries a warning that names `clio-coder config trust <surface>`.
- **When approval ends.** Any change to the state file's bytes makes the surface read `changed`. A later install, update, enable, disable or remove, a `--force` reinstall and a hand edit all change them, and every project package in the workspace stays unloaded until the new bytes are reviewed and approved. Revoking the approval has the same effect. A running session treats a revoked or changed approval like a disable at its next admission recheck.
- **First install.** When `.clio-coder/extensions/state.json` is absent, `clio-coder extensions install <path> --project` approves the state it creates. When `.clio-coder/plugins/state.json` is absent, a project-scope `library install` committed from the CLI, the Library overlay or the GUI approves it. The approval pins the bytes the install just wrote, and it happens only if the install committed.
- **Never self-approving.** Archive imports (`share import`, `/archive import`), `library import`, `interop adopt`, the skill install offers, and every install, update, enable, disable or remove after the first leave the surface unapproved.
- **Task worktrees.** A task worktree that Clio Coder created for a dispatched worker inherits the `extensions` and `plugins` approval of the workspace it was created from while its state file is byte-identical to the origin's file and the origin's own approval of that file is current. Inheritance is evaluated at each capture, writes no record of its own, and covers no other surface. Clio proves the origin from its ownership claim at `<origin>/.clio-coder/worktrees/<runId>.task-owner.json` ([task-worktree-claim.ts](../../src/core/task-worktree-claim.ts)), which must name the worktree's own path, not from anything inside the worktree. A hand-made `git worktree`, a worktree whose claim is gone, a worktree whose state differs, and a worktree whose origin approval is revoked or changed do not inherit.
- **Authority.** A model cannot approve a surface. Tool calls that invoke `config trust` are blocked under `trust-authority`, and model writes to the `<state>/workspace-trust/` records and to the installed resource trees, which hold the install-state files, are refused.

## Extensions and plugins

A plugin is content: skills, agents, prompt templates and playbooks, with Clio's own content under the Clio namespace of an Agent Plugin `plugin.json`. Clio preserves a plugin's `mcp.json` and does not execute plugin MCP servers or plugin hooks. Installing, enabling or browsing a plugin never runs code inside Clio.

An extension is Clio code in its own process, declared in `clio-coder-extension.yaml`. At runtime api 2 it can register hooks, runtime tools named `extension_<id>__<tool>`, commands named `/ext:<id>:<name>`, workspaces and skins, and interviews. Discovery and review read only the manifest. An extension and a plugin are separate packages with their own digest, state and consent. An extension may name the one plugin it serves with `plugin: <name>`. That link alone lets a command declare `replaces: prompt` to answer a prompt of that plugin, and the takeover applies only while the plugin is installed and enabled.

**Capability envelope.** The operator consents to what an extension may do, not to its bytes. The envelope covers its commands, events and timer, hooks with their failure modes, runtime tools with their action class, interface slots, workspaces with their regions and keys, watched paths, the content it may read (`prompt`, `tool-args`, `tool-results`, `assistant-text`), file read and write roots, whether it may run programs or use the network, the host `state` it keeps (per session, across sessions) and `takesOver`, the plugin prompts its commands answer. One envelope renderer feeds every review. `clio-coder extensions install` prints it before the write, the Library review and the `share import` plan show it, and an update review names what reaches further than the installed copy (`Reaches further than the installed copy:`) or says it reaches no further.

**Digest binding.** The review hashes its envelope, and the install applies only that digest. A package whose envelope changed after review is refused with `extension capability envelope differs from the one reviewed; review a fresh plan`. The install records the envelope digest beside the content digest. At load, the recorded envelope digest must match the manifest's envelope, and a mismatch leaves the package invalid and unloaded until it is reinstalled and reviewed. A record with no envelope digest fails the same way.

**Confinement.** The runtime child runs in a private copy of the package under Node permission flags built from the manifest. Those flags are a seat belt against mistakes and not a boundary against hostile code. When an OS sandbox exists (bubblewrap on Linux, or `sandbox-exec` on macOS, which is unverified on a real macOS build), the child also runs inside it with the filesystem read-only outside its declared write roots, secrets masked, Clio-managed paths (`.clio-coder`, the config directory, workspace trust) and Git metadata read-only, and an empty network namespace unless the manifest declares `net: true`. A declared write root may not name the workspace root or `.clio-coder`. Without a sandbox backend the Node flags apply alone and a declared `net: false` is not enforced. The launch always requests the sandbox in `auto` mode, so `safety.sandbox` does not change it. `/extensions` shows a `Confinement:` line per runtime, for example `bwrap OS sandbox; network blocked (enforced); secrets masked and Clio-managed paths read-only`, or `no OS sandbox (bubblewrap (bwrap) is not installed); Node flags only, so the declared network ban is not enforced`.

**Package code.** Two authoring commands execute package code on request. `clio-coder extensions validate <path>` runs the package's startup code in a private copy under its declared Node permissions and inside the OS sandbox when one is available, without invoking a handler, and prints that notice with the result. `clio-coder extensions test <path>` runs the package's own `*.test.ts` files under Node's test runner in the package directory. A model shell call that runs either one, or a `clio-coder share import` that is not a dry run, is held for the operator's approval the way `library install` is, because the model may have written the package or the archive. Run them only on code you trust. A share archive's extension entries install through the same envelope review and digest check. Project-scope extensions also need the workspace approval in [project trust](#project-trust).

## Information flow

Information flow keeps named content away from destinations the operator did not choose. Source rules in the project policy label content when a read, shell command or `@file` reference touches a source, and every model request, mediated outbound tool call and System One engine request is checked against the labels the session carries. A refusal holds at `yolo`. Claude Code, Codex, ACP agents and pane peers cannot admit their own model requests, so they are refused at launch when any source rule does not admit their target. The contract, limits and recovery steps are in [information flow](../guide/information-flow.md). Implementation: [information-flow.ts](../../src/domains/safety/information-flow.ts) and [flow-ledger.ts](../../src/entry/flow-ledger.ts).

## Approvals

A parked call carries a request id. A main-agent approval resumes only that call. A worker escalation approval also resumes only the parked call. A denial is remembered for a matching tool, arguments, approval axis, and safety classification within that worker run, so an identical call is denied without a new card. An approval is never remembered. The approval card explains a decision already made; it never changes the decision. Who answers depends on the surface:

- The TUI: the operator, in the approval card.
- An ACP client, the GUI included: the client's own permission request, answered by its operator. A client that advertises `clio-coder/interviews` or `clio-coder/workerPermissions` at initialize is attended, which also routes `ask_user`, harness cards and forwarded worker asks to that operator. A client that advertises neither keeps the unattended behavior. See [ACP architecture](acp.md).
- A headless `clio-coder run`: nobody is attached, so every ask is denied at both levels, including damage-control confirmations that still ask at `yolo`, and the session prompt says so. The denial result reads `clio-coder run cannot confirm permission requests; rerun interactively to approve this action.`, followed by the rule, the cause, `This call was denied; no approval is pending.` and, for an unrecognized command, the recognized form to use.
- A dispatched worker: the permit's ask route, which `fleet.permissions.mode` sets by default. See [Worker permits](#worker-permits).
- An ACP delegation peer: the mediator denies the ask without stalling.

`WorkerSpec.onPermission` (`deny`, `fail` or `escalate`) is the wire form of a worker's ask route ([spec-contract.ts](../../src/worker/spec-contract.ts)). A permit that routes asks to `main` travels as `escalate` with a main-authority binding.

| `fleet.permissions.mode` | A worker's ask |
| --- | --- |
| `deny` (default) | Becomes a structured tool denial and the run continues. A refused execute call counts toward a per-run limit; the limit, exit code and denial format are in [worker dispatch mechanics](worker-dispatch-mechanics.md). |
| `fail` | Ends the run at the first ask as `permission_required` (exit 3). |
| `escalate` | Parks the call and forwards it to the operator. `fleet.permissions.escalation.timeoutMs` (default `120000`) bounds the wait and `fleet.permissions.escalation.fallback` (`deny` default, or `fail`) applies on timeout. With nobody attached (a headless run, an ACP client without `clio-coder/workerPermissions`, the fleet CLI) the fallback applies at once. |
| `main` | Routes an ordinary ask to the main agent instead of the operator. |

Under `main`, the main agent grants an ask only at `yolo`, only when the effect sits inside the operator's delegation ceiling for the turn and the worker's permit, and only when the same call would be admitted as the main agent's own at `yolo` ([grant-authority.ts](../../src/domains/dispatch/grant-authority.ts)). Below `yolo` an attended operator decides, and a headless run denies at once. A rail only a person may clear, a hard block, a gateway-wrapped call and a call too large to evaluate are never main-grantable. The worker re-admits a granted call under its unchanged permit before it runs.

Runtime support is checked at dispatch. Subprocess runtimes admit only `deny`. The Claude SDK admits `deny` and `fail` but cannot park an `escalate` request. Only native local workers take `main` grants, and a dispatch under `main` to any other runtime, or to a remote placement, is refused with an error that names `escalate` and `deny` as alternatives. Runs started outside the dispatch tool, such as a slash command or the watchdog, have no main agent waiting, so their `main` asks narrow to `deny`.

### Approval cards

The card's keys are `Enter` to allow once, `Alt+X` to stop the turn, `Esc` or `Ctrl+C` to deny, `Alt+V` to inspect a parked `write` or `edit`, `Alt+T` to fold the standing approval terms and the arrow keys to scroll a tall card. Letters typed while the card is open go to the composer. A card that another screen closes without an answer is presented again. While the composer holds a draft, `Enter` is inert and the entry becomes `Backspace` to clear the draft, so the habitual send key cannot allow a call.

A bash approval card also carries an `Effect:` row, one plain sentence per step of the command, such as "Deletes build recursively". The host writes the sentences from the full command and checks existing paths on disk, redacts secrets and bounds each sentence at 240 characters. The card shows three sentences and folds the rest into `and N more`, except that severe sentences (deletes, stops, history rewrites) stay visible up to eight. A worker's ask carries the sentences its worker wrote, and an ACP permission request carries them as `consequenceLines`. They are presentation only. Admission never reads them, so a command Clio Coder does not recognize shows no row and a recognized one is not blocked or asked about because of it. The reader works on the literal command, so an operand written as `$DIR` is shown as `$DIR`. Bidirectional control characters in card text are escaped as `\u{...}`.

A shell word written with ANSI-C quoting (`$'...'`) is decoded before admission, so path and write rules judge what the shell will see. An ambiguous ANSI-C escape or a locale-quoted `$"..."` word cannot be inspected, so it asks at both levels under rule `bash-hidden-quoting`.

### Unattended analysis

For a main-agent run that should execute ordinary analysis commands without approval, the operator can choose `yolo` for that invocation:

```bash
clio-coder run --autonomy yolo "Inspect the locking code and report possible faults or hangs."
```

Writing an analysis script in `/tmp`, executing it with `python3`, and using a heredoc pass the ordinary approval rails at `yolo`. Keep the bash call's `cwd` inside the workspace; an external script path does not require moving `cwd` outside it. At `default`, the external write and unrecognized execution ask.

`yolo` does not promise that every task can finish unattended. A damage-control confirmation still requires approval, and a headless run denies that call because no operator is attached. Hard blocks and protected paths still hold. Dispatched workers get the operator's `yolo` only for execute-class calls (see [Worker permits](#worker-permits)); their other asks follow `fleet.permissions.mode`, where `deny` prevents an interactive stop by denying an approval-required call and `escalate` can still ask the operator even when the main session uses `yolo`.

When an ordinary analysis call unexpectedly asks, report the Clio Coder version, effective session autonomy, exact tool arguments including `cwd`, and whether the call came from the main agent or a worker. Include the approval's rule or reason code when available. These distinguish a safety-net confirmation from a worker's `default` autonomy or a main-agent admission defect.

## Worker permits

The host resolves one immutable permit per worker attempt ([worker-permit.ts](../../src/domains/safety/worker-permit.ts)) and seals its digest on the receipt as `safety.permit`. It separates a hard ceiling from a standing allowance inside it, and nothing a worker, a recipe or a task requests can widen either.

- **Ceiling.** The capability class, the admitted tools that the turn's delegation ceiling also covers, the read-only restriction, the write roots, and what the runtime itself enforces. A class bounds its tools: `read-only` admits only read tools, `artifact-write` only the artifact write, `verification` no writes and no bash (checks run through typed verification). `orchestration` agents cannot run as workers, `internal` is available only to host-selected helper protocols, and orchestrator-only tools (`dispatch`, `ask_user`) are never admitted to a worker.
- **Allowance.** `git` is `inspect` (default) or `worktree`, which lets a `workspace-edit` worker stage and commit through typed Git inside its own task worktree and nowhere else. `asks` is `deny`, `fail` or `main`, defaulting from `fleet.permissions.mode` (`escalate` maps to `main` with operator authority). A recipe's `permissions:` block (`git`, `asks`) declares the allowance for its workers, and `git: worktree` requires the `workspace-edit` class. Per-task narrowing can only narrow: widening `git` to `worktree` or `asks` to `main` for one task is an admission error, a retry never runs wider than the attempt it replaces, and a recipe routing asks to `main` never raises who decides them.
- **Operator execute authority.** When the session autonomy is `yolo`, the runtime mediates every call, the run is not read-only, and neither the recipe nor the task declares `asks: deny` or `asks: fail`, the permit carries `executeAutonomy: yolo`. A worker call whose every effect is execute-class (`bash`, `run_script`, `verify`) is then admitted at `yolo`, so an unrecognized command runs without an ask. Every other action class stays at `default`, and hard blocks, damage-control confirmations and protected paths hold. At `default` session autonomy workers hold no such grant.
- **Unmediated runtimes.** A runtime that runs its own tool loop (Claude Code, Codex, other CLIs) is refused write-capable work unless the operator sets `trustedUnmediated: true` on the target in user settings. The receipt records the opt-in.

## Worker OS sandbox

`safety.sandbox` runs the commands of a dispatched native (HTTP runtime) worker under an OS sandbox: the `bash` tool, `run_script` and verification checks. Main-agent commands, subprocess and SDK runtimes, and workers placed on a `fleet.nodes` node are not sandboxed. Native `write` and `edit` run outside the child sandbox but honor the same read-only paths.

| Value | Behavior |
| --- | --- |
| `auto` (default) | Sandboxes when a backend is available. Otherwise commands run unsandboxed and a worker-diagnostics line `[worker] sandbox unavailable (...)` is written once. |
| `required` | Refuses worker commands when no backend is available. |
| `off` | Never sandboxes. |

Backends ([availability.ts](../../src/core/sandbox/availability.ts)): Linux uses bubblewrap (`/usr/bin/bwrap` or `bwrap` on `PATH`) and is probed with the same namespaces a real command uses, so a kernel or container that forbids unprivileged user namespaces reports unavailable. macOS uses a `sandbox-exec` seatbelt profile that is unverified on a real macOS build. Other platforms have no backend. The probe runs once per process.

Policy ([worker-policy.ts](../../src/core/sandbox/worker-policy.ts)): the filesystem is readable and writes land only in the worker's writable roots and a private `/tmp`. Writable roots are the run's `write_roots`, else its task worktree, else its working directory, and a read-only run has none. `.git` and `.clio-coder` inside a writable root stay read-only except for the Git metadata that typed Git task mutations need. Secret paths and runtime escape paths (the user runtime directory, the container sockets) are masked, `SSH_AUTH_SOCK` is unset, and `TMPDIR` points at the private `/tmp` under bubblewrap. Network is off unless `safety.sandboxNetwork` is `true` or the run holds `web_fetch`. A missing exact-file write root cannot be created by a command, so the worker's safety line tells it to create the file with the `write` tool first. The effective sandbox (mode, backend, availability, writable roots, network) is sealed on the receipt.

## System One and the safety net

System One is an optional experimental decision model. Its sites record detached readings without delaying calls or results, and they are silent when no engine is bound, when the engine is slow or fails, and when the answering build has no fitted cut. At the safety sites a reading adds no confirmation, banner or delay.

- **The yolo gate.** At `yolo`, in an interactive session, an `execute` call that the classifier did not recognize starts a detached System One reading that is recorded for training. It never parks, denies or delays the call. A call the classifier already parks, blocks or recognizes does not reach it, and headless runs and ACP sessions have no gate.
- **Tool-result screening.** Results of `web_fetch`, `web_read` and MCP tools start a detached reading for text that directs an AI agent. The deterministic marker scan still applies.
- **Card advisory.** An ordinary approval card can show one advisory sentence about the call's blast radius when a `toolCall` engine is bound. It says it is advisory, cannot delay the card and does not change what allow, deny or stop do.

The settings, sites and records are in the [System One guide](../guide/system-one.md) and [System One architecture](system-one.md).

## Workers

- Every worker permit is derived from the host's settings, not the session level. Execute-class calls inherit `yolo` only as [Worker permits](#worker-permits) describes. A read-only dispatch adds the restriction above, and its sealed receipt records it as `safety.readOnly: true`, whether or not the worker ever tried to write.
- A task that declares `write_roots` is confined to them and cannot dispatch. Without an OS sandbox covering the run it also loses `bash`, `verify` and `run_script`, and a `write_roots_checks_withheld` scope notice says so. With the sandbox it keeps `bash`, `verify` and `run_script` inside the roots.
- A task with `worktree: true` runs in its own git worktree, by default at `.clio-coder/worktrees/<runId>/` (`fleet.worktrees.root` can move the working tree), on branch `clio-coder/task/<runId>`. See [Fleet dispatch](../guide/fleet-dispatch.md).
- A checkout writer lease lets one Clio Coder process at a time dispatch workspace-edit workers into a checkout. A second process is refused with `checkout_writer_lease_held` ([checkout-writer-lease.ts](../../src/domains/dispatch/checkout-writer-lease.ts)).
- Workers carry the approved information-flow source rules and the restrictions their inherited context holds, and judge every model request against them.

## Evidence and the finish contract

- The finish contract ([finish-contract.ts](../../src/domains/safety/finish-contract.ts)) checks the end of a turn that changed files, looking at the session entries since the last user message, at most 80. It looks for validation evidence, such as a validation command that ran or a dispatch receipt, or for a `limitation` receipt. With neither, the footer shows `change not verified; inspect the turn receipt` and the decision is written to the audit log. At high rigor the contract instead withholds completion and re-prompts the model to validate or record a limitation, unless the task scope forbids recovery. The contract settles without that advisory when the turn made no mutation, left no net workspace change after an undo, changed only paths outside the workspace or Clio Coder configuration, or only deleted tests or docs (non-source paths) or a path the operator's message asked to delete. A blocked call and an out-of-workspace write are not unverified changes. A write to `.clio-coder/settings.yaml`, `.clio-coder/settings.local.yaml` or `.clio-coder/fleets/<name>.md` is Clio Coder configuration and does not count as a changed file. Validation evidence is retained behind workspace `cd` prefixes.
- When checks pass but behavior coverage is unknown, the footer shows an info line, `checks passed; coverage of the change not measured`, which clears at the next turn. With validation evidence but no passed check it reads `validation evidence recorded; coverage of the change not measured`. Both are operator status and never a request to run more checks.
- A [project quality policy](../guide/quality-policy.md) adds path-scoped required checks. Native verification receipts must match current source, check declaration, and policy snapshots. A valid policy selects high rigor unless explicitly overridden; recovery stays within the turn's existing authority. Check-scoped limitations settle requirements only when the policy explicitly allows them, and remain unverified. Rigor resolution and the validation contract are described in that guide.
- The citation-grounding assessor (`assessor.citation-grounding`, [citation-grounding.ts](../../src/domains/safety/citation-grounding.ts)) records which lines a numbered `read` or a grep match printed. When a final answer cites `path:line` into a file that was read without line numbers at a line no tool printed, it carries the turn onward once with the unbacked citations. It never blocks the answer, skips files the session mutated, and cannot see bash output or `code_nav` symbol lines.
- Checks named in a dispatch's `verification` run on the host after the worker finishes. The worker's report is a claim until then.
- Each current receipt carries a SHA-256 digest over its canonical receipt fields and reconstructible ledger provenance. Verification checks shared ledger fields and recomputes the digest, so an edited sealed field fails. The digest detects tampering; it is not a signature.

## Safety settings

| Key | Default | Applies | Meaning |
| --- | --- | --- | --- |
| `safety.autonomy` | `default` | live | The operator's autonomy level, `default` or `yolo`. |
| `safety.limits.sessionCostUsd` | `5` | next turn | Session ceiling on priced spend. A request on a priced route (known or estimated cost) is admitted only while spend is below it. An interactive session waits for a raised ceiling; a headless run ends with exit code 4 (`budget_ceiling`). Unpriced routes never enter this gate. The value is a finite number of at least 0 and a negative value fails validation. `0` means no session ceiling, and the gate admits every request. |
| `safety.limits.chatToolCallsPerTurn` | `60` | next turn | Soft per-turn tool-call budget for the main agent. Crossing it blocks further calls in the turn with a stop-and-summarize directive. |
| `safety.limits.readBytesPerCall` | `51200` | next turn | Per-call byte cap of the `read` tool, floored at 1 KiB. |
| `safety.limits.observationBytesPerTurn` | `196608` | next turn | Shared per-turn byte pool for observation-producing tools. While it holds the default, the pool scales at 1.5 bytes per context-window token between 192 KiB and 1 MiB; a configured value applies exactly. |
| `safety.review.enabled` | `false` | live | Enables the watchdog verifier (`observer.watchdog`, see [middleware](middleware-and-components.md)). |
| `safety.review.target` | unset | live | Target id for the watchdog run; the session's active target when unset. Must name a configured target. |
| `safety.review.cadenceToolCalls` | unset | live | Also fires the watchdog every N tool calls (at least 1) inside a turn. |
| `safety.sandbox` | `auto` | next dispatch | Worker OS sandbox mode: `auto`, `required` or `off`. |
| `safety.sandboxNetwork` | `false` | next dispatch | Lets sandboxed worker commands reach the network. |
| `fleet.permissions.mode` | `deny` | next turn | Default ask route of a worker: `deny`, `fail`, `escalate` or `main`. |
| `fleet.permissions.escalation.timeoutMs` | `120000` | next turn | Escalation wait before the fallback applies. |
| `fleet.permissions.escalation.fallback` | `deny` | next turn | Posture on escalation timeout: `deny` or `fail`. |

Defaults come from `DEFAULT_SETTINGS` in [defaults.ts](../../src/core/defaults.ts), validation from [config.ts](../../src/core/config.ts), and effect timing from [classify.ts](../../src/domains/config/classify.ts). The [configuration reference](../guide/configuration-reference.md) lists every key.

## Source map

| Component | Source | Key contracts |
| :--- | :--- | :--- |
| Policy engine | [policy-engine.ts](../../src/domains/safety/policy-engine.ts) | `createSafetyPolicyEngine` |
| Shared admission | [admission.ts](../../src/domains/safety/admission.ts) | `evaluateAdmission` |
| Autonomy mapping | [autonomy.ts](../../src/domains/safety/autonomy.ts) | `mapAutonomy`, `autonomyAskRejection` |
| Worker permit | [worker-permit.ts](../../src/domains/safety/worker-permit.ts) | `resolveWorkerPermit` |
| Tool admission | [registry.ts](../../src/tools/registry.ts) | `createRegistry` |
| Damage-control rules | [damage-control.ts](../../src/domains/safety/damage-control.ts) | `match` |
| Project policy | [project-policy.ts](../../src/domains/safety/project-policy.ts) | `loadProjectSafetyPolicy` |
| Project trust | [workspace-trust.ts](../../src/core/workspace-trust.ts), [config-trust.ts](../../src/cli/config-trust.ts) | `captureProjectSurface`, `runConfigTrustCommand` |
| Read scope checks | [read-scope.ts](../../src/domains/safety/read-scope.ts) | `readScopeEscape`, `readScopeSpellings` |
| Worker sandbox | [worker-process.ts](../../src/core/sandbox/worker-process.ts) | `planSandboxedSpawn` |
| Audit records | [audit.ts](../../src/domains/safety/audit.ts) | `buildAuditRecord`, `openAuditWriter` |
| Decision presentation | [decision-presentation.ts](../../src/domains/safety/decision-presentation.ts) | `classifyDecisionPresentation`, `DECISION_TIERS` |
| System One sites | [factory.ts](../../src/domains/system-one/factory.ts) | see [System One Architecture](system-one.md) |
| Finish contract and rigor | [finish-contract.ts](../../src/domains/safety/finish-contract.ts), [rigor.ts](../../src/domains/safety/rigor.ts) | `assessFinishContract`, `resolveRigor` |
