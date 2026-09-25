# Clio Coder Safety Model

`createSafetyPolicyEngine` in [policy-engine.ts](../../src/domains/safety/policy-engine.ts) decides what a tool call may do. The tool registry in [registry.ts](../../src/tools/registry.ts) applies that decision and then the autonomy mapping in [autonomy.ts](../../src/domains/safety/autonomy.ts). The [tool usage guide](../guide/tool-usage.md) shows the operator surface.

Safety is enforced by code, not by the prompt. The session prompt describes the rules, and the registry enforces them whether or not the model followed that description.

## What this is not

Clio gates tool calls before they run. It is not an operating-system sandbox. Commands, hooks and external agents run with the operator's own permissions. Environment filtering narrows what a child process inherits; it does not isolate the child.

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
| Recognized command: a built-in test runner or inspection command, a `&&` chain of them, or a command declared in a trusted `.clio-coder/safety.yaml` | runs | runs |
| Any other command: project build, lint, typecheck and CI scripts, `$(...)`, pipes, redirects | asks | runs |
| Outward action: `ask_user` with `exposure: outward`, or `web_fetch` other than a bodiless GET or HEAD | asks | runs |
| Plan-scale dispatch: several tasks, a compete, a remote node, or applying a compete winner | asks once for the whole plan | runs, and the plan hash is sealed into each receipt |
| Damage-control confirmation rule | asks | asks |
| Hard block | blocked | blocked |

A read-only run is a dispatch restriction, not a level. Reviewer, judge and council roles, `/oracle`, the watchdog verifier, fleet `scope: readonly`, recipes with `capabilityClass: read-only`, and the operator's `--read-only` flag set it. For mediated tools, the registry denies calls other than reads inside the workspace, including skill activation. Dispatch refuses a read-only request on an agent-managed ACP peer that cannot enforce the restriction; subprocess runtimes do not expose per-call registry mediation, and their read-only guarantees vary by runtime.

## The safety net

The policy engine checks a call in this order, and the first block wins:

1. Write-root confinement. When a run declares `write_roots`, a write outside them is blocked, and so are commands and dispatch, which could write anywhere.
2. Damage-control blocks from [damage-control-rules.yaml](../../damage-control-rules.yaml), and any `git_destructive` command that no ask rule covers.
3. An approved `.clio-coder/safety.yaml` that is invalid. Execution tools fail closed until it is fixed.
4. Operator authority. A tool cannot grant workspace trust, change Clio's `settings.yaml` or the workspace trust records, or change installed skills, plugins and extensions outside the operator CLI.
5. Path policy. Zero-access paths, such as `.env`, `~/.ssh/`, `*.pem`, `credentials.yaml` and `.git/config`, are neither read nor written, and a bash command that names one is blocked. Read-only paths, such as `.clio-coder/safety.yaml`, `.clio-coder/verifiers.yaml`, installed resource directories and system directories, are never written.
6. Confirmation rails. A damage-control ask rule asks at both levels. Library changes, system changes and the ordinary command rails ask at `default` and pass at `yolo`.

The registry then applies the read-only restriction, the turn's allowed tools and any skill's tool narrowing, and last the autonomy mapping in the table above.

Paths are judged after links and a physical `..` are resolved, so a link cannot carry a read or a write out of scope unnoticed ([read-scope.ts](../../src/domains/safety/read-scope.ts)).

A project `.clio-coder/safety.yaml` can declare commands and path entries, but it takes effect only after the operator approves its exact bytes with `clio-coder config trust safety`. See [Commands and modes](../guide/commands-and-modes.md#project-trust).

### Damage-control rules

Hard blocks include recursive or forced `rm`, `sudo rm`, `find -delete`, `rsync --delete`, `shred`, `chmod 777`, `dd` to a device, `mkfs`, fork bombs, forced process kills, clearing shell history, force pushes, `git reset --hard`, `git clean` on directories, stash and reflog destruction, `git filter-branch`, `curl` or `wget` piped to a shell, writes to system roots, cloud deletion commands (AWS, gcloud, Firebase, Vercel, Netlify, Wrangler), and SQL `DROP`, `TRUNCATE` and unbounded `DELETE`.

Confirmation rules ask at both levels: `git checkout -- .`, `git restore .`, `git stash drop`, `git branch -D`, deleting a remote branch with `git push`, `gcloud iam policies`, SQL `DELETE` by id, `truncate -s 0`, and `:>`. The whole-worktree spellings `./`, `:/` and a pathspec after `--` count as `.` for the two git rules.

Every rule is matched against each command a shell string would run, not only the string as a whole, so an operator cannot hide one: `git restore . && echo ok`, `git restore .; ls`, `sh -c "git restore ."` and `$(git restore .)` all ask. A `$(...)` written inside double quotes is not yet read as a command ([protected-artifacts.ts](../../src/domains/safety/protected-artifacts.ts)).

## Approvals

A parked call carries a request id. A main-agent approval resumes only that call. A worker escalation approval also resumes the parked call and remembers the answer for matching tool, arguments, approval axis, and safety classification within that worker run. The approval card explains a decision already made; it never changes the decision. Who answers depends on the surface:

- The TUI: the operator, in the approval card.
- An ACP client, the GUI included: the client's own permission request, answered by its operator.
- A headless `clio-coder run`: nobody is attached, so every ask is denied, and the session prompt says so.
- A dispatched worker: `fleet.permissions.mode`. `deny`, the default, turns the ask into a tool denial and the run continues; `fail` ends the run as `permission_required`; `escalate` forwards the ask to the operator and falls back to `deny` or `fail` on timeout. Subprocess runtimes admit only `deny`; Claude SDK admits `deny` or `fail`, but cannot park an `escalate` request.
- An ACP delegation peer: the mediator denies the ask without stalling.

## Workers

- Every worker runs at `default`. A read-only dispatch adds the restriction above.
- A task that declares `write_roots` is confined to them and cannot run commands or dispatch.
- A task with `worktree: true` runs in its own git worktree at `.clio-coder/worktrees/<runId>/` on branch `clio-coder/task/<runId>`. See [Fleet dispatch](../guide/fleet-dispatch.md#worktree-per-task).
- A checkout writer lease lets one Clio process at a time dispatch workspace-edit workers into a checkout. A second process is refused with `checkout_writer_lease_held` ([checkout-writer-lease.ts](../../src/domains/dispatch/checkout-writer-lease.ts)).

## Evidence and the finish contract

- The finish contract ([finish-contract.ts](../../src/domains/safety/finish-contract.ts)) checks the end of a turn that changed files. It looks for validation evidence, such as a validation command that ran or a dispatch receipt, or for a `limitation` receipt. With neither, the model receives an advisory to report the change as unverified.
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
| Finish contract and rigor | [finish-contract.ts](../../src/domains/safety/finish-contract.ts) | `assessFinishContract` |
