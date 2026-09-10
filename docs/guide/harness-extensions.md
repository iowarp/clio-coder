# Harness extensions

> **Visual blueprint:** See the [visual reference](../html/harness_extensions_blueprint.html) in the source checkout.

Harness extensions add executable capabilities to Clio. Library recipes may also carry explicitly invoked workflow or evaluation scripts. Installing or browsing a recipe never registers harness tools, hooks, operator commands, or UI. A domain workflow that combines prompts, agents, skills, fleets, and reference files is a plugin, installed with `clio-coder library install <path>`.

An extension declares command tools in `clio-coder-extension.yaml`, `.yml`, or `.json`. Clio discovers and validates declarations without importing or executing package code. Tools become available in a new session after installation. Native workers can use a tool when their admitted recipe includes its qualified name; narrower profiles such as `minimal-local` exclude extension commands.

## Create a command tool

Create a directory containing this `clio-coder-extension.yaml`:

```yaml
id: local-analysis
name: Local Analysis
version: 1.0.0
description: Local analysis capabilities for Clio.
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

Install the directory and start a new Clio session:

```bash
clio-coder extensions install /path/to/local-analysis --user
clio-coder extensions list --all --json
clio-coder
```

The model can call `extension_local-analysis__summarize` with `{"values":[1,2,3]}`. A recipe requests that same qualified name in `tools.required` or `tools.optional`. Python tools use `runtime: python3` and read `json.loads(sys.argv[1])`; Clio launches Python with `-I` to isolate interpreter configuration.

## Command contract

Each tool declares `name`, `description`, `runtime`, `entrypoint`, and `inputSchema`. Supported runtimes are `node` and `python3`. Clio uses its current Node executable and resolves `python3` from the normal tool environment. Entrypoints are ordinary files inside the installed package; symlinks, hard links, absolute paths, and parent traversal are refused. Helper files remain covered by the full package digest.

Clio passes the validated JSON object as one argument and runs a fixed argument vector with no shell. The child runs in the workspace directory. Standard output must contain exactly one JSON value. Use standard error for diagnostics. Nonzero exits, invalid JSON, cancellation, timeout, and exceeded output limits return tool errors with execution metadata and package provenance.

Input is limited to 64 KiB. `timeoutMs` defaults to 120000 and is bounded at 300000. `maxOutputBytes` defaults to 600000 and is bounded at 1048576. Output limits include standard output and standard error together.

Schemas support `type`, `description`, `properties`, `required`, `additionalProperties`, `items`, scalar `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, and `maxItems`. The root must be an object. Each object declares its properties and `additionalProperties: false`; array schemas declare `items`. References and executable schema keywords are refused. Clio validates each invocation against the schema before starting the child.

Qualified names use `extension_<id>__<name>` and must fit 64 characters. Package IDs use provider-safe lowercase letters, numbers, single underscores, and hyphens; local tool names start with a letter and use lowercase letters, numbers, and single underscores. Duplicate and colliding tool registrations are refused.

The manifest keys are `id`, `name`, `version`, `description`, `capabilities`, `compatibility`, and optional `runtime` (described below). A manifest naming `resources`, `prompts`, `skills`, `agents`, `fleets`, or `themes` is invalid, and the diagnostic points at `clio-coder library install <path>`. `capabilities` is optional: a package whose only contribution is a root `hooks.yaml` is a valid harness extension with no command tools.

## Admission and lifecycle

Every model-visible extension command tool is an execution action and runs sequentially. Packages cannot declare themselves read-only. The registry evaluates both the qualified capability call and its fixed executable command through Clio's existing safety policy, autonomy, approval, and middleware rules. Read-only autonomy blocks commands; workers with explicit write confinement cannot execute an unconfined extension command. Installation does not bypass command approval. The child receives Clio's normal allowlisted tool environment, which excludes provider credentials and interpreter injection variables.

Command tools are installed programs with the filesystem and network access of the invoking process. Entry containment and environment filtering do not create an operating-system sandbox. Install code you trust, as you would a local executable script.

The existing extension lifecycle applies:

```bash
clio-coder extensions disable local-analysis --user
clio-coder extensions enable local-analysis --user
clio-coder extensions install /path/to/new-local-analysis --user --force
clio-coder extensions remove local-analysis --user
```

Installation records and verifies the entire package tree. Each invocation rechecks the effective installed package, enabled state, canonical root, and digest. Disabling, removing, replacing, or modifying a package revokes existing tool calls. A disabled project installation also suppresses the user installation with the same ID.

Tool schemas are frozen when a session or worker registry is created. Restart the session after installing, enabling, or updating capabilities; `/extensions reload` refreshes extension snapshots, hooks, and operator runtimes at idle. It does not change a live model's tool schemas. Recipe resources have the independent `/library reload` path. A new native worker constructs its own verified registry, and the ordinary allowed-tool surface and worker attestation apply. External command-line worker runtimes do not gain Clio command tools.

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

Only `.mjs` entrypoints are supported. Ship JavaScript and contained assets;
author TypeScript with your own build if desired. Clio never installs
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
`requestId`, and a read-only snapshot of `workspace`, `sessionId`, `generation`
and `mode`. No conversation body, tool arguments or credentials cross this
API. Results render locally for the operator and never start a model turn or
become a session transcript entry. The required `text` is also the headless
fallback; include the same useful findings and evidence qualifiers there.

`session_open` receives a `startup`, `reload`, or `session-change` reason.
`turn_end` receives `completed`, meaning the foreground turn settled, not that
its scientific or engineering objective passed validation. Observers are
asynchronous observations, distinct from effect-producing `hooks.yaml`.
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

Inside an interactive session, invoke `/ext:lab-status:dashboard` or append a
local JSON filename. Browse `/extensions` and use
`/extensions reload` after a reviewed reinstall or enable. The library
navigation work may expose `/extensions [reload]` as the primary route while
retaining these compatibility routes; both must use the same extension reload
callback. `/library reload` never loads runtime code.

Canonical commands use `/ext:<extension-id>:<command>`. Existing extension IDs
are preserved, including dots and underscores. Local command names start with
a lowercase letter and contain lowercase letters, digits or underscores.
There are no short aliases. Built-ins retain ownership; an existing prompt
with the same canonical spelling remains a prompt and disables that extension
command with a conflict diagnostic. This includes unavailable and display-only
prompts. Completion and dispatch share that collision projection. Avoid `ext:`
when authoring new prompt names. Unknown canonical commands error; escaped
`\/ext:...` remains ordinary model text.

`extensions run` is the explicit headless operator path. It starts only the
selected installed runtime, supplies `sessionId: null`, sends no synthetic
session observation, prints one fallback or JSON result, then disposes the
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
  commands are unavailable. Reload requested during a turn, command, local
  shell operation or modal interaction is queued to an idle boundary.
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
remote cluster queries or submissions. `measurements` is a separate existing
command-tool package that computes count, mean, extrema and sample standard
deviation of supplied finite numbers. Units and provenance stay caller-supplied;
a singleton's sample standard deviation is unavailable (`null`).
