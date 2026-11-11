# Worker context inheritance

The [fleet dispatch guide](../guide/fleet-dispatch.md) explains worker context choices during dispatch.

Clio Coder dispatch separates **what a worker inherits** from **how workers are scheduled**. This implements the isolation, fork, and splice patterns discussed in [Organizing context in a multi-agent harness](https://www.langchain.com/blog/organizing-context-in-a-multi-agent-harness), using Clio Coder's existing Pi agent loop and dispatch admission boundary.

The default remains an isolated conversation. A native worker gets its own Pi Agent, worker system prompt, admitted tools, dynamic project context, task, and run-local accounting. Context inheritance does not grant additional tools, write roots, or autonomy. Conversation isolation is not a filesystem sandbox; use dispatch worktrees when filesystem isolation is required.

With project-context tier `bounded`, workers also receive up to 2,400 characters of codemap, orientation, and wiki discovery fragments even when no handbook exists. Handbook selection remains separate; when a handbook's invariants overflow the worker budget, part of the budget stays reserved for the worker's own sections and the omitted invariants are named (see [Context engine](context-engine.md)). A repository with no handbook supplies its compiled handbook (see [Project context](project-context.md)) through the same selection; in a task worktree a handbook the source checkout keeps out of git still wins over the worktree's compile, and the source checkout's compiled handbook stands in when the worktree has neither. A task worktree supplies its own structural context when guidance falls back to the source checkout, and the run's project-context provenance includes the orientation message. See [Project context](project-context.md) for freshness and current status retrieval.

A headless peer runtime (`claude-code`, `codex-cli`, `pi-cli`, `opencode-cli`) at tier `bounded` receives one compiled rule set in that message when the handbook has sections: the handbook's sections plus the rules in its own repository instruction files that the tree still supports. Where the runtime has a switch, Clio turns its own instruction discovery off for the run. A runtime without one (`opencode-cli`) that runs in its own task worktree gets the compiled rules written over its instruction files in that worktree instead, marked skip-worktree and restored before the diff is taken, so the overlay never lands. The run record's `projectContext.peerInstructions` names the delivery mode, the files, and the counts of stale rules and of holding rules that did not fit; see [Repository instructions on a headless peer](../guide/interop.md#repository-instructions-on-a-headless-peer).

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

Fork accepts optional `max_tokens`. Splice also accepts `paths` and `refs`. The token limit is an estimate for the inherited portion, not the complete worker request. The final request must also fit the worker's system prompt, tool schemas, task, dynamic inputs, and output reserve. The allowed explicit token range is 256-262144; the default splice limit is 8000. A seed has a 512 KiB serialized cap (`WORKER_CONTEXT_MAX_BYTES`), of which 8 KiB is held back as headroom when a selection is built, and the complete native WorkerSpec must fit the existing 1 MiB stdin frame. Larger contexts fail explicitly. `paths` and `refs` each hold 1 to 64 entries of at most 4096 characters with no control characters, and duplicates are removed.

Splice refs address the captured messages: `tool:<call-id>` for a tool result, or `message:<zero-based-index>` for a user or assistant message. Unknown refs fail. Ref indexes are snapshot-relative, not session turn IDs. Path selection is the practical default: explicit paths override the intent's read roots, relevant paths, and write roots. Matching uses lexical paths in tool arguments relative to the parent's workspace; it does not read files, follow symlinks, or perform semantic relevance search. Without paths, recent tool observations are candidates.

All parent user/context text, tool errors, and explicit refs are required. If they cannot fit, dispatch refuses the splice and asks for a larger budget or an isolated task with an explicit briefing. Optional observations are selected newest first, then rendered in original order. Repeated calls with identical names and arguments use the newest optional observation; a smaller stale result cannot replace a newer result that did not fit. Assistant conclusions enter only through explicit refs and are labeled as parent claims. Private reasoning is omitted from splices. Required user images and explicitly selected image results require native fork; optional image observations are omitted and the packet discloses that it contains selected text only.

## Capture, ownership, and reproducibility

The chat loop captures its current Pi messages, or its prepared model replay when no runtime is active. This is the active branch's model-visible working set: existing compaction and eviction projections stay in effect. It does not reopen the raw parent ledger or resurrect sibling branches.

Capture occurs synchronously when dispatch arguments are admitted, before asynchronous routing, metadata probes, permission handling, or execution. Every inheriting member of one dispatch call uses the same capture boundary. A final incomplete assistant tool-call batch, including any results already completed within that batch, is excluded as a unit. Capture also follows Pi's exclusion of aborted and errored assistant responses, drops results belonging to their partial tool declarations, and records the excluded count. User instructions survive that filtering. An orphaned result, duplicate tool-call ID, or incomplete older batch causes explicit refusal rather than constructing invalid provider history.

The snapshot is deeply copied. Admission freezes selected requests, and retries and detached execution carry the selected seed rather than rereading the parent. Pipeline steps receive their upstream result separately; later parent turns do not become part of the already admitted seed. Separate dispatch calls have separate capture boundaries. Automatically constructed reviewers and judges retain their own fresh requests; do not use inherited author conclusions when an independent check is the purpose of a separately dispatched worker.

Native forks enter `initialState.messages`. They are not replayed as new events, credited as worker token usage, or counted as reads and tests executed by the worker. Pi remains responsible for converting model-specific messages at the provider boundary. A splice enters once through dynamic prompt messages. The worker's own assignment comes after inherited context and dynamic inputs.

The parent session writer is never forked or closed. Human `/tree`, `/fork`, and resume retain their existing semantics. Workers do not append their raw conversations to the parent; dispatch continues to return the normal sealed worker result.

## Context pressure and recovery

Every native worker checks context headroom before each provider request. The estimate includes actual system and tool surfaces and reserves output capacity. The ceiling is the smaller of the window times `context.compaction.threshold` and the window minus the output reserve. Automatic eviction runs only when both `context.compaction.auto` and `context.workingSet.enabled` are true; otherwise a request over the ceiling ends the run with `worker_context_exhausted`. An unreported serving window admits the request, and a real overflow then fails with the server's own error. Parent usage is never a sizing anchor for a child; after the worker's first completion, its own provider usage calibrates subsequent estimates.

The first request is never automatically reduced: an oversized fork must be explicitly replaced by a smaller splice. During later requests, the guard preserves the two most recent assistant rounds and all user context, tool errors, mutations, and unknown tools. It may remove older private reasoning when visible assistant content remains, and replace older successful observations of at least 1000 characters from the known read tools (`read`, `grep`, `find`, `ls`, `code_nav`, `web_read`, `web_fetch`, including the same calls made through the gateway) with stable markers. If the latest round alone still does not fit, because a worker read several large files in parallel, the guard also evicts that round's read results, largest first, and the marker tells the model to read a narrower range. When the server rejects a request as too large, the worker earns one retry whose request is projected down to 70 percent of the failed estimate; if eviction cannot reach that target, the run fails with the server's error. The original Pi history is not rewritten.

Evicted observations are durably stored before replacement under `<stateDir>/context-observations/<digest>.json` (`<stateDir>` is Clio Coder's state directory, `$XDG_STATE_HOME/clio-coder` on Linux), with mode 0600. A marker provides an exact file location and a `worker:<digest>` recall ref. Native `context(scope="recall")` discovers only this run's evicted observations. Passing a ref retrieves the exact persisted result through the existing bounded observation envelope. The run-local allowlist rejects another worker's refs, arbitrary paths, and parent-session refs; stored bytes are digest-checked on recall. Recall does not count as rereading or validating the current source. Workers without an admitted context tool can use the marker's file through their admitted read tool.

If protected context still cannot fit, the worker ends with `worker_context_exhausted`. Dispatch classifies that as deterministic and does not retry it unchanged. Backend token counts can differ from structural estimates; the guard is conservative headroom management, not a promise that every provider tokenizer or oversized individual tool response will fit.

## Evidence and compatibility

Non-isolated requests record context mode, parent session/leaf/workspace, snapshot digest, selected-content digest, estimated tokens, bytes, selected refs, omitted messages, the excluded unfinished tail, and excluded interrupted responses. The resolved plan displays the selection's digest and size; the run envelope and the run's result carry the provenance under `workerContext`. The run's `run.settled` record keeps its hash and the context-provenance verdict, so the run's seal covers them, and context provenance remains separate from independent validation evidence.

The host persists the selected seed at `<stateDir>/context-seeds/<contentHash>.json`, using mode 0600 and durable writes. These are exact historical artifacts with the same sensitivity as session history; there is no automatic garbage collection. Native seeds are self-contained over the wire, including for remote workers. Their metadata and contents are validated before model use and are covered by the existing whole-spec attestation.

The native worker reads spec versions **8 and 9** (`WORKER_SPEC_VERSIONS` in [spec-contract.ts](../../src/worker/spec-contract.ts)). The dispatcher emits v8 without `extensionHooks` and v9 when that field is present. A v8 spec carrying hooks is refused, as is any unsupported version; the worker exits `2` before model use. A v8 peer can serve hook-free dispatch, while attached session hooks require a v9-capable peer. ACP and other runtime adapters receive bounded splice text but do not implement native history forking or Clio Coder's native pressure/recall loop.

No extra LLM request is needed for capture or selection. Optional splice budgeting uses additive size estimates and one final serialization, rather than serializing the growing packet for every candidate. Stable projections help repeated requests retain an unchanged prefix. Cache reuse depends on the worker system prompt, tool surface, model, and provider cache policy.

## A worker's output token limit

A worker is a separate process. It does not inherit the parent session's live
settings; it reads layered settings from disk for its own working directory
(`startWorkerRun`, [worker-runtime.ts](../../src/engine/worker-runtime.ts)). An unsaved `/settings` or
`/model` override in the parent session therefore does not reach it. Those
resolved settings also govern the worker's observation caps, guardrails, and working-set
eviction, not just its output cap. The dispatcher also carries the operator's configured
model ids and a settings fingerprint on the spec, so the worker protects the same resident
models and the orchestrator can refuse a peer admitted under other settings. External vendor runtimes, such as Claude CLI
or Antigravity delegation, return before this native path and are not governed by
the native request adapter at all.

Precedence for `chat.maxOutputTokens`, highest first: `.clio-coder/settings.local.yaml`,
`.clio-coder/settings.yaml`, the user `settings.yaml`, then the compiled default.
**The compiled default is `0`** ([defaults.ts](../../src/core/defaults.ts)), which is not a token
count. `0` means no configured budget. The requested output then comes from the model
profile's recommended output tokens, bounded to half of the served window, then from the
resolved model's advertised output limit, and finally from the product floor of 32768 tokens
when the model advertises neither.

Both project layers are gated on workspace trust ([workspace-trust.ts](../../src/core/workspace-trust.ts)).
An untrusted project, a project whose configuration changed after trust was
recorded, or a malformed settings file all drop the project layers and fall back
to user settings or the compiled default. This is why a worker can legitimately
run with a different cap than the project file appears to ask for.

Whatever the resolved number is, it is a request, not a promise. `remainingContextMaxTokens`
([output-budget.ts](../../src/engine/apis/output-budget.ts)) clamps it to the model's advertised output
limit and to the remaining context window, and each provider then maps the budget
onto its own wire contract. On the OpenAI-compatible LiteLLM path,
`reasoning_effort` is forwarded under `allowed_openai_params` when the model and runtime
resolve a controlled thinking effort ([openai-completions.ts](../../src/engine/apis/openai-completions.ts)); that is a LiteLLM
compatibility allowance and not a universal provider contract. A per-response cap
also caps one response, not a task: it does not bound total task tokens or
guarantee the task finishes.

## Sister repositories

A run's rules come from the repository that owns its files, never from the directory the session started in. The owning repository is the nearest ancestor of the run's `cwd` with a `.git` entry ([project-root.ts](../../src/core/project-root.ts)); a linked worktree is the same repository as its main checkout. A run is in another repository when that root differs from the root owning the session's working directory, which every session uses as its process directory. A clone or submodule nested inside the session's repository counts as another, and so does a task worktree made from it. Outside the session's tree, the one run admitted is the read-only Scout on an [external checkout](dispatch-typed-intent.md#67-external-scout-read); mutating work there is not admitted, and when it is, it takes the same path.

- **One repository per task.** Dispatch collects the task's `cwd` and its relative `read_roots`, `write_roots`, `relevant_paths` and `expected_outputs`. A task whose paths fall in two repositories, such as a nested checkout and its parent, is refused with `task_spans_repositories: Use one repository per task; all declared paths must stay inside it.`, naming both roots and telling the coordinator to dispatch one task per repository with that repository as `cwd` ([scout-workspace.ts](../../src/domains/dispatch/scout-workspace.ts)).
- **That repository's rules only.** An external Scout gets that checkout's handbook as bounded project context, though Scout's own tier is `none`, because orientation in an unfamiliar repository is where its rules help most. Nothing of the session's handbook, project rules or path-scoped rules crosses over, and the run's project customization is operator-only whether or not that repository is trusted: its `.clio-coder/rules` and project `profile.yaml` never enter. The user profile in the config directory still applies, since it is about the person, not the project.
- **Trust.** Another repository's handbook is prompt text from a project the operator did not open. When its `handbook` surface is approved in that repository (`clio-coder config trust handbook`, run there; see [Safety model](safety-model.md)), the worker gets the handbook as in its own session. Until then it gets only the rules that repository's tree verifies (cited paths and scripts exist, checker ids resolve, no tree fact contradicts them), under their own headings, plus the rules its checkers declare. The uncheckable rest is left out and counted, and the run raises a `sister_handbook_untrusted` scope notice naming the count and the trust command. A repository with no handbook contributes nothing yet ([sister-repository.ts](../../src/domains/context/sister-repository.ts)).
- **The main agent.** When the session reads, lists, searches or edits files in another repository, the tool result gains one reminder, `Rules of <name>, compiled from <files>`, holding that repository's invariants under the same trust filter. It is at most 1,500 characters, whole rules only, with the rest named by file. It comes once per repository in each session, and again in that session only when the compile changes. Before the first compile lands the tool result carries none. It rides on the tool result rather than the system prompt, so the session's own handbook and cached prompt prefix stay as they are ([sister-repository-reminder.ts](../../src/domains/middleware/sister-repository-reminder.ts)).
- **State.** The compile and its verification ledger live under the state root in `handbooks/<key>/`, keyed by the repository's real path. Dispatch and the tool-result reminder only read that cache. A refresh runs in the background: it asks Git for the commit and lists the tree asynchronously, under deadlines, and verifies the rules on a worker thread, at most two repositories at a time. It recompiles only when that repository's commit, handbook bytes or trust change. Every directory of the repository shares one compile. Stopping the session kills the refresh's Git calls and its worker, leaving the last compile. Until the refresh lands, the last compile is served. A run that finds no compile at all gets none of that repository's handbook rules and raises a `sister_handbook_pending` scope notice; later runs receive the compile. Clio writes nothing into a repository the operator did not start it in.
