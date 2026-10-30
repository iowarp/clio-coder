# Extensions

The [component and middleware architecture](../architecture/middleware-and-components.md) explains discovery and hook boundaries.

An extension is Clio code that changes Clio Coder itself. It runs in its own process, declares everything it may do in a manifest, and needs the operator's review of that declaration before it installs or updates. An extension can observe the session, gate tool calls, serve model-callable tools, keep state, draw into the terminal, take over a workspace of the screen, and run interviews.

A [plugin](plugins.md) is the other package kind. It is an Agent Plugin with a root `plugin.json` and carries content only: skills, agents, prompt templates and playbooks, with Clio's own content under the Clio namespace. A root `mcp.json` can declare stdio servers that launch only after explicit MCP trust; Clio does not execute plugin hooks. Installing a plugin never runs code. A plugin may carry scripts that a skill or playbook runs explicitly, and those stay ordinary files under normal tool safety. Plugins and extensions are separate packages with one manifest, one digest, one state file and one consent each. An extension root never holds a `plugin.json`; the diagnostic tells you to publish the plugin and the extension as two packages.

An extension declares its capabilities in `clio-coder-extension.yaml`, `.yml`, or `.json`. Clio discovers and validates declarations without importing or executing package code.

Source: `src/domains/extensions/`, [harness-extensions.ts](../../src/tools/harness-extensions.ts), [extension-runtime-tools.ts](../../src/tools/extension-runtime-tools.ts), [slash-commands.ts](../../src/session-control/slash-commands.ts), and [extensions.ts](../../src/cli/extensions.ts).

## Package manifest

An extension root contains one manifest, found in the order `clio-coder-extension.yaml`, `clio-coder-extension.yml`, `clio-coder-extension.json`. Any other top-level key is an error.

| Key | Required | Rule |
| --- | --- | --- |
| `id` | yes | 2 to 80 characters: lowercase letters, digits, dots, underscores, and hyphens, starting and ending alphanumeric. A package with tools cannot use dots (the qualified tool name must be provider-safe) or a double underscore. |
| `name` | no | Display name. Defaults to `id`. |
| `version` | yes | Non-empty string. It is not parsed as Semantic Version. |
| `description` | yes | Non-empty string. |
| `compatibility.clio` | no | SemVer range of at most 256 characters, such as `>=0.6.2`, `^0.6.2`, or `0.6.x`. Tags and malformed ranges are rejected. |
| `plugin` | no | The one plugin this extension serves, as a plugin id. See [Pairing with a plugin](#pairing-with-a-plugin). |
| `runtime` | no | The extension's code and everything it may do. `runtime.api: 2` is the current contract; `runtime.api: 1` still loads. |
| `capabilities.tools` | no | 1 to 32 command tool declarations. See [Command tools](#command-tools). |

`capabilities` and `runtime` are optional, so a package whose only contribution is a root `hooks.yaml` is a valid extension with no tools. A manifest naming `resources`, `prompts`, `skills`, `agents`, or `fleets` is invalid, and the diagnostic points at `clio-coder library install <path>` because those belong in a plugin.

Installation refuses a package whose `compatibility.clio` range excludes the running Clio Coder version, naming the extension, its range, and the running version. Clio repeats the check whenever it loads installed extensions, so a package that becomes incompatible after an upgrade stays visible in `extensions list` with its diagnostic and contributes nothing. An incompatible project package does not hide a compatible user package with the same ID. A manifest without `compatibility.clio` is unrestricted.

### Install locations and precedence

| Scope | Root | State file |
| --- | --- | --- |
| user | `<configDir>/extensions/<id>/` | `<configDir>/extensions/state.json` |
| project | `.clio-coder/extensions/<id>/` | `.clio-coder/extensions/state.json` |

In a workspace whose project extensions are approved (see [Workspace trust for project extensions](#workspace-trust-for-project-extensions)), a valid, compatible project package shadows the user package with the same ID, and a disabled project package still suppresses the user package. Directories whose names start with a dot are ignored.

### Workspace trust for project extensions

A project package installs from the repository's own `.clio-coder/extensions/state.json`, so its digest check proves integrity and not consent. Project extensions load only after the operator approves that file for the workspace, which is the `extensions` surface of workspace trust. User-scope packages never depend on it.

Until the surface is approved, every project copy is blocked. It contributes no tools, hooks, runtime or UI, and it neither shadows nor suppresses a user package with the same ID, so the user copy keeps loading even when the blocked project copy is disabled. A blocked copy stays visible. `--json` carries `trustBlocked: true` on every project copy, and an enabled, valid, compatible one reads `untrusted` in `extensions list` and carries the warning `project extensions are not trusted for this workspace and are not loaded; review with clio-coder config trust extensions`. `extensions run` refuses it with `extension <id> has no eligible operator command '<command>'`.

```bash
clio-coder config trust extensions                  # review package identities (read-only)
clio-coder config trust extensions --hash <sha256>  # approve the reviewed package identities
clio-coder config trust extensions --revoke         # withdraw the approval
```

Approval records the reviewed package identities, including package ID, content
digest, source, origin, trust flag and capability envelope. Reinstalling the same
identity, disabling or removing a package preserves consent. A changed identity,
even if only its source changes, or an enabled identity outside the approved set
needs a new review. Legacy records that lack content
pins still use approval of the exact state-file bytes. Loaders also reverify
each installed tree against its recorded digest.

A new approval takes effect at `/extensions reload` or the next start. A revoked
or changed approval withdraws runtime authority when observed. The next tool
call reports that the extension was disabled, removed, replaced or changed.

An operator install through `extensions install` or the Library can add approval
when the workspace has no extension state or its existing state is trusted. Only
records still carrying the content digest that install wrote are approved;
a concurrent replacement stays unapproved. The direct CLI's success notice is:

```text
Project extensions were new or already approved here, so your install keeps them approved. Changes made outside your installs need clio-coder config trust extensions.
```

A share-archive import never approves extensions. A task worktree that Clio
created can inherit its origin's approval when its enabled identities are
covered, or when its state file is byte-identical to the approved origin.
Hand-made worktrees do not inherit that approval. Source:
`src/core/workspace-trust.ts` and `src/cli/extensions.ts`.

## Capability envelope

The `runtime` block of an api 2 manifest is the capability envelope: the part of the declaration the operator consents to. Its canonical form covers commands, takeovers of a plugin's prompts (`takesOver`), kept host state (`state`), events and tick, watched paths, hooks with their timeouts and failure modes, tools with their action class, interface slots, workspaces with their regions and keys, content access, file roots, and whether it may run programs or use the network. Clio hashes that canonical form into the envelope digest. Reordering a list never changes the digest.

The operator reviews the envelope in words before an install and before an update:

- `clio-coder extensions install <path>` prints what the package would be allowed to do, then installs and records the envelope digest it printed.
- The Library review (`/library install extension:<name>`, `/library update extension:<name>`, or the `clio-coder library` CLI) shows the same lines. On an update it first lists what the new envelope reaches beyond the installed copy, such as new commands, new tools, a faster timer, wider file roots, or a gate that may now refuse calls.
- `clio-coder extensions validate <path>` prints the envelope and its digest for a package you are writing.

The install applies only the envelope that was reviewed. If the manifest changes between review and apply, the install refuses with `extension capability envelope differs from the one reviewed; review a fresh plan`. The digest is recorded in the extension's `state.json` entry. Clio checks it again every time it loads the installed package: a manifest whose envelope no longer matches the recorded digest stays visible and inactive with the diagnostic `installed extension capability envelope differs from the one recorded at install`, and an install made before envelopes were recorded reads `has no recorded capability envelope; reinstall to review what it may do`.

Bytes can change freely inside an approved envelope, which is what lets a dev folder reload on every save. A wider envelope asks again. The full package digest still pins every file for installed packages.

## Runtime api 2

An api 2 runtime is a disposable Node child per extension. Clio starts it from a verified private copy of the package, talks to it over a bounded message protocol, and disposes it on reload. Nothing from the host crosses into it as a live object. The runtime never sees the conversation unless the manifest declares `access`, and what it draws is for the operator and never enters the model's context.

API 2 hooks, runtime tools, observations and maintenance ticks run in terminal,
headless `clio-coder run` and ACP hosts. The dispatching process also hosts
extensions for `fleet run` and `run --agent`; native workers send their hooked
tool calls back to that host. Extension runtimes do not start inside workers.
Workspaces, skins and docks require the terminal. Without an interview channel,
an interview cancels immediately with reason `headless`.

```yaml
id: lab-guard
version: 1.0.0
description: Refuse writes to protected paths and show lab status.
compatibility:
  clio: ">=0.6.2"
runtime:
  api: 2
  entrypoint: runtime/extension.ts
  commands:
    - { name: protect, description: Protect a path against write and edit calls. }
  hooks:
    - on: before_tool
      tools: [write, edit]
      timeoutMs: 250
      onTimeout: block
      onError: block
  access: [tool-args]
  state: { session: false, store: true }
  permissions: { fs: { read: [], write: [] }, exec: false, net: false }
```

```typescript
import type { ExtensionApiV2 } from "@iowarp/clio-coder/extensions";

export default function extension(api: ExtensionApiV2): void {
	api.handle("protect", async (args, ctx) => {
		const path = args.trim();
		const current = await ctx.store.get<string[]>("protected");
		const paths = [...new Set([...(current.value ?? []), path])];
		const saved = await ctx.store.set("protected", paths, { ifVersion: current.version });
		return { text: saved.ok ? `Protected ${path}` : "The store changed; retry protect." };
	});
	api.hook("before_tool", async (event, ctx) => {
		const args = event.point === "before_tool" ? event.args : undefined;
		const path = args !== null && typeof args === "object" && "path" in args ? args.path : undefined;
		const { value = [] } = await ctx.store.get<string[]>("protected");
		return typeof path === "string" && value.includes(path)
			? { effects: [{ kind: "block_tool", reason: `${path} is protected` }] }
			: {};
	});
}
```

The entrypoint is a `.mjs`, `.ts` or `.mts` file inside the package. Clio never installs dependencies or runs package lifecycle scripts, so ship every file the extension executes. Author types come from `import type { ... } from '@iowarp/clio-coder/extensions'`; the package export is types only and Clio injects the implementation. Registration in code must match the manifest exactly: a command, hook, tool or event the code registers but the manifest does not declare (or the reverse) fails the runtime at startup.

| `runtime` key | Rule |
| --- | --- |
| `commands` | Up to 32 `{ name, description, timeoutMs }`. Names match `[a-z][a-z0-9_-]*`. The slash form is `/ext:<id>:<name>`. `timeoutMs` defaults to 30 s and is bounded at 300 s. A command with `replaces: prompt` is described under [Pairing](#pairing-with-a-plugin). |
| `events` | Passive observations: `session_open`, `session_close`, `turn_start`, `turn_end`, `tool_end`, `permission_requested`, `permission_resolved`, `dispatch_started`, `dispatch_completed`, `dispatch_failed`, `compaction_end`, `budget_alert`, `safety_blocked`, `fs_changed`, `workspace_enter`, `workspace_leave`, plus one `{ tick: <duration> }` entry. A tick is at least 5 s and at most one hour. |
| `watch` | Up to 8 workspace-relative globs behind `fs_changed`. `watch` and the `fs_changed` event are declared together. |
| `hooks` | Up to 16 awaited gates at `prompt_submit`, `before_tool`, `after_tool`, `turn_start` or `turn_end`. Each declares `timeoutMs` (50 to 2000, default 250), `onTimeout` and `onError` as `pass` or `block`, and optionally the `tools` it matches at the two tool points. |
| `tools` | Up to 32 runtime tools `{ name, description, inputSchema, actionClass, timeoutMs }`. The model reaches one as `extension_<id>__<name>` through the gateway. `actionClass` is `execute` (default) or `read`, and `read` is refused in a package that may run programs or write beyond its store. |
| `ui` | Slots the extension may fill: `status`, `band`, `card`, `toast`, `panel`, `dock`, `interview`. |
| `workspaces` | Up to 4 workspaces: `{ id, title, regions, board, skin, keys }`. See [Workspaces and skins](#workspaces-and-skins). |
| `access` | Content that crosses the boundary: `prompt`, `tool-args`, `tool-results`, `assistant-text`. Without a class, the matching event field is absent. |
| `services` | `{ embedding: true }` asks for the host embedding service. The envelope review shows it as `may request embeddings from the configured model`. |

### Embeddings

An approved extension that declares `runtime.services.embedding: true` gets `ctx.embed({ inputs, task, expectedProfileIdentity? })` on its handler context. The host embeds through the semantic index's configured embedding profile (`context.semantic`), in the foreground with a 25 s timeout, and returns the vectors with the profile they came from; the extension never sees the model's URL or credentials. A request whose `expectedProfileIdentity` differs from the live profile is rejected with `Embedding profile changed; re-embed saved vectors before comparing them`, so vectors from two profiles are never compared. Without the declaration, or before it is approved, `ctx.embed` is absent. See [Semantic Context](semantic-context.md) for the profile.
| `permissions` | `fs.read` (`workspace`, `home`, or a path), `fs.write` (`store` or a workspace-relative directory), `exec`, `net`. All default to none. A write root cannot name the workspace root or anything under `.clio-coder/`. |
| `state` | `session` and `store`, each default false. `ctx.state` survives a reload and a restart that resumes the session (256 KiB, 256 keys). `ctx.store` is kept per extension across sessions on this machine (1 MiB, 256 keys). Both are versioned key-value tables, and `set` takes `ifVersion` for a compare-and-set. |
| `config` | Up to 24 typed fields `{ key, type, default, description, options }`, delivered as `ctx.options` with defaults filled in. |

A hook handler returns `effects` (and optionally UI), never a decision it can force past the safety policy. The effects are `block_tool`, `annotate_tool_result`, `inject_reminder`, `require_tool`, `lock_tools`, `notify_operator`, `protect_path`, `request_continuation`, `rewrite_tool_input` and, at `prompt_submit`, `rewrite_prompt` and `block_prompt`. An effect returned at a point that cannot apply it is refused at load. A rewritten tool input is validated against the tool's schema and classified again, so a hook can narrow or redirect a call and never widen its authority. A hook that misses its deadline or throws follows its declared `onTimeout` or `onError`, and a hook that misses three deadlines in a row is disabled for the rest of the generation. Declare `block` only for a real gate.

### Tool hooks on dispatched workers

Session `before_tool` and `after_tool` hooks follow native worker dispatches from
the TUI, ACP, `fleet run` and `run --agent`. A missing hook answer uses the
stricter of the hook's error and timeout policies. A blocking tool hook refuses
CLI runtimes and ACP delegation because those transports cannot carry the hook.
`fleet run` checks every step's route before running any step.

Hook tool selectors can match an MCP family with a trailing `*`, for example
`mcp_slurm__*`. With `tool-args` access, file landings include the resolved path
after symlink resolution, and dispatch landings include the workers to start.
A read-only recipe's workers have no write roots in those landings.

A worker carrying these hooks needs WorkerSpec version 9. A hook-free spec uses
version 8. An older node that rejects the spec version is classified as build
skew and can fail over. Source: `src/worker/spec-contract.ts` and
`src/domains/dispatch/extension.ts`.

`clio-coder context wiki` and `context init` also host their own extensions.
When that host cannot start and a blocking hook applies, dispatch is refused;
`context init` can fall back to its heuristic generator. Source:
`src/cli/wiki-generate.ts` and `src/cli/bootstrap-generate.ts`.

### Tools, commands and actions

A command receives the unexpanded argument string and a context with `snapshot`, `signal`, `requestId`, `options`, `state` and `store`. The snapshot carries `workspace`, `sessionId`, `generation`, `mode`, the active workspace of this extension, and `plugin` (see below). A command and an action may open a panel, take the screen, start an interview and fill or submit the prompt. A background handler (an observation or a hook) may only update ambient UI. Results render locally for the operator and never become a session transcript entry. The required `text` is the headless fallback.

Runtime tools are served by the live runtime: registering one never runs package code, and a call with no running runtime fails instead of starting one. They sit behind the gateway, so the provider's tool schema set is the same before and after a reload. A tool that returns an `interview` parks until the operator finishes or cancels it, and the answers become the tool result.

### Interface

UI is bounded data. The host draws everything and maps tones to theme roles. An extension supplies no color, control sequence or component. A view is a tree of `box`, `text`, `markdown`, `kv`, `table`, `list`, `steps`, `board`, `tree`, `progress`, `spark`, `badge`, `actions`, `art`, `divider` and `spacer` nodes, at most 6 levels deep and 400 nodes. A view outside those bounds is dropped whole. `status` is one line of 160 characters with an optional tone, `band` is at most 3 rows above the prompt, `card` at most 24 rows, and `toast` 200 characters. `dock` is a side dock, and a `panel` holds the overlay. The footer shows each owner's status with host-assigned labels, and core activity and permission cues keep ownership. The permission prompt cannot be redrawn. `clio-coder extensions view --watch <frame-file> [--dock-taps <tap-file>]` previews a frame while you author.

### Workspaces and skins

A workspace is a named layout an extension takes over while the operator is in it. It declares which regions it draws (`header`, `board`, `islands`, `rail`, `footer`), whether the board is a `band` or an `island`, leader keys `{ key, action, label }` (a single character each, at most 12), and an optional `skin`. Islands are up to 4 framed cards of at most 48 columns and 10 rows. A handler enters or leaves a workspace through `workspace: { enter: <id> }` or `{ leave: true }`, and `workspace_enter` and `workspace_leave` events report the change. Regions and islands draw only while the workspace is active.

A skin is a JSON file inside the package, validated at discovery. It overrides palette colors by name with a value for a dark and a light terminal background, sets a brand glyph, and labels the package's own agents on its islands. The host refuses overrides of the error, warning, approval and composer colors and any value below a 4.5 contrast ratio against its background. Skins and region takeover are terminal-only.

### Interviews

An interview is a multi-step form the host draws, started from a command, an action or a tool result. A step has up to 4 questions of kind `single`, `multi` or `text`, with up to 12 options each. The operator's answers return to the registered `api.interview(id, handler)` handler, which returns the next step or `{ done: true, ... }` with the final output. With no operator to answer, the interview cancels with reason `headless`. An `initial` value is a draft the operator still has to submit.

## Confinement

Node permission flags built from the manifest (`--permission`, `--allow-fs-read`, `--allow-fs-write`, and `--allow-child-process` only when `exec` is declared) limit the child to its private package copy, its store and the roots it declared. Those flags are a seat belt against mistakes, not a boundary against hostile code: a package that may run programs can do anything those programs can.

When the platform has an OS sandbox, Clio also wraps the runtime child in it: bubblewrap on Linux, Seatbelt on macOS (the macOS profile is unverified). Inside it the child is read-only outside its declared write roots, secrets are masked, Clio-managed paths (`.clio-coder/`, the config directory, workspace trust and `.git`) are read-only even under a wider write root, new Unix-domain sockets are refused unless the operator's `safety.sandboxUnixSockets` is `allow` (a reachable socket of a terminal multiplexer, X11 or a daemon runs commands outside the sandbox), and the network is blocked unless the package declares `net: true`. Without a backend, such as Windows or a Linux host with no working `bwrap`, the child runs under the Node flags alone and a declared `net: false` is not enforced.

`/extensions` shows a **Confinement** line for each api 2 extension that says which of those applies, for example `bwrap OS sandbox; network blocked (enforced); secrets masked and Clio-managed paths read-only`, or `no OS sandbox (<reason>); Node flags only, so the declared network ban is not enforced`. The line is the honest state of the running child.

## Pairing with a plugin

A plugin carries content and an extension carries code, so a package that needs both ships two packages. An extension may name the one plugin it serves with top-level `plugin: <name>`. That link alone makes `replaces: prompt` legal: a command declared with `replaces: prompt` answers `/<plugin>:<name>` in place of the plugin's prompt of that name. Without `plugin:`, `replaces: prompt` is a manifest error.

The takeover applies only while that plugin is installed and enabled. The plugin's prompts keep a working fallback, so the plugin still works when its extension is absent, disabled or muted, and a plugin without its extension starts no runtime. The takeover is part of the capability envelope as `takesOver` and the consent card lists each prompt name it takes over. The runtime tells the extension which plugin is in effect through `snapshot.plugin` (`{ id, prompts }`, or `null`), where `prompts` are the plugin's names in `<plugin>:<name>` form.

The Library installs the pair as two entries: `clio-coder library install plugin:materio` and `clio-coder library install extension:materio`. Each has its own review, digest and state.

## Command tools

An extension may also declare model-callable command tools in `capabilities.tools`: a fixed executable run once per call, with no resident process. Command tools suit a stateless script. Use a runtime tool when the extension keeps state or needs the host.

```yaml
id: local-analysis
name: Local Analysis
version: 1.0.0
description: Local analysis capabilities for Clio Coder.
compatibility:
  clio: ">=0.6.2"
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

Command tools sit behind the gateway. The model finds and calls this one with `gateway(op="call", capability="extension_local-analysis__summarize", args={values:[1,2,3]})`, after `gateway(op="find")` or `gateway(op="describe")` if needed. An agent definition requests the same qualified name in `tools.required` or `tools.optional`, and native workers can use a tool when their admitted agent includes its qualified name; narrower profiles such as `minimal-local` exclude extension tools. Python tools use `runtime: python3` and read `json.loads(sys.argv[1])`.

Each tool declares `name`, `description`, `runtime`, `entrypoint`, and `inputSchema`, and may declare `timeoutMs` and `maxOutputBytes`. Supported runtimes are `node` and `python3`. Clio Coder runs `node -- <entrypoint> <json>` with its current Node executable, and `python3 -I <entrypoint> <json>`, where `-I` isolates interpreter configuration. Entrypoints are ordinary files inside the installed package; symlinks (in the entrypoint or any parent), hard links, absolute paths, and parent traversal are refused. Helper files remain covered by the full package digest.

Clio passes the validated JSON object as one argument and runs a fixed argument vector with no shell. The child runs in the workspace directory. Standard output must contain exactly one JSON value. Use standard error for diagnostics. Nonzero exits, invalid JSON, cancellation, timeout, and exceeded output limits return tool errors with execution metadata and package provenance. Input is limited to 64 KiB. `timeoutMs` defaults to 120000 and is bounded at 300000. `maxOutputBytes` defaults to 600000 and is bounded at 1048576, counting standard output and standard error together.

Schemas support `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`), `description`, `properties`, `required`, `additionalProperties`, `items`, scalar `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, and `maxItems`, nested at most 12 levels. The root must be an object. Each object declares its properties and `additionalProperties: false`; array schemas declare `items`; `required` names declared properties. References and executable schema keywords are refused. Clio validates each invocation against the schema before starting the child. Local tool names start with a lowercase letter and use lowercase letters, digits, and single underscores. The qualified name is `extension_<id>__<name>` and must fit 64 characters. Duplicate and colliding tool registrations are refused.

Command tools have no OS sandbox. They run with the invoking process's filesystem and network access under Clio's allowlisted tool environment, which excludes provider credentials and interpreter injection variables. Prefer a runtime tool when confinement matters.

## Trust and gates

| Surface | Gate |
| --- | --- |
| Command tool | Every model-visible command tool is an execution action and runs sequentially. Packages cannot declare themselves read-only. The registry evaluates both the qualified capability call and its fixed executable command through Clio Coder's safety policy, autonomy, approval, and middleware rules. A read-only dispatch restriction blocks commands, and workers with explicit write confinement cannot execute an unconfined extension command. |
| Runtime tool | A tool declared `execute` goes through the same approval and autonomy rules as any execution action. A tool declared `read` skips that approval, which is why `read` is refused in a package that may run programs or write beyond its store, and why narrowing `execute` to `read` is listed as growth on update. |
| Runtime | Runs in a disposable Node child under the Node permission flags and, when one exists, the OS sandbox. It starts in an interactive session, a headless `clio-coder run`, an ACP session, `clio-coder fleet run`, `clio-coder run --agent`, or through `extensions run`, and never inside a native worker. Workspaces, skins and docks stay terminal-only. |
| Hook | A hook can request blocking or rewriting within what the safety policy allows, and cannot grant what the policy denies. Declarative hooks in `hooks.yaml` and runtime hooks both run behind the middleware. |
| Installation | A package is admitted only when its tree matches the digest recorded in `state.json` and, for api 2, its envelope matches the recorded envelope digest. A project package is admitted only while the operator has also approved the project's `.clio-coder/extensions/state.json` for the workspace, because the digest proves integrity and not consent. A user package needs no workspace approval. |

Installation does not bypass command approval. At autonomy `default` the model cannot administer extensions: model writes under `.clio-coder/extensions/` or `<configDir>/extensions/` are refused, and a model shell call that runs `clio-coder extensions install`, `update`, `remove`, `enable`, `disable`, or `pin` is blocked. At the operator's `yolo` only the yolo floor holds, so those commands run and project writes are admitted, while writes under Clio Coder's own config directory stay refused (`clio-owned-state`). A model shell call that runs `clio-coder config trust` is blocked at every autonomy level (reason `trust-authority`), so the model can never approve project extensions.

Package code asks the operator first. A model shell call that runs `clio-coder share import` (a dry run only plans and does not ask), `clio-coder extensions test` (which runs the package's `*.test.ts` files) or `clio-coder extensions validate` (whose registration check starts the entrypoint) is held for the operator's approval at `default`, the way `library install` is, because each one installs or runs code from a package the model may have written; at `yolo` it runs without asking. `extensions install` stays blocked at `default`. Discovery, `extensions list`, `extensions discover` and the install itself never execute package code.

## Install state and integrity

Installation records the SHA-256 digest of the entire package tree in `extensions/state.json` beside the installed packages. The digest frames every entry in sorted relative-path order by kind (file, directory, or link), path, and bytes, so file names, empty directories, symlink targets, and contents are all bound. Symlinks must resolve inside the package, and hard-linked files, special files, and a symlinked package root are refused. Plugins use the same digest function.

Each tool call rechecks the effective installed package, enabled state, canonical root, and digest. Disabling, removing, replacing, or modifying a package revokes existing tool calls. An install record without a digest, a drifted tree, a missing record, a mismatched envelope digest, and a corrupt state file all fail closed: the package stays visible and inactive, and its diagnostic says to reinstall. Listing extensions, booting Clio Coder, inspection, and plain doctor runs never rewrite install state.

If extension state is corrupt or absent, a normal reinstall refuses it. `extensions install <valid-source> --force` backs up corrupt state, preserves the previous package bytes in a hidden backup directory beside the package, then installs and records the verified replacement. With valid state, a forced replacement discards the previous tree without a backup. `extensions remove <id>` can also remove an unverifiable package from the load path while preserving its bytes and any corrupt state in the paths the command prints. These recovery backups are not treated as installed packages.

Every Library lifecycle (install, update, enable, disable, remove, import) leaves a bounded receipt with the operation, package, digests, scope, source and actor, and extension activity reaches the session and trace store. `/extensions`, `/library`, `clio-coder trace tail` and evidence bundles show them; see [observability](../architecture/observability.md).

## Hook declarations

A package root may contain `hooks.yaml`, either a list of declarations or a map with a `hooks` list. Clio Coder captures the file's bytes during install-digest verification and parses the captured bytes, so a file rewritten after verification is never reopened. Hooks are best-effort: a malformed declaration is rejected with a diagnostic and never aborts a turn. These declarative hooks need no process. A runtime hook (above) is the choice when the decision needs code or state.

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

A hook whose event cannot apply the effect it produces is refused at load with an issue naming the events that can. Extension hooks have the lowest precedence of four origins (extension, user, project, project.local), and a later origin overrides an earlier one with the same `id`. Native workers never receive declarative hooks. Api 2 tool hooks run in headless runs, ACP sessions, dispatched workers, `clio-coder fleet run` and `clio-coder run --agent`: a native worker holds each tool call a runtime hook matches, and the process that dispatched it runs the hook and answers. Every execution emits a receipt carrying the package provenance, declarations digest, and generation; `clio-coder config inspect` reads them. Hook events, effects, and budgets are in the [middleware architecture](../architecture/middleware-and-components.md).

A worker that cannot hold a call is refused rather than run past a blocking hook, one with `onError: block` or `onTimeout: block`. A CLI runtime such as `claude-code` or `codex-cli` runs its own tools under its own names, and an ACP delegation runs the external agent's own tool loop, so any blocking hook refuses either dispatch whatever tools the hook names. A plan preview and the failover candidates of a route refuse every such worker the same way, and `clio-coder fleet run` checks each step's route in preflight, so a playbook with one refused step is refused before any step runs. A claude-sdk worker is refused only when a blocking hook matches one of its tools. Any other hook such a worker would run without gets one notice (on stderr in a headless command) naming the extension and the unhooked runtime. A worker carries at most 64 tool hooks, blocking ones first. Hooks past that cap never run for worker calls, so a dispatch is refused when a blocking hook past the cap matches the worker's tools. A spec that carries hooks is worker spec version 9, so a fleet node serving a hooked dispatch needs a build that reads version 9; a node one release behind still serves dispatches without hooks.

`clio-coder fleet run`, `clio-coder run --agent`, `clio-coder context wiki` and `clio-coder context init` start their own extension host to run these hooks. When that host fails to start and a blocking tool hook applies, the command refuses before it dispatches any worker, naming the extension, and `context init` falls back to its heuristic bootstrap. Inside a session, bootstrap generation dispatches through the session, whose extension host runs the hooks.

A desk or extension that seals interview results with a key file cannot hide that key from the main agent. The main agent's shell runs as the same user and can read any file the extension can: at `yolo` it runs unsandboxed, and the main-session sandbox at `default` keeps the filesystem readable and masks only known credential paths. Treat the seal as tamper evidence against workers, not against the main agent.

## Extension CLI

```bash
clio-coder extensions init <id> [--template status|hook|panel|tool|workspace] [--dir <path>]
clio-coder extensions validate <path> [--json]
clio-coder extensions test <path>
clio-coder extensions view --watch <frame-file> [--dock-taps <tap-file>]
clio-coder extensions list [--all] [--json] [--user|--project]
clio-coder extensions discover <path> [--json]
clio-coder extensions run <id> <command> [--json] -- [arguments]
clio-coder extensions install <path> [--user|--project] [--force] [--json]
clio-coder extensions enable <id> [--user|--project] [--json]
clio-coder extensions disable <id> [--user|--project] [--json]
clio-coder extensions remove <id> [--user|--project] [--json]
```

`clio-coder ext` is an alias. `install` defaults to user scope. `enable`, `disable`, and `remove` act on the project copy when one exists and otherwise on the user copy; `--user` or `--project` selects exactly that copy. `list` hides shadowed entries unless `--all` is given, while disabled, untrusted, invalid, and incompatible packages stay visible. The state column reads `eligible`, `inactive`, `disabled`, `untrusted`, `shadowed:<scope>`, `incompatible`, or `invalid`. `untrusted` marks an enabled, valid, compatible project copy in a workspace whose project extensions are not approved. An operator `install --project` into new or already trusted project state can approve the identities it writes; see [Workspace trust for project extensions](#workspace-trust-for-project-extensions). `install` refuses an existing ID without `--force` and enables the installed package. `discover` inspects a path or a directory of packages without installing and exits 1 when any candidate is invalid. A bare `clio-coder extensions` or a usage error exits 2, and error diagnostics exit 1. Updating an installed extension from the Library is `clio-coder library update extension:<name>`, which reviews the envelope growth first.

Inside a session, `/extensions` opens the extension reference with each package's state, generation, failures, commands, current status and confinement. `/extensions reload` rebuilds the installed set (see below). `/extensions dev [folder]` loads a folder under development, `/extensions mute <id>` silences an extension for this session, and `/extensions unmute <id>` restores it. Dev and mute are terminal-only.

## Authoring

`clio-coder extensions init <id>` scaffolds a package from a template (`status`, `hook`, `panel`, `tool` or `workspace`), each with a manifest, a TypeScript entrypoint and a test. `clio-coder extensions validate <path>` checks the manifest, prints the envelope and its digest, and runs a registration check that starts the entrypoint in a private copy to confirm the code registers exactly what the manifest declares, without activating it or calling a handler. `clio-coder extensions test <path>` runs the package's `**/*.test.ts` files with `node --test`. Tests import a host from `@iowarp/clio-coder/extensions/testing`:

```typescript
import { createExtensionTestHost } from "@iowarp/clio-coder/extensions/testing";

const host = await createExtensionTestHost(packageRoot);
const result = await host.command("protect", "paper/draft.md");
const gated = await host.hook({ point: "before_tool", tool: "write", turnId: null, args: { path: "paper/draft.md" } });
await host.tick();          // fire the declared tick
await host.advance(10000);  // move the fake clock
await host.dispose();
```

The test host drives the same registration code the runtime uses with an in-memory state and store, so a handler is tested by calling it.

Clio can write an extension with the operator. A folder under `.clio-coder/dev/extensions/<id>/` is a dev extension for the terminal session. Each save is debounced, copied to a private directory, and loaded at the next idle boundary, so a save made during a turn takes effect when the turn ends. A package loads only after the operator approves its capability envelope for the session; a save whose envelope is the same or smaller reloads without asking, and a wider one waits for approval again. A save that does not build keeps the previous valid copy loaded and names the failure. Nothing about a dev extension is persisted, and one session at a time develops a folder. Promote a finished package with `clio-coder extensions install <path>` or publish it to the Library.

## Generations and reload

A running session does not read installed packages on every load. While domains start, the extensions domain publishes nothing: readers use an ephemeral generation-0 projection. The composition root then asks the extensions domain to build an immutable candidate for the session's working directory and builds the matching user-hook registration table from it. After validating that both candidates are still current, it publishes the snapshot and hooks with two adjacent reference assignments. That paired boot snapshot is generation 1. It contains package identity and provenance, the tool declarations of each loadable package, and the parsed `hooks.yaml` declarations. Every consumer in the process reads the committed generation, so consecutive loads within one turn agree on the package set.

`/extensions reload` is the only in-session way to publish a later generation. It rebuilds the snapshot from disk, re-verifies every installed tree and envelope digest against `state.json`, rereads the workspace approval of project extensions, builds the user-hook registrations for the candidate, validates both candidates, and then performs the same two adjacent assignment-only publications. No callback, event, log, or refusal sits between them; conflict diagnostics and the plugin resource reload run only after both references are live. Hook evaluation and every later reader therefore see the previous hooks or the new ones, never an intermediate pairing.

The command reports the new generation, which packages were added (`+`), removed (`-`), or modified (`~`), and how many hooks were registered, dropped, overridden, or rejected. A tree that no longer verifies is listed as inactive and contributes nothing until it is reinstalled. A build failure or stale candidate publishes neither side, reports the reason (`build-failed`, `reentrant`, `stale`, or `workspace-changed`), and keeps the previous generation. Reload requested during a turn, a command, a local shell operation, or a modal interaction is queued to an idle boundary.

Reloading an unchanged tree still publishes a new generation with the same content digest; content identity is the digest, not the generation number. Installs, enables, disables, and removes performed by `clio-coder extensions` in another process are invisible to a running session until the operator reloads or restarts. There is no filesystem watcher, so a CLI mutation never becomes an implicit mid-turn hook change.

Model-visible command-tool schemas are frozen when a session registry is created. A reload never changes a live model's tool surface, and adding, modifying, or removing a command tool requires restarting Clio Coder. Runtime tools sit behind the gateway and follow the live runtime. A new native worker builds its own verified registry, and external command-line worker runtimes do not gain Clio Coder tools. Plugin resources have their own generation and their own `/library reload`.

## Running and managing runtimes

```bash
# From the source checkout, or use the examples directory in the installed package:
clio-coder extensions install examples/extensions/lab-status --project
clio-coder extensions list --all --json
clio-coder extensions run lab-status dashboard
clio-coder extensions run lab-status dashboard --json -- /path/to/local-record.json
```

An operator `install --project` can approve the identities it wrote into new or
already trusted project state. Disabling or removing an approved identity
preserves consent. See [project extension trust](#workspace-trust-for-project-extensions).

Inside an interactive session, invoke `/ext:lab-status:dashboard` or append a local JSON filename. Browse `/extensions` and use `/extensions reload` after a reviewed reinstall or enable. `/library reload` refreshes plugin resources independently and never loads runtime code.

Canonical commands use `/ext:<extension-id>:<command>`. Existing extension IDs are preserved, including dots and underscores. Local command names start with a lowercase letter and contain lowercase letters, digits, underscores or hyphens (api 1 allows only underscores). There are no short aliases. Built-ins retain ownership; an existing prompt with the same canonical spelling remains a prompt and disables that extension command with a conflict diagnostic. This includes unavailable and display-only prompts. Completion and dispatch share that collision projection. Avoid `ext:` when authoring new prompt names. Unknown canonical commands error; escaped `\/ext:...` remains ordinary model text. The one exception is a paired extension's `replaces: prompt` command, which also answers `/<plugin>:<name>`.

`extensions run` is the headless operator path for invoking one extension command.
It accepts only `--json` and the `--` argument separator, so `--user`, `--project`,
`--force` and `--all` exit 2. It starts only the selected installed runtime,
supplies `sessionId: null`, sends no synthetic session observation, prints one
fallback or JSON result (`extensionId`, `command`, `generation`, `provenance`,
`output`), then disposes the runtime. SIGINT and SIGTERM cancel it. A CLI invocation
does not reload another running session. Ordinary `clio-coder run` and ACP host
their own runtimes. Native workers use admitted tools and send hooked calls to
the dispatching host; a slash token does not invoke an extension command there.

Installation eligibility, extension snapshot and hook generation, runtime readiness and model tool schemas are separate facts:

- Listing says `eligible`, not that another process has activated the package. The live extension reference reports runtime state, generation, failures, available commands, current status and confinement. Tool evidence is taken from the actual session registry when that host provides it.
- Idle reload restarts every child using verified copies. During reload, commands are unavailable.
- The snapshot and hook pair still commits together. Runtime staging happens first, then that pair commits, then the runtime generation publishes and children acknowledge activation. Startup and handler failures are reported as degraded runtime state. A rejected reload leaves no replacement runtimes active; old children are already stopped and require a retry. This does not promise atomic rollback of arbitrary code or preserve module globals across reloads.
- Each command rechecks installed scope, enabled state, canonical root and whole-tree digest before and after execution. A slow host tick also observes revocation while idle, at a 30-second minimum interval that lengthens on slower filesystems. Once observed, old requests and UI lose authority and the child is disposed. Disable and remove are scoped; a disabled project copy suppresses a user copy, while project removal may reveal it on reload. Installation, enable and update need an explicit reload to start newly eligible code.
- Command tool schemas stay frozen. **Editing only UI in a mixed command-tool and runtime package changes the full package digest and revokes that session's old command-tool calls.** Start a new session, or keep rapidly developed UI in a runtime-only package.

At most 8 runtimes run concurrently across api 1 and api 2 (api 1 keeps its own cap of 4 and claims first); further eligible packages show a limit diagnostic. An api 2 runtime has at most 32 commands, 16 hooks, 32 tools and 8 concurrent requests. Startup and activation each have a 5-second deadline, observations 2 seconds, and a hook its declared 50 to 2000 ms. Arguments are limited to 16 KiB, a result to 256 KiB, a protocol message to 320 KiB, and the channel to 256 messages per second. stdout and stderr are discarded as non-protocol diagnostic streams, and their combined 64 KiB lifetime cap fails the runtime. Failures are bounded diagnostics, not arbitrary terminal output.

Cancellation fences the result immediately, signals the handler, allows 250 ms of best-effort disposal, then kills the child. Timeouts and protocol failures kill it directly. Linux and macOS process groups also stop ordinary descendants; Windows has direct-child termination only. A detached daemon, external job, already-written file, or an unresponsive child after an ungraceful parent death cannot be reclaimed by this lifecycle contract.

## Runtime api 1

`runtime.api: 1` packages still load. An api 1 runtime registers commands and two observations (`session_open`, `turn_end`), and returns a status line (160 characters, tone `neutral`, `positive`, `warning` or `error`) and a panel of plain text, labeled metrics and tables. It declares `commands`, `events` and `ui` in the manifest, ships a `.mjs` entrypoint, receives a read-only snapshot, has no tool, hook, state or workspace surface, and has no capability envelope or OS sandbox: it runs under your user account's authority. Prefer api 2 for new work. The [lab-status example](../../examples/extensions/README.md) is an api 1 runtime and `git-pulse` and `peer-guard` are api 2.

## Scientific examples

[The worked examples](../../examples/extensions/README.md) are included in the npm package. `lab-status` reads a bounded local JSON experiment record and uses an explicitly synthetic fixture by default. It performs no SSH, provider calls, remote cluster queries or submissions. `measurements` is a separate command-tool package that computes count, mean, extrema and sample standard deviation of supplied finite numbers. Units and provenance stay caller-supplied; a singleton's sample standard deviation is unavailable (`null`).
