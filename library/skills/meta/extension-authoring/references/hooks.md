# Awaited hooks, failures and receipts

Declare a hook in `runtime.hooks`, then register `api.hook(point, handler)`.
Observations registered with `api.on` are passive; only hooks return effects.
Tool filters use native tool names (`write`, `edit`), not argument field names.
The native write/edit file argument is `path`. Request `access: [tool-args]` to
inspect it; canonicalize file paths before comparing shared claims.

| Hook point | Accepted effects |
| --- | --- |
| `prompt_submit` | `rewrite_prompt`, `block_prompt`, `notify_operator`, `pin_context` |
| `before_tool` | `block_tool`, `annotate_tool_result`, `protect_path`, `require_tool`, `lock_tools`, `rewrite_tool_input` |
| `after_tool` | `annotate_tool_result`, `protect_path`, `require_tool`, `lock_tools`, `pin_context` |
| `turn_start` | `inject_reminder`, `require_tool`, `lock_tools`, `notify_operator`, `pin_context` |
| `turn_end` | `inject_reminder`, `request_continuation`, `notify_operator` |

Return `{effects: [...], ui?: {...}}`, or `{}` to pass. UI can update declared
ambient slots, but cannot start an interview, change the workspace or prompt.
At most 8 effects; reason/message text at most 2000 characters. Effects at the
wrong point or malformed output are refused when the handler returns.

- `block_tool` takes `reason`; `block_prompt` takes `reason`.
- `annotate_tool_result` takes `message`, optional severity `info|warn`.
- `inject_reminder` takes `message`, optional severity `info|advisory|warn` and
  optional audience `model`; it cannot claim a hard-block severity.
- `require_tool` takes `toolName`, the name the model calls. For this
  package's own tool that is `extension_<id>__<tool>`, and the manifest must
  list the tool under `runtime.promote`; otherwise the effect is refused with
  `... is not promoted, so no request can require it; list <tool> under
  runtime.promote`. Builtin, MCP and other packages' tools are not checked.
  `lock_tools` has no extra fields.
- `pin_context` takes `text`, at most 8192 UTF-8 bytes, once per result. It
  sets this extension's one pinned block; a new value replaces the old one and
  empty text clears it. The block rides the message tail, is re-sent verbatim
  only when the context no longer carries its current value (a change, or a
  compaction that dropped it), and never reaches workers. Returning the same
  text every turn costs nothing; a value that changes on every write costs up
  to 8 KB of history each time. Pins persist with the session, so a resumed
  or restarted session carries them; a cleared block stays cleared, and a
  forked session starts without its parent's pins.
- `notify_operator` takes `message` and a deduplication `key`.
- `protect_path` takes `path` and `reason`; `request_continuation` takes `message`
  and optional `note`.
- `rewrite_tool_input` takes object `args` and `reason`, needs `tool-args` access;
  the host revalidates the schema and reclassifies safety after rewriting.
- `rewrite_prompt` takes `text` and `reason`, needs `prompt` access, and applies
  to plain typed prompts. Prompt-template bodies are not rewritten. Blocking
  does not itself require prompt access, but inspecting prompt text does.

Hook `timeoutMs` is 50–2000 ms, default 250. Both `onTimeout` and `onError`
default to `pass`; choose `block` only for a gate whose absence must refuse a
pending operation. At this head failure semantics depend on the point:

| Failure policy | Host behavior |
| --- | --- |
| `pass` | Receipt/notice of the failure; no gate effect. |
| `block` at `before_tool` | Refuses the pending tool call. |
| `block` at `prompt_submit` | Refuses the submitted prompt. |
| `block` at `after_tool` | Adds a warning annotation; the tool already ran. |
| `block` at `turn_start` | Refuses the turn before its first model request. |
| `block` at `turn_end` | Refused at load: the hook runs after the turn, so gate at `turn_start`. |

Three consecutive timeouts disable that hook for the runtime generation; its
failure policy still applies to later matching calls. Reload resets the generation.
Hooks run in the terminal, headless `clio-coder run` and ACP hosts. Runtimes never
start inside workers: a native worker sends each hooked tool call back to the
dispatching process, which runs the hook. CLI runtimes and ACP delegations
cannot carry a hook, so a blocking hook refuses those dispatches.

## Event fields

- `prompt_submit` always carries `origin`: `operator`, `continuation` (yolo
  continuing a stopped turn, with `continuation: {index, cap}`), `job` or
  `peer`; `template` names the prompt template bounding the turn. `turn_start`
  and `turn_end` carry the same fields when known. End run state on a new
  `operator` prompt, not on a `continuation`.
- A continuation's `prompt_submit` carries `lastToolCall: {tool, outcome, args?}`
  when the stopped turn made a tool call. `outcome` is `ok`, `error` or
  `unfinished`; `args` are redacted and clipped and need `tool-args` access.
  Operator, job and peer prompts never carry it.
- Every event carries `model` when the host knows it: `id`, `target`,
  `contextWindow` (or null), `thinkingLevel`, `promptCaching` and `tier`
  (`small`, `standard`, `frontier`; the operator's `models.<id>.tier` or a
  heuristic). A worker's hooked calls carry the worker's model. Hosts before
  0.8.4 omit it, so treat it as optional.

The host writes receipts for hook invocations and applied effects with extension
ownership, outcome/duration, runtime generation, content and envelope digests.
Use these to distinguish an actual refused call from a displayed advisory.
Do not claim that an `onError: pass` cooperative guard is a security boundary:
`peer-guard` protects exact claimed paths only for the declared write/edit tools,
not scripts, every mutation tool or every Clio home on the machine.
