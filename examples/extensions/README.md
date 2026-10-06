# Local scientific extensions

These installable examples use the harness extension lifecycle, separately from
library recipes. They require a Clio build containing operator runtime API v1.
The examples require Clio Coder 0.5.0 or later; their manifests enforce that minimum.

From the repository root:

```bash
clio-coder extensions discover examples/extensions/lab-status --json
clio-coder extensions install examples/extensions/lab-status --project
clio-coder extensions run lab-status dashboard
clio-coder extensions run lab-status dashboard --json
```

In Clio, reload through `/extensions reload`, then invoke
`/ext:lab-status:dashboard`. Core renders the panel, owns scrolling and Escape,
and displays the status with the extension's owner label. The default record is
`jobs.synthetic.json`: **SYNTHETIC FIXTURE**, two completed jobs and one running
job. These are deterministic demonstration records, not measured cluster facts.

Pass a local JSON record filename as the argument to inspect your own data:

```bash
clio-coder extensions run lab-status dashboard -- /absolute/path/experiment.json
```

The record has `experiment` and `jobs` fields. Each job supplies a string `id`,
positive integer `ranks`, `state` (`queued`, `running`, `completed`, `failed`) and
nonnegative finite `elapsedSeconds`. Set `synthetic: true` for simulated data.
Records without that marker are labeled local reported data, not independently
verified results. Files are regular local files up to 32 KiB and at most 100 jobs.
The example performs no SSH, scheduler query, submission, provider request or
credential access. Turn observations repeat the last explicit snapshot; invoke
the dashboard again to refresh the file. Runtime state resets on reload.

The separate measurement package keeps the existing model tool contract:

```bash
clio-coder extensions install examples/extensions/measurements --project
```

Start a new session. The admitted model tool is
`extension_measurements__summarize`, with input such as
`{"values":[1,2,3],"units":"seconds"}`. That input is a **synthetic deterministic
example**, with mean 2 and sample standard deviation 1. A one-value input returns
`null` for sample standard deviation. Numeric overflow errors instead of
reporting null or invented valid measurements. Execution still passes the tool
registry's safety, autonomy and approval rules. Native worker recipes must
explicitly admit the qualified tool. Installing a runtime never adds tools to
existing model schemas.

Update source, reinstall with `--force`, then reload operator runtimes at idle.
Disable and remove exact copies with `--project` or `--user`:

```bash
clio-coder extensions disable lab-status --project
clio-coder extensions enable lab-status --project
clio-coder extensions remove lab-status --project
```

Do not edit installed package bytes in place. Whole-tree digest drift revokes
calls; mixed tool/UI packages need a new session even when only UI bytes change.
Installed runtime code has your account's filesystem/network authority. A child
process gives bounded teardown and fresh module caches, not an OS sandbox.

## Git pulse (api 2)

`git-pulse/` keeps an owner-labelled status line and band with branch, dirty-path
count and local upstream ahead/behind. It watches `.git/HEAD` and `.git/index`,
polls every five seconds for working-file changes, and retains its last snapshot
in session state. `/ext:git-pulse:pulse` refreshes and opens a card. No upstream is
reported explicitly; Git failures produce unavailable facts, never a fake clean
repository. It invokes only Git with fixed argv and no shell, fetch or push;
`exec: true` nevertheless grants general child-process authority, not a Git-only
allowlist. Workspace reads are declared; network and direct writes are disabled.

## Peer guard (api 2)

`peer-guard/` provides `/ext:peer-guard:claim <path>`, `release <path>` and a
`claims` table. Its awaited write/edit hook blocks exact canonical workspace
paths claimed by a different owner within ten minutes; `claimMinutes` is the
manifest default and can be varied in test fixtures. The shared store is scoped
to this extension and Clio state home. Claims use compare-and-set updates,
resolve existing symlink parents, expire on read, and can be renewed or released
by their owner. Claims require an established Clio session: before the first turn, commands
explain this requirement and leave the store unchanged.
Errors/timeouts pass: this is cooperative coordination, not protection from
scripts, other mutation tools or sessions using a different state home.

Both new examples require operator runtime api 2. Validate and run their public
package tests before the operator approves a dev envelope or installs them:

```bash
clio-coder extensions validate examples/extensions/git-pulse
clio-coder extensions test examples/extensions/git-pulse
clio-coder extensions validate examples/extensions/peer-guard
clio-coder extensions test examples/extensions/peer-guard
```

For iteration, copy an example to `.clio-coder/dev/extensions/<id>/` and start the
TUI there, or use `/extensions dev <folder>`. Saves reload at idle after consent;
`/extensions mute <id>` and `unmute` remove/restore its session runtime.
