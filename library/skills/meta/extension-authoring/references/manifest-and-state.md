# Manifest, envelope and state

The standalone root has `clio-coder-extension.yaml` with `id`, `version`,
`description`, an optional `name` (defaults to the ID), and `runtime`.
Runtime keys are closed: unknown fields fail validation. A minimal package declaring one command and its card:

```yaml
id: sample
name: Sample
version: 0.1.0
description: Show a local snapshot as a host-rendered card
runtime:
  api: 2
  entrypoint: runtime/extension.ts
  commands:
    - name: show
      description: Show a local snapshot
  ui: [card]
  permissions:
    fs: { read: [], write: [] }
    exec: false
    net: false
  state: { session: true, store: false }
```

```ts
import type { ExtensionApiV2 } from "@iowarp/clio-coder/extensions";
export default function extension(api: ExtensionApiV2): void {
  api.handle("show", async (_args, ctx) => {
    const snapshot = await ctx.state.get("snapshot");
    const text = JSON.stringify(snapshot.value ?? "No snapshot yet");
    return { text, card: { t: "text", text: text.slice(0, 2000) } };
  });
}
```

Entrypoints also accept `.mts`. Relative imports must name real files, including
`.ts` when that is the file on disk. For a separate type check using those
specifiers, enable `allowImportingTsExtensions` with `noEmit`. Runtime code must
not depend on repository-private imports or a bundler's import rewriting.

| Runtime field | Contract | Operator cost to explain |
| --- | --- | --- |
| `commands` | Up to 32 `{name, description, timeoutMs?}`; `/ext:<id>:<name>`. `replaces: prompt` is for a bundle's matching prompt command. | Explicit invocations; describe what each does. |
| `events` | Observation names below, plus at most one `{tick: 5s}` (or integer milliseconds). Register `api.on("tick", ...)`. Tick range 5 s–1 h. | Background work and polling frequency; observations cannot gate calls. |
| `watch` | Up to 8 contained workspace-relative globs; must accompany `fs_changed`, and vice versa. Host batches up to 64 paths after a 500 ms debounce. | Files observed and refresh work; watch Git metadata and use a tick for working-file changes. |
| `hooks` | Up to 16 `{on, tools?, timeoutMs?, onTimeout?, onError?}`; tools filter applies only to before/after tool. | Awaited latency and possible refusal. See the hooks table. |
| `tools` | Up to 32 `{name, description, inputSchema, actionClass?, timeoutMs?}`. Schema must be an object schema; names use single underscores. The public contract names them `extension_<id>__<name>`. Default action class `execute`, timeout 30 s. | Intended model-callable behavior and safety/approval; see the current admission limit below. A `read` declaration cannot accompany exec or workspace writes. |
| `ui` | `status`, `band`, `card`, `toast`, `panel`, `dock`, `interview`; declare each returned slot. | Screen space and interaction. Plain `text` remains the headless fallback. |
| `workspaces` | Up to 4 `{id, title, regions, board?, skin?, keys?}`; regions: `header`, `board`, `islands`, `rail`, `footer`. Board placement `band` or `island` needs the board region. Skin is a contained `.json` path. Up to 12 `{key, action, label}` bindings. | Taking the screen on an explicit command/action; placement, branding and key ownership. |
| `access` | `prompt`, `tool-args`, `tool-results`, `assistant-text`; omitted content is stripped while metadata remains. | Exposure of typed prompts, tool input/output or assistant text. `turn_start` observations carry the typed line only with `prompt`. |
| `permissions` | `fs.read`: `workspace`, `home`, absolute read roots or contained relative workspace roots; `fs.write`: `store` or contained relative workspace roots. Up to 16 each. `exec`/`net` booleans default false. | File visibility, writes, arbitrary child-program authority and network intent. Package/bootstrap files are readable independently. |
| `state` | `{session: boolean, store: boolean}`, both default false; enables the corresponding context API. | Retained session or machine-local extension data. |
| `config` | Up to 24 `{key, type, default, description, options?}`; string/number/boolean. String-only options up to 16; default must match type and options. | Author-selected behavior and its costs. At this head live `ctx.options` uses manifest defaults; the test kit can override them. No settings UI is promised. |

At this head the public API, child registration and test kit support
`api.tool`, but the live operator facade and gateway registry do not connect
`runtime.tools`. Existing command tools come from `capabilities.tools`; that is
a separate contract. Do not promise a live model can discover/call an api 2
runtime tool yet. Exercise its handler with `host.tool` and report the admission
gap; use commands/actions for live operator interaction.

Observation names: `session_open`, `session_close`, `turn_start`, `turn_end`,
`tool_end`, `permission_requested`, `permission_resolved`, `dispatch_started`,
`dispatch_completed`, `dispatch_failed`, `compaction_end`, `budget_alert`,
`safety_blocked`, `fs_changed`, `workspace_enter`, `workspace_leave`, plus the
separately declared tick. Ticks coalesce while the runtime is busy.

The consent digest includes command names, events/tick, watch, hooks, tool
names/action classes, UI, workspace IDs/regions/board/keys, access and permissions.
It does not include entrypoint, descriptions, skin path, state flags or config.
Explain those costs too; do not mistake digest membership for complete review.
The current growth comparison catches new timers but does not compare the
frequency of an existing timer or changes to board placement. Ask the operator
to review such behavior changes explicitly; do not rely on a fresh consent card.

`exec: true` is a boolean, not a Git-only allowlist. An example may use only
`execFile("git", explicitArgv, ...)`, but the granted child-process authority is
broader. The child has Node filesystem permissions; network denial is currently
not enforced by an OS network sandbox. Do not describe this as account isolation.

## State instead of module variables

Immutable definitions and helper functions may live at module scope. Mutable
counters, drafts, session owners and last snapshots belong in the context:

- `ctx.snapshot.workspace` is the project directory; `activeWorkspace` is a UI
  workspace ID or null. `sessionId` can be null before the first turn.
- `ctx.state` is per extension and session, survives process reload, and persists
  when a session is resumed. Before a session ID exists it is held in memory.
  At this head another null-session reload resets it; migration into the first real session preserves
  it only if it has not already been reset. Defer durable ownership claims until
  a session ID exists.
- `ctx.store` is shared across sessions of the same extension ID using the same
  Clio state directory on this machine, not a distributed coordination service.
- Both APIs provide async `get`, `set`, `delete`, `keys`. `get` returns
  `{value, version}`; `set(key, value, {ifVersion})` returns `{ok, version}`.
  On a conflicting write, re-read and retry a bounded number of times.
- Values cross a JSON boundary. Keys are at most 200 characters; each collection
  has at most 256 keys. Session state is bounded to 256 KiB; store to 1 MiB.
  Prune stale records and bound tables rather than treating storage as a database.
- Host deadlines abort the request signal. Check it before committing a result
  after a slow external operation; use it with cancellable I/O.
