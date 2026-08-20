# Pi SDK Boundary

Clio Coder uses Pi 0.84.0 as its provider, agent-loop, and terminal SDK. This
page records where Pi owns a reusable primitive and where Clio deliberately
keeps product behavior. Review this table on every Pi upgrade. An action marked
`Keep` is an explicit boundary decision, not an invitation to replace the
Clio-owned surface during a dependency bump.

## Boundary table

| Pi export or surface | Clio file or function | Action | Reason |
| --- | --- | --- | --- |
| pi-agent-core `truncateHead`, `truncateTail`, `truncateLine`, and `formatSize` | `src/tools/truncate.ts` | Route through Pi. | Pi owns UTF-8-safe truncation. Clio retains its 16 KiB default and `splitLinesForCounting`, which Pi does not export. |
| pi-ai `StringEnum` | `src/engine/ai.ts` and the `src/tools/string-enum.ts` adapter | Route through Pi. | The former TypeBox implementation duplicated Pi's compact provider-safe schema. |
| pi-agent-core `COMPACTION_SUMMARY_PREFIX`, `COMPACTION_SUMMARY_SUFFIX`, `BRANCH_SUMMARY_PREFIX`, `BRANCH_SUMMARY_SUFFIX`, and `bashExecutionToText` | `src/interactive/chat-renderer.ts` through `src/engine/messages.ts` | Route through Pi. | Replay text must match Pi's `convertToLlm` wording while Clio keeps its `SessionEntry` mapping and replay bounds. |
| pi-tui `stripTerminalSequences` | `src/domains/session/tree/preview.ts` | Keep the Clio sanitizer. | Pi removes SGR and OSC sequences but intentionally leaves private-mode CSI and character-set escapes that may occur in captured tool output. |
| pi-ai `isRetryableAssistantError` | `src/domains/session/retry.ts` | Route generic classification through Pi and keep the Clio delta. | Clio additionally recognizes self-hosted model loading and enforces its separate 15-second floor. |
| pi-ai `retryAssistantCall` and pi-agent-core `AgentHarness` retry | `src/interactive/chat-loop.ts` and `src/interactive/turn-recovery.ts` | Keep Clio orchestration. | Clio retries `agent.continue()` with a visible cancellable countdown. `retryAssistantCall` wraps one completion, and `AgentHarness` requires Pi's session repository. |
| pi-ai `StreamOptions.samplingParams`, `OpenAICompletionsOptions.thinkingBudgets`, and `supportsThinkingTokenBudget` | `src/engine/apis/openai-completions.ts` | Route request controls through Pi. | Clio retains only catalog-to-option selection and runtime-specific payload fields. |
| pi-ai `compat.thinkingFormat` | `src/engine/apis/openai-completions.ts` payload adapters | Keep the LM Studio and llama.cpp deltas. | Pi has no LM Studio TTL or draft-model field and no llama.cpp `cache_prompt` field. |
| pi-agent-core `validateToolArguments` | `src/engine/apis/openai-completions.ts` malformed-call guard | Keep the Clio diagnostic. | Pi returns a validation result so a model can retry. Clio stops a turn from a repeatedly malformed local server and gives the operator a runtime-specific remedy. |
| pi-ai `Usage.reasoning` | `src/engine/apis/openai-completions.ts` reasoning estimate | Keep the Clio fallback. | Some self-hosted servers stream thinking but report no reasoning usage. Clio fills only an absent value. |
| No Pi equivalent | `src/engine/apis/openai-completions.ts` sentinel filters, `src/engine/harmony-response.ts`, and `src/engine/gemma-channel-filter.ts` | Keep Clio ownership. | Pi has no Harmony or Gemma channel parser and no tokenizer-sentinel stream filter. |
| pi-ai `clampMaxTokensToContext` | `src/engine/apis/output-budget.ts` | Keep the Clio outer budget. | Clio adds its default output budget, a llama.cpp tool-turn cap, and the loaded context window. Pi's conservative clamp still runs underneath. |
| pi-ai Anthropic `streamSimple` request assembly | `src/engine/provider-payload.ts` Anthropic thinking patch | Delete the Clio rewrite and route through Pi. | Pi produces the same adaptive effort and token-budget fields from the active thinking level. |
| pi-ai `OpenAIResponsesOptions.reasoningSummary` | `src/engine/provider-payload.ts` OpenAI reasoning-summary patch | Keep the Clio patch. | Pi's `Agent` path calls `streamSimple`, which fixes this field to `auto` and exposes no caller option. |
| No Pi equivalent | `src/engine/apis/ollama-native.ts`, `src/engine/apis/lmstudio.ts`, and `src/engine/apis/llamacpp-residency.ts` | Keep Clio ownership. | Pi's Ollama provider uses OpenAI completions and has no target residency manager. |
| pi-ai `CredentialStore` and `Models.getAuth` | `src/domains/providers/auth/storage.ts` | Keep Clio ownership. | Clio's locked YAML store, damage control, target-first registry, and runtime overrides are product boundaries. |
| pi-ai `createModels`, `createProvider`, and `ModelsStore` | `src/domains/providers/**` | Keep Clio ownership. | Targets, nodes, probing, residency, ALCF, and fleet placement are Clio concepts rather than provider-keyed SDK state. |
| pi-ai `Provider.auth.oauth` | `src/engine/oauth.ts` | Route built-in OAuth through Pi and keep ALCF. | Pi owns provider OAuth implementations. Clio adds the ALCF science-provider flow. |
| pi-agent-core application cut-point helpers | `src/domains/session/compaction/cut-point.ts` | Keep Clio ownership. | The published SDK does not export these helpers, and Clio operates on its larger `SessionEntry` union with a tested small-session fallback. |
| pi-agent-core `estimateTokens` and `estimateContextTokens` | `src/domains/session/compaction/tokens.ts` and `src/domains/session/context-accounting.ts` | Keep Clio ownership. | Clio accounts for message overhead, images, tool-schema splits, and provider-usage reconciliation beyond Pi's character estimate. |
| pi-agent-core `SUMMARIZATION_SYSTEM_PROMPT`, `generateSummary`, and `serializeConversation` | `src/domains/session/compaction/compact.ts` and `src/domains/session/compaction/branch-summary.ts` | Keep Clio ownership. | Pi's functions require Pi v4 entries and `Models`; Clio compacts its ledger with cumulative checkpoints and turn-prefix summaries. |
| pi-agent-core `JsonlSessionRepo`, v4 `Session`, and `AgentHarness` | `src/engine/session.ts` and `src/domains/session/**` | Keep Clio ownership. | The on-disk ledger, active tree, fork behavior, receipts, and evidence are Clio's durable spine. |
| pi-agent-core `loadSkills`, `loadPromptTemplates`, `parseCommandArgs`, `substituteArgs`, and `formatSkillsForSystemPrompt` | `src/domains/resources/skills/loader.ts` and `src/domains/resources/prompts/loader.ts` | Keep Clio loaders and reuse leaf primitives when compatible. | Clio owns marketplace pinning, trust, evals, activation records, and prompt-source policy. Argument substitution can use Pi without replacing the loader. |
| pi-agent-core harness tools, `executeShellWithCapture`, and `sanitizeBinaryOutput` | `src/tools/**` | Keep Clio ownership. | Tool admission, observation budgets, safety rails, and result shaping apply across interactive, headless, ACP, and worker runs. |
| No Pi equivalent | `src/engine/loop-guard.ts`, `src/domains/safety/**`, `src/domains/dispatch/**`, and `src/domains/evidence/**` | Keep Clio ownership. | These surfaces enforce Clio's safety, fleet, receipt, and evidence contracts. |
| pi-tui `wrapTextWithAnsi` | `src/core/termination.ts` | Keep the small ASCII wrapper. | Core cannot import Pi across the engine boundary, and the shutdown notice does not justify another adapter. |
| No pi-tui transcript model | `src/interactive/chat-panel.ts` and `src/interactive/worker-stream.ts` | Keep Clio ownership. | Transcript folding, worker cards, and tool-output collapse are application policy. |
| pi-tui `CombinedAutocompleteProvider` | `src/interactive/slash-autocomplete.ts` | Keep Clio command composition. | Clio's declarative slash specification owns parsing, help, and completion consistency. |
| pi-tui `KeybindingsManager`, `TUI_KEYBINDINGS`, and `Editor.addToHistory` | `src/domains/config/keybindings.ts` and interactive editor wiring | Route terminal actions through Pi. | Pi owns editor behavior while Clio owns the configured bindings and accepted-input policy. |
| pi-tui `Markdown`, `renderLatex`, `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, and `stripTerminalSequences` | Interactive Markdown, Mermaid, layout, and width wiring | Route terminal primitives through Pi. | Clio retains theme tokens, Mermaid span styling, and application layout only. |

## Thin-wrapper watch list

Review these files first when Pi changes. They intentionally contain little
behavior and should not grow another implementation of an SDK primitive.

- `src/engine/apis/index.ts` registers Clio's API provider through pi-ai `/compat`.
- `src/engine/apis/openai-completions.ts` maps compatibility flags, sampling parameters, and thinking budgets. Its Clio deltas are the local-runtime guards and sentinel, Harmony, and Gemma filters.
- `src/engine/provider-payload.ts` retains only the OpenAI Responses reasoning-summary patch.
- `src/engine/types.ts` and `src/engine/ai.ts` expose erased Pi types and `StringEnum` behind the engine boundary.
- `src/domains/session/retry.ts` wraps `isRetryableAssistantError` and adds the local-model loading rule.
- `src/interactive/chat-renderer.ts` consumes Pi's compaction, branch, and bash replay wording through `src/engine/messages.ts`.
- Interactive Markdown, Mermaid, LaTeX, fullscreen, alternate-screen, and keybinding glue should continue to compose pi-tui primitives.

## Pi regression net

Run these contracts first on a Pi bump, before the full gate:

- `tests/contracts/thinking-runtime.test.ts`
- `tests/contracts/openai-completions.test.ts`
- `tests/contracts/lmstudio.test.ts`
- `tests/contracts/lmstudio-instance-resolution.test.ts`
- `tests/contracts/replay-pi-message-text.test.ts`
- `tests/contracts/tool-string-enum.test.ts`
- `tests/smoke/tui-width-matrix.test.ts`
- The headless JSON stream contracts under `tests/contracts/`.

The complete upgrade procedure lives in
[Development Pipeline](development-pipeline.md#inheriting-a-pi-release).
