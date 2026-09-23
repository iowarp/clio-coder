# Context Engine

The context engine manages token budgeting, repository indexing, prompt compilation, and multi-tier compaction across [src/domains/context/](../../src/domains/context/) and [src/domains/session/](../../src/domains/session/).

---

## Action Map

| Need | Surface |
| --- | --- |
| Check live token budget and pressure | `/context` or `context(scope="budget")` |
| Force eviction or compaction | `/context compact` or `self_compact({note_to_self})` |
| Recover interrupted compaction | `/context recover <handoffId> <reduce\|deliver>` |
| Build / refresh structural code index | `clio-coder context init` or `clio-coder context refresh` |
| Generate Markdown architecture wiki | `clio-coder context wiki` |
| Inspect effective settings & context config | `context(scope="settings")` |

---

## Context Window Resolution

The context engine resolves a model's effective context window ($W$) using a strict priority hierarchy:

1. **Operator Target Override**: `targets[].contextWindow` in `settings.yaml`.
2. **Model Catalog Declaration**: `catalog.models[id].contextWindow` from registered manifests.
3. **Live Provider Probe**: Dynamically extracted via `/models` or `/api/ps` (e.g. Ollama native runtime).
4. **Fallback Default**: Engine default (128,000 tokens).

### Usable Budget vs Reserved Output

$$	ext{Usable Input Budget} = \min(W, 	ext{Target Cap}) - 	ext{Reserved Output} - 	ext{Safety Headroom}$$

- **Reserved Output**: Dedicated buffer for assistant response generation (defaults to model advertised max or 4,096 tokens).
- **Safety Headroom**: Bounded buffer (default 1,024 tokens) preventing hard provider overflows.

---

## Token Accounting & Ledger

Tokens are tracked through an append-only ledger ([src/domains/session/context-ledger.ts](../../src/domains/session/context-ledger.ts)):

- **Turn Accounting**: Every turn records input tokens, output tokens, cached tokens, and provider-reported reasoning tokens.
- **Snapshot Ledger**: Emits `contextAccounting` records on each stream settlement.
- **Ledger Invariant**: Persisted token counts are immutable; compaction records append delta adjustments rather than rewriting past history.

---

## Single-Threshold Compaction Pipeline

When session token pressure exceeds `context.compaction.threshold` (default 80% of usable budget), the engine executes a three-tier reduction pipeline:

```
[Token Pressure > 80%]
       │
       ▼
1. Working-Set Eviction ──(Under Budget?)──► [Resume Turn]
       │ No
       ▼
2. Targeted Recall Check
       │ Still Over
       ▼
3. LLM Summary Handoff ──► [Persist Session v5 Record] ──► [Resume Turn]
```

### 1. Working-Set Eviction
Non-destructive observation pruning:
- Replaces bulky tool execution bodies (e.g., extensive `grep`, `read`, `bash` outputs) with lightweight tombstone markers.
- **Tombstone Format**: Record ID, execution digest, byte count, and recall key.
- **Preserved Content**: Agent reasoning, user prompts, file mutation diffs, and the most recent 2 turns are immune from working-set eviction.

### 2. Recall Semantics
Evicted observations can be selectively re-hydrated:
- The model or operator requests restoration using `/context recall <recordId>`.
- Restored blocks are re-inserted into the active working set, triggering re-compaction of older entries if budget pressure demands.

### 3. LLM Summary Handoff
Last-resort compaction when eviction cannot reclaim enough space:
- Invokes a dedicated summary model (or active target) with a structured prompt.
- Produces an assistant-authored note-to-self capturing core objectives, active findings, modified files, and pending next steps.
- Appends a `summary` and `contextPruned` record in session format v5.
- Original turns remain preserved in history and `/view transcript` but are evicted from active model context.

---

## Cache Divergence & Prefix Caching

Clio stabilizes the prompt prefix to maximize KV-cache reuse on providers supporting prefix caching (Anthropic, Gemini, OpenAI, llama.cpp):

| Layer | Volatility | Position in Prompt | Cache Retention |
| :--- | :--- | :--- | :--- |
| **System Prompt & Identity** | Static | Top | Permanent across session |
| **Tools & Gateway Declarations** | Infrequent | Header | Stays warm unless tools toggle |
| **Project Handbook & Codewiki** | Low | Upper-middle | Warm until files mutate |
| **Durable Memories & Handoffs** | Medium | Lower-middle | Re-evaluated at turn boundaries |
| **Active Turn History** | High | Tail (Bottom) | Growing delta |

- **Cache Tracking**: Reports `cached <N>` tokens on turn receipts.
- **Divergence Honesty**: When prompt compilation drifts (e.g. tools change), receipts explicitly report `cold: prompt recompiled` rather than reporting false cache metrics.

---

## Configuration Settings

Settings defined under `context.*` in `settings.yaml`:

| Setting | Default | Purpose |
| :--- | :--- | :--- |
| `context.autoCompaction` | `true` | Enable automatic background multi-tier compaction. |
| `context.compaction.threshold` | `0.80` | Usable budget occupancy fraction triggering compaction. |
| `context.compaction.model` | `null` | Optional dedicated model target for summary handoffs. |
| `context.toolResultMaxBytes` | `65536` | Maximum bytes retained per tool execution before scratch offload. |
| `context.workingSet.enabled` | `true` | Enable non-destructive working-set observation eviction. |
| `context.workingSet.policy` | `"structural-v1"` | Eviction strategy (`structural-v1` or `age-horizon`). |

---

## Project Handbooks & Preload

Clio discovers and injects project context hierarchically:
- **Root Handbook**: `CLIO-CODER.md` at repository root.
- **Directory Overrides**: `CLIO-CODER.override.md` scoped to specific subtrees.
- **Preload Class**: Read-only instructions compiled into the stable system prompt layer.

---

## Codewiki & Architecture Index

The repository maintains two local knowledge layers:

| Layer | Artifact | Generator | Prompt Surfacing |
| :--- | :--- | :--- | :--- |
| **Structural Codewiki** | `.clio-coder/codewiki.json` (schema v5) | `context init` / `refresh` (model-free) | `<codewiki>` tag via `code_nav` |
| **Markdown Wiki** | `.clio-coder/wiki/**/*.md` | `context wiki` (dispatched workers) | `<wiki>` overview tag |

### Structural Index Lifecycle
- Built on session initialization or explicitly via `clio-coder context init`.
- Tracks file paths, languages, roles, hashes, export/import symbols, and dependency edges.
- Powers fast symbol search and repository navigation without consuming LLM inference calls.
