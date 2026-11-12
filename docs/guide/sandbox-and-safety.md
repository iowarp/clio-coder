# Sandbox and Safety

This guide explains, in plain terms, what CLIO Coder may do on your machine,
what it hides from the commands it runs, and when it stops to ask you. The
exact rules, with every reason code, are in the
[safety model](../architecture/safety-model.md).

## Quick start

1. Run `clio-coder doctor` and read the `shell sandbox` row. `OK` means shell
   commands run inside an OS sandbox on this host: bubblewrap on Linux, or
   `sandbox-exec` on macOS, whose profile has not yet been verified on a real
   macOS build. `WARN` means they run uncontained and more of them
   ask first. See [Shell sandbox rows](doctor.md#shell-sandbox-rows).
2. Work at the `default` autonomy level. It needs no setup.
3. In your request, name any action that reaches beyond the project, such as
   "push the branch when the tests pass". The safety judge reads your words
   when it decides.
4. If a change goes wrong, `/rewind` restores the files from the snapshot taken
   before it.

## The two autonomy levels

| Level | Use it for | In short |
| --- | --- | --- |
| `default` | Everyday work, attended or not. | Edits and contained shell work run. What escapes the sandbox goes to the safety judge, and you are asked only when the judge has no verdict or the choice is yours. |
| `yolo` | Long jobs you leave running. | Nothing waits for you. It is contained by default: the sandbox, snapshots and judge work as at `default`, and a call that would ask you is refused back to CLIO Coder instead. |

Unconfined yolo is a separate choice for containers and other disposable
machines. Commands run unsandboxed, as you, with your credentials. It needs
`safety.yoloConfinement: unconfined` in your user settings and its own one-time
acceptance. A short floor still blocks wiping `/`, your home directory or a
system tree, formatting disks, fork bombs, and writes into CLIO Coder's own
settings and credentials.

Set the level in `/settings`, `clio-coder configure`, with `--autonomy`, or
with the leader key and `y`. The first switch to yolo shows a one-time
acceptance card, and yolo is refused as root outside a container. Only you
set the level: no tool, project file or model output can raise it. See
[Choosing an autonomy level](commands-and-modes.md#choosing-an-autonomy-level)
for the full comparison.

## What a contained command may do

At `default`, and at contained yolo, the main session's `bash`, `run_script`
and command-running `verify` calls run inside the sandbox. A contained command
can read the filesystem, use the network and write only to:

- the workspace;
- the scratch roots: the temp directories (`$TMPDIR`, `/tmp` and `/var/tmp`)
  and any directory listed in `safety.scratchRoots`;
- a private tool cache that `XDG_CACHE_HOME`, `npm_config_cache`,
  `PIP_CACHE_DIR`, `UV_CACHE_DIR` and `PLAYWRIGHT_BROWSERS_PATH` point at;
- the repository's git directories, so `git commit`, `fetch` and `checkout`
  work.

Git hooks, git config files and `core.hooksPath` directories stay read-only,
because anything written there would later run outside the sandbox. So do the
project's `.clio-coder` folder, your own `~/.cache`, `~/.npm` and `~/.local`,
and CLIO Coder's own config, data, state and cache directories. The command
runs in its own process namespace and cannot signal your other programs.

## What the sandbox hides

A contained command cannot read your credentials, even though it can read
the rest of the filesystem. Hidden are, among others:

- SSH and GPG keys, the SSH agent, and Kerberos ticket caches;
- cloud and cluster logins: `~/.aws`, `~/.azure`, `~/.config/gcloud`,
  `~/.kube`, Docker's `config.json`;
- code-host and registry tokens: `~/.config/gh`, `~/.git-credentials`,
  `~/.netrc`, `~/.npmrc`, `~/.pypirc`, Cargo credentials;
- password stores and keyrings, browser profiles, shell histories, and the
  logins of other coding agents;
- CLIO Coder's own credential store;
- secret files in the workspace and scratch roots, such as `.env`, `*.key`,
  service-account JSON and Terraform state. Templates such as `.env.example`
  stay readable.

The command also starts with a scrubbed environment: a variable whose name
marks a credential (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY` and the like), or
whose value looks like one, is removed. List a variable a build must keep in
`safety.sandboxPassEnv` in your user settings.

Creating a local Unix socket is refused too, because a socket to a terminal
multiplexer, a display or a daemon can run commands outside the sandbox. Tools
that need one fail with `Operation not permitted`: Docker, local database
clients, X11 and D-Bus clients, the `tsx` CLI and Python's `forkserver`
start method. `safety.sandboxUnixSockets` (`owned` or `allow`) loosens this.

## When a command leaves the sandbox

Some commands cannot work without your credentials. CLIO Coder never runs
these inside the sandbox; it sends them to the safety judge first:

- `git push` (other than `--dry-run`);
- code-host and cloud CLIs such as `gh`, `glab`, `aws`, `gcloud`, `az`,
  `kubectl`, `terraform` and `vercel`, and `ssh`, `scp` and `sftp`;
- batch scheduler clients: Slurm (`sbatch`, `srun`, `squeue`, `scancel` and
  the rest), PBS (`qsub`, `qstat`), LSF (`bsub`, `bjobs`) and Flux;
- publishing, such as `npm publish`, `cargo publish` or `docker push`;
- network writes, such as `curl` with a body or a method other than GET.

When a contained command fails because of the sandbox, CLIO Coder can rerun it
with `unsandboxed: true`. That rerun also goes to the judge, which lets it run
only when one of your messages mentions leaving the sandbox; otherwise it asks
you.

Scheduler clients authenticate through a local daemon socket that the sandbox
refuses, so a script that calls `sbatch` itself fails inside the sandbox.
Submit from the command the agent runs rather than from a wrapper script. See
[Scheduler clients](hpc-clusters.md#scheduler-clients).

## How each level treats an escaping command

| Level | A push, publish, scheduler or cloud command, or `unsandboxed: true` |
| --- | --- |
| `default` | The judge runs it when your messages ask for it. Otherwise the judge refuses it, or you get an approval card when the judge has no verdict. |
| contained `yolo` | The judge runs an outward step only when your own message names it. Anything else is refused back to CLIO Coder, which continues without it and says so in its final reply. |
| unconfined `yolo` | It runs, as you. |
| headless `clio-coder run` at `default` | The judge decides from your prompt. Anything it does not allow is denied, since nobody can answer a card. |

An approval card nobody answers within `safety.unattendedAfterSeconds` (300
seconds by default) is denied, and the turn continues.

## Make the sandbox stricter or looser

`safety.sandbox` takes three values:

- `auto` (the default): use the sandbox when the host has one.
- `required`: workers' commands are refused on a host without a sandbox. At
  unconfined yolo, every command `default` would contain, and every script,
  runs in the sandbox, and `unsandboxed: true` is refused. An outward command
  then leaves the sandbox only as one literal command whose options are all
  on that CLI's short list; `scp`, `glab`, `aws`, `gcloud`, `terraform`,
  `srun`, `salloc` and `flux` stay inside on every line, without the
  credentials the sandbox hides. The main session at
  `default` still runs uncontained, with the approval rails, on a host without
  a sandbox.
- `off`: never sandbox. More commands then ask first.

Other user settings:

- `safety.scratchRoots`: absolute directories a contained command and the
  file tools may write without asking, such as `/scratch/$USER` on a cluster.
- `safety.sandboxPassEnv`: variable names to keep in the sandbox.
- `safety.judge.environment`, `allow` and `deny`: facts and rules for the
  judge in your own words. See
  [Telling the safety judge about your environment](commands-and-modes.md#telling-the-safety-judge-about-your-environment).

All settings are listed in the
[configuration reference](configuration-reference.md).

## Project configuration and /trust

A repository can carry its own CLIO Coder configuration in `.clio-coder/`:
safety rules, settings, hooks, extensions and library packages. Each one is
ignored until you approve its exact contents for this workspace.

When you open a project with unapproved configuration, a card lists what it
would change. **Review** prints every file, **Trust all** approves them, and
**Open without it** starts the session with that configuration ignored. The
header then reads `Project configuration not active · /trust`, and `/trust`
opens the same card later. In a shell:

```bash
clio-coder config trust settings            # print the files and their digest
clio-coder config trust settings --hash <sha256>   # approve what you reviewed
clio-coder config trust settings --revoke   # withdraw the approval
```

An edit to an approved file reads `changed` and needs a new approval. The
agent can never approve a surface for you. See
[Project trust](commands-and-modes.md#project-trust).

## What a project can change

Even approved, a project settings file can only make CLIO Coder more careful
than your user settings:

- It can lower `safety.autonomy` to `default`, never raise it to `yolo`.
- It can tighten `safety.sandbox` (`off`, then `auto`, then `required`), never
  loosen it.
- It can lower limits such as `safety.limits`, never raise them.
- It can switch the review watchdog on, never off.
- It cannot carry credentials, add scratch roots, pass variables into the
  sandbox, change the judge, or accept yolo for you.

An ignored key is reported as a settings issue. A project `safety.yaml` can
add its own rules: commands that run without asking, and paths that stay
hidden, read-only, unwritable or undeletable. Those path rules still hold at
unconfined yolo. See
[Project policy](../architecture/safety-model.md#project-policy).

## Undo with /rewind

In a Git work tree, CLIO Coder writes a private snapshot of your files before
the first change of each turn and before every destructive step, at both
levels. `/rewind` lists the snapshots, previews what a restore would change,
and restores files only; it never moves your branches. See
[Undoing file changes with /rewind](commands-and-modes.md#undoing-file-changes-with-rewind).

## Workers

Workers you dispatch run in their own sandbox, with no network unless
`safety.sandboxNetwork` is on or they hold `web_fetch`. Their ordinary asks go
to the same safety judge by default, and a worker cannot raise its own level.
See [Workers at each level](../architecture/safety-model.md#workers-at-each-level).

## What the sandbox does not cover

Typed tools such as `write` and `edit`, git hooks, the MCP servers the main
session starts, and external coding agents are checked by the rules above but
run with your own operating-system permissions. Windows has no sandbox
backend; WSL uses the Linux one.

The masks match known names and value shapes, so a credential stored under an
unusual name stays readable. The network stays on, so a contained command can
send what it can read. For full isolation, run CLIO Coder inside a container
or a virtual machine. See
[Platform limits](../architecture/safety-model.md#platform-limits).
