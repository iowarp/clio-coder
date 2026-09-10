# Worker context inheritance

> **Visual blueprint:** [Worker context visual reference](https://github.com/iowarp/clio-coder/blob/main/docs/html/worker_context_blueprint.html).

Clio dispatch separates **what a worker inherits** from **how workers are scheduled**. This implements the isolation, fork, and splice patterns discussed in [Organizing context in a multi-agent harness](https://www.langchain.com/blog/organizing-context-in-a-multi-agent-harness), using Clio's existing Pi agent loop and dispatch admission boundary.

The default remains an isolated conversation. A native worker gets its own Pi Agent, worker system prompt, admitted tools, dynamic project context, task, and run-local accounting. Context inheritance does not grant additional tools, write roots, or autonomy. Conversation isolation is not a filesystem sandbox; use dispatch worktrees when filesystem isolation is required.

## Dispatch API

```json
{
  "agent": "researcher",
  "task": "Investigate the parser failure and cite the relevant source lines.",
  "intent": { "read_roots": ["src/parser"] },
  "context": { "mode": "splice", "paths": ["src/parser"], "max_tokens": 8000 }
}
```

`context` is independent of the top-level scheduling `mode` (`parallel`, `sequential`, `pipeline`, and so on). A batch's `context` is the default for each task; an object task can replace it, for example with `{ "mode": "isolated" }` for a separate check. Ordinary `briefing` and pipeline predecessor outputs remain separate dynamic inputs.

| Context mode | Native HTTP/Pi worker | ACP and other runtimes | Selection |
| --- | --- | --- | --- |
| `isolated` | Fresh conversation | Fresh runtime conversation | No inherited session messages; existing project context and explicit briefing still apply |
| `fork` | Existing history seeded into Pi | Rejected; use splice | Entire captured model-visible history, without silent trimming |
| `splice` | Bounded historical evidence packet | Same packet through existing prompt delivery | Exact selected text, with source labels; no summarizer or extra model call |

Fork accepts optional `max_tokens`. Splice also accepts `paths` and `refs`. The token limit is an estimate for the inherited portion, not the complete worker request. The final request must also fit the worker's system prompt, tool schemas, task, dynamic inputs, and output reserve. The allowed explicit token range is 256-262144; the default splice limit is 8000. A seed has a 512 KiB serialized cap, and the complete native WorkerSpec must fit the existing 1 MiB stdin frame. Larger contexts fail explicitly.

Splice refs address the captured messages: `tool:<call-id>` for a tool result, or `message:<zero-based-index>` for a user or assistant message. Unknown refs fail. Ref indexes are snapshot-relative, not session turn IDs. Path selection is the practical default: explicit paths override the intent's read roots, relevant paths, and write roots. Matching uses lexical paths in tool arguments relative to the parent's workspace; it does not read files, follow symlinks, or perform semantic relevance search. Without paths, recent tool observations are candidates.

All parent user/context text, tool errors, and explicit refs are required. If they cannot fit, dispatch refuses the splice and asks for a larger budget or an isolated task with an explicit briefing. Optional observations are selected newest first, then rendered in original order. Repeated calls with identical names and arguments use the newest optional observation; a smaller stale result cannot replace a newer result that did not fit. Assistant conclusions enter only through explicit refs and are labeled as parent claims. Private reasoning is omitted from splices. Required user images and explicitly selected image results require native fork; optional image observations are omitted and the packet discloses that it contains selected text only.

## Capture, ownership, and reproducibility

The chat loop captures its current Pi messages, or its prepared model replay when no runtime is active. This is the active branch's model-visible working set: existing compaction and eviction projections stay in effect. It does not reopen the raw parent ledger or resurrect sibling branches.

Capture occurs synchronously when dispatch arguments are admitted, before asynchronous routing, metadata probes, permission handling, or execution. Every inheriting member of one dispatch call uses the same capture boundary. A final incomplete assistant tool-call batch, including any results already completed within that batch, is excluded as a unit. Capture also follows Pi's exclusion of aborted and errored assistant responses, drops results belonging to their partial tool declarations, and records the excluded count. User instructions survive that filtering. An orphaned result, duplicate tool-call ID, or incomplete older batch causes explicit refusal rather than constructing invalid provider history.

The snapshot is deeply copied. Admission freezes selected requests, and retries and detached execution carry the selected seed rather than rereading the parent. Pipeline steps receive their upstream result separately; later parent turns do not become part of the already admitted seed. Separate dispatch calls have separate capture boundaries. Automatically constructed reviewers and judges retain their own fresh requests; do not use inherited author conclusions when an independent check is the purpose of a separately dispatched worker.

Native forks enter `initialState.messages`. They are not replayed as new events, credited as worker token usage, or counted as reads and tests executed by the worker. Pi remains responsible for converting model-specific messages at the provider boundary. A splice enters once through dynamic prompt messages. The worker's own assignment comes after inherited context and dynamic inputs.

The parent session writer is never forked or closed. Human `/tree`, `/fork`, and resume retain their existing semantics. Workers do not append their raw conversations to the parent; dispatch continues to return the normal sealed worker result.

## Context pressure and recovery

Every native worker checks context headroom before each provider request. The estimate includes actual system and tool surfaces and reserves output capacity. It honors the configured compaction threshold and automatic working-set eviction setting. Parent usage is never a sizing anchor for a child; after the worker's first completion, its own provider usage calibrates subsequent estimates.

The first request is never automatically reduced: an oversized fork must be explicitly replaced by a smaller splice. During later requests, the guard preserves the two most recent assistant rounds and all user context, tool errors, mutations, and unknown tools. It may remove older private reasoning when visible assistant content remains, and replace large older successful observations from known read tools with stable markers. The original Pi history is not rewritten.

Evicted observations are durably stored before replacement under `$XDG_STATE_HOME/clio-coder/context-observations/<digest>.json` (or Clio's configured state root). A marker provides an exact file location and a `worker:<digest>` recall ref. Native `context(scope="recall")` discovers only this run's evicted observations. Passing a ref retrieves the exact persisted result through the existing bounded observation envelope. The run-local allowlist rejects another worker's refs, arbitrary paths, and parent-session refs; stored bytes are digest-checked on recall. Recall does not count as rereading or validating the current source. Workers without an admitted context tool can use the marker's file through their admitted read tool.

If protected context still cannot fit, the worker ends with `worker_context_exhausted`. Dispatch classifies that as deterministic and does not retry it unchanged. Backend token counts can differ from structural estimates; the guard is conservative headroom management, not a promise that every provider tokenizer or oversized individual tool response will fit.

## Evidence and compatibility

Non-isolated requests record context mode, parent session/leaf/workspace, snapshot digest, selected-content digest, estimated tokens, bytes, selected refs, omitted messages, the excluded unfinished tail, and excluded interrupted responses. The resolved plan displays the selection's digest and size; the run envelope and receipt carry the provenance under `workerContext`. Receipt integrity binds it, and context provenance remains separate from independent validation evidence.

The host persists the selected seed at `$XDG_STATE_HOME/clio-coder/context-seeds/<contentHash>.json`, using mode 0600 and durable writes. These are exact historical artifacts with the same sensitivity as session history; no automatic garbage collection is introduced in this change. Native seeds are self-contained over the wire, including for remote workers. Their metadata and contents are validated before model use and are covered by the existing whole-spec attestation.

WorkerSpec version **4** is required. Rebuild/update remote workers together with the orchestrator; an older worker must reject the new specification rather than silently ignore inherited history. ACP and other runtime adapters receive bounded splice text but do not implement native history forking or Clio's native pressure/recall loop.

No extra LLM request is needed for capture or selection. Optional splice budgeting uses additive size estimates and one final serialization, rather than serializing the growing packet for every candidate. Stable projections help repeated requests retain an unchanged prefix, but provider cache reuse is measured behavior, not guaranteed: worker system prompts, tool surfaces, models, and provider cache rules can differ from the parent.

## A worker's output token limit

A worker is a separate process. It does not inherit the parent session's live
settings; it reads layered settings from disk for its own working directory
(`startWorkerRun`, `src/engine/worker-runtime.ts`). An unsaved `/settings` or
`/model` override in the parent session therefore does not reach it. Those
resolved settings also govern the worker's observation caps and working-set
eviction, not just its output cap. External vendor runtimes, such as Claude CLI
or Antigravity delegation, return before this native path and are not governed by
the native request adapter at all.

Precedence for `chat.maxOutputTokens`, highest first: `.clio-coder/settings.local.yaml`,
`.clio-coder/settings.yaml`, the user `settings.yaml`, then the compiled default.
**The compiled default is `0`** (`src/core/defaults.ts`), which is not a token
count. `0` means "use the resolved model's advertised output limit", falling back
to the product floor when the model does not advertise one.

Both project layers are gated on workspace trust (`src/core/workspace-trust.ts`).
An untrusted project, a project whose configuration changed after trust was
recorded, or a malformed settings file all drop the project layers and fall back
to user settings or the compiled default. This is why a worker can legitimately
run with a different cap than the project file appears to ask for.

Whatever the resolved number is, it is a request, not a promise. `remainingContextMaxTokens`
(`src/engine/apis/output-budget.ts`) clamps it to the model's advertised output
limit and to the remaining context window, and each provider then maps the budget
onto its own wire contract. On the OpenAI-compatible LiteLLM path,
`reasoning_effort` is forwarded under `allowed_openai_params` when thinking
effort is enabled (`src/engine/apis/openai-completions.ts`); that is a LiteLLM
compatibility allowance and not a universal provider contract. A per-response cap
also caps one response, not a task: it does not bound total task tokens or
guarantee the task finishes.

`tests/contracts/worker-output-settings.test.ts` covers the eight combinations of
trust state and layer (trusted project at low/medium/xhigh effort, trusted local
override, untrusted, changed-after-trust, malformed, and user settings only).

## Validation

The worker-context contract tests cover incomplete multi-tool batches, copy isolation, path and explicit-ref selection, stale duplicate reads, mandatory constraints and errors, images, admission freezing, active-branch eviction replay, receipt tampering, scoped recall, and provider-usage reconciliation after eviction. Dispatch integration tests run the actual Pi worker against a controlled HTTP provider and verify single delivery, exclusion of later parent turns, absence of inherited fork events, wire validation, and rejection before a provider call when context is oversized. The normal full CI gate also exercises existing dispatch, session replay, worker transport, and operator behavior.

