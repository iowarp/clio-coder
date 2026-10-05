# Harness extensions

The [component and middleware architecture](../architecture/middleware-and-components.md) explains discovery and hook boundaries.

Harness extensions add executable capabilities to Clio Coder: model-callable command tools, operator-side slash commands with status and panels, and hook declarations. A domain workflow that combines prompts, agents, skills, fleets, and reference files is a plugin, installed with `clio-coder library install <path>`; see [plugins.md](plugins.md). Installing or browsing a plugin never registers harness tools, hooks, operator commands, or UI. A plugin may carry scripts that a skill or fleet runs explicitly, and those stay ordinary files under normal tool safety.

An extension declares its capabilities in `clio-coder-extension.yaml`, `.yml`, or `.json`. Clio discovers and validates declarations without importing or executing package code. Command tools become available in a new session after installation. Native workers can use a tool when their admitted recipe includes its qualified name; narrower profiles such as `minimal-local` exclude extension commands.

Source: `src/domains/extensions/`, [harness-extensions.ts](../../src/tools/harness-extensions.ts), [slash-commands.ts](../../src/session-control/slash-commands.ts), and [extensions.ts](../../src/cli/extensions.ts).

## Package manifest

An extension root contains one manifest, found in the order `clio-coder-extension.yaml`, `clio-coder-extension.yml`, `clio-coder-extension.json`. Any other top-level key is an error.

| Key | Required | Rule |
| --- | --- | --- |
| `id` | yes | 2 to 80 characters: lowercase letters, digits, dots, underscores, and hyphens, starting and ending alphanumeric. A package with command tools cannot use dots (the qualified tool name must be provider-safe) or a double underscore. |
| `name` | no | Display name. Defaults to `id`. |
| `version` | yes | Non-empty string. It is not parsed as Semantic Version. |
| `description` | yes | Non-empty string. |
| `compatibility.clio` | no | SemVer range of at most 256 characters, such as `>=0.4.7`, `^0.4.7`, or `0.4.x`. Tags and malformed ranges are rejected. |
| `capabilities.tools` | no | 1 to 32 command tool declarations (below). |
| `runtime` | no | Operator runtime declaration (below). |

`capabilities` is optional, so a package whose only contribution is a root `hooks.yaml` is a valid harness extension with no command tools. A manifest naming `resources`, `prompts`, `skills`, `agents`, or `fleets` is invalid, and the diagnostic points at `clio-coder library install <path>`.

Installation refuses a package whose `compatibility.clio` range excludes the running Clio Coder version, naming the extension, its range, and the running version. Clio repeats the check whenever it loads installed extensions, so a package that becomes incompatible after a Clio Coder upgrade stays visible in `extensions list` with its diagnostic and contributes no command tools or hooks. An incompatible project package does not hide a compatible user package with the same ID. A manifest without `compatibility.clio` is unrestricted.

### Install locations and precedence

| Scope | Root | State file |
| --- | --- | --- |
| user | `<configDir>/extensions/<id>/` | `<configDir>/extensions/state.json` |
| project | `.clio-coder/extensions/<id>/` | `.clio-coder/extensions/state.json` |

In a workspace whose project extensions are approved (see [Workspace trust for project extensions](#workspace-trust-for-project-extensions)), a valid, compatible project package shadows the user package with the same ID, and a disabled project package still suppresses the user package. Directories whose names start with a dot are ignored.

### Workspace trust for project extensions

A project package installs from the repository's own `.clio-coder/extensions/state.json`, so its digest check proves integrity and not consent. Project extensions load only after the operator approves that file for the workspace, which is the `extensions` surface of workspace trust. User-scope packages never depend on it.

Until the surface is approved, every project copy is blocked. It contributes no command tools, hook declarations, operator runtime or UI, and it neither shadows nor suppresses a user package with the same ID, so the user copy keeps loading even when the blocked project copy is disabled. A blocked copy stays visible. `--json` carries `trustBlocked: true` on every project copy, and an enabled, valid, compatible one reads `untrusted` in `extensions list` and carries the warning `project extensions are not trusted for this workspace and are not loaded; review with clio-coder config trust extensions`. `extensions run` refuses it with `extension <id> has no eligible operator command '<command>'`.

```bash
clio-coder config trust extensions                  # print the captured state file and its SHA-256 digest (read-only)
clio-coder config trust extensions --hash <sha256>  # approve exactly those bytes
clio-coder config trust extensions --revoke         # withdraw the approval
```

Approval pins the exact bytes of `state.json`. The file records the content digest of every project package and the loaders reverify each tree against it, so one approval covers exactly the set of packages the operator reviewed. Any change to the file's bytes ends the approval: an install, a `--force` reinstall, an enable, a disable, a remove, or an edit. The surface then reads `changed` and every project package in the workspace stays unloaded until the new bytes are reviewed and approved. The command grammar and output are in [commands and modes](commands-and-modes.md).

A new approval takes effect at `/extensions reload` or the next start. A revoked or changed approval is treated like a disable: the next command-tool call fails with the disabled, removed, replaced or changed message, and an operator runtime loses authority once the change is observed.

Two cases load project extensions without a `config trust` step:

- **First install.** When the workspace has no `.clio-coder/extensions/state.json`, `clio-coder extensions install <path> --project` creates it and approves it in the same step, because the operator's own first install is the review. Plain output then adds `This is the workspace's first project extension install, so project extensions are approved for it. Later installs, disables and removes need clio-coder config trust extensions.` With `--json` the line is absent and the approval still applies. No other command self-approves extensions. A project-scope extension import from a share archive (`share import`, `/archive import`) never does, even for the workspace's first project extension.
- **Task worktrees.** A task worktree that Clio created for a dispatched worker inherits its origin workspace's approval while its `state.json` is byte-identical to the origin's approved file. A hand-made `git worktree`, a worktree whose state differs, and a worktree whose origin approval is revoked or changed read `untrusted` or `changed` like any other workspace. The inheritance rules are in the [safety model](../architecture/safety-model.md).

## Create a command tool

Create a directory containing this `clio-coder-extension.yaml`:

```yaml
id: local-analysis
name: Local Analysis
version: 1.0.0
description: Local analysis capabilities for Clio Coder.
compatibility:
  clio: ">=0.4.7"
capabilities:
  tools:
    - name: summarize
      description: Return the count and sum of supplied measurements.
      runtime: node
      entrypoint: tools/summarize.cjs
      timeoutMs: 10000
      maxOutputBytes: 16384
      inputSchema:
        type: object
        properties:
          values:
            type: array
            items:
              type: number
            maxItems: 1000
        required: [values]
        additionalProperties: false
```

Add `tools/summarize.cjs`:

```javascript
const { values } = JSON.parse(process.argv[2]);
console.log(JSON.stringify({
  count: values.length,
  sum: values.reduce((sum, value) => sum + value, 0),
}));
```

Install the directory and start a new Clio Coder session:

```bash
clio-coder extensions install /path/to/local-analysis --user
clio-coder extensions list --all --json
clio-coder
```

Command tools sit behind the gateway. The model finds and calls this one with `gateway(op="call", capability="extension_local-analysis__summarize", args={values:[1,2,3]})`, after `gateway(op="find")` or `gateway(op="describe")` if needed. A recipe requests the same qualified name in `tools.required` or `tools.optional`. Python tools use `runtime: python3` and read `json.loads(sys.argv[1])`.

## Command contract

Each tool declares `name`, `description`, `runtime`, `entrypoint`, and `inputSchema`, and may declare `timeoutMs` and `maxOutputBytes`. Supported runtimes are `node` and `python3`. Clio Coder runs `node -- <entrypoint> <json>` with its current Node executable, and `python3 -I <entrypoint> <json>`, where `-I` isolates interpreter configuration. Entrypoints are ordinary files inside the installed package; symlinks (in the entrypoint or any parent), hard links, absolute paths, and parent traversal are refused. Helper files remain covered by the full package digest.

Clio passes the validated JSON object as one argument and runs a fixed argument vector with no shell. The child runs in the workspace directory. Standard output must contain exactly one JSON value. Use standard error for diagnostics. Nonzero exits, invalid JSON, cancellation, timeout, and exceeded output limits return tool errors with execution metadata and package provenance.

Input is limited to 64 KiB. `timeoutMs` defaults to 120000 and is bounded at 300000. `maxOutputBytes` defaults to 600000 and is bounded at 1048576. Output limits include standard output and standard error together.

Schemas support `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`), `description`, `properties`, `required`, `additionalProperties`, `items`, scalar `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, and `maxItems`, nested at most 12 levels. The root must be an object. Each object declares its properties and `additionalProperties: false`; array schemas declare `items`; `required` names declared properties. References and executable schema keywords are refused. Clio validates each invocation against the schema before starting the child.

Local tool names start with a lowercase letter and use lowercase letters, digits, and single underscores. The qualified name is `extension_<id>__<name>` and must fit 64 characters. Duplicate and colliding tool registrations are refused.

## Trust and sandbox boundary

Command tools, operator runtimes, and hook commands are installed programs with the filesystem and network access of the invoking process. Entry containment, environment filtering, and timeouts do not create an operating-system sandbox. Install code you trust, as you would a local executable script.

| Surface | Gate |
| --- | --- |
| Command tool | Every model-visible command tool is an execution action and runs sequentially. Packages cannot declare themselves read-only. The registry evaluates both the qualified capability call and its fixed executable command through Clio Coder's safety policy, autonomy, approval, and middleware rules. A read-only dispatch restriction blocks commands, and workers with explicit write confinement cannot execute an unconfined extension command. The child receives Clio Coder's allowlisted tool environment, which excludes provider credentials and interpreter injection variables. |
| Operator runtime | Runs with your user account's authority, independently of model-tool autonomy, in a disposable Node child. It starts only in an interactive session or through `extensions run`, never in `clio-coder run`, ACP sessions, or native workers. |
| Hook declaration | Hooks can add middleware effects, including a request to block a tool call, but cannot grant what the safety policy denies. A command hook runs an argv without a shell under a timeout. |
| Installation | A package is admitted only when its tree matches the digest recorded in `state.json`. A project package is admitted only while the operator has also approved the project's `.clio-coder/extensions/state.json` for the workspace (`clio-coder config trust extensions`), because the digest proves integrity and not consent. A user package needs no workspace approval. |

Installation does not bypass command approval. The model cannot administer extensions: model writes under `.clio-coder/extensions/` or `<configDir>/extensions/` are refused, and a model shell call that runs `clio-coder extensions install`, `update`, `remove`, `enable`, `disable`, or `pin` is blocked at every autonomy level. A model shell call that runs `clio-coder config trust` is blocked too (reason `trust-authority`), so the model cannot approve project extensions.

## Install state and integrity

Installation records the SHA-256 digest of the entire package tree in `extensions/state.json` beside the installed packages. The digest frames every entry in sorted relative-path order by kind (file, directory, or link), path, and bytes, so file names, empty directories, symlink targets, and contents are all bound. Symlinks must resolve inside the package, and hard-linked files, special files, and a symlinked package root are refused. Plugins use the same digest function.

Each invocation rechecks the effective installed package, enabled state, canonical root, and digest. Disabling, removing, replacing, or modifying a package revokes existing tool calls. An install record without a digest, a drifted tree, a missing record, and a corrupt state file all fail closed: the package stays visible and inactive, and its diagnostic says to reinstall with `--force`. Listing extensions, booting Clio Coder, inspection, and plain doctor runs never rewrite install state.

If extension state is corrupt or absent, a normal reinstall refuses it. `extensions install <valid-source> --force` backs up corrupt state, preserves the previous package bytes in a hidden backup directory beside the package, then installs and records the verified replacement. With valid state, a forced replacement discards the previous tree without a backup. `extensions remove <id>` can also remove an unverifiable package from the load path while preserving its bytes and any corrupt state in the paths the command prints. These recovery backups are not treated as installed packages.

## Hook declarations

A package root may contain `hooks.yaml`, either a list of declarations or a map with a `hooks` list. Clio Coder captures the file's bytes during install-digest verification and parses the captured bytes, so a file rewritten after verification is never reopened. Hooks are best-effort: a malformed declaration is rejected with a diagnostic and never aborts a turn.

```yaml
- id: units-reminder
  on: turn_start
  kind: prompt
  message: State units for every measurement.
- on: after_tool
  tools: [bash]
  kind: command
  argv: ["node", "scripts/check-output.cjs"]
  timeoutMs: 2000
  as: annotate
```

| Field | Applies to | Rule |
| --- | --- | --- |
| `id` | all | Optional. Defaults to `<extension-id>.<kind>.<hash>`. |
| `on` | all | `before_tool`, `after_tool`, `turn_start`, or `turn_end`. `on_compaction` parses, but it is observe-only and applies no effect, so a user hook declared on it is always refused. |
| `tools` | all | Optional list of tool names the hook matches. |
| `enabled` | all | Optional boolean, default true. |
| `kind` | all | `prompt`, `effect`, or `command`. |
| `message`, `severity` | `prompt` | Message truncated to 2000 characters. Severity is `info` (default), `advisory`, `warn`, or `hard-block`. |
| `effect` | `effect` | One existing closed middleware effect, validated at load. |
| `argv`, `cwd`, `timeoutMs`, `as` | `command` | Non-empty argv array with no shell. `cwd` defaults to the workspace and must resolve under it. `timeoutMs` defaults to 2000 and is clamped to 100 through 5000. Output is cut to 4000 characters and returned as `annotate` (default) or as a `reminder`. |

A hook whose event cannot apply the effect it produces is refused at load with an issue naming the events that can. Extension hooks have the lowest precedence of four origins (extension, user, project, project.local), and a later origin overrides an earlier one with the same `id`. Native workers never receive user-defined hooks. Every execution emits a receipt carrying the package provenance, declarations digest, and generation; `clio-coder config inspect` reads them. Hook events, effects, and budgets are in the [middleware architecture](../architecture/middleware-and-components.md).

## Extension CLI

```bash
clio-coder extensions list [--all] [--json] [--user|--project]
clio-coder extensions discover <path> [--json]
clio-coder extensions run <id> <command> [--json] -- [arguments]
clio-coder extensions install <path> [--user|--project] [--force] [--json]
clio-coder extensions enable <id> [--user|--project] [--json]
clio-coder extensions disable <id> [--user|--project] [--json]
clio-coder extensions remove <id> [--user|--project] [--json]
```

`clio-coder ext` is an alias. `install` defaults to user scope. `enable`, `disable`, and `remove` act on the project copy when one exists and otherwise on the user copy; `--user` or `--project` selects exactly that copy. `list` hides shadowed entries unless `--all` is given, while disabled, untrusted, invalid, and incompatible packages stay visible. The state column reads `eligible`, `inactive`, `disabled`, `untrusted`, `shadowed:<scope>`, `incompatible`, or `invalid`. `untrusted` marks an enabled, valid, compatible project copy in a workspace whose project extensions are not approved. The first `install --project` into a workspace with no project extension state also approves it; see [Workspace trust for project extensions](#workspace-trust-for-project-extensions). `install` refuses an existing ID without `--force` and enables the installed package. `discover` inspects a path or a directory of packages without installing and exits 1 when any candidate is invalid. A bare `clio-coder extensions` or a usage error exits 2, and error diagnostics exit 1.

## Generations and reload

A running session does not read installed packages on every load. While domains start, the extensions domain publishes nothing: readers use an ephemeral generation-0 projection. The composition root then asks the extensions domain to build an immutable candidate for the session's working directory and builds the matching user-hook registration table from it. After validating that both candidates are still current, it publishes the snapshot and hooks with two adjacent reference assignments. That paired boot snapshot is generation 1. It contains package identity and provenance, the command-tool declarations of each loadable package, and the parsed `hooks.yaml` declarations. Every consumer in the process reads the committed generation, so consecutive loads within one turn agree on the package set.

`/extensions reload` is the only in-session way to publish a later generation. It rebuilds the snapshot from disk, re-verifies every installed tree against `state.json`, rereads the workspace approval of project extensions, builds the user-hook registrations for the candidate, validates both candidates, and then performs the same two adjacent assignment-only publications. No callback, event, log, or refusal sits between them; conflict diagnostics and the plugin resource reload run only after both references are live. Hook evaluation and every later reader therefore see the previous hooks or the new ones, never an intermediate pairing.

The command reports the new generation, which packages were added (`+`), removed (`-`), or modified (`~`), and how many hooks were registered, dropped, overridden, or rejected. A tree that no longer verifies is listed as inactive and contributes nothing until it is reinstalled. A build failure or stale candidate publishes neither side, reports the reason (`build-failed`, `reentrant`, `stale`, or `workspace-changed`), and keeps the previous generation. Reload requested during a turn, a command, a local shell operation, or a modal interaction is queued to an idle boundary.

Reloading an unchanged tree still publishes a new generation with the same content digest; content identity is the digest, not the generation number. Installs, enables, disables, and removes performed by `clio-coder extensions` in another process are invisible to a running session until the operator reloads or restarts. There is no filesystem watcher, so a CLI mutation never becomes an implicit mid-turn hook change.

Model-visible command-tool schemas are frozen when a session registry is created. A reload never changes a live model's tool surface, and adding, modifying, or removing a tool requires restarting Clio Coder. A new native worker builds its own verified registry, and external command-line worker runtimes do not gain Clio Coder command tools. Plugin resources have their own generation and their own `/library reload`.

## Operator commands, status, and panels

An optional `runtime` adds local code-backed slash commands and observations in
an interactive session. It uses a fresh disposable Node child per package.
Discovery, installation, validation and `extensions list` remain code-free.
Installing or enabling trusted runtime code makes it eligible to execute on the
next interactive startup or explicit extension reload. Module initialization,
commands and observations run with your user account's filesystem and network
authority, independently of model-tool autonomy. The API provides no tool,
provider, credential, model, worker or session mutation methods. This is
lifecycle isolation, not an operating-system sandbox.

```json
{
  "id": "lab-status",
  "name": "Local experiment status",
  "version": "1.0.0",
  "description": "Inspect local experiment records.",
  "compatibility": { "clio": ">=0.4.7" },
  "runtime": {
    "api": 1,
    "entrypoint": "extension.mjs",
    "commands": [{ "name": "dashboard", "description": "Show local experiment status." }],
    "events": ["session_open", "turn_end"],
    "ui": ["status", "panel"]
  }
}
```

Only `.mjs` entrypoints are supported (at most 240 characters). Ship JavaScript and contained assets;
author TypeScript with your own build if desired. Clio Coder never installs
dependencies or runs package lifecycle scripts. Each runtime loads from a
private copy whose complete digest matches the reviewed installation. Contained
relative helpers and assets are copied and refreshed too. Mutable external
imports, native add-ons, detached subprocesses, remote state, and files written
by the extension are outside the reload guarantee.

The default export registers exactly the declared commands and observations.
Registration closes when the factory settles; it cannot add tools or new
commands later. Import author types with
`import type { ExtensionApi, ExtensionOutput } from '@iowarp/clio-coder/extensions'`.
This package export contains types only; Clio injects the implementation.

```javascript
/** @param {import('@iowarp/clio-coder/extensions').ExtensionApi} api */
export default function extension(api) {
  api.handle("dashboard", (_args, context) => {
    context.signal.throwIfAborted();
    return {
      text: "SYNTHETIC FIXTURE: 2 of 3 jobs completed",
      status: { text: "SYNTHETIC: 2/3 completed", tone: "neutral" },
      panel: {
        title: "Synthetic experiment",
        sections: [
          { kind: "metrics", items: [{ label: "Completed jobs", value: "2/3" }] },
          { kind: "text", text: "Demonstration data; no cluster jobs were submitted." }
        ]
      }
    };
  });
  api.on("session_open", () => ({ text: "", status: { text: "Synthetic fixture ready" } }));
  api.on("turn_end", () => ({ text: "" }));
  api.onDispose(() => { /* best-effort local cleanup */ });
}
```

Commands receive the unexpanded argument string and a context with `signal`,
`requestId`, and a read-only `snapshot` of `workspace`, `sessionId`, `generation`
and `mode`. No conversation body, tool arguments or credentials cross this
API. Results render locally for the operator and never start a model turn or
become a session transcript entry. The required `text` is also the headless
fallback; include the same useful findings and evidence qualifiers there.

`session_open` receives a `startup`, `reload`, or `session-change` reason.
`turn_end` receives `completed`, meaning the foreground turn settled, not that
its scientific or engineering objective passed validation. Observers are
passive, asynchronous observations, distinct from the effect-producing
declarations in `hooks.yaml`.
Observers may return status, but cannot open a panel or steal focus. There is
one coalesced pending observation; a busy runtime skips observations. No timer
polling or arbitrary event bus subscription API is exposed. Runtime globals
reset on reload and on resume, fork, workspace change or branch switch.

UI is bounded data. A status is one string (160 characters) and an optional
`neutral`, `positive`, `warning`, or `error` tone; `status: null` clears it.
The footer displays a single additive line with host-assigned owner labels;
core activity, approval cues and notices retain ownership. The Extensions
reference shows each owner's full current status if the footer truncates it.
Panels support plain text, labeled metrics, and tables. Clio owns wrapping,
scrolling, Escape, focus and permission interruption. Terminal controls are
stripped. Background code cannot open panels; a command opens one only when
no other overlay needs the screen. An unavailable panel falls back to text.
Panels expire with their instance and close on observed revocation when they
hold the overlay slot; an interrupted expired panel shows an expiry message.

## Invoke and manage operator runtimes

```bash
# From the source checkout, or use the examples directory in the installed package:
clio-coder extensions install examples/extensions/lab-status --project
clio-coder extensions list --all --json
clio-coder extensions run lab-status dashboard
clio-coder extensions run lab-status dashboard --json -- /path/to/local-record.json
```

In a workspace with no project extension state, the first `install --project` also approves project extensions for it. Every later project install, enable, disable or remove changes the state file and needs `clio-coder config trust extensions` before the project packages load again.

Inside an interactive session, invoke `/ext:lab-status:dashboard` or append a
local JSON filename. Browse `/extensions` and use
`/extensions reload` after a reviewed reinstall or enable. `/library reload`
refreshes plugin resources independently and never loads runtime code.

Canonical commands use `/ext:<extension-id>:<command>`. Existing extension IDs
are preserved, including dots and underscores. Local command names start with
a lowercase letter and contain lowercase letters, digits or underscores.
There are no short aliases. Built-ins retain ownership; an existing prompt
with the same canonical spelling remains a prompt and disables that extension
command with a conflict diagnostic. This includes unavailable and display-only
prompts. Completion and dispatch share that collision projection. Avoid `ext:`
when authoring new prompt names. Unknown canonical commands error; escaped
`\/ext:...` remains ordinary model text.

`extensions run` is the explicit headless operator path. It accepts only
`--json` and the `--` argument separator, so `--user`, `--project`, `--force`
and `--all` exit 2. It starts only the
selected installed runtime, supplies `sessionId: null`, sends no synthetic
session observation, prints one fallback or JSON result
(`extensionId`, `command`, `generation`, `provenance`, `output`), then disposes the
runtime. SIGINT/SIGTERM cancel it. A CLI invocation does not reload any other
running session. Ordinary `clio-coder run`, ACP sessions and native workers do
not start operator/UI runtimes. They retain existing admitted command tools;
a slash token is not permission to run an operator extension in a worker.

Installation eligibility, extension snapshot/hook generation, operator runtime
readiness and model tool schemas are separate facts:

- Listing says `eligible`, not that another process has activated the package.
  The live Extensions reference reports runtime state, generation, failures,
  available commands and current status. Tool evidence is taken from the actual
  session registry when that host provides it. Other hosts explicitly label the
  comparison as a runtime-startup observation, which does not prove a model
  schema binding.
- Idle reload restarts every child using verified copies. During reload,
  commands are unavailable.
- The existing synchronous snapshot/hook pair still commits together. Runtime
  staging happens first, then that pair commits, then the runtime generation
  publishes and children acknowledge activation. Startup/handler failures are
  reported as degraded runtime state. A rejected reload leaves no replacement
  runtimes active; old children are already stopped and require a retry.
  This deliberately does not promise atomic rollback of arbitrary code or
  preserve module globals across reloads.
- Each command rechecks installed scope, enabled state, canonical root and
  whole-tree digest before and after execution. A slow host tick also observes
  revocation while idle. No timer or scan runs when there are no active runtimes
  or pending reloads. Active runtimes receive a full admission check at a
  30-second minimum interval, lengthened to at least 100 times the last scan
  duration on slower filesystems. Checks may therefore be delayed on HPC/shared
  storage. Commands and observations still verify before and after execution;
  the slow timer is only proactive revocation detection. Once observed, old
  requests and UI lose authority and the child is disposed. Disable/remove is
  scoped; a disabled project copy suppresses a user copy, while project removal
  may reveal it on reload. Installation, enable and update need explicit reload
  to start newly eligible code.
- Tool schemas stay frozen. **Editing only UI in a mixed tool/runtime package
  changes the full package digest and revokes that session's old tool calls.**
  Reinstalling and reloading the UI cannot rebind those calls. Start a new
  session, or keep rapidly developed UI in a separate runtime-only package.
  Existing declarative extension hooks retain captured generations until reload;
  they do not acquire the command tools' per-invocation digest recheck.

At most four runtimes run concurrently; further eligible packages show a limit
diagnostic. There are at most 32 commands, two observations and eight disposal
callbacks per runtime. Startup/activation each have a 5-second deadline;
commands default to 30 seconds and may declare `timeoutMs` from 100 through
300000. Observations have a 2-second deadline. Arguments are limited to 16 KiB;
results to 64 KiB (text 32768 characters), and protocol messages to 96 KiB and
128 messages per second. Panels have at most 16 sections, 32 metric items,
8 table columns and 100 rows per table. stdout/stderr are discarded as
non-protocol diagnostic streams and their combined 64 KiB lifetime cap fails
the runtime. Failures are bounded diagnostics, not arbitrary terminal output.

Cancellation fences the result immediately, signals the handler, allows
250 ms of best-effort disposal, then kills the child. Timeouts/protocol failures
kill it directly. Linux/macOS process groups also stop ordinary descendants;
Windows has direct-child termination only. A detached daemon, external job,
already-written file, or an unresponsive child after an ungraceful parent death
cannot be reclaimed by this lifecycle contract. No OS containment is claimed.

## Scientific examples

[The worked examples](../../examples/extensions/README.md) are included in the
npm package. `lab-status` reads a bounded local JSON experiment record and uses
an explicitly synthetic fixture by default. It performs no SSH, provider calls,
remote cluster queries or submissions. `measurements` is a separate
command-tool package that computes count, mean, extrema and sample standard
deviation of supplied finite numbers. Units and provenance stay caller-supplied;
a singleton's sample standard deviation is unavailable (`null`).
