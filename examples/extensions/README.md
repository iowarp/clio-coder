# Local scientific extensions

These installable examples use the harness extension lifecycle, separately from
library recipes. They require a Clio build containing operator runtime API v1.
The manifests retain the current package compatibility minimum, 0.4.7; use this
implementation or a later release that includes it (the original 0.4.7 release
predates the runtime field).

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
