# Pi SDK Boundary

Clio Coder pins Pi 0.99.1 as its provider, agent-loop, and terminal SDK. This
page describes SDK primitives and Clio-owned behavior. Review these boundaries
when upgrading Pi.

## Boundary table

| Pi export or surface | Clio file or function | Action | Reason |
| --- | --- | --- | --- |
| pi-agent-core `truncateHead`, `truncateTail`, `truncateLine`, and `formatSize` | [truncate.ts](../../src/tools/truncate.ts) | Route through Pi. | Pi owns UTF-8-safe truncation. Clio retains its 16 KiB default and `splitLinesForCounting`, which Pi does not export. |
| pi-ai `StringEnum` | [ai.ts](../../src/engine/ai.ts) | Route through Pi. | Tools import Pi's compact provider-safe schema through the engine boundary. |
| pi-agent-core `COMPACTION_SUMMARY_PREFIX`, `COMPACTION_SUMMARY_SUFFIX`, `BRANCH_SUMMARY_PREFIX`, `BRANCH_SUMMARY_SUFFIX`, and `bashExecutionToText` | [chat-renderer.ts](../../src/interactive/chat-renderer.ts) through [messages.ts](../../src/engine/messages.ts) | Route through Pi. | Replay text must match Pi's `convertToLlm` wording while Clio keeps its `SessionEntry` mapping and replay bounds. |
| pi-tui `stripTerminalSequences` | [preview.ts](../../src/domains/session/tree/preview.ts) | Keep the Clio sanitizer. | Pi removes SGR and OSC sequences but intentionally leaves private-mode CSI and character-set escapes that may occur in captured tool output. |
| pi-ai `isRetryableAssistantError` and `retryDelayMs` | [retry.ts](../../src/domains/session/retry.ts) | Route generic classification and capped exponential backoff through Pi; keep the Clio delta. | Clio additionally recognizes self-hosted model loading and enforces its separate 15-second floor. |
| pi-ai `retryAssistantCall` and pi-agent-core `AgentHarness` retry | [chat-loop.ts](../../src/interactive/chat-loop.ts) and [turn-recovery.ts](../../src/interactive/turn-recovery.ts) | Keep Clio orchestration. | Clio retries `agent.continue()` with a visible cancellable countdown. `retryAssistantCall` wraps one completion, and `AgentHarness` requires Pi's session repository. |
| pi-ai `StreamOptions.samplingParams`, `OpenAICompletionsOptions.thinkingBudgets`, and `supportsThinkingTokenBudget` | [openai-completions.ts](../../src/engine/apis/openai-completions.ts) | Route request controls through Pi. | Clio retains only catalog-to-option selection and runtime-specific payload fields. |
| pi-ai `compat.thinkingFormat` | `src/engine/apis/openai-completions.ts` payload adapters | Keep the LM Studio and llama.cpp deltas. | Pi has no LM Studio TTL or draft-model field and no llama.cpp `cache_prompt` field. |
| pi-agent-core `validateToolArguments` | `src/engine/apis/openai-completions.ts` malformed-call guard | Keep the Clio diagnostic. | Pi returns a validation result so a model can retry. Clio stops a turn from a repeatedly malformed local server and gives the operator a runtime-specific remedy. |
| pi-ai `Usage.reasoning` | `src/engine/apis/openai-completions.ts` reasoning estimate | Keep the Clio fallback. | Some self-hosted servers stream thinking but report no reasoning usage. Clio fills only an absent value. |
| No Pi equivalent | `src/engine/apis/openai-completions.ts` sentinel filters, [harmony-response.ts](../../src/engine/harmony-response.ts), and [gemma-channel-filter.ts](../../src/engine/gemma-channel-filter.ts) | Keep Clio ownership. | Pi has no Harmony or Gemma channel parser and no tokenizer-sentinel stream filter. |
| pi-ai `clampMaxTokensToContext` | [output-budget.ts](../../src/engine/apis/output-budget.ts) | Keep the Clio outer budget. | Clio adds its default output budget, a llama.cpp tool-turn cap, and the loaded context window. Pi's conservative clamp still runs underneath. |
| pi-ai Anthropic `streamSimple` request assembly | [provider-payload.ts](../../src/engine/provider-payload.ts) `patchProviderThinkingPayload` | Route through Pi. | Pi maps the active thinking level onto adaptive effort or a bounded `budget_tokens`, so Clio leaves the Anthropic payload untouched. |
| pi-ai `OpenAIResponsesOptions.reasoningSummary` | `src/engine/provider-payload.ts` OpenAI reasoning-summary patch | Keep the Clio patch. | Pi's `Agent` path calls `streamSimple`, which fixes this field to `auto` and exposes no caller option. |
| No Pi equivalent | [ollama-native.ts](../../src/engine/apis/ollama-native.ts), [lmstudio.ts](../../src/engine/apis/lmstudio.ts), and [llamacpp-residency.ts](../../src/engine/apis/llamacpp-residency.ts) | Keep Clio ownership. | Pi's Ollama provider uses OpenAI completions and has no target residency manager. |
| pi-ai `CredentialStore` and `Models.getAuth` | [storage.ts](../../src/domains/providers/auth/storage.ts) | Keep Clio ownership. | Clio's locked YAML store, damage control, target-first registry, and runtime overrides are product boundaries. |
| pi-ai `createModels`, `createProvider`, and `ModelsStore` | `src/domains/providers/**` | Keep Clio ownership. | Targets, nodes, probing, residency, ALCF, and fleet placement are Clio concepts rather than provider-keyed SDK state. |
| pi-ai `Provider.auth.oauth` | [oauth.ts](../../src/engine/oauth.ts) | Route built-in OAuth through Pi and keep ALCF. | Pi owns provider OAuth implementations. Clio adds the ALCF science-provider flow. |
| pi-agent-core `findCutPoint` and `findTurnStartIndex` | [cut-point.ts](../../src/domains/session/compaction/cut-point.ts) | Keep Clio ownership. | These public root exports accept Pi v4 `Entry[]`; Clio uses its own `SessionEntry` union, ledger indexes, tool-batch boundaries, and small-session fallback. Reuse requires preserving those contracts through an entry/index projection, not a direct import substitution. |
| pi-agent-core `estimateTokens` and `estimateContextTokens` | [tokens.ts](../../src/domains/session/compaction/tokens.ts) and [context-accounting.ts](../../src/domains/session/context-accounting.ts) | Keep Clio's outer accounting. | Pi also anchors estimates to provider usage. Clio additionally accounts for framing, system prompts, tool schemas, pending input, usage invalidation, and the greater of projected and anchored totals. Both use heuristics for unmeasured content; neither character estimate guarantees an upper bound for every tokenizer. |
| pi-agent-core `generateSummary`, `generateSummaryWithUsage`, and `serializeConversation` | [compact.ts](../../src/domains/session/compaction/compact.ts) and [branch-summary.ts](../../src/domains/session/compaction/branch-summary.ts) | Keep the current summary boundary pending a tested adapter. | The public summary generators accept `AgentMessage[]`, `Models`, and Pi harness context; `serializeConversation` accepts provider messages. Clio additionally owns bounded cumulative checkpoints, turn-prefix summaries, cancellation, usage settlement, and publication checks. The internal `SUMMARIZATION_SYSTEM_PROMPT` constant is not a public root export. |
| pi-agent-core `JsonlSessionRepo`, v4 `Session`, and `AgentHarness` | [session.ts](../../src/engine/session.ts) and `src/domains/session/**` | Keep Clio ownership. | The on-disk ledger, active tree, fork behavior, receipts, and evidence are Clio's durable spine. |
| pi-agent-core `loadSkills`, `loadPromptTemplates`, `parseCommandArgs`, `substituteArgs`, and `formatSkillsForSystemPrompt` | [loader.ts](../../src/domains/resources/skills/loader.ts) and [loader.ts](../../src/domains/resources/prompts/loader.ts) | Keep Clio loaders and reuse leaf primitives when compatible. | Clio owns marketplace pinning, trust, activation records, and prompt-source policy. Argument substitution can use Pi without replacing the loader. |
| pi-agent-core harness tools, `executeShellWithCapture`, and `sanitizeBinaryOutput` | `src/tools/**` | Keep Clio ownership. | Tool admission, observation budgets, safety rails, and result shaping apply across interactive, headless, ACP, and worker runs. |
| No Pi equivalent | [loop-guard.ts](../../src/engine/loop-guard.ts), `src/domains/safety/**`, `src/domains/dispatch/**`, and `src/domains/evidence/**` | Keep Clio ownership. | These surfaces enforce Clio's safety, fleet, receipt, and evidence contracts. |
| pi-tui `wrapTextWithAnsi` | [termination.ts](../../src/core/termination.ts) | Keep the small ASCII wrapper. | Core cannot import Pi across the engine boundary, and the shutdown notice does not justify another adapter. |
| No pi-tui transcript model | [chat-panel.ts](../../src/interactive/chat-panel.ts) and [worker-stream.ts](../../src/interactive/worker-stream.ts) | Keep Clio ownership. | Transcript folding, worker cards, and tool-output collapse are application policy. |
| pi-tui `CombinedAutocompleteProvider` | [slash-autocomplete.ts](../../src/interactive/slash-autocomplete.ts) | Keep Clio command composition. | Clio's declarative slash specification owns parsing, help, and completion consistency. |
| pi-tui `KeybindingsManager`, `TUI_KEYBINDINGS`, and `Editor.addToHistory` | [keybindings.ts](../../src/domains/config/keybindings.ts) and interactive editor wiring | Route terminal actions through Pi. | Pi owns editor behavior while Clio owns the configured bindings and accepted-input policy. |
| pi-tui `Markdown`, `renderLatex`, `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, and `stripTerminalSequences` | Interactive Markdown, Mermaid, layout, and width wiring | Route terminal primitives through Pi. | Clio retains theme tokens, Mermaid span styling, and application layout only. |
| pi-agent-core `prepareNextTurn` / `prepareNextTurnWithContext` (runs only before another assistant turn) | [turn-runtime.ts](../../src/interactive/turn-runtime.ts) continuation guard and [turn-context.ts](../../src/interactive/turn-context.ts) `postToolContinuationGuard` | Keep `prepareNextTurn`; no adaptation. | The guard runs only when the transcript tail is a tool result and the loop will continue. End-of-run work runs on `agent_end`. |
| pi-agent-core `Agent.reset()` (rejects during an active run) | `src/interactive/chat-loop.ts` `resetForSession` and [session-switch-settlement.ts](../../src/interactive/session-switch-settlement.ts) | Keep Clio's settle-then-replace reset. | Clio never calls `Agent.reset()`. Every session reset caller cancels and awaits `whenSettled()` first, then replaces `agent.state.messages`; the bang-command path waits on `isStreaming()` before refreshing. |
| pi-agent-core `BeforeToolCallResult.terminate` | [agent-tools.ts](../../src/tools/agent-tools.ts) blocked-call path | Decline. | Clio blocks tools inside `execute` by throwing the model-facing rejection; a blocked call must not end the batch. Batch termination stays on `AgentToolResult.terminate` from successful terminal tools. |
| pi-agent-core `streamProxy()` namespace metadata and `ToolCall.namespace` | None | Decline. | Clio does not proxy assistant streams and does not use OpenAI Responses namespaced or deferred tools. |
| pi-ai `SimpleStreamOptions.toolChoice` (`auto` / `none`) | `src/engine/provider-payload.ts` and the `onPayload` hook in `src/interactive/turn-runtime.ts` and [worker-runtime.ts](../../src/engine/worker-runtime.ts) | Keep the Clio payload patch. | Clio needs both `none` and a named required tool across every dialect it serves, including generic OpenAI-compatible servers that reject object `tool_choice`. Splitting `none` onto the neutral option would leave two mechanisms for one concern. |
| pi-ai strict tool-schema conversion and null normalization | `src/engine/ai.ts` `validateEngineToolArguments` | Inherit. | No Clio tool sets `constrainedSampling`, so strict conversion is inert. `null` for an optional non-nullable argument is dropped instead of rejected. |
| pi-ai OpenAI-compatible reasoning replay and signature serialization fixes | `src/engine/apis/openai-completions.ts` | Inherit. | The wrapper delegates `stream` and `streamSimple` to Pi's adapter. Clio persists raw assistant content blocks, including `thinkingSignature`, and restores them through rich replay; Pi decides whether signatures remain usable for the selected model and transport. |
| pi-ai Anthropic server-side refusal fallback with returned-model pricing | `src/interactive/turn-context.ts` `reconcileUsage` and [trace-store.ts](../../src/domains/observability/trace-store.ts) | Inherit. | Usage and cost arrive already priced for the returned model; Clio records `message.model` as reported. `fallbacks` is only sent for catalog models that declare `allowedFallbackModels`. |
| pi-tui capability overrides (`PI_HYPERLINKS`, `PI_IMAGE_PROTOCOL`, `PI_TRUE_COLOR`, `setCapabilityOverrides`) and `PI_TUI_ESC_TIMEOUT` | [tokens.ts](../../src/interactive/theme/tokens.ts) truecolor detection | Decline. | These govern pi-tui's own image, hyperlink, and escape-sequence handling. Clio's theme detects truecolor from `COLORTERM` and `TERM` independently and does not consume pi-tui capability detection. |
| pi-tui `TuiAltScreenOptions.copyOnSelect` / `copySelection` and transcript search (`tui.altScreen.search*`) | [interactive-shell.ts](../../src/interactive/interactive-shell.ts) alt-screen construction and `src/domains/config/keybindings.ts` | Inherit defaults. | Selection copy stays on by default. The tracked input-policy patch runs Clio's router before Pi's viewport listeners; `ctrl+g` advances a match only while the search overlay is focused, so the Clio leader chord is unavailable during a search and nowhere else. |
| pi-tui alternate-screen direct-row painting | [instrumented-tui.ts](../../src/engine/instrumented-tui.ts) | Inherit. | `compositeOverlays`, `extractCursorPosition`, and `applyLineResets` still run inside one `doRender`, so Clio's frame and phase measurements are unchanged. |

## Agent-loop and provider interfaces

The three direct Pi dependencies share the exact 0.87.1 pin. Pi's agent core and
AI providers run stock JavaScript; only pi-tui has a Clio-owned patch. See
[patch ownership and alternatives](../../patches/README.md).

| Pi surface | Clio adaptation and reason |
| --- | --- |
| `shouldStopAfterTurn` removed in favor of `finishTurn` | The worker's helper-result stop returns `{ action: "end" }` from `finishTurn`. Pi now calls it before `turn_end` and applies the decision afterwards. The predicate reads state that `message_end` and tool execution set, and both run earlier, so the stop point is unchanged. Pi also calls it for error and aborted responses; the predicate is pure, so that is harmless. |
| `prepareRequest`, `peekQueuedMessages`, `AgentTurnDecision` `continue` | Not adopted. Clio's request assembly and follow-up scheduling stay Clio-owned. |
| Anthropic OAuth client version 2.1.280 | Required by Claude Opus 5.5 subscription access. |
| Catalog: Claude Opus 5.5, GPT-6 Sol, GPT-6 Luna | Inherited through `listCatalogModelsForRuntime`, so `targets use` and the model picker accept them. Opus 5.5 refuses disabled thinking; select a thinking level for it. |
| Unknown OpenAI-compatible endpoints default to `supportsStrictMode: false` | Clio declares no constrained sampling, so tool entries only lose their `"strict": false` field. Local runtimes already set the flag explicitly. |
| Per-model image input limits (`inputLimits.images`) | Inherited from catalog entries; Clio configures none of its own. |

## Transcript ownership

`Agent.state.systemPrompt` is a
read-only projection of system messages. Pi's `normalizeContext` folds legacy
`systemPrompt` and `tools` into a leading system message; it **does not deduplicate**
a transcript that already contains that baseline. Clio therefore sends native
transcripts with `messages` only and builds legacy prompt/tool snapshots only
where a Clio-owned consumer needs them.

| Pi surface | Clio adaptation and reason |
| --- | --- |
| `normalizeContext`, `getCurrentSystemPrompt`, `getCurrentTools` | [context.ts](../../src/engine/context.ts) delegates section patches, prompt concatenation, and tool additions/removals to Pi. Native API dispatch and OpenAI completions preserve the transcript; Ollama's custom wire and worker request projection consume the resolved snapshot. Clio does not implement its own transcript reducer. |
| `createInitialSystemMessage`, `toToolDeclaration` | Session replay and prompt recompilation replace Clio's complete baseline through `replaceEngineMessages` / `setEngineSystemPrompt`. Clio persists its compiled prompt and conversation separately, so rehydration intentionally produces one baseline, not a second prompt appended to the old one. Executable tools remain in `state.tools`; only portable declarations enter messages. |
| Parent-to-worker context and tool-free side rounds | Fork/splice capture excludes parent system/tool declarations before validating complete conversation batches. The child retains its own compiled prompt and executable loadout. Side-question and handoff rounds similarly drop session system entries before installing their own tool-free prompt. First-turn middleware counts conversation only. |
| `AgentLoopTurnUpdate.context` | Post-tool compaction returns the complete rebuilt transcript and executable tools. The active loop receives the new prompt and retained conversation before its continuation. No obsolete top-level `systemPrompt` is carried on that context. |
| System messages in `Agent.state.messages` | Conversation accounting, measured-anchor indexes, snapshots and replay comparisons exclude system entries because system text and schemas already have their own budget categories. Worker result offsets are measured after Agent construction, excluding the injected baseline and every inherited message. |
| `getToolStateChanges`, public context transforms, `convertToLlm` | Warming copies the transcript, declares changed executable tools using Pi's diff, then applies the same transforms and conversion as a real turn. Transformed system messages and tools reach the provider intact. Warming never executes tools or appends its response to the session. Local residency, foreground ownership, input limits and billing admission remain Clio policy. |
| `resolveTranscript` and provider compatibility flags | Pi decides whether a model receives mid-conversation system messages/tool additions or a collapsed request. The completions wrapper transforms assistant reasoning without flattening system history. Legacy custom stream delegates still receive a resolved request snapshot for compatibility. |
| Retry and overflow fixes | Clio inherits Pi's Cloudflare 520/Azure transient-error classification and z.ai overflow detection. Capped exponential delay uses Pi's public `retryDelayMs`; model-loading floors, cancellable UI countdowns, stream-stall limits and `Agent.continue()` recovery remain Clio-owned. |
| Cache retention and provider request assembly | Pi continues to own native cache-control fields and provider-specific retention behavior. Clio supplies target policy, session identity, local-runtime fields and measured cache telemetry. Upstream coding-agent prompt warming is not a public pi-agent-core/pi-ai warm API and does not replace Clio's local-only admission and lifetime rules. |
| Meta provider and Muse OAuth | Environment-key parity includes `META_API_KEY`. Clio's explicitly selected provider catalogs and OAuth flows remain tied to supported runtime descriptors; out-of-tree runtime plugins can use the public Pi provider factory. |
| pi-tui native platform helpers | The pinned package supplies `darwin-platform.node`, `win32-platform.node`, and `linux-platform-x11.node` for arm64/x64. Pi owns clipboard and modifier integration. |
| pi-tui rendering, LaTeX, fuzzy matching and file completion fixes | Inherited through the unchanged public TUI wrappers. Stock Pi lacks the application input ordering and semantic edit/search APIs required by Clio, so the narrowly scoped TUI patch remains. |

### Anthropic dispatch schemas

Pi's non-strict Anthropic serializer retains root `properties` and `required`
fields but omits root `$defs`. Clio inlines the nested intent, budget, and
worker-context schemas in its tool declaration so serialized dispatch arguments
have complete schemas. This keeps the non-strict tool contract compatible with
models that do not support strict sampling.

### Provider and terminal interfaces

| Pi surface | Clio behavior |
| --- | --- |
| OpenRouter catalog selects Anthropic Messages | With no explicit target URL, synthesis keeps the catalog API, URL, compatibility flags, and effort map together. Explicit URLs use the runtime's OpenAI-completions contract and omit metadata for other transports. Unknown models use the OpenAI fallback. |
| `AssistantMessage.providerThinkingLevel` and Anthropic `supportsMidConvoEffort` | Clio persists historical provider effort with raw assistant content and restores it through rich replay. Pi owns request assembly and signed-thinking recovery. |
| Scroll styling callbacks and `OverlayHandle.getBounds()` | Clio uses public track/thumb styling callbacks and delegates bounds to the mounted frame. |
| Component mouse handling and alt-screen controls | Clio composes compatible Pi components and supplies mouse wiring for its custom components. `clearOnShrink` defaults to false. |
| `AgentTool.replay` | Clio leaves the optional policy unset and uses `Agent` rather than Pi's durable harness. |
| OpenAI-compatible `vllmPriority` | Available through Pi's compatibility setting; Clio has no scheduler-priority setting. |

Environment-key parity includes `qwen-token-plan-individual` →
`QWEN_TOKEN_PLAN_API_KEY`; Clio has no built-in Qwen runtime.

Clio uses its own session persistence. Worker event projection strips cumulative
snapshots from deltas while retaining terminal messages. Pi's internal compaction
file-list helpers are not exported through a supported package subpath, so Clio
owns its file-list formatter.

## Thin-wrapper watch list

Review these files first when Pi changes. They intentionally contain little
behavior and should not grow another implementation of an SDK primitive.

- [api-registry.ts](../../src/engine/api-registry.ts) owns Clio's ordered dispatcher using Pi's public lazy API factories and the provider catalogs selected in [models.ts](../../src/engine/models.ts) for Clio's built-in runtimes. Its dynamic `/compat` bridge exists only for configured out-of-tree runtime plugins that require Pi's process-global registry identity.
- [env-api-keys.ts](../../src/engine/env-api-keys.ts) pins Pi 0.87.1's synchronous environment-key and ambient-credential discovery behind a parity contract; revisit it on every Pi upgrade until Pi exports that helper directly.
- [openai-completions.ts](../../src/engine/apis/openai-completions.ts) maps compatibility flags, sampling parameters, and thinking budgets. Its Clio deltas are the local-runtime guards and sentinel, Harmony, and Gemma filters.
- [provider-payload.ts](../../src/engine/provider-payload.ts) holds the OpenAI Responses reasoning-summary patch and the tool-choice and response-schema payload patches. It does not patch Anthropic thinking.
- [types.ts](../../src/engine/types.ts) and [ai.ts](../../src/engine/ai.ts) expose erased Pi types and `StringEnum` behind the engine boundary.
- [retry.ts](../../src/domains/session/retry.ts) wraps `isRetryableAssistantError` and adds the local-model loading rule.
- [chat-renderer.ts](../../src/interactive/chat-renderer.ts) consumes Pi's compaction, branch, and bash replay wording through [messages.ts](../../src/engine/messages.ts).
- Interactive Markdown, Mermaid, LaTeX, fullscreen, alternate-screen, and keybinding glue should continue to compose pi-tui primitives.

## Architecture boundary enforcement and tests

The rule keys on the `@earendil-works/pi-` prefix, and it is a single rule with
no exceptions: only files under `src/engine/**` may import a `@earendil-works/pi-*`
package, type-only imports included. The allowlist of type-only exceptions
(`allowedPiTypeImportSpecifiersOutsideEngine`) is deliberately empty. Everything
else, `src/interactive/**` included, reaches Pi through engine re-exports such as
[tui-primitives.ts](../../src/engine/tui-primitives.ts), and domains take erased engine shapes
(`EngineModel`, `Api`, `Model`) from [types.ts](../../src/engine/types.ts) and [ai.ts](../../src/engine/ai.ts).

[check-boundaries.ts](../../tests/boundaries/check-boundaries.ts) enforces this statically over the import
graph, alongside six other isolation rules including the Stage 0 instant-shell
closure (`STAGE_0_OWNER`, `STAGE0_SEAMS`). [engine-lifecycle.test.ts](../../tests/contracts/engine-lifecycle.test.ts)
covers agent-loop ordering, reset, tool-argument normalization, the keybinding
table and alt-screen render seams; [tool-boundaries.test.ts](../../tests/contracts/tool-boundaries.test.ts)
covers tool schema admission and execution isolation across runtimes.

## SDK upgrade checks

Run `pnpm run ci` after changing the pin or patch. The
[validation reference](../../CONTRIBUTING.md#validation-reference) describes the
source, installed-package, and release checks. Transcript replay, provider
serialization, engine lifecycle, and terminal input ordering are the relevant
compatibility boundaries.
