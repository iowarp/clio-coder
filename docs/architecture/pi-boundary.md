# Pi SDK Boundary

Clio Coder uses Pi 0.84.4 as its provider, agent-loop, and terminal SDK. This
page records where Pi owns a reusable primitive and where Clio deliberately
keeps product behavior. Review this table on every Pi upgrade. An action marked
`Keep` is an explicit boundary decision, not an invitation to replace the
Clio-owned surface during a dependency bump.

## Boundary table

| Pi export or surface | Clio file or function | Action | Reason |
| --- | --- | --- | --- |
| pi-agent-core `truncateHead`, `truncateTail`, `truncateLine`, and `formatSize` | `src/tools/truncate.ts` | Route through Pi. | Pi owns UTF-8-safe truncation. Clio retains its 16 KiB default and `splitLinesForCounting`, which Pi does not export. |
| pi-ai `StringEnum` | `src/engine/ai.ts` | Route through Pi. | The deleted `src/tools/string-enum.ts` TypeBox adapter duplicated Pi's compact provider-safe schema. Tools now import the re-export from the engine boundary. |
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
| pi-agent-core `prepareNextTurn` / `prepareNextTurnWithContext` (0.84.4 ordering: runs only when the loop will start another assistant turn) | `src/interactive/turn-runtime.ts` continuation guard and `src/interactive/turn-context.ts` `postToolContinuationGuard` | Keep `prepareNextTurn`; no adaptation. | The guard already returned early unless the transcript tail was a tool result, so it was continuation-only on 0.84.0. Under 0.84.4 it also stops running after terminating batches and before `agent_end`, which removes a spurious guard failure after `artifact`-style terminal tool results. End-of-run work stays on `agent_end`. Locked by `tests/contracts/engine-lifecycle.test.ts`. |
| pi-agent-core `Agent.reset()` (0.84.1 rejects during an active run) | `src/interactive/chat-loop.ts` `resetForSession` and `src/interactive/session-switch-settlement.ts` | Keep Clio's settle-then-replace reset. | Clio never calls `Agent.reset()`. Every session reset caller cancels and awaits `whenSettled()` first, then replaces `agent.state.messages`; the bang-command path waits on `isStreaming()` before refreshing. The contract test records that a mid-run reset is refused upstream. |
| pi-agent-core `BeforeToolCallResult.terminate` (0.84.1) | `src/tools/agent-tools.ts` blocked-call path | Decline. | Clio blocks tools inside `execute` by throwing the model-facing rejection; a blocked call must not end the batch. Batch termination stays on `AgentToolResult.terminate` from successful terminal tools. |
| pi-agent-core `streamProxy()` namespace metadata (0.84.2) and `ToolCall.namespace` | None | Decline. | Clio does not proxy assistant streams and does not use OpenAI Responses namespaced or deferred tools. |
| pi-ai `SimpleStreamOptions.toolChoice` (0.84.3, `auto` / `none`) | `src/engine/provider-payload.ts` and the `onPayload` hook in `src/interactive/turn-runtime.ts` and `src/engine/worker-runtime.ts` | Keep the Clio payload patch. | Clio needs both `none` and a named required tool across every dialect it serves, including generic OpenAI-compatible servers that reject object `tool_choice`. Splitting `none` onto the neutral option would leave two mechanisms for one concern. |
| pi-ai strict tool-schema conversion and null normalization (0.84.2) | `src/engine/ai.ts` `validateEngineToolArguments` | Inherit. | No Clio tool sets `constrainedSampling`, so strict conversion is inert. `null` for an optional non-nullable argument is now dropped instead of rejected; locked by the engine lifecycle contract. |
| pi-ai OpenAI-compatible reasoning replay and signature serialization fixes (0.84.3, 0.84.4) | `src/engine/apis/openai-completions.ts` | Inherit. | The wrapper delegates `stream` and `streamSimple` to Pi's adapter, so replay fixes apply to in-run turns. Clio's ledger does not persist `thinkingSignature`, so resumed sessions still replay without signatures (pre-existing). |
| pi-ai Anthropic server-side refusal fallback with returned-model pricing (0.84.3) | `src/interactive/turn-context.ts` `reconcileUsage` and `src/domains/observability/trace-store.ts` | Inherit. | Usage and cost arrive already priced for the returned model; Clio records `message.model` as reported. `fallbacks` is only sent for catalog models that declare `allowedFallbackModels`. |
| pi-tui capability overrides (`PI_HYPERLINKS`, `PI_IMAGE_PROTOCOL`, `PI_TRUE_COLOR`, `setCapabilityOverrides`) and `PI_TUI_ESC_TIMEOUT` (0.84.2, 0.84.4) | `src/interactive/theme/tokens.ts` truecolor detection | Decline. | These govern pi-tui's own image, hyperlink, and escape-sequence handling. Clio's theme detects truecolor from `COLORTERM` and `TERM` independently and does not consume pi-tui capability detection. |
| pi-tui `TuiAltScreenOptions.copyOnSelect` / `copySelection` and transcript search (`tui.altScreen.search*`, 0.84.2, 0.84.4) | `src/interactive/interactive-shell.ts` alt-screen construction and `src/domains/config/keybindings.ts` | Inherit defaults. | Selection copy stays on by default. Search is pi-tui's viewport listener and runs before Clio's router; `ctrl+g` advances a match only while the search overlay is focused, so the Clio leader chord is unavailable during a search and nowhere else. Locked by the engine lifecycle contract. |
| pi-tui alternate-screen direct-row painting (0.84.2) | `src/engine/instrumented-tui.ts` | Inherit. | `compositeOverlays`, `extractCursorPosition`, and `applyLineResets` still run inside one `doRender`, so Clio's frame and phase measurements are unchanged. Locked by the engine lifecycle contract. |

## Thin-wrapper watch list

Review these files first when Pi changes. They intentionally contain little
behavior and should not grow another implementation of an SDK primitive.

- `src/engine/api-registry.ts` owns Clio's ordered dispatcher using Pi's public lazy API factories and full built-in provider catalog. Its dynamic `/compat` bridge exists only for configured out-of-tree runtime plugins that require Pi's process-global registry identity.
- `src/engine/env-api-keys.ts` pins Pi 0.84's synchronous environment-key and ambient-credential discovery behind a parity contract; revisit it on every Pi upgrade until Pi exports that helper directly.
- `src/engine/apis/openai-completions.ts` maps compatibility flags, sampling parameters, and thinking budgets. Its Clio deltas are the local-runtime guards and sentinel, Harmony, and Gemma filters.
- `src/engine/provider-payload.ts` retains only the OpenAI Responses reasoning-summary patch.
- `src/engine/types.ts` and `src/engine/ai.ts` expose erased Pi types and `StringEnum` behind the engine boundary.
- `src/domains/session/retry.ts` wraps `isRetryableAssistantError` and adds the local-model loading rule.
- `src/interactive/chat-renderer.ts` consumes Pi's compaction, branch, and bash replay wording through `src/engine/messages.ts`.
- Interactive Markdown, Mermaid, LaTeX, fullscreen, alternate-screen, and keybinding glue should continue to compose pi-tui primitives.

## Pi regression net

Run these contracts first on a Pi bump, before the full gate:

- `tests/contracts/engine-lifecycle.test.ts` (agent-loop ordering, reset, tool-argument normalization, keybinding table, alt-screen render seams)
- `tests/contracts/provider-transport.test.ts`
- `tests/contracts/provider-context-boundary.test.ts`
- `tests/contracts/gemma-channel-filter.test.ts`
- `tests/contracts/tool-boundaries.test.ts`
- `tests/contracts/session-durability.test.ts`
- `tests/smoke/process-lifecycle.test.ts`

The complete upgrade procedure lives in
[Development Pipeline](../process/development-pipeline.md#inheriting-a-pi-release).
