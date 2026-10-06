# Awaited hooks, failures and receipts

Declare a hook in `runtime.hooks`, then register `api.hook(point, handler)`.
Observations registered with `api.on` are passive; only hooks return effects.
Tool filters use native tool names (`write`, `edit`), not argument field names.
The native write/edit file argument is `path`. Request `access: [tool-args]` to
inspect it; canonicalize file paths before comparing shared claims.

| Hook point | Accepted effects |
| --- | --- |
| `prompt_submit` | `rewrite_prompt`, `block_prompt`, `notify_operator` |
| `before_tool` | `block_tool`, `annotate_tool_result`, `protect_path`, `require_tool`, `lock_tools`, `rewrite_tool_input` |
| `after_tool` | `annotate_tool_result`, `protect_path`, `require_tool`, `lock_tools` |
| `turn_start` | `inject_reminder`, `require_tool`, `lock_tools`, `notify_operator` |
| `turn_end` | `inject_reminder`, `request_continuation`, `notify_operator` |

Return `{effects: [...], ui?: {...}}`, or `{}` to pass. UI can update declared
ambient slots, but cannot start an interview, change the workspace or prompt.
At most 8 effects; reason/message text at most 2000 characters. Effects at the
wrong point or malformed output are refused when the handler returns.

- `block_tool` takes `reason`; `block_prompt` takes `reason`.
- `annotate_tool_result` takes `message`, optional severity `info|warn`.
- `inject_reminder` takes `message`, optional severity `info|advisory|warn` and
  optional audience `model`; it cannot claim a hard-block severity.
- `require_tool` takes `toolName`; `lock_tools` has no extra fields.
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
| `block` at `turn_start`/`turn_end` | Reports the failure; it does not hard-block the turn. |

Three consecutive timeouts disable that hook for the runtime generation; its
failure policy still applies to later matching calls. Reload resets the generation.
Hooks are wired into the interactive harness, not workers, ACP or headless turns.

The host writes receipts for hook invocations and applied effects with extension
ownership, outcome/duration, runtime generation, content and envelope digests.
Use these to distinguish an actual refused call from a displayed advisory.
Do not claim that an `onError: pass` cooperative guard is a security boundary:
`peer-guard` protects exact claimed paths only for the declared write/edit tools,
not scripts, every mutation tool or every Clio home on the machine.
