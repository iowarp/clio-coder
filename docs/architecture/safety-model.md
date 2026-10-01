# Clio Coder Safety Model

`createSafetyPolicyEngine` in [policy-engine.ts](../../src/domains/safety/policy-engine.ts) decides what a tool call may do. The tool registry in [registry.ts](../../src/tools/registry.ts) applies that decision and then the autonomy mapping in [autonomy.ts](../../src/domains/safety/autonomy.ts). The [tool usage guide](../guide/tool-usage.md) shows the operator surface.

The registry enforces safety rules before admitted tool calls execute. The session prompt describes those rules to the model.

## Execution boundary

Clio gates tool calls before they run. Commands, hooks, and external agents run with the operator's operating-system permissions. Environment filtering controls inherited variables; filesystem and process isolation require an external sandbox.

## Autonomy

Autonomy is the operator's grant to the main agent. There are two levels:

- `default` runs workspace reads, edits and recognized commands. Other commands, outward actions, access outside the workspace, system changes and plan-scale dispatch ask the operator.
- `yolo` is the same agent without those ordinary stops. It never outranks the safety net: hard blocks, damage-control rules and protected paths hold at both levels.

Only the operator sets the level, through the user `settings.yaml`, `/settings`, `clio-coder configure`, `--autonomy`, or the session mode of an ACP client. Project settings layers cannot set it, and no tool, skill, worker or model output can raise it. Every dispatched worker runs at `default`, whatever the session level.

| Action | `default` | `yolo` |
| --- | --- | --- |
| Read, list or search inside the workspace | runs | runs |
| Read, list or search outside the workspace | asks | runs |
| Write or edit inside the workspace | runs | runs |
| Write outside the workspace, or another `system_modify` action | asks | runs |
| Recognized command: a built-in test runner, read-only inspection (`cat`, `head`, `tail`, `wc`, `nl`, `ls`, `pwd`, `stat`, `basename`, `dirname`, `realpath`, `readlink`, `echo`, `printf`, `true`, `which`, `cut`, `tr`, `grep`, `egrep`, `fgrep`, `rg`, `find`, `sed -n`, git inspection of `status`, `diff`, `log`, `show`, `branch`, `rev-parse` and `ls-files`, which can print the history of files already tracked in git, while `git grep`, `git blame` and `git cat-file` ask) on workspace paths, recognized steps joined by `&&`, `\|\|`, `;` or `\|` with output redirected only to `/dev/null` or `2>&1`, or a command declared in a trusted `.clio-coder/safety.yaml` | runs | runs |
| Any other command: project build, lint, typecheck and CI scripts, `$(...)` and `<(...)`, an unquoted `~`, brace or glob operand, recursive `grep` or `ls -R`, `grep -f`, `wc --files0-from`, `rg` on a directory or with no named file and no pipe feeding it, a symlink-following flag such as `find -L`, a redirect into a file, a step outside the recognized set | asks | runs |
| Outward action: `ask_user` with `exposure: outward`, a bash `git push` other than `--dry-run`, or `web_fetch` other than a bodiless GET or HEAD | asks | runs |
| Plan-scale dispatch: several tasks, a compete, a remote node, or applying a compete winner | asks once for the whole plan | runs, and the plan hash is sealed into each receipt |
| Damage-control confirmation rule | asks | asks |
| Hard block | blocked | blocked |

A read-only run is a dispatch restriction, not a level. Reviewer, judge and council roles, `/oracle`, the watchdog verifier, fleet `scope: readonly`, recipes with `capabilityClass: read-only`, and the operator's `--read-only` flag set it. For mediated tools, the registry denies calls other than reads inside the workspace, including skill activation. Dispatch refuses a read-only request on an agent-managed ACP peer that cannot enforce the restriction; subprocess runtimes do not expose per-call registry mediation, and their read-only guarantees vary by runtime.

## The safety net

The policy engine checks a call in this order, and the first block wins:

1. Write-root confinement. When a run declares `write_roots`, a write outside them is blocked, and so are commands and dispatch, which could write anywhere.
2. Damage-control blocks from [damage-control-rules.yaml](../../damage-control-rules.yaml), any `git_destructive` command that no ask rule covers, and the delete-target rule below.
3. An approved `.clio-coder/safety.yaml` that is invalid. Execution tools fail closed until it is fixed.
4. Operator authority. A tool cannot grant workspace trust, change Clio's `settings.yaml` or the workspace trust records, or change installed skills, plugins and extensions outside the operator CLI.
5. Path policy. Zero-access paths, such as `.env`, `~/.ssh/`, `*.pem`, `credentials.yaml` and `.git/config`, are neither read nor written, and a bash command that names one is blocked. Read-only paths, such as `.clio-coder/safety.yaml`, `.clio-coder/verifiers.yaml`, installed resource directories and system directories, are never written.
6. Confirmation rails. A damage-control ask rule asks at both levels. Library changes, system changes and the ordinary command rails ask at `default` and pass at `yolo`.

The registry then applies the read-only restriction, the turn's allowed tools and any skill's tool narrowing, and last the autonomy mapping in the table above.

Paths are judged after links and a physical `..` are resolved, so a link cannot carry a read or a write out of scope unnoticed ([read-scope.ts](../../src/domains/safety/read-scope.ts)).

A project `.clio-coder/safety.yaml` can declare commands and path entries, but it takes effect only after the operator approves its exact bytes with `clio-coder config trust safety`. See [Commands and modes](../guide/commands-and-modes.md#project-trust).

### Damage-control rules

Hard blocks include `rm` of `/`, the home directory or everything in either, `sudo rm`, `find -delete`, `rsync --delete`, `shred`, `chmod 777`, recursive `chmod` on system roots, recursive `chown` to root, `dd` to a device, `mkfs`, fork bombs, `kill -9 -1`, `killall -9`, `pkill -9`, clearing shell history, force pushes (`--force`, `-f` and `+` refspecs), `git reset --hard`, forced `git clean` without a preview flag, `git stash clear`, `git reflog expire`, `git gc --prune=now`, `git filter-branch`, `curl` or `wget` piped to a shell, writes to system roots through redirects or `tee`, cloud deletion commands (AWS, gcloud, Firebase, Vercel, Netlify, Wrangler), and SQL `DROP`, `TRUNCATE` and `DELETE` without a `WHERE`.

### Delete targets

A shell delete is judged by where it lands, never by its flags. `rm -rf build` inside the workspace is an ordinary command that asks at `default` and runs at `yolo`. A delete is a hard block at both levels, under rule `delete-outside-workspace`, when it targets the workspace root, a path outside the workspace, the workspace's `.git`, or a path the shell names only at run time such as `$VAR` or a command substitution. Scratch roots (`/tmp`, `/var/tmp`, the system temp directory) are exempt, except for a checkout's own root and `.git`. Any spelling of the same delete is refused, and globs and brace expansions are judged by the directory before the first wildcard.

Confirmation rules ask at both levels: `git checkout -- .`, `git restore .`, `git stash drop`, `git branch -d` or `-D`, deleting a remote branch with `git push`, `gcloud iam policies`, SQL `DELETE` by id, `truncate -s 0`, and `:>`. The whole-worktree spellings `./`, `:/` and a pathspec after `--` count as `.` for the two git rules.

Every rule is matched against each command a shell string would run, not only the string as a whole, so an operator cannot hide one: `git restore . && echo ok`, `git restore .; ls`, `sh -c "git restore ."` and `$(git restore .)` all ask. Command substitutions using `$(...)` or backticks are scanned inside double quotes too ([protected-artifacts.ts](../../src/domains/safety/protected-artifacts.ts)).

## Approvals

A parked call carries a request id. A main-agent approval resumes only that call. A worker escalation approval also resumes the parked call and remembers the answer for matching tool, arguments, approval axis, and safety classification within that worker run. The approval card explains a decision already made; it never changes the decision. Who answers depends on the surface:

- The TUI: the operator, in the approval card.
- An ACP client, the GUI included: the client's own permission request, answered by its operator. A client that advertises `clio-coder/interviews` or `clio-coder/workerPermissions` at initialize is attended, which also routes `ask_user`, harness cards and forwarded worker asks to that operator. A client that advertises neither keeps the unattended behavior ([ACP architecture](acp.md#attended-clients)).
- A headless `clio-coder run`: nobody is attached, so every ask is denied, and the session prompt says so.
- A dispatched worker: `fleet.permissions.mode`. `deny`, the default, turns the ask into a tool denial and the run continues; `fail` ends the run as `permission_required`; `escalate` forwards the ask to the operator and falls back to `deny` or `fail` on timeout; `main` routes an ordinary ask to the main agent instead. At `yolo` the main agent grants it when the effect sits inside its delegation ceiling and the worker's permit. Below `yolo` it forwards the ask to an attended operator, and a headless run denies it at once. A rail only a person may clear, and a hard block, is never main-grantable. Only native local workers honor `main`; any other runtime denies the ask without sending it to the operator. Subprocess runtimes admit only `deny`; Claude SDK admits `deny` or `fail`, but cannot park an `escalate` request.
- An ACP delegation peer: the mediator denies the ask without stalling.

### Unattended analysis

For a main-agent run that should execute ordinary analysis commands without
approval, the operator can choose `yolo` for that invocation:

```bash
clio-coder run --autonomy yolo "Inspect the locking code and report possible faults or hangs."
```

Writing an analysis script in `/tmp`, executing it with `python3`, and using a
heredoc pass the ordinary approval rails at `yolo`. Keep the bash call's `cwd`
inside the workspace; an external script path does not require moving `cwd`
outside it. At `default`, the external write and unrecognized execution ask.

`yolo` does not promise that every task can finish unattended. A damage-control
confirmation still requires approval, and a headless run denies that call
because no operator is attached. Hard blocks and protected paths still hold.
Dispatched workers remain at `default`: `fleet.permissions.mode: deny` prevents
an interactive stop by denying an approval-required call, and `escalate` can
still ask the operator even when the main session uses `yolo`.

When an ordinary analysis call unexpectedly asks, report the Clio version,
effective session autonomy, exact tool arguments including `cwd`, and whether
the call came from the main agent or a worker. Include the approval's rule or
reason code when available. These distinguish a safety-net confirmation from
a worker's `default` autonomy or a main-agent admission defect.

## System One and the safety net

System One is an optional decision model that can add friction to a call and never removes any. It has two roles here, and both are silent when no engine is bound, when the engine is slow or fails, and when the answering build has no fitted cut ([System One guide](../guide/system-one.md)).

- **The yolo gate.** At `yolo`, in an interactive session, an `execute` call that the classifier did not recognize is sent to System One before it runs. If a fitted build reads the call as reaching far or destroying data that version control or a reinstall cannot bring back, the call parks as one confirmation card titled "System One confirmation". Its Requested-by row names the main agent "through System One gate" and the answering build, and its reason line states what System One read. The gate only ever parks. A call the classifier already parks, blocks or recognizes does not reach it, headless runs and ACP sessions have no gate, and a gate that is unavailable leaves `yolo` exactly as permissive as before. A hard block, a damage-control rule and a protected path outrank it at both levels.
- **Tool-result screening.** Results of `web_fetch`, `web_read` and MCP tools are read for text that directs an AI agent. A flag puts a banner in front of the result naming the build, and it never clears a result that the deterministic marker scan already flagged. Clio's own listings, recipes and worker reports are not screened.

An ordinary approval card can also show one advisory sentence about the call's blast radius when a `toolCall` engine is bound. It says it is advisory, cannot delay the card and does not change what allow, deny or stop do.

The card's keys are `Enter` to allow once, `s` to stop the turn, `Esc` to deny, `v` to inspect a parked `write` or `edit`, `?` to fold the standing approval terms and the arrow keys to scroll a tall card. While the composer holds a draft, `Enter` is inert and the entry becomes `Backspace` to clear the draft, so the habitual send key cannot allow a call.

## Workers

- Every worker runs at `default`. A read-only dispatch adds the restriction above, and its sealed receipt records it as `safety.readOnly: true`, whether or not the worker ever tried to write.
- A task that declares `write_roots` is confined to them and cannot run commands or dispatch.
- A task with `worktree: true` runs in its own git worktree at `.clio-coder/worktrees/<runId>/` on branch `clio-coder/task/<runId>`. See [Fleet dispatch](../guide/fleet-dispatch.md#worktree-per-task).
- A checkout writer lease lets one Clio process at a time dispatch workspace-edit workers into a checkout. A second process is refused with `checkout_writer_lease_held` ([checkout-writer-lease.ts](../../src/domains/dispatch/checkout-writer-lease.ts)).

## Evidence and the finish contract

- The finish contract ([finish-contract.ts](../../src/domains/safety/finish-contract.ts)) checks the end of a turn that changed files. It looks for validation evidence, such as a validation command that ran or a dispatch receipt, or for a `limitation` receipt. With neither, the model receives an advisory to report the change as unverified.
- A [project quality policy](../guide/quality-policy.md) adds path-scoped required checks. Native verification receipts must match current source, check declaration, and policy snapshots. A valid policy selects high rigor unless explicitly overridden; recovery stays within the turn's existing authority. Check-scoped limitations settle requirements only when the policy explicitly allows them, and remain unverified.
- Checks named in a dispatch's `verification` run on the host after the worker finishes. The worker's report is a claim until then.
- Each current receipt carries a SHA-256 digest over its canonical receipt fields and reconstructible ledger provenance. Verification checks shared ledger fields and recomputes the digest, so an edited sealed field fails. The digest detects tampering; it is not a signature.

## Source map

| Component | Source | Key contracts |
| :--- | :--- | :--- |
| Policy engine | [policy-engine.ts](../../src/domains/safety/policy-engine.ts) | `createSafetyPolicyEngine` |
| Autonomy mapping | [autonomy.ts](../../src/domains/safety/autonomy.ts) | `mapAutonomy`, `autonomyAskRejection` |
| Tool admission | [registry.ts](../../src/tools/registry.ts) | `createRegistry` |
| Damage-control rules | [damage-control.ts](../../src/domains/safety/damage-control.ts) | `match` |
| Read scope checks | [read-scope.ts](../../src/domains/safety/read-scope.ts) | `readScopeEscape`, `readScopeSpellings` |
| Audit records | [audit.ts](../../src/domains/safety/audit.ts) | `buildAuditRecord`, `openAuditWriter` |
| System One gate card | [decision-presentation.ts](../../src/domains/safety/decision-presentation.ts) | `SYSTEM_ONE_GATE_RULE_ID`, `systemOneGateText` |
| System One sites | [factory.ts](../../src/domains/system-one/factory.ts) | see [System One Architecture](system-one.md) |
| Finish contract and rigor | [finish-contract.ts](../../src/domains/safety/finish-contract.ts) | `assessFinishContract` |

The policy exempts rule matches only when every span is inside an inert quoted argument to echo, printf, git commit/tag messages or grep/rg patterns. Whole-command and segment scans remain active. SQL and operator matches, substitutions, pipelines, heredocs and executable wrapper words prevent the exemption.

Git damage-control scans also dequote simple-command words, join backslash-newline continuations, and skip recognized git global options to find the subcommand. Original scans remain active, so normalization adds coverage without removing conservative matches.

Each scan candidate must independently prove its matches inert before an exemption applies. Quoted prose cannot suppress a destructive normalized git command elsewhere in the same call.

For git clean, push and checkout, combined short flags are expanded for damage-control matching. Unique destructive long-option prefixes for reset and push are expanded; ambiguous prefixes and `--force-with-lease` are preserved.

Whole-worktree `git checkout .` and forced checkout ask for confirmation at both autonomy levels. Plus-prefixed push refspecs such as `git push origin +main` hard-block as force updates.

Inert quoted-argument exemptions inspect the shell command alone. A bash call’s `cwd` is path metadata and cannot turn quoted documentation into shell execution.

`git clean` previews with `-n` or `--dry-run` run at both autonomy levels, including combined short flags and previews that also carry force flags. Forced deletion without a preview flag remains blocked. Each command in a shell chain is checked separately.

`git push --force-with-lease`, including an explicit lease value, uses the recognized Git command rail and runs at both autonomy levels. Unconditional `--force`, `-f`, and plus-prefixed force refspecs remain blocked.

Restoring a named file from an explicit `--source` uses the same recognized Git command rail as an ordinary single-path restore. Whole-worktree restores, including `--staged .`, and branch deletion with either `-d` or `-D` still ask at both autonomy levels. These operations change repository state across the selected scope.
