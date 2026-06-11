# Context Engine

Clio Coder tracks context pressure, records per-turn snapshots, and protects the provider context with bounded tool results plus single-threshold compaction.

Source of truth lives in `src/domains/session/context-accounting.ts`, `src/domains/session/context-ledger.ts`, `src/domains/session/compaction/`, and the chat-loop integration in `src/interactive/chat-loop.ts`.

## Context window resolution

Each target has a declared, desired, and effective context window. The effective window is the operating ceiling used by budget checks and compaction. It can come from a live loaded model config, a probe, an endpoint override, a model hint, catalog knowledge, a local-native default, or a descriptor default.

Local-native runtimes use a recommended minimum desired window of 128,000 tokens. If the live model reports a smaller loaded context window, Clio re-resolves the target so accounting uses the actual ceiling.

## Token accounting and snapshots

The estimator in `context-accounting.ts` uses a four-characters-per-token family for hot-path accounting. It estimates system prompt, tools, messages, pending input, and runtime categories without calling a model tokenizer on every TUI refresh.

At submit time, Clio captures a context snapshot and persists a slim JSONL record under the session directory as `context-snapshots.jsonl`. The slim record keeps token counts, segment metadata, signatures, and hashes, not the heavy prompt or transcript text. When provider usage arrives, `reconcileSnapshot` folds actual input and output counts back into the ledger.

The `/context-view` overlay and footer meter read the same ledger categories: `system`, `tools`, `agents`, `skills`, `memory`, `project`, `messages`, `pending`, `reserve`, `free`, and `streaming`.

## Single-threshold compaction

Auto-compaction is controlled by one pressure threshold. Pressure is `estimated_tokens / context_window`. The default threshold is `0.8`.

When `compaction.auto` is enabled and pressure crosses the threshold before a request, Clio first masks stale tool observations older than `excludeLastTurns`. This is a cheap local rewrite. Tool call and result structure remain present, but the observation body is replaced with a marker.

Marker format:

```text
[Observation masked: <tool> output was <lines> lines, <chars> chars - contents masked to save context. Re-run the tool for current content.] Preview: <preview>
```

Already-compacted entries are not masked again. If masking drops pressure below the threshold, Clio sends the request without an LLM summary. If pressure remains above the threshold, Clio runs the summary compaction path, appends a compaction summary entry, refreshes replay messages from the session, and continues.

Manual `/compact`, `CLIO_FORCE_COMPACT=1`, and overflow recovery force the LLM summary path directly. The overflow guard runs before the user turn is committed, so a blocked oversized request does not leave an unanswered user entry in the ledger.

## Cache-divergence honesty

Compaction rewrites the replayed history. On a local backend with a single prefix-cache slot, the next turn after compaction is expected to be cold because the byte prefix changed. Dispatch traffic can disturb the same slot.

Clio records these disturbances once on the next assistant entry as `promptCache.expectedColdReasons`. The user sees one dim notice, and `turn-report.mjs` renders the expected-cold line next to per-call cache data.

Per-call cache verdicts are `hot`, `partial`, `cold`, and `small`. They are derived from provider usage and persisted with `timing { ttftMs, apiMs }` and `promptCache { input, cacheRead, cacheWrite, backendVerdict }` when available.

## Settings

The public settings block has one threshold and one recent-turn horizon:

```yaml
compaction:
  auto: true
  threshold: 0.8
  excludeLastTurns: 6
  # model: provider/summary-model-id
  # systemPrompt: ~/.config/clio/prompts/compaction.md
```

`auto` controls the pre-request trigger. Manual `/compact` still runs when `auto` is false. `model` optionally selects a dedicated summarization model. `systemPrompt` optionally points at a prompt override file for compaction.

A lifecycle migration named `2026-06-11-compaction-single-threshold` rewrites older settings files to this shape once.
