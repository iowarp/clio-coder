# Prompt Envelope and Tools

Clio Coder keeps the model-facing envelope stable and moves enforcement into the runtime registry and safety policy.

## One system prompt per session

The chat loop compiles one provider-facing system prompt for a session. The compile key is `endpoint|model|autonomy|sessionId`.

The compiled prompt is reused byte-for-byte on ordinary submits. It recompiles only when that key changes or when config hot-reload invalidates the prompt cache. When recompilation changes the text, the session ledger records a `promptRecompiled` entry with the previous hash, new hash, and token estimate.

There are no dynamic per-turn prompt fragments. Pending skill requests are visible text in the user message, not hidden prompt machinery.

## One tool surface per session

For tool-capable providers, Clio sends the full registry as the session tool surface. The list is deterministic and sorted through the worker-tool resolver, so the serialized schemas stay byte-identical on every submit.

Tool visibility is not a per-turn hinting system. Pending-skill policy, ask-user policy, Bash policy, path policy, protected artifacts, dispatch admission, middleware, and the autonomy mapping are enforced when a tool is invoked. The `autonomy` level is applied at registry admission after the safety net passes a call; the safety prompt fragment mirrors that enforced matrix as guidance to the model. Prompt text and provider schemas do not bypass the registry.

Providers that cannot call tools receive no schemas, and the prompt tells the model to proceed without tool calls.

## Context protection

Clio uses two context-protection mechanisms.

1. Tool results are capped at the source. The default tool-result source cap is 6KB with continuation text for offset and limit style follow-up. Result shaping has an 8KB backstop. Summary-kind tools such as `bash`, `run_task`, `validate_frontend`, `dispatch`, and `web_fetch` have explicit 16KB policies. `ask_user` has a 20KB policy.
2. Auto-compaction uses one pressure threshold. The default threshold is 0.8. When pressure crosses the threshold, Clio first masks stale tool observations older than `excludeLastTurns`. If pressure remains above the threshold, it runs the LLM summary compaction path and replays from the compacted session view.

Manual `/compact`, `CLIO_FORCE_COMPACT=1`, and overflow recovery force the LLM summary path directly.

Compaction rewrites history, so the next turn on a local single-slot backend is expected to lose prefix-cache alignment. Clio records `expectedColdReasons` and shows one dim notice for that turn.

## Inspecting a session

Use the turn report to inspect persisted timing and cache behavior:

```bash
node scripts/turn-report.mjs --session <id>
```

The report prints per-call `ttft`, `api`, input, cache read, cache write, backend cache verdict, and expected cold reasons. Cache verdicts are `hot`, `partial`, `cold`, or `small`.
