# Context Engine

Clio manages two kinds of context: the material sent to your model, and the project information used to find relevant code. You can inspect both without rebuilding the project or starting another model request.

**Start with `/context`.** It shows the current model window, context usage, project guidance, and available cache measurements. Most sessions need no manual tuning.

## Choose the action you need

| You want to… | Use | What to expect |
| --- | --- | --- |
| Inspect the current conversation budget | `/context` | A context breakdown with estimates and available provider measurements. |
| Summarize a long conversation | `/context compact` | Model-backed compaction; this can use tokens. |
| Refresh the repository's structural index | `/context refresh` | Rebuilds local code navigation data; leaves authored handbooks alone. |
| Check a generated project wiki | `clio-coder context wiki --status` | Reads status without generating pages or making a model call. |

The sections below explain the behavior. Expand the implementation details only when you need them. For exact tool arguments, use the [tool reference](../guide/tool-usage.md); for worker context, see [worker context](worker-context.md).

## Context window resolution

The effective window is the limit Clio uses for budgeting. It may differ from a model’s advertised maximum, especially when a local server loads a smaller window. `/context` labels the source of that value.

<details>
<summary>Which model window does Clio use?</summary>

Clio distinguishes three values:

| Value | Meaning |
| --- | --- |
| Declared | A model or runtime capability, which may be larger than the server currently serves. |
| Desired | Clio's advisory target for a useful window; it does not allocate server capacity. |
| Effective | The resolved budget used for requests and compaction. |

Resolution combines requested runtime windows, loaded-state observations, target configuration, probes, and model/runtime defaults. It is not a simple “last setting wins” chain: observed or configured limits can cap a requested value. Live loaded-state discovery is preferred over a saved observation for the same target and model.

`clio-coder run --max-context-tokens` can **reduce** the effective budget for one run. It cannot enlarge the model's or server's capacity.

A resumed session reuses its recorded loaded window when live discovery has not yet reported a loaded value. Without that saved measurement, resolution falls back to the remaining configured, probed, or declared evidence.

`lastLoadedContextWindow` reads the last `loaded` window the session's own `context-snapshots.jsonl` recorded for the same target and model and hands it to resolution as `knownLoadedContextWindow`. It is used only when live discovery reports nothing, and it is scoped to that target and model, so a different selection re-probes and a model reloaded at a new size corrects as soon as discovery names the live window.

Clio uses 131,072 tokens as its desired-window floor and fallback when no source reports a window. This is an assumption, not an effective minimum the server promises. A resolved target window below 128,000 tokens triggers the undersized-window warning; a deliberately smaller per-run cap does not trigger that target warning. If a live model reports a smaller loaded context window, Clio re-resolves the target so accounting uses the actual ceiling.

The `/context` overlay states which layer answered, next to the token total: `loaded`, `probed`, `configured`, `declared`, or `assumed`.

A probed llama.cpp window is the share one request gets, not the server's total. llama.cpp splits `--ctx-size` evenly across `--parallel` slots unless `--kv-unified` is set, so a server started with `--ctx-size 786432 --parallel 4 --no-kv-unified` admits 196,608 tokens per request, and that is the figure autocompact and the meter plan against.

The probe reads the flags (long and short forms, `-c`, `-np`, `-kvu`, and the last of `--kv-unified` or `--no-kv-unified` given) off the router's per-model status, keeps the split on the model's discovery state, and `/context` prints the derivation next to the share: `196,608 (786,432 / 4 slots)`.

`clio-coder targets` does the same in its `ctx` note for the target's default model and adds a probe note naming the flags.

</details>

## Token accounting and snapshots

Before a request, Clio estimates the prompt size. When the provider reports usage, Clio reconciles those measurements with the session ledger. Category breakdowns remain estimates; a provider total does not make every category exact.

<details>
<summary>How estimates, provider counts, and snapshots fit together</summary>

The estimator in `context-accounting.ts` uses a four-characters-per-token family for hot-path accounting. It estimates system prompt, tools, messages, pending input, and runtime categories without calling a model tokenizer on every TUI refresh.

At submit time, Clio captures a context snapshot and persists a slim JSONL record under the session directory as `context-snapshots.jsonl`. The slim record keeps token counts, segment metadata, signatures, and hashes, not the heavy prompt or transcript text. When provider usage arrives, `reconcileSnapshot` folds actual input and output counts back into the ledger.

Every snapshot records the divergence between the two accountings. `estimatedTokens` is the chars/4 prompt-side total the snapshot was captured with and is never rewritten by a reconcile; `reconciledTokens` is the provider's own prompt count for the call, with cached prompt tokens folded back in; `divergenceRatio` is the second over the first. A ratio above 1 means the estimator is under-counting what the backend charges for the same messages.

Provider measurements inform the live budget used by pre-submit, post-tool continuation, and overflow checks. The budget takes the larger of the structural estimate and the trusted provider-anchored total. When no live anchor is trusted—such as before the first provider response, after a session reset, or when target, runtime, model, endpoint, or message history diverges—accounting falls back to the conservative legacy estimator.

While a live anchor is trusted, the floor is structural (the breakdown sum of prompt, messages, pending input, and tool schemas), pricing material the attested call never saw without letting provider counts fall below structural reality. Live provider accounting counts measured prompt schemas once within the anchored history, avoiding false pressure from duplicate schema charges.

It prices independent positive prompt and tool growth without netting shrinkage against growth, and preserves the post-reconcile message tail through working-set eviction replay. A working-set projection subtracts the tokens the eviction planner priced out and re-anchors on the projected message list rather than discarding the attestation, so post-eviction accounting remains provider-anchored.

A summary compaction rewrites the conversation the attestation described, so it drops the anchor and the next provider call re-establishes it.

Session metadata enforces session format version 4 (`CURRENT_SESSION_FORMAT_VERSION = 4`). Version 4 is additive: it adds the `contextEviction` and `contextRecall` records and changes no existing entry. A version 3 session therefore migrates to 4 in place when Clio opens it, and no entry is rewritten. Formats older than version 3 are unsupported. Formats newer than version 4 are also refused, with an error directing you to upgrade Clio. This release reads versions 3 and 4; older binaries may not read sessions it writes.

The `/context` overlay and footer meter read the same ledger categories in display order: `system`, `tools`, `agents`, `skills`, `memory`, `project`, `messages`, `pending`, `streaming`, `free`, and `reserve`.

</details>

## Single-threshold compaction

Automatic compaction is enabled by default at **80% context pressure**. Clio first tries reversible working-set eviction. If that is not enough, it requests a summary. A summary can lose detail; the preserved ledger remains the source for exact history.

<details>
<summary>How pressure is computed and which stage runs first</summary>

Auto-compaction is controlled by `context.compaction.threshold`. Pressure is `budgeted_tokens / context_window`, where the budget includes a trusted provider anchor when available and retains the structural estimate as a floor. The default threshold is `0.8`.

With automatic compaction enabled, pressure at or above the threshold first tries reversible working-set eviction without a model call. Disabling `context.workingSet.enabled` skips that stage and proceeds to summary compaction. If pressure remains high, an LLM summary replaces older material in model replay. Recall remains available on demand; it is not an automatic compaction stage. Both mechanisms preserve the raw ledger by default.

</details>

<details>
<summary>1. Working-set eviction</summary>

### 1. Working-set eviction


When `context.compaction.auto` is enabled and pressure crosses the threshold before a request, Clio applies the configured working-set policy first. The policy selects tool-result bodies and closed-turn thinking blocks, `runAutoCompact` appends one `contextEviction` ledger entry, and `refreshAgentMessagesFromSession` projects those units out of model replay behind a one-line marker. Nothing is deleted: the ledger keeps the original bodies, the transcript keeps showing them, and `/resume`, `/tree`, `/fork`, and the HTML export are unaffected.

Already-evicted units are never selected again. Recent turns keep their full observations and thinking, governed by `context.workingSet.protectLastTurns`. Results whose estimated body is below `context.workingSet.minEvictableTokens` (200 tokens by default) are kept whatever their age as a low-yield churn guard.

The engine separately refuses any candidate whose marker would save no tokens. The `age-horizon` policy is therefore the selection the old destructive mask made minus those small results, not a byte-identical reproduction of it; the default `structural-v1` policy applies its structural rules before any age rule.

If the projection drops pressure below the threshold, Clio sends the request and no summary runs. The policies, the protection predicates, the marker format, and the ledger records are documented in [context-working-set.md](context-working-set.md).

</details>

<details>
<summary>2. Recall</summary>

### 2. Recall


An evicted or summarized tool-result body comes back on demand. `context(scope="recall", ref="<turnId>")` returns its persisted body through the observation envelope and appends a `contextRecall` entry. Omit `ref` to discover historical results with `query`, `limit`, and `offset`; discovery does not append a recall record. Operators use `/context recall <ref>`, which prints the body to the transcript without putting it into model context. Content removed by older destructive compaction or masking cannot be recovered.

A recall does not un-evict. The marker stays byte-identical where it was, so the provider prefix cache is untouched, and repeated recalls of the same ref are the churn signal the `/context` overlay reports.

Offline replay does not infer those explicit decisions from a later read of the same path. A reread already returns current content, while recall returns a selected historical ref. The replay tables keep the token-weighted `recallTokens` demand bound and reserve recall count, churn, and tail-growth simulation for ledgers or corpora that record which refs were actually recalled.

</details>

<details>
<summary>3. LLM summary, as a last resort</summary>

### 3. LLM summary, as a last resort


If pressure remains above the threshold after eviction, Clio runs the summary compaction path: it calls the summarization model, appends a `compactionSummary` entry, refreshes projected replay messages from the session, and continues. This is the only mechanism that spends tokens and the only one whose output is a lossy paraphrase, which is why it runs last.

Compaction projects the active-path working set before counting tokens, choosing a cut, or serializing the summary request. Evicted bodies and thinking therefore stay excluded from the summarizer as well as ordinary replay; the raw ledger remains available for exact recall.

The first pass searches from the start of the active path. Later passes search strictly after the previous `compactionSummary`, using the prior checkpoint and retained suffix as canonical context for one cumulative replacement. Compaction retains selected verified skill text, exact operator instructions verbatim, canonical active replay, complete tool batches (keeping the full tool call and result batch intact rather than cutting mid-batch), and prior retained suffixes across iterative checkpoint boundaries.

This ensures essential task constraints and verified context persist across repeated checkpoints without over-promising that every oversized model task will fit. Each summary request budgets the complete prompt and its bounded output against the resolved model window.

A summary that reaches its model output limit is incomplete and cannot replace the current checkpoint. Its reported usage remains recorded as a failed compaction call. Manual compaction preserves the latest operator request verbatim when a split removes it, even after the active turn has settled.

Esc and Ctrl+C cancel manual and pre-submit compaction through the same signal as the production summary call; canceling pre-submit compaction also stops the pending chat submission. Post-tool continuation forwards the engine abort signal, and ACP session cancellation reaches compaction before the chat stream starts.

Session reset and disposal abort outstanding summaries. Compaction checks cancellation before invocation, before accepting a response, and before publication, so a late response cannot become a checkpoint. These checks do not establish semantic summary quality, which requires separate model evidence.

Manual `/context compact`, `CLIO_CODER_FORCE_COMPACT=1`, and overflow recovery force the summary path directly and skip every pre-stage. The overflow guard runs before the user turn is committed, so a blocked oversized request does not leave an unanswered user entry in the ledger.

</details>

<details>
<summary>What working-set eviction will not take</summary>

### What working-set eviction will not take


Only two things ever leave the working set: a tool result's body and an assistant
turn's thinking. Operator words, summaries, skill activations, ledgers, worker
runs and bash executions are the session's record of itself and are never
candidates (`isProtected`, `src/domains/context/working-set/protect.ts`).

Within that, the recent window is untouchable for both kinds:
`context.workingSet.protectLastTurns` (default 6) fixes a cutoff, and any entry
at or after it is protected whatever a policy concludes.

Eviction never breaks the call/result envelope. It replaces the observation *body* with a marker and leaves the pairing intact: `toolCallId`, `toolName`, the existing `details` are retained (`projectToolResult`, `src/domains/context/working-set/project.ts`), so replay still matches each result to its call and the renderer still knows what the call was.

Only the text the model reads changes. The `workingSet` stamp on `details` is how a reader tells a marker from a genuinely small tool result. Batch indivisibility is a separate guarantee belonging to the summarization checkpoint, not to body eviction.

Recall then readmits an exact body. **Main-session recall reads the session
ledger**, not a separate store: `context(scope="recall", ref="<turnId>")` or
`/context recall <ref>` folds the ledger at the live leaf and returns the body
through the ordinary observation envelope. A ref that is unknown or sits on an
abandoned branch is refused rather than guessed at. Native workers are the
separate case, with their own digest-checked store and `worker:<digest>` refs;
[worker-context.md](worker-context.md) describes it.

These are structural guarantees about eviction and replay. They are not a claim
about summary quality: as above, a summary that reaches its model output limit is
incomplete and cannot replace the checkpoint it was meant to stand in for. The
durable ledger is not rewritten either way.

</details>

<details>
<summary>The legacy mask escape hatch</summary>

### The legacy mask escape hatch


`CLIO_CODER_LEGACY_MASK=1` restores the destructive pre-stage working-set eviction replaced. It calls `session.replaceEntries` and rewrites the persisted bodies, so masked content is gone for the operator as well as the model. It uses the old marker format:

```text
[Observation masked: <tool> output was <lines> lines, <chars> chars - contents masked to save context. Re-run the tool for current content.] Preview: <preview>
```

Use this legacy path only for compatibility diagnosis; it rewrites stored content rather than preserving the original bodies.

</details>

<details>
<summary>Replay text</summary>

### Replay text


When the ledger is replayed to the model, compaction summaries, branch summaries, and bash executions become standardized user-role message text. Clio imports `COMPACTION_SUMMARY_PREFIX`, `BRANCH_SUMMARY_PREFIX`, their suffixes, and `bashExecutionToText` through `src/engine/messages.ts`; `src/interactive/chat-renderer.ts` maps Clio's entry shapes onto them and applies replay truncation. The working-set projection runs before that builder, so markers are what the replay text is built from.

</details>

## Cache-divergence honesty

**A stable prefix is an opportunity for reuse, not a promise of a cache hit.** `/context` reports the usage facts available from the backend and lists events that may have changed reuse. An event by itself does not prove that the cache became cold.

<details>
<summary>Cache measurements and reasons for changed reuse</summary>

A stable request prefix gives a backend an opportunity to reuse cached work. Actual reuse depends on the provider, model, serving configuration, routing, and cache lifetime. Clio cannot guarantee a cache hit or a particular discount.

Eviction and compaction change replayed history. They may require some of the next prompt to be processed again. Recall appends the retrieved body instead of restoring it in place, so the earlier marker remains stable.

The compiled system prompt places stable identity and operating rules before changing context; the order and the rule behind it are in [prompt-envelope-and-tools.md](prompt-envelope-and-tools.md#section-order-stable-prefix-first).

Compaction and eviction both change the replayed history. On a local backend with a single prefix-cache slot, the next turn after either one is expected to be cold because the byte prefix moved. Dispatch traffic can disturb the same slot.

Clio records these disturbances once on the next assistant entry as `promptCache.expectedColdReasons`. There are eight recorded reasons, and they split into two groups by what they disturb.

| Reason | Stamped when | Tier |
| --- | --- | --- |
| `working_set_evict` | An eviction event was applied to the replayed history. | every tier |
| `tool_surface_change` | The session's tool signature differs from the last completed run's. | every tier |
| `prompt_recompiled` | A recompile changed the prompt text and the manifest holds a previous hash to name, or an in-process session switch replaced the prefix after this process had applied a prompt. | every tier |
| `compaction` | The summary compaction path ran. | `local-native` |
| `dispatch` | A dispatch started, completed, or failed between turns. | `local-native` |
| `residency` | A residency load or eviction succeeded on this session's own serving endpoint. | `local-native` |
| `thinking_change` | The resolved thinking level for this run differs from the last completed backend run's. | `local-native` |
| `background_memory` | A proactive-memory step completed against the endpoint this session streams to. | `local-native` |

The three tier-independent reasons record changes to the request prefix. They do not prove that the backend discarded its whole cache. The other five disturb a local server or the template it renders, and a single-slot local cache is the only one an interleaved run actually displaces, so they are stamped only when the runtime's tier is `local-native`.

Two of them are gated on identity as well as tier: `residency` compares the mutation's target key against this session's own runtime and base URL, and `background_memory` compares the memory step's canonical endpoint key against the target this session streams to, so work on a second server never explains a cold prefix on the first.

`prompt_recompiled` deliberately does not fire on a process's first compile: a fresh or resumed session has no previous hash to have diverged from, and stamping it there would mark every session's opening turn as expected-cold. An in-process switch (`/resume`, `/new`, a fork) stamps it from the switch itself rather than from the manifest.

Manifest provenance follows the session, so the incoming session's `previousHash` is its own last recorded hash and usually equals what it compiles now, which leaves the manifest with nothing to report; the backend's slot meanwhile still holds the outgoing session's prompt and history, so the switch records a possible cause of changed cache behavior.

The user sees one dim notice per reason, and the same reasons persist on the run's first assistant entry in the session ledger next to the per-call cache data. The `/context` overlay renders each one in prose (`working-set eviction`, `dispatch traffic`, `residency change`, `thinking-level change`, `tool-surface change`, `prompt recompile`, `compaction`, `background memory step`) and falls through to the wire value only for an unknown reason.

Per-call cache verdicts are `hot`, `partial`, `cold`, and `small`. They are derived from provider usage and persisted with `timing { ttftMs, apiMs }` and `promptCache { input, cacheRead, cacheWrite, backendVerdict }` when available.

### What the serving backend reports

On a llama.cpp or LM Studio target, Clio also persists the server's own prefill accounting rather than inferring it from pi-ai's token counts. The observer reads the last complete timing object off the final ordinary SSE event of a stream, or the top-level one on a non-streaming response, from the response the turn already makes; it opens no second connection and sets no extra payload flag. What lands on the assistant entry is `promptCache.backend`:

| Field | Meaning |
| --- | --- |
| `promptTokens` | The whole prompt the server accounted for. On the observed llama.cpp build that is `prompt_n + cache_n`, since `prompt_n` counts only newly evaluated work. |
| `cachedTokens` | `cache_n`, the prompt work the slot reused. `null` when the server reports no cache figure at all. |
| `predictedTokens` | `predicted_n`, tokens generated. |
| `promptMs` | `prompt_ms`, wall-clock milliseconds spent in prefill. |
| `predictedMs` | `predicted_ms`, wall-clock milliseconds spent generating. |
| `source` | `llamacpp-timings` or `lmstudio-timings`. |

`uncachedPrefillTokens` is derived centrally as `promptTokens - cachedTokens`, and only when both figures are present and consistent. That distinction carries all the way to the surfaces: a missing `cache_n` persists `cachedTokens: null` and leaves the pi-ai verdict in force, so `/context` says `server does not report cache reads` instead of calling the backend cold.

LM Studio 2.29.0 is that case today. Its OpenAI-compatible port returns `usage`, `stats`, and `system_fingerprint` and no `timings` object, on both the streaming and non-streaming shapes and with `timings_per_token` explicitly requested, so `lmstudio-timings` is a shape Clio accepts and has not yet observed.

The verdict keeps its existing pi-ai path unless pi-ai reports `cacheRead === 0` while the backend reports a numeric `cachedTokens`. In that one case the same hot, partial, cold, and small thresholds are applied to the measured counts instead. No timing ratio or wall-clock heuristic participates in a verdict.

`/context` renders the last call as `prefill: N uncached · M cached · X ms`, and falls back to `prefill: N prompt · X ms` when the server gave no cache figure. `/usage` folds every durable call in the session into a total uncached prefill plus the four verdict counts, `clio-coder usage report` carries the same two facts per session, and `clio-coder doctor` reports the latest session's verdict counts and its most frequent expected-cold reason without opening the TUI.

The `/context` overlay closes the loop. When the last settled run came back `cold` and Clio had recorded a reason for it, the overlay adds a line naming that reason, for example `last cache-affecting events: working-set eviction (reuse measured separately)`, and reports the cache line without the warning token. A reused prompt shell with a cold backend and no recorded reason stays a warning: Clio kept the bytes stable and the provider re-prefilled anyway, which is a disagreement worth surfacing.

### Self-hosted prefix-cache contract

Clio controls the request it sends. The inference server controls cache allocation, retention, eviction, and whether requests reach the same cache. Stable prompt bytes alone do not guarantee reuse.

- **llama.cpp:** reuse can depend on slot selection, KV-pool configuration, and model architecture. Server flags and defaults change between builds; check the documentation for your deployed version.
- **Gateway routes:** the gateway may filter request fields or route successive requests to different backends. A saved Clio target does not prove backend affinity.
- **Other local runtimes:** use the usage or timing fields the server actually reports. Missing cache telemetry is not evidence of a cold cache.

Use `/context` to inspect measured reuse and `clio-coder targets --probe` to inspect the facts Clio discovered. Change a server setting only after checking its version-specific meaning and measuring your workload.

</details>

## Prompt pre-warm

Pre-warming is **off by default** (`chat.prewarm: false`). When enabled, it makes a small request to an eligible local server before a real turn. It can consume inference capacity and does not guarantee a faster response.

<details>
<summary>When warming runs and what happens on submit</summary>

Prefill can be a significant part of local inference latency. A fresh session's first turn prefills the whole compiled prompt plus the tool schemas before the model emits a token, and a resumed session's first turn prefills the entire replayed history.

Both are paid after the operator presses Enter, and both are fully determined before they type anything. Since llama.cpp picks the slot with the longest common prefix and re-evaluates only the suffix, sending that prefix early may make the later turn faster when the backend retains and reuses it.

Clio sends it at three moments: after the session prompt compiles at session start, after a resume rebuilds the message array, and after a compaction settles. The third is included because the next turn is known to be cold and the operator is usually reading the summary rather than typing.

The payload is the request the next turn would send minus the operator's text: the same system prompt, the same tool schemas, the same replayed messages, the same thinking level, and the same `cache_prompt`, with one single-character user message appended so the chat template renders the prefix up to the user turn, and `max_tokens: 1`.

It is built through the same `streamSimple` dispatcher `createEngineAgent` hands the engine as its `streamFn`, not a hand-assembled payload, because any byte that differs ahead of the user turn defeats the purpose.

Warming is skipped while a main turn or any dispatch is active. It also checks endpoint capacity and claims a slot for the duration of its request. This is a conservative admission rule: an unrelated active dispatch can still prevent warming.

Eligible routes include supported `local-native` targets and the explicitly recognized LiteLLM-to-LM-Studio deployment path. Other cloud or gateway routes do not become eligible merely because `chat.prewarm` is enabled. Workers and headless `run` do not use interactive pre-warming.

Submitting a task detaches an in-flight warm-up so interactive admission does not wait for it. Detaching does not guarantee that the backend stops processing the request. Clio still records the completed request's usage; it stops showing that round as the current pre-warm when it no longer describes the next prompt.

Each round appends one `prewarm` custom ledger entry carrying its trigger, the backend prompt tokens, `timing`, and `promptCache`. The entry is never rendered and never becomes a model message, so it contributes zero tokens to the context estimate.

`/context` shows `prewarmed: N tokens in X ms` until the next settled run answers the question it asked. `prewarm` is never an expected-cold reason: a pre-warm is the opposite of a disturbance. Its provider usage is real spend and is reported to `/usage` and `clio-coder usage report` under its own row, the way a `/btw` side question is.

</details>

## Settings

The defaults below are enough for most sessions. Change them through `/settings` when you have a specific reason; see the [configuration reference](../guide/configuration-reference.md) for validation and precedence.


| Setting | Default | Purpose |
| --- | --- | --- |
| `context.compaction.auto` | `true` | Enable automatic pressure handling. |
| `context.compaction.threshold` | `0.8` | Pressure level that triggers it. |
| `context.workingSet.target` | `0.6` | Target pressure after eviction when enough material can be removed. |
| `chat.prewarm` | `false` | Opt into eligible local prompt warming. |

<details>
<summary>All working-set settings and a YAML example</summary>

The public settings use one compaction threshold plus a non-destructive working-set stage:

```yaml
chat:
  prewarm: false

context:
  workingSet:
    enabled: true
    policy: structural-v1
    target: 0.6
    protectLastTurns: 6
    minEvictableTokens: 200
  compaction:
    auto: true
    threshold: 0.8
    # model: provider/summary-model-id
    # systemPrompt: ~/.config/clio-coder/prompts/compaction.md
```

`context.compaction.auto` controls the pre-request trigger. Manual `/context compact` still runs when `auto` is false. `context.compaction.model` optionally selects a dedicated summarization model, and `context.compaction.systemPrompt` optionally points at a prompt override file. The retired `compaction.excludeLastTurns` key is not part of settings v2. The temporary legacy mask uses its compiled six-turn fallback, while working-set protection uses `context.workingSet.protectLastTurns`.

| Key | Default | Accepted | Meaning |
| --- | --- | --- | --- |
| `context.workingSet.enabled` | `true` | boolean | `false` skips eviction and goes directly to summary compaction. It does not restore the destructive mask. |
| `context.workingSet.policy` | `structural-v1` | `age-horizon`, `structural-v1` | Candidate selection rule set. `age-horizon` is the pre-layer age selection. |
| `context.workingSet.target` | `0.6` | number greater than 0 and less than 1 | Used-over-window ratio an applied eviction event batches down to. |
| `context.workingSet.protectLastTurns` | `6` | integer ≥ 1 | Recent turns whose observations and thinking are never evicted. |
| `context.workingSet.minEvictableTokens` | `200` | integer ≥ 0 | Results below this body estimate are never evicted. The default is a measured low-yield churn guard; marker break-even is enforced separately. |

Set `CLIO_CODER_LEGACY_MASK=1` only as a temporary compatibility escape hatch for the old destructive mask stage. See [context-working-set.md](context-working-set.md) for what each policy selects and why.

Settings validation is strict: an older file still carrying the removed `compaction.thresholds` block fails to load with the exact key path during normal startup. Edit removed or unknown keys deliberately; `clio-coder doctor --fix` does not transform settings into the current schema.

---

</details>

## Directory-scoped project handbooks

`CLIO-CODER.md` supplies project guidance. Deeper directories can add their own guidance, while `CLIO-CODER.override.md` replaces inherited layers for its subtree. An empty override does not silently restore the instructions it replaced.

<details>
<summary>Handbook inheritance, overrides, and reset behavior</summary>

Project guidance is resolved from the filesystem root to the working directory. An ordinary `CLIO-CODER.md` adds a layer for its directory and descendants. `CLIO-CODER.override.md` starts a replacement boundary: it wins over `CLIO-CODER.md` in the same directory, discards all handbook layers inherited from ancestors, and remains effective below that directory. Ordinary handbooks in deeper directories may add new layers after the override. A sibling outside the override's subtree keeps its own inherited chain.

For example, a session in `repo/src/parser/` loads `repo/src/CLIO-CODER.override.md` followed by `repo/src/parser/CLIO-CODER.md`; it does not load `repo/CLIO-CODER.md`. A session in `repo/docs/` still loads `repo/CLIO-CODER.md`. Selected readable, non-whitespace-only handbooks are ordinary authored Markdown: arbitrary headings and a missing project identity are accepted, and source bytes are preserved.

A strict structured projection is optional and may be absent; it never fabricates a project name or rules. Surviving source layers render ancestor-to-descendant with explicit paths, subject to the preload budget below.

An empty or unreadable override fails closed. Clio reports that file but does not reactivate the inherited or same-directory handbook it replaced. Ordinary Markdown does not have to satisfy the generated-handbook schema. `clio-coder config inspect` lists every effective handbook and its layer number.

Handbook resolution is read-only. `/context init` and its CLI form are the only commands that author or update the exact `CLIO-CODER.md` in the current directory; `/context refresh` touches neither standard nor override handbooks. Neither command rewrites an inherited file or an override.

A same-directory override therefore continues to shadow a standard handbook created or updated by init until the operator removes the override. Normal reset preserves both handbook names; `context reset --all` may remove the local standard `CLIO-CODER.md` after its second confirmation but always preserves `CLIO-CODER.override.md` as operator-authored context.

</details>

## Project-context preload class

Small handbooks enter the prompt directly. Oversized guidance is only partially included, with paths and omitted ranges so Clio can retrieve more when needed. Partial preload is not the same as reading the whole handbook.

<details>
<summary>Preload limits and how omitted guidance is reported</summary>

The compiled session prompt uses one bounded selector in `src/domains/prompts/preload.ts`. Small rendered inputs remain exact; oversized authored handbooks retain safe exact prefixes within 8,000 UTF-16 units and 220 rendered lines, including metadata.

Allocation favors nearest layers and renders included layers ancestor-first. It no longer replaces oversized guidance with a lossy synopsis. Model-facing omission notices identify source paths and included/omitted physical line ranges with retrieval instructions.

Captured-source hashes are retained separately in preload classification and accounting/manifest metadata; they are not printed as per-source hashes in those notices. The conservative prefix scanner preserves line endings, whitespace, Unicode, and complete command lines; an oversized first block may leave no authored excerpt.

This is incomplete guidance, not a complete policy. Reporting surfaces share the selection:

- `/context init` and `clio-coder context init` report full or partial preload, included UTF-16 units and rendered lines, and source omission accounting; they warn when a full preload is within 10% of either limit.
- `clio-coder config inspect` shows the shared preload class and layer position on every effective handbook entry.
- The `/context` overlay shows a `project preload:` line under the category legend once a session prompt has compiled, followed by the effective handbook path(s): one `handbook:` line for a single file, or a `handbooks (ancestor → nearest):` list when layered handbooks apply. Paths render workspace-relative; a handbook above the workspace keeps a `~`-shortened or absolute path.

</details>

## Context refresh

**Refresh updates the structural index; init manages the local handbook.** Plain init preserves existing authored guidance. Explicit proposal and publication options let you review generated changes before adopting them.

<details>
<summary>Init, proposals, refresh, and publishing a handbook</summary>

`/context refresh` and `clio-coder context refresh` rebuild the structural codewiki
and restamp `.clio-coder/state.json` without reading or writing inherited handbooks or overrides. The CLI
flag `--wiki` is the only refresh path that may update the Markdown wiki, and
it only runs when an existing wiki metadata file is present. Regenerating or
updating the exact local standard handbook stays with `/context init`.

`clio-coder context init` is model-driven by default; `--heuristic` selects deterministic offline generation. Plain init preserves an existing authored handbook. When a generator produces a candidate, it writes a review proposal under `.clio-coder/proposals/` with adjacent JSON recording generation telemetry, source hash, and proposal hash.

`--propose` never publishes, even when no handbook exists. `--apply` and `--rewrite` explicitly publish generated updates or replacements. Publication provenance changes only when the handbook is published. Generated drafts still pass strict proposal and serialization validation; accepting ordinary authored Markdown does not relax those checks.

When bootstrapping across local runtimes such as `llamacpp` where strict grammar/schema enforcement might be rejected by the endpoint, generator logic retries automatically using a bounded prompt-parser fallback. If `--rewrite` was requested but the model generation fails to produce a valid handbook rewrite, `clio-coder context init` prints a notice and exits with code 1 rather than leaving an inconsistent state.

</details>

## Generated handbook structure and verification expectations

Generated handbooks use repository evidence such as manifests, source structure, and declared checks. A suggested verification command is not evidence that it ran. Review generated guidance before relying on it.

<details>
<summary>What handbook generation derives from the repository</summary>

During handbook generation (`context init` and `clio-coder context init`), Clio derives structural sections from workspace manifests and toolchains. Starter project-wide rules come only from scanned project-wide instruction locations and explicitly opted-in global Codex guidance; directory-scoped skills, examples, and nested instructions remain evidence with their original scope. Declared verification commands are suggestions, not evidence that they were executed:

- **Context retrieval**: Derived from the codewiki index, naming primary entry points and directing agents to use `code_nav` for navigation. To prevent staleness across repository mutations, exact volatile file counts are omitted.
- **Verification expectations**: Synthesized from declared toolchain configuration and manifest files:
  - **Node.js**: Detects the active package manager (`npm`, `pnpm`, `yarn`, or `bun`) and names declared non-mutating scripts (`typecheck`, `lint`, `format`, `build`, `test`, `ci`, `test:contracts`, `test:smoke`, `check:boundaries`).
  - **CMake**: Inspects `CMakePresets.json` and emits declared configure, build, and test presets independently.
  - **Rust / Cargo**: Names `cargo build` and `cargo test` when `Cargo.toml` is present.
  - **Go**: Names `go build ./...` and `go test ./...` when `go.mod` is present.
  - **Python**: Detects declared runners (`tox` via `tox.ini` or `[tool.tox]` in `pyproject.toml`; `pytest` via `pytest.ini` or `[tool.pytest.ini_options]` in `pyproject.toml`) and names them without guessing undeclared runners.

---

</details>

## Codewiki and Wiki

The **structural codewiki** supports code navigation without a model call. The optional **Markdown wiki** is generated through worker dispatches. They are separate artifacts with different costs and update rules.

<details>
<summary>How the two layers differ in cost, producer, and prompt surfacing</summary>

Project context has two local layers. The structural layer is model-free and
feeds navigation. The Markdown wiki layer is agent-authored and exists only
when the operator explicitly asks for it.

| Layer | Artifact | Producer | Model use | Prompt surfacing |
| --- | --- | --- | --- | --- |
| Structural codewiki | `.clio-coder/codewiki.json` plus `.clio-coder/state.json` | `context init`, `context refresh`, `context index`, session freshness checks, and incremental mutation observers | None | `<codewiki>available...; use code_nav</codewiki>` |
| Markdown wiki | `.clio-coder/wiki/**/*.md` plus `.clio-coder/wiki/meta.json` | `clio-coder context wiki` or `clio-coder context refresh --wiki` | Yes, one planning dispatch plus one dispatch per page | `<wiki>N pages at .clio-coder/wiki (start: quickstart.md)...</wiki>` |

</details>

<details>
<summary>What the structural index records, and rebuilding it from a seed</summary>

### Structural Index

 `.clio-coder/codewiki.json` uses schema v5 and is written as compact JSON. File records contain a stable id, path, language, line count, role, per-file content hash, extracted import specifiers, and an optional first docstring/JSDoc summary.

Symbol records store declaration-level symbols only (such as classes, interfaces, types, global functions, and methods) and intentionally skip function-local symbols. Each record stores name, kind, file id, line, and optional signature. Edges are built from imports and record either an internal file id target or an external module string.

In Git workspaces, the indexer uses the same visible file set across full builds, incremental updates, fingerprints, and project profiles: tracked files plus untracked, unignored work in progress. It excludes symlinks, submodule gitlinks, generated output, scratch space, and local-state directories such as `.git`, `.clio-coder`, `.superpowers`, `.codex`, `.claude`, `node_modules`, `dist`, `build`, `coverage`, virtualenvs, `target`, and `vendor`.

Non-Git workspaces use a bounded filesystem walk with the same directory exclusions. Source coverage spans TypeScript, JavaScript, Python, Rust, Go, C, C++, CUDA (`.cu` and `.cuh`), Java, Ruby, and C#, with config entries for manifests such as `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `CMakeLists.txt`, `Gemfile`, and `*.csproj`.

Codewiki reconciliation runs in a worker under the coordinator’s artifact lease. When the selected input is the exact committed index read under that lease, the coordinator sends an artifact reference and recorded line total instead of cloning the parsed index between threads.

An unchanged reconciliation returns only its fingerprint; stale and incremental paths load the artifact in the worker. Reset shares the writer queue and lease, so admitted writes finish before reset removes their output and later incremental notifications cannot recreate an absent index.

Extraction is async and tree-sitter-first. Clio loads WASM grammars for the ten source languages above, extracts symbols/imports/exports, and merges available regex import extraction. A failed parse falls back to the available regex extractor for that file.

Python edges distinguish relative import levels and absolute package imports, using package initializer evidence; they describe a static source graph and do not execute import hooks or infer arbitrary PYTHONPATH settings. Fingerprint migration also reconciles old edges when source bytes are unchanged.

Ambiguous `.h` files are classified deterministically by `classifyCHeaderLanguage` (`src/core/c-header-language.ts`). The scanner removes comments before checking C++-only standard-library includes, and removes comments and literals before checking C++ syntax markers such as templates, namespaces, class/member declarations, scope resolution, C++ casts, and C++ qualifiers.

If any C++ marker is present, the header is indexed as `c++`; otherwise, it defaults to `c`. This guarantees that both full indexing and incremental file syncs assign identical language tags to `.h` files. Declaration-only C/C++ APIs are indexed so header-heavy MPI, CUDA, and scientific libraries remain navigable even when implementations live elsewhere.

Successful file-mutating tools report changed paths through a coalesced, serialized observer queue. Path updates can reuse unchanged parse records and reparse changed files, but publishing a new global fingerprint requires full source-content reconciliation so an unnotified edit cannot be certified as current.

The coordinator brackets reconciliation with source-byte fingerprints and retries an unstable scan up to three times; unreadable or persistently changing inputs prevent certification. An unchanged notification retains the previous global baseline instead of certifying unrelated files.

Deleted records are removed and import edges are rebuilt from the reconciled records. This reduces reparsing work, not the source reads needed to establish global freshness.

</details>

<details>
<summary>Deriving an architecture map and when citations can be pinned</summary>

### Architecture seed

 `clio-coder context map` derives an archify architecture specification from the structural index with no model call and writes it to `.clio-coder/artifacts/maps/<repo>.architecture.json` (or `--out <path>`). Map generation reconciles the existing structural index before mapping; missing index refuses, naming `clio-coder context index`.

Pinned source citations require that the workspace is clean at repository root, indexed file bytes match current files and Git blobs, the origin remote is a GitHub URL, and `HEAD` is a full revision. When those conditions hold, components carry `sources` naming indexed files and declared symbol lines.

Unknown or dirty source states cleanly produce usable uncited architecture seeds; `--json` reports the path, component and connection counts, repository metadata, reconciled index status, and source state (`clean`, `dirty`, or `unknown`). Component IDs remain unique across internal and external names, connection IDs are unique, and matching directory/package names retain separate import destinations and counts.

Placement is layered by import direction with explicit routes for archify's standard profile; composition warnings may still require operator edits.

Clio never renders the seed directly: the architecture mapping pipeline separates deterministic seed generation (`context map`), model-authored refinement (`archify` skill), validation and delivery (`archify validate` / `deliver`), and review.

Standard validation checks schema conformance and layout composition, while verification commands check path and symbol citations against the workspace. Mechanical validation passes do not establish semantic claims or visual layout quality: source review assesses semantic claims, while visual review in a browser assesses layout presentation.

Custom model-authored maps can remain layout-invalid until refined. When the seed carries pinned repository evidence, pass `--repo-root .` to re-verify every cited path against the working tree; omit that option for an unpinned seed.

</details>

<details>
<summary>Wiki generation, interrupted-run recovery, and how `code_nav` resolves</summary>

### Markdown Wiki & `code_nav` Resolution


The wiki lives under `.clio-coder/wiki/` as a nested tree and is written by the
`wiki-writer` agent. Model agents resolve pages dynamically through `code_nav`
with `mode: "wiki"`; an optional query resolves a page id or title, where the id
is the page's path without its extension (`domains/dispatch`), and returns its
summary and path. That gives deterministic on-demand navigation without loading
whole pages into prompt context.

The unit of work is one page, not one wiki. A run makes a single planning dispatch, then one dispatch per page, each with a fresh context holding only that page's plan entry, its anchor sources, and the sibling paths it may link to. The repository-wide payload, including the codewiki digest, appears only in the planning prompt.

Because a static prompt is re-sent on every round of a run, this is what keeps prefill cost from growing quadratically with the size of the wiki. Ordinary planner, page, and whole-run time and tool estimates are advisory across generation, not automatic aborts.

An explicit caller deadline (`timeout_ms`) or operator cancellation remains authoritative. Failed writers remain pending; admission rejection does not consume a writer attempt.

`_plan.json` is the skeleton and checkpoint. A deterministic codewiki plan exists before model dispatch; the planner may merge, split, rename, drop, or re-anchor entries, with malformed rewrites falling back to the candidate. The harness owns completion and attempts.

Changes to authored title, intent, or source set reset progress; dropped planned pages are checkpointed as retirements and removed during assembly. A resumed checkpoint checks source evidence and conservatively requeues pages when it is missing or changed.

Resolved and requested coverage depth (`auto`, `simple`, `medium`, `detailed`) are harness-owned. Explicit upgrades and downgrades requeue coverage with existing prose retained, while dispatch receipts remain untouched. Default interrupted and partial retries retain saved depth; completed auto updates may increase coverage as the codebase grows.

Every depth requires the same evidence accuracy.

Every page opens with repaired front matter. Its metadata model has `title`,
`summary`, `sources`, `symbols`, `tests`, `invariants`, and `validate`, but the
serializer always writes only `title`, adds `summary` when non-empty, and omits
empty list fields. That metadata is the retrieval layer: `quickstart.md`, every
directory `index.md`, and the task-routing table are generated from the repaired
values after each run, so writers do not have to maintain those navigation pages by hand. This does not prove the generated prose is correct.

Both original writer output and completed saved pages pass nonmutating mechanical validation before completion or reuse. Supported missing or escaping paths, invalid line ranges, malformed source/test metadata, and empty bodies keep pages pending.

Canonical metadata and body citations participate in source-byte dependencies, including JS source aliases. Failed refreshes retain dependencies; successful repairs replace them so obsolete references can retire. Assembly mechanically repairs missing headings, malformed front matter, dangling citations, and links, reporting repairs or omission markers.

Assembly repair alone does not establish completion: a page is complete only after a successful writer dispatch and retention by assembly. Mechanical evidence checks do not prove semantic claims or that the model read the source. Empty pages, failed writers, and unplanned writer-added pages remain pending.

Existing readable prose can remain available after a failed update while its page stays pending and stale. Writer-discovered source and test dependencies survive routing repair for later update scoping.

`meta.json` records content publication time and model provenance, source evidence, the page-tree content hash, page list, and plan. `generation.pagesPlanned` and `generation.pagesWritten` describe completeness. A `generated` outcome means content was published; `noop` means Markdown bytes were unchanged.

Either can still have pending pages. Unchanged-content attempts persist plan progress and attempts without changing content-publication time or model provenance; successful unchanged-content writers can validate existing prose. The CLI reports `incomplete` when any pages remain pending, with separate published, complete, and pending counts and explicit recovery instructions.

`clio-coder context wiki` creates or updates a wiki and first refreshes a stale structural index. `--update` requests update mode explicitly; it refreshes stale pages based on changed source dependencies, but is not a promise to overcome exhausted attempts.

`clio-coder context wiki --retry-pending` retries each pending page once, including exhausted pages, without erasing cumulative attempts or replanning at the same depth. If no saved plan exists, `--retry-pending` produces an actionable failure without spending model calls.

`--status` reads status and retained failure diagnostics without a model call. Metadata is prepared beside staged pages before publication. After process interruption, the next generation validates live and previous content/metadata pairs and restores a valid previous pair when live is absent or incomplete, preserving a damaged live tree separately.

The wiki lock serializes generation, but other editors are not locked out and readers can observe the rename gap: this is process-crash recovery, not atomic directory exchange or power-loss durability. `clio-coder context refresh --wiki` rebuilds codewiki and updates only an existing wiki.

</details>

<details>
<summary>What each session event and `context` command does to both layers</summary>

### Lifecycle Matrix


| Event | Structural codewiki behavior | Markdown wiki behavior |
| --- | --- | --- |
| Session start | If state or `.clio-coder/codewiki.json` already exists, Clio checks freshness best-effort and performs a full rebuild when the index is stale, missing, unreadable, or needs v5 backfill. Never-indexed directories are skipped. | No generation or update. Existing wiki status may surface in the welcome dashboard. |
| In-session edits | Successful file mutations enqueue changed paths for incremental `updateCodewikiPaths`; the queue is serialized and best-effort. | No automatic update. |
| Session stop | Drains queued incremental writes and records `lastSessionAt` when project state exists. It does not rebuild the index; out-of-band drift is checked at the next session start. | No automatic update. |
| `/context init` or `clio-coder context init` | Performs a full codewiki rebuild before generating, preserving, proposing, or previewing `CLIO-CODER.md`; writes state with the fingerprint and codewiki version when it writes state. | No wiki generation. |
| `/context refresh` or `clio-coder context refresh` | Performs a full codewiki rebuild and writes state. Does not touch `CLIO-CODER.md`. | If an existing wiki is stale and `--wiki` was not passed on the CLI, prints a hint to run `clio-coder context refresh --wiki` or `clio-coder context wiki --update`. |
| `clio-coder context refresh --wiki` | Performs the same full codewiki rebuild and state write. | Updates an existing wiki through the model-backed page dispatches. No wiki metadata means no wiki model call. |
| `clio-coder context wiki` | Automatically refreshes the codewiki index if stale before composing the wiki prompt. | Plans, dispatches each owed page, validates completion outcomes, and publishes assembled content or records unchanged-content progress; failed pages remain pending. |
| `clio-coder context wiki --status` | No index rebuild. | Reads metadata and reports page count, update time, recorded git head, git-head drift, and how many planned pages remain unwritten. |

</details>

<details>
<summary>How the tree-hash fingerprint decides the index is stale</summary>

### Staleness

 Codewiki staleness uses `isStale(prev, curr)`, comparing `fingerprint.treeHash`. The v3 fingerprint hashes each included relative path and its source-byte digest, so whitespace-only edits and same-size edits with restored timestamps invalidate it.

It covers the shared visible indexable file set and excludes ignored/generated/local-state paths. Read errors fail certification. Cached status checks may reuse a fingerprint for five seconds; individual reads remain synchronous even in the cooperatively yielding path.

`gitHead` and `loc` remain reporting fields. Older fingerprint domains invalidate once and trigger reconciliation; this is not an atomic filesystem snapshot.

`.clio-coder/state.json` stores the fingerprint and optional `codewikiVersion`.
Legacy v2/v3/v4 codewiki files can still be read as degraded v5 artifacts, but
their missing or deliberately invalidated per-file hashes make `codewikiNeedsBackfill` true. The
next session freshness check, `code_nav` demand load, wiki generation, or
explicit refresh rebuilds them into full v5.

Wiki staleness uses separate bounded source-byte evidence, including README and configuration files beyond the structural index. Before/after capture and claimed-directory comparisons detect changed, added, or deleted inputs; changes during generation return previously written pages to pending.

Capture is limited to 20,000 files and 128 MiB of source bytes. Missing, legacy, unreadable, or over-limit evidence cannot certify freshness, and unavailable Git evidence is conservative rather than treated as a clean diff. These observations do not form an atomic filesystem snapshot or a complete semantic input manifest.

</details>

<details>
<summary>Which markers reach the prompt and what they do not validate</summary>

### Surfacing and Navigation


Project-type markers use the type recorded in `state.json`, falling back to detection only when no state exists. The codewiki marker checks artifact presence and recorded source freshness without parsing the index on the prompt path. It does not validate artifact contents: `code_nav` and session freshness checks read the index and rebuild an unreadable artifact from source before using it.

The compiled prompt surfaces only markers, never the codewiki JSON or wiki page
contents. Fresh codewiki renders as `<codewiki>available; use code_nav</codewiki>`.
A stale codewiki marker adds `(stale; run /context refresh)`. A valid wiki marker
names the page count and `quickstart.md`; a stale wiki marker adds `(stale; run
clio-coder context wiki --update)`.

`clio-coder context` prints a structural digest from `renderCodewikiDigest`: schema
version, project language, file/config/symbol/edge counts, language and role
counts, top areas, entry points, key symbols, and dependency samples. The
welcome dashboard shows module count, wiki page count and freshness, and a
small entry-point excerpt from the same digest. Agents query the structural
layer through the read-only `code_nav` tool. See [tool-usage.md](../guide/tool-usage.md)
for the full mode reference.

</details>

## Source and related references

| Area | Implementation |
| --- | --- |
| Context estimates and snapshots | [context-accounting.ts](../../src/domains/session/context-accounting.ts), [context-ledger.ts](../../src/domains/session/context-ledger.ts) |
| Compaction and retained history | [compaction](../../src/domains/session/compaction/), [working-set projection](../../src/domains/context/working-set/) |
| Project guidance selection | [preload.ts](../../src/domains/prompts/preload.ts) |
| Interactive warming | [turn-prewarm.ts](../../src/interactive/turn-prewarm.ts) |

Continue with [working-set eviction and recall](context-working-set.md), [prompt composition](prompt-envelope-and-tools.md), or [session history](session-lifecycle.md).
