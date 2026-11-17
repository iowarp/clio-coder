# Manifest, envelope and state

The standalone root has `clio-coder-extension.yaml` with `id`, `version`,
`description`, an optional `name` (defaults to the ID), and `runtime`.
Manifest keys are closed: unknown fields fail validation unless the manifest
lists them under `ignorable` (below). A minimal package declaring one command and its card:

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
| `tools` | Up to 32 `{name, description, inputSchema, actionClass?, readOnly?, idempotent?, timeoutMs?}`. Schema must be an object schema; names use single underscores. The model calls `extension_<id>__<name>` through the gateway. Default action class `execute`, timeout 30 s. `readOnly` defaults to true for `read` and cannot be true for `write`; `idempotent` defaults false. | Intended model-callable behavior and safety/approval. A `read` declaration cannot accompany exec or workspace writes. `readOnly`/`idempotent` change loop-guard counting and observation aging (see below). |
| `promote` | Up to 4 declared tool names whose schemas every request carries; each tool's description plus schema at most 2048 bytes. At most 8 attach per session, by package id order. | Token cost on every request. Required before a hook can `require_tool` its own tool. Adding one asks for consent again. |
| `ui` | `status`, `band`, `card`, `toast`, `panel`, `dock`, `interview`; declare each returned slot. | Screen space and interaction. Plain `text` remains the headless fallback. |
| `workspaces` | Up to 4 `{id, title, regions, board?, skin?, keys?}`; regions: `header`, `board`, `islands`, `rail`, `footer`. Board placement `band` or `island` needs the board region. Skin is a contained `.json` path. Up to 12 `{key, action, label}` bindings. | Taking the screen on an explicit command/action; placement, branding and key ownership. |
| `access` | `prompt`, `tool-args`, `tool-results`, `assistant-text`; omitted content is stripped while metadata remains. | Exposure of typed prompts, tool input/output or assistant text. `turn_start` observations carry the typed line only with `prompt`. |
| `permissions` | `fs.read`: `workspace`, `home`, absolute read roots or contained relative workspace roots; `fs.write`: `store` or contained relative workspace roots. Up to 16 each. `exec`/`net` booleans default false. | File visibility, writes, arbitrary child-program authority and network intent. Package/bootstrap files are readable independently. |
| `state` | `{session: boolean, store: boolean}`, both default false; enables the corresponding context API. | Retained session or machine-local extension data. |
| `config` | Up to 24 `{key, type, default, description, options?}`; string/number/boolean. String-only options up to 16; default must match type and options. | Author-selected behavior and its costs. At this head live `ctx.options` uses manifest defaults; the test kit can override them. No settings UI is promised. |

A live runtime serves its `runtime.tools`: the model finds and calls one
through the gateway, or directly when `promote` lists it, and a call with no
running runtime fails instead of starting one. Command tools from
`capabilities.tools` are a separate contract. Exercise handlers with
`host.tool`.

Loop guard: only a tool declared `readOnly` or `idempotent` counts toward
identical-call repeats, and a successful call of a tool not declared read-only
resets every other call's identical count, so read, write, read of one record
is admitted. The same declaration gates observation aging: on a small-tier or
uncached route an earlier result is stubbed once a later identical call
replaced it only for a `readOnly` or `idempotent` tool, so declare
`readOnly: true` on tools that only read and leave step tools unannotated.

A tool result may add `summary` (non-empty, at most 2048 bytes). The model then
sees the summary and a `detail_ref`; the full `text` and `data` are stored for
the session and `ledger(action="detail", ref=...)` pages through them. Without a
saved session the model gets the full result. Promoted tools never reach
workers.

Observation names: `session_open`, `session_close`, `turn_start`, `turn_end`,
`tool_end`, `permission_requested`, `permission_resolved`, `dispatch_started`,
`dispatch_completed`, `dispatch_failed`, `compaction_end`, `budget_alert`,
`safety_blocked`, `fs_changed`, `workspace_enter`, `workspace_leave`, plus the
separately declared tick. Ticks coalesce while the runtime is busy.
`compaction_end` carries `outcome` (`ok|failed|unknown`) and `trigger`
(`auto|force|overflow|step|unknown`); `step` is the checkpoint a
`turnPolicy: step` turn starts from on a small or uncached route, so a handler
that rebuilds state after compaction can branch on it.

A prompt template's `turnPolicy: {mode: step, stepTool: <tool>}` ends each turn
after one step of its step tool. Add `when` to apply it only on some routes,
for example `when: [small, uncached]`. Tokens are the model tiers `small`,
`standard` and `frontier`, plus `uncached` for a route that does not cache
prompts. The route is judged at each turn the template starts; on a route no
token matches, the turn runs with no step policy at all, so a cached frontier
route can chain steps in one turn. An empty, repeated or unknown token makes
the template unavailable.

The consent digest includes command names, prompt takeovers, state flags when
either is set, the embedding service, events/tick, watch, hooks, tool
names/action classes, promoted tools, UI, workspace IDs/regions/board/keys,
access and permissions. It does not include entrypoint, descriptions, skin
path, `readOnly`/`idempotent` or config.
Explain those costs too; do not mistake digest membership for complete review.
The current growth comparison catches new timers but does not compare the
frequency of an existing timer or changes to board placement. Ask the operator
to review such behavior changes explicitly; do not rely on a fresh consent card.

## Ignorable fields

A top-level `ignorable` lists field paths a host that does not know them may
skip: dotted from the manifest root, list elements unindexed
(`runtime.tools.readOnly` covers every tool), unique, at most 32. A host skips
an unknown key only when its path is listed, and warns once per path naming
the extension (`extensions validate`, `discover`, `install` and `list` print
it); an unlisted unknown key still fails. A known key is parsed and enforced
whether or not it is listed. Skipped keys and the list itself stay out of the
consent digest, so adding `ignorable` never asks the operator again.

List only keys whose absence leaves the package safe and correct, such as a
hint. WTF-P lists its loop-guard hint and keeps promotion strict, because its
step gate needs the promoted tool:

```yaml
compatibility: { clio: ">=0.8.4-0" }
ignorable:
  - runtime.tools.readOnly
runtime:
  api: 2
  tools:
    - { name: status, actionClass: execute, readOnly: true }
    # description, inputSchema and the other tools elided
  promote: [next_step]
```

Hosts before 0.8.4 do not know `ignorable` itself and refuse it as an unknown
manifest key, so keep `compatibility.clio` at `>=0.8.4-0` when you use it. From
0.8.4 on, a new optional field needs an `ignorable` entry, not a new floor.

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
