# pi-mono 0.67.4 engine-boundary audit

Status: frozen for Clio v0.1. Update this file only on a deliberate pi-mono version bump.

Scope: every symbol the Clio engine layer (`src/engine/**`) may re-export. Names and signatures are copied verbatim from pi-mono 0.67.4 sources. Any Clio consumer that needs a symbol not listed here must bump pi-mono AND extend this document in the same commit.

## @mariozechner/pi-agent-core@0.67.4

Package source root: `/home/akougkas/tools/pi-mono/packages/agent/src/`. Index re-exports from `./agent.js`, `./agent-loop.js`, `./proxy.js`, and `./types.js`.

### Classes

- `Agent` (from `agent.ts`) is the stateful wrapper around the low-level agent loop. Construction: `new Agent(options: AgentOptions = {})`. It owns a private `MutableAgentState` (not exported) and exposes it as a read-only `AgentState` via `get state(): AgentState`. There is no `createState()` factory and no external way to mutate the runtime-owned fields.

  Public instance surface:
  - `get state(): AgentState`
  - `get steeringMode(): "all" | "one-at-a-time"` / `set steeringMode(mode)`
  - `get followUpMode(): "all" | "one-at-a-time"` / `set followUpMode(mode)`
  - `get signal(): AbortSignal | undefined`. Returns the active run's signal.
  - Public fields (assignable after construction): `convertToLlm`, `transformContext?`, `streamFn: StreamFn`, `getApiKey?`, `onPayload?`, `beforeToolCall?`, `afterToolCall?`, `sessionId?`, `thinkingBudgets?`, `transport: Transport`, `maxRetryDelayMs?`, `toolExecution: ToolExecutionMode`.
  - `subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void`. Returns an unsubscribe fn.
  - `steer(message: AgentMessage): void`
  - `followUp(message: AgentMessage): void`
  - `clearSteeringQueue(): void` / `clearFollowUpQueue(): void` / `clearAllQueues(): void`
  - `hasQueuedMessages(): boolean`
  - `abort(): void`
  - `waitForIdle(): Promise<void>`
  - `reset(): void`
  - Overloaded `prompt`: `async prompt(message: AgentMessage | AgentMessage[]): Promise<void>` and `async prompt(input: string, images?: ImageContent[]): Promise<void>` (implementation accepts `string | AgentMessage | AgentMessage[]`).
  - `async continue(): Promise<void>`. Continues from the current transcript; throws if the last message is an assistant message and no steering/follow-up queue is drainable.

### Loop functions (from `agent-loop.ts`)

- `type AgentEventSink = (event: AgentEvent) => Promise<void> | void;`
- `agentLoop(prompts: AgentMessage[], context: AgentContext, config: AgentLoopConfig, signal?: AbortSignal, streamFn?: StreamFn): EventStream<AgentEvent, AgentMessage[]>`
- `agentLoopContinue(context: AgentContext, config: AgentLoopConfig, signal?: AbortSignal, streamFn?: StreamFn): EventStream<AgentEvent, AgentMessage[]>`
- `runAgentLoop(prompts, context, config, emit, signal?, streamFn?): Promise<AgentMessage[]>`
- `runAgentLoopContinue(context, config, emit, signal?, streamFn?): Promise<AgentMessage[]>`

### Proxy helpers (from `proxy.ts`)

- `type ProxyAssistantMessageEvent` is a discriminated union (`start`, `text_*`, `thinking_*`, `toolcall_*`, `done`, `error`) used for server-side proxy streaming.
- `interface ProxyStreamOptions extends SimpleStreamOptions { authToken: string; proxyUrl: string; }`
- `streamProxy(model: Model<any>, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream`. This is a drop-in `streamFn` replacement when routing through a server. `ProxyMessageEventStream` (a private subclass of `EventStream`) is returned but not re-exported as a type.

### Interfaces and types (from `types.ts`)

- `type StreamFn = (...args: Parameters<typeof streamSimple>) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;`. The function must not throw; failures must be encoded in the returned stream.
- `type ToolExecutionMode = "sequential" | "parallel";`
- `type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;`
- `interface BeforeToolCallResult { block?: boolean; reason?: string; }`
- `interface AfterToolCallResult { content?: (TextContent | ImageContent)[]; details?: unknown; isError?: boolean; }`
- `interface BeforeToolCallContext { assistantMessage: AssistantMessage; toolCall: AgentToolCall; args: unknown; context: AgentContext; }`
- `interface AfterToolCallContext { assistantMessage: AssistantMessage; toolCall: AgentToolCall; args: unknown; result: AgentToolResult<any>; isError: boolean; context: AgentContext; }`
- `interface AgentLoopConfig extends SimpleStreamOptions` with fields: `model: Model<any>`; `convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>`; `transformContext?`; `getApiKey?`; `getSteeringMessages?: () => Promise<AgentMessage[]>`; `getFollowUpMessages?: () => Promise<AgentMessage[]>`; `toolExecution?: ToolExecutionMode`; `beforeToolCall?`; `afterToolCall?`.
- `type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";` (distinct from the pi-ai `ThinkingLevel`, which omits `"off"`).
- `interface CustomAgentMessages {}` is an empty seam for consumer declaration merging.
- `type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];`
- `interface AgentState` has these fields (order matters because accessors vs readonly):
  - `systemPrompt: string`
  - `model: Model<any>`
  - `thinkingLevel: ThinkingLevel`
  - `set tools(tools: AgentTool<any>[])` / `get tools(): AgentTool<any>[]` (assignment copies the top-level array)
  - `set messages(messages: AgentMessage[])` / `get messages(): AgentMessage[]` (assignment copies the top-level array)
  - `readonly isStreaming: boolean`
  - `readonly streamingMessage?: AgentMessage`
  - `readonly pendingToolCalls: ReadonlySet<string>`
  - `readonly errorMessage?: string`
- `interface AgentOptions` (from `agent.ts`) has every field optional:
  - `initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>`
  - `convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>`
  - `transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>`
  - `streamFn?: StreamFn`
  - `getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined`
  - `onPayload?: SimpleStreamOptions["onPayload"]`
  - `beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>`
  - `afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>`
  - `steeringMode?: "all" | "one-at-a-time"`
  - `followUpMode?: "all" | "one-at-a-time"`
  - `sessionId?: string`
  - `thinkingBudgets?: ThinkingBudgets`
  - `transport?: Transport`
  - `maxRetryDelayMs?: number`
  - `toolExecution?: ToolExecutionMode`
- `interface AgentToolResult<T> { content: (TextContent | ImageContent)[]; details: T; }`
- `type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;`
- `interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> { label: string; prepareArguments?: (args: unknown) => Static<TParameters>; execute: (toolCallId: string, params: Static<TParameters>, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<TDetails>) => Promise<AgentToolResult<TDetails>>; }`
- `interface AgentContext { systemPrompt: string; messages: AgentMessage[]; tools?: AgentTool<any>[]; }`
- `type AgentEvent = { type: "agent_start" } | { type: "agent_end"; messages: AgentMessage[] } | { type: "turn_start" } | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] } | { type: "message_start"; message: AgentMessage } | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent } | { type: "message_end"; message: AgentMessage } | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any } | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any } | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };`

### Lifecycle notes

- `Agent.prompt()` and `Agent.continue()` start exactly one active run. A second call while a run is active throws. Use `steer()` (inject before the next assistant turn finishes) or `followUp()` (inject only after the agent would otherwise stop).
- `Agent.subscribe()` listeners are awaited in subscription order during event delivery and share the active-run abort signal. `agent_end` is the final emitted event but `waitForIdle()` does not resolve until those listeners settle and `finishRun()` clears runtime state.
- `Agent.abort()` triggers the underlying `AbortController`. The loop encodes failures as an `AssistantMessage` with `stopReason: "aborted"` (or `"error"`) and pushes a synthetic `agent_end`.
- Tools run in `toolExecution: "parallel"` (default) or `"sequential"`. Hooks: `beforeToolCall` can block with `{ block: true, reason }`; `afterToolCall` can override `content`, `details`, or `isError` field-by-field (no deep merge).

## @mariozechner/pi-ai@0.67.4

Package source root: `/home/akougkas/tools/pi-mono/packages/ai/src/`. The index re-exports from `api-registry.js`, `env-api-keys.js`, `models.js`, `providers/faux.js`, `providers/register-builtins.js`, `stream.js`, `types.js`, `utils/event-stream.js`, `utils/json-parse.js`, `utils/overflow.js`, `utils/typebox-helpers.js`, `utils/validation.js`, plus several provider-specific option types.

The index also re-exports `Type` (value) and the `Static`, `TSchema` types from `@sinclair/typebox`.

### Functions (stream + registry)

- `stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ProviderStreamOptions): AssistantMessageEventStream` (from `stream.ts`).
- `complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ProviderStreamOptions): Promise<AssistantMessage>`.
- `streamSimple<TApi extends Api>(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream`.
- `completeSimple<TApi extends Api>(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>`.
- `registerApiProvider<TApi, TOptions>(provider: ApiProvider<TApi, TOptions>, sourceId?: string): void` (from `api-registry.ts`).
- `getApiProvider(api: Api): ApiProviderInternal | undefined` (returns the `ApiProviderInternal` type; note that type is not exported; `getApiProviders()` returns an array of the same).
- `getApiProviders(): ApiProviderInternal[]`
- `unregisterApiProviders(sourceId: string): void`
- `clearApiProviders(): void`
- `registerBuiltInApiProviders(): void` (from `providers/register-builtins.ts`; called automatically at module load, and again on `resetApiProviders()`).
- `resetApiProviders(): void`
- `setBedrockProviderModule(module: BedrockProviderModule): void` is an opt-in override for host environments that bundle Bedrock separately.

There is no `getProviders`/`getModel`/`getModels` in `api-registry.ts`. Those live in `models.ts`; see below.

### Model-registry helpers (from `models.ts`)

- `getProviders(): KnownProvider[]`
- `getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(provider: TProvider, modelId: TModelId): Model<ModelApi<TProvider, TModelId>>`
- `getModels<TProvider extends KnownProvider>(provider: TProvider): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]`
- `calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"]`. Mutates and returns `usage.cost`.
- `supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean`. Returns true for gpt-5.2/5.3/5.4 and opus-4.6.
- `modelsAreEqual<TApi extends Api>(a, b): boolean`. Compares `id` and `provider`.

### Lazy provider stream exports (from `providers/register-builtins.ts`)

- `streamAnthropic`, `streamSimpleAnthropic`
- `streamAzureOpenAIResponses`, `streamSimpleAzureOpenAIResponses`
- `streamGoogle`, `streamSimpleGoogle`
- `streamGoogleGeminiCli`, `streamSimpleGoogleGeminiCli`
- `streamGoogleVertex`, `streamSimpleGoogleVertex`
- `streamMistral`, `streamSimpleMistral`
- `streamOpenAICodexResponses`, `streamSimpleOpenAICodexResponses`
- `streamOpenAICompletions`, `streamSimpleOpenAICompletions`
- `streamOpenAIResponses`, `streamSimpleOpenAIResponses`

(Bedrock is registered but its `streamBedrockLazy` is not re-exported; you reach it via `streamSimple()` or `stream()`.)

### Faux provider (from `providers/faux.ts`)

- `interface FauxModelDefinition { id; name?; reasoning?; input?; cost?; contextWindow?; maxTokens?; }`
- `type FauxContentBlock = TextContent | ThinkingContent | ToolCall`
- `fauxText(text: string): TextContent`
- `fauxThinking(thinking: string): ThinkingContent`
- `fauxToolCall(name: string, arguments_: ToolCall["arguments"], options?: { id?: string }): ToolCall`
- `fauxAssistantMessage(content: string | FauxContentBlock | FauxContentBlock[], options?: { stopReason?; errorMessage?; responseId?; timestamp?; }): AssistantMessage`
- `type FauxResponseFactory = (context, options, state, model) => AssistantMessage | Promise<AssistantMessage>`
- `type FauxResponseStep = AssistantMessage | FauxResponseFactory`
- `interface RegisterFauxProviderOptions { api?; provider?; models?; tokensPerSecond?; tokenSize?: { min?; max? } }`
- `interface FauxProviderRegistration { api; models; getModel(); state; setResponses; appendResponses; getPendingResponseCount; unregister; }`
- `registerFauxProvider(options?: RegisterFauxProviderOptions): FauxProviderRegistration`

### API-registry types (from `api-registry.ts`)

- `type ApiStreamFunction = (model: Model<Api>, context: Context, options?: StreamOptions) => AssistantMessageEventStream`
- `type ApiStreamSimpleFunction = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream`
- `interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> { api: TApi; stream: StreamFunction<TApi, TOptions>; streamSimple: StreamFunction<TApi, SimpleStreamOptions>; }`

### Core types (from `types.ts`)

- `type KnownApi` = union of `"openai-completions" | "mistral-conversations" | "openai-responses" | "azure-openai-responses" | "openai-codex-responses" | "anthropic-messages" | "bedrock-converse-stream" | "google-generative-ai" | "google-gemini-cli" | "google-vertex"`.
- `type Api = KnownApi | (string & {})`
- `type KnownProvider` = union of `"amazon-bedrock" | "anthropic" | "google" | "google-gemini-cli" | "google-antigravity" | "google-vertex" | "openai" | "azure-openai-responses" | "openai-codex" | "github-copilot" | "xai" | "groq" | "cerebras" | "openrouter" | "vercel-ai-gateway" | "zai" | "mistral" | "minimax" | "minimax-cn" | "huggingface" | "opencode" | "opencode-go" | "kimi-coding"`.
- `type Provider = KnownProvider | string`
- `type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh"` (note: no `"off"` here; see pi-agent-core's distinct `ThinkingLevel`).
- `interface ThinkingBudgets { minimal?: number; low?: number; medium?: number; high?: number; }`
- `type CacheRetention = "none" | "short" | "long"`
- `type Transport = "sse" | "websocket" | "auto"`
- `interface StreamOptions { temperature?; maxTokens?; signal?: AbortSignal; apiKey?; transport?; cacheRetention?; sessionId?; onPayload?; headers?; maxRetryDelayMs?; metadata?; }`
- `type ProviderStreamOptions = StreamOptions & Record<string, unknown>`
- `interface SimpleStreamOptions extends StreamOptions { reasoning?: ThinkingLevel; thinkingBudgets?: ThinkingBudgets; }`
- `type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (model: Model<TApi>, context: Context, options?: TOptions) => AssistantMessageEventStream`
- `interface TextSignatureV1 { v: 1; id: string; phase?: "commentary" | "final_answer"; }`
- `interface TextContent { type: "text"; text: string; textSignature?: string; }`
- `interface ThinkingContent { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean; }`
- `interface ImageContent { type: "image"; data: string; mimeType: string; }`
- `interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, any>; thoughtSignature?: string; }`
- `interface Usage { input; output; cacheRead; cacheWrite; totalTokens; cost: { input; output; cacheRead; cacheWrite; total; }; }`
- `type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted"`
- `interface UserMessage { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number; }`
- `interface AssistantMessage { role: "assistant"; content: (TextContent | ThinkingContent | ToolCall)[]; api: Api; provider: Provider; model: string; responseId?: string; usage: Usage; stopReason: StopReason; errorMessage?: string; timestamp: number; }`
- `interface ToolResultMessage<TDetails = any> { role: "toolResult"; toolCallId; toolName; content: (TextContent | ImageContent)[]; details?: TDetails; isError: boolean; timestamp: number; }`
- `type Message = UserMessage | AssistantMessage | ToolResultMessage`
- `interface Tool<TParameters extends TSchema = TSchema> { name: string; description: string; parameters: TParameters; }`
- `interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[]; }`
- `type AssistantMessageEvent` is a discriminated union (`start`, `text_start/delta/end`, `thinking_start/delta/end`, `toolcall_start/delta/end`, `done`, `error`) with every payload carrying `partial: AssistantMessage`.
- `interface OpenAICompletionsCompat { supportsStore?; supportsDeveloperRole?; supportsReasoningEffort?; reasoningEffortMap?; supportsUsageInStreaming?; maxTokensField?; requiresToolResultName?; requiresAssistantAfterToolResult?; requiresThinkingAsText?; thinkingFormat?; openRouterRouting?; vercelGatewayRouting?; zaiToolStream?; supportsStrictMode?; }`
- `interface OpenAIResponsesCompat {}`
- `interface OpenRouterRouting { allow_fallbacks?; require_parameters?; data_collection?; zdr?; enforce_distillable_text?; order?; only?; ignore?; quantizations?; sort?; max_price?; preferred_min_throughput?; preferred_max_latency?; }`
- `interface VercelGatewayRouting { only?: string[]; order?: string[]; }`
- `interface Model<TApi extends Api> { id; name; api: TApi; provider: Provider; baseUrl; reasoning: boolean; input: ("text" | "image")[]; cost: { input; output; cacheRead; cacheWrite }; contextWindow; maxTokens; headers?; compat?: (TApi extends "openai-completions" ? OpenAICompletionsCompat : TApi extends "openai-responses" ? OpenAIResponsesCompat : never); }`

### Event-stream utilities (from `utils/event-stream.ts`)

- `class EventStream<T, R = T> implements AsyncIterable<T>` with `push(event)`, `end(result?)`, `result(): Promise<R>`, and `[Symbol.asyncIterator]()`.
- `class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage>`
- `createAssistantMessageEventStream(): AssistantMessageEventStream`

### JSON and validation helpers

- `parseStreamingJson<T = any>(partialJson: string | undefined): T` (from `utils/json-parse.ts`).
- `validateToolCall(tools: Tool[], toolCall: ToolCall): any` (from `utils/validation.ts`).
- `validateToolArguments(tool: Tool, toolCall: ToolCall): any`.
- `isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean` (from `utils/overflow.ts`).
- `getOverflowPatterns(): RegExp[]`.
- `StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): TUnsafe<T[number]>` (from `utils/typebox-helpers.ts`).

### Env and provider options

- `getEnvApiKey(provider: KnownProvider | string): string | undefined` (from `env-api-keys.ts`). Returns `"<authenticated>"` sentinel for Bedrock/Vertex when credentials are resolvable without an explicit key.
- Provider-specific option types re-exported as `type` only: `BedrockOptions`, `AnthropicOptions`, `AzureOpenAIResponsesOptions`, `GoogleOptions`, `GoogleGeminiCliOptions`, `GoogleThinkingLevel`, `GoogleVertexOptions`, `MistralOptions`, `OpenAICodexResponsesOptions`, `OpenAICompletionsOptions`, `OpenAIResponsesOptions`.
- OAuth type re-exports: `OAuthAuthInfo`, `OAuthCredentials`, `OAuthLoginCallbacks`, `OAuthPrompt`, `OAuthProvider`, `OAuthProviderId`, `OAuthProviderInfo`, `OAuthProviderInterface` (all `type` re-exports from `utils/oauth/types.js`).
- Typebox re-exports: `Type` (value), `Static`, `TSchema` (types).

### Initialization

- `providers/register-builtins.ts` calls `registerBuiltInApiProviders()` at module load, so importing anything from `@mariozechner/pi-ai` already populates the shared `apiProviderRegistry` with every built-in API. The registry lives in module-scope `apiProviderRegistry` in `api-registry.ts`; calling `registerBuiltInApiProviders()` again is idempotent for the same keys (it overwrites entries with the same `api`).
- Order of registration is not meaningful; lookups go through `getApiProvider(model.api)`.
- To swap Bedrock out (e.g., offline builds), call `setBedrockProviderModule(...)` before the first bedrock stream call. To reset from scratch, call `clearApiProviders()` then `registerBuiltInApiProviders()` (or `resetApiProviders()` which does both).

## @mariozechner/pi-tui@0.67.4

Package source root: `/home/akougkas/tools/pi-mono/packages/tui/src/`. Index re-exports are listed below grouped by module.

### Core TUI and container types (from `tui.ts`)

- `class TUI extends Container` is the main renderer. Constructor: `new TUI(terminal: Terminal, showHardwareCursor?: boolean)`. Key members: `terminal: Terminal`, `onDebug?: () => void`, `start()`, `stop()`, `requestRender(force?)`, `setFocus(component)`, `showOverlay(component, options?) => OverlayHandle`, `hideOverlay()`, `hasOverlay()`, `addInputListener(listener) => () => void`, `removeInputListener(listener)`, `addChild()/removeChild()/clear()` (inherited from `Container`), `invalidate()`, `getShowHardwareCursor()/setShowHardwareCursor()`, `getClearOnShrink()/setClearOnShrink()`, getter `fullRedraws: number`.
- `class Container implements Component` is the base container with `children: Component[]`, `addChild()`, `removeChild()`, `clear()`, `invalidate()`, `render(width): string[]`.
- `interface Component { render(width: number): string[]; handleInput?(data: string): void; wantsKeyRelease?: boolean; invalidate(): void; }`
- `interface Focusable { focused: boolean; }`
- `isFocusable(component: Component | null): component is Component & Focusable`
- `const CURSOR_MARKER: string` is the zero-width APC marker components emit at the cursor position.
- `type OverlayAnchor = "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top-center" | "bottom-center" | "left-center" | "right-center"`
- `interface OverlayMargin { top?; right?; bottom?; left?; }`
- `type SizeValue = number | \`${number}%\``
- `interface OverlayOptions { width?: SizeValue; minWidth?: number; maxHeight?: SizeValue; anchor?: OverlayAnchor; offsetX?: number; offsetY?: number; row?: SizeValue; col?: SizeValue; margin?: OverlayMargin | number; visible?: (termWidth, termHeight) => boolean; nonCapturing?: boolean; }`
- `interface OverlayHandle { hide(): void; setHidden(hidden: boolean): void; isHidden(): boolean; focus(): void; unfocus(): void; isFocused(): boolean; }`
- `visibleWidth(str: string): number` is also re-exported from `tui.ts` (originates in `utils.ts`).

### Components

All components implement `Component`; Editor and Input additionally implement `Focusable`.

- `Box` (from `components/box.ts`) is a padded container. `new Box(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string)`. Methods: `addChild`, `removeChild`, `clear`, `setBgFn`, `invalidate`, `render`.
- `CancellableLoader` (from `components/cancellable-loader.ts`) `extends Loader`. Exposes `signal: AbortSignal`, `aborted: boolean`, `onAbort?: () => void`, `dispose()`.
- `Editor` (from `components/editor.ts`) is a prompt editor with slash-command autocomplete and bracketed paste. `new Editor(tui: TUI, theme: EditorTheme, options: EditorOptions = {})`. Field `focused: boolean`, `borderColor: (str: string) => string`, `onSubmit?: (text: string) => void`. Numerous runtime methods (setText/getText, setAutocomplete, setHistory, etc.) live on the class; re-export the class and document-specific methods per-feature as Clio needs them.
  - `interface EditorTheme { borderColor: (str) => string; selectList: SelectListTheme; }`
  - `interface EditorOptions { paddingX?: number; autocompleteMaxVisible?: number; }`
  - `interface TextChunk { text: string; startIndex: number; endIndex: number; }` is also exported for wrap helpers.
  - `wordWrapLine(line: string, maxWidth: number, preSegmented?: Intl.SegmentData[]): TextChunk[]`
- `Image` (from `components/image.ts`) is an inline image with terminal-specific rendering. `new Image(base64Data: string, mimeType: string, theme: ImageTheme, options: ImageOptions = {}, dimensions?: ImageDimensions)`. Additional API: `getImageId()`.
  - `interface ImageOptions { maxWidthCells?; maxHeightCells?; filename?; imageId?; }`
  - `interface ImageTheme { fallbackColor: (str) => string; }`
- `Input` (from `components/input.ts`) is a single-line input. Zero-arg constructor. Public fields: `focused: boolean`, `onSubmit?: (value: string) => void`, `onEscape?: () => void`. Accessors `getValue()` / `setValue()`.
- `Loader` (from `components/loader.ts`) `extends Text`. `new Loader(ui: TUI, spinnerColorFn, messageColorFn, message = "Loading...")`. Methods `start()`, `stop()`, `setMessage(message)`.
- `Markdown` (from `components/markdown.ts`) renders markdown. `new Markdown(text: string, paddingX: number, paddingY: number, theme: MarkdownTheme, defaultTextStyle?: DefaultTextStyle)`.
  - `interface DefaultTextStyle { color?; bgColor?; bold?; italic?; strikethrough?; underline?; }`
  - `interface MarkdownTheme { heading; link; linkUrl; code; codeBlock; codeBlockBorder; quote; quoteBorder; hr; listBullet; bold; italic; strikethrough; underline; highlightCode?; codeBlockIndent?; }`
- `SelectList` (from `components/select-list.ts`). Constructor: `new SelectList(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout?: SelectListLayoutOptions)`. Fields `onSelect?: (item) => void`, `onCancel?: () => void`, `onSelectionChange?: (item) => void`. Methods `setFilter(filter)`, `setSelectedIndex(index)`.
  - `interface SelectItem { value: string; label: string; description?: string; }`
  - `interface SelectListTheme { selectedPrefix; selectedText; description; scrollInfo; noMatch; }` (all `(text: string) => string`)
  - `interface SelectListTruncatePrimaryContext { text; maxWidth; columnWidth; item: SelectItem; isSelected: boolean; }`
  - `interface SelectListLayoutOptions { minPrimaryColumnWidth?; maxPrimaryColumnWidth?; truncatePrimary?; }`
- `SettingsList` (from `components/settings-list.ts`). Constructor: `new SettingsList(items: SettingItem[], maxVisible: number, theme: SettingsListTheme, onChange: (id, newValue) => void, onCancel: () => void, options?: SettingsListOptions)`. Method `updateValue(id, newValue)`.
  - `interface SettingItem { id: string; label: string; description?: string; currentValue: string; values?: string[]; submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component; }`
  - `interface SettingsListTheme { label: (text, selected) => string; value: (text, selected) => string; description: (text) => string; cursor: string; hint: (text) => string; }`
  - `SettingsListOptions` is defined in the source but not re-exported from the package index; treat it as internal. If Clio needs `enableSearch`, pass the literal shape via the constructor.
- `Spacer` (from `components/spacer.ts`). Constructor: `new Spacer(lines: number = 1)`. Method `setLines(lines)`.
- `Text` (from `components/text.ts`). Constructor: `new Text(text = "", paddingX = 1, paddingY = 1, customBgFn?)`. Methods `setText`, `setCustomBgFn`, `invalidate`.
- `TruncatedText` (from `components/truncated-text.ts`). Constructor: `new TruncatedText(text: string, paddingX = 0, paddingY = 0)`.

### Editor-component helper (from `editor-component.ts`)

- `type EditorComponent` is an opaque interface consumed by host code that swaps in custom editors.

### Autocomplete (from `autocomplete.ts`)

- `interface AutocompleteItem`
- `interface AutocompleteSuggestions`
- `interface AutocompleteProvider`
- `interface SlashCommand`
- `class CombinedAutocompleteProvider implements AutocompleteProvider`

### Fuzzy matching (from `fuzzy.ts`)

- `interface FuzzyMatch`
- `fuzzyMatch(query: string, text: string): FuzzyMatch`
- `fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[]`

### Keybindings (from `keybindings.ts`)

- `const TUI_KEYBINDINGS` holds default keybinding definitions for editor, input, and select keybinding ids (keys like `"tui.editor.cursorUp"`, `"tui.input.submit"`, `"tui.select.confirm"`, etc.). Satisfies `KeybindingDefinitions`.
- `interface Keybindings` is a declaration-merge seam; keys are the keybinding ids.
- `type Keybinding = keyof Keybindings`
- `interface KeybindingDefinition { defaultKeys: KeyId | KeyId[]; description?: string; }`
- `type KeybindingDefinitions = Record<string, KeybindingDefinition>`
- `type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>`
- `interface KeybindingConflict { key: KeyId; keybindings: string[]; }`
- `class KeybindingsManager`. Constructor: `new KeybindingsManager(definitions: KeybindingDefinitions, userBindings?: KeybindingsConfig)`. Methods: `matches(data, keybinding)`, `getKeys(keybinding)`, `getDefinition(keybinding)`, `getConflicts()`, `setUserBindings(userBindings)`, `getUserBindings()`, `getResolvedBindings()`.
- `getKeybindings(): KeybindingsManager`, `setKeybindings(keybindings: KeybindingsManager): void` are process-wide singleton accessors.

### Keyboard parsing (from `keys.ts`)

- `const Key` is a frozen map of symbolic key ids.
- `type KeyId = BaseKey | ModifiedKeyId<BaseKey>`
- `type KeyEventType = "press" | "repeat" | "release"`
- `isKeyRelease(data: string): boolean`
- `isKeyRepeat(data: string): boolean`
- `isKittyProtocolActive(): boolean`
- `setKittyProtocolActive(active: boolean): void`
- `matchesKey(data: string, keyId: KeyId): boolean`
- `parseKey(data: string): string | undefined`
- `decodeKittyPrintable(data: string): string | undefined`

### Stdin buffer (from `stdin-buffer.ts`)

- `type StdinBufferOptions`
- `type StdinBufferEventMap`
- `class StdinBuffer extends EventEmitter<StdinBufferEventMap>`

### Terminal (from `terminal.ts`)

- `interface Terminal` is the stdin/stdout/dimensions/cursor/kitty protocol contract (start, stop, drainInput, write, columns, rows, kittyProtocolActive, moveBy, hideCursor/showCursor, clearLine/clearFromCursor/clearScreen, setTitle).
- `class ProcessTerminal implements Terminal` is the concrete implementation over `process.stdin`/`process.stdout`.

### Terminal image utilities (from `terminal-image.ts`)

- Types: `ImageProtocol`, `TerminalCapabilities`, `CellDimensions`, `ImageDimensions`, `ImageRenderOptions`.
- Functions: `allocateImageId`, `calculateImageRows`, `deleteAllKittyImages`, `deleteKittyImage`, `detectCapabilities`, `encodeITerm2`, `encodeKitty`, `getCapabilities`, `getCellDimensions`, `getGifDimensions`, `getImageDimensions`, `getJpegDimensions`, `getPngDimensions`, `getWebpDimensions`, `imageFallback`, `renderImage`, `resetCapabilitiesCache`, `setCellDimensions`.

### Width and wrap utilities (from `utils.ts`)

- `truncateToWidth(...)`, `visibleWidth(str)`, `wrapTextWithAnsi(text, width)` (the three names the index re-exports).

Other utils.ts functions (`getSegmenter`, `extractAnsiCode`, `isWhitespaceChar`, `isPunctuationChar`, `applyBackgroundToLine`, `sliceByColumn`, `sliceWithWidth`, `extractSegments`) are NOT re-exported from the package index in 0.67.4; Clio must not use them via the engine layer.

## What Clio re-exports through src/engine/

Every symbol above that a Clio domain or worker may need must be re-exported from files in `src/engine/`. The pi-mono imports must only appear in `src/engine/`; `src/engine/index.ts` is the single public surface that domains and workers consume.

Concretely:

- `src/engine/types.ts` re-exports the shared pi-ai type surface (`Api`, `KnownApi`, `KnownProvider`, `Provider`, `Model`, `Message`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `TextContent`, `ThinkingContent`, `ImageContent`, `ToolCall`, `Tool`, `Context`, `AssistantMessageEvent`, `Usage`, `StopReason`, `StreamOptions`, `SimpleStreamOptions`, `ProviderStreamOptions`, `Transport`, `CacheRetention`, `ThinkingBudgets`, `ThinkingLevel` (pi-ai variant), `AssistantMessageEventStream`, `StreamFunction`, `OpenAICompletionsCompat`, `OpenAIResponsesCompat`, `OpenRouterRouting`, `VercelGatewayRouting`, `Static`, `TSchema`, `Type`) along with the pi-agent-core types (`AgentMessage`, `AgentState`, `AgentOptions`, `AgentContext`, `AgentEvent`, `AgentTool`, `AgentToolCall`, `AgentToolResult`, `AgentToolUpdateCallback`, `AgentLoopConfig`, `BeforeToolCallContext`, `BeforeToolCallResult`, `AfterToolCallContext`, `AfterToolCallResult`, `ToolExecutionMode`, `StreamFn`, pi-agent-core `ThinkingLevel`, `CustomAgentMessages`).
- `src/engine/ai.ts` re-exports the runtime functions: `stream`, `complete`, `streamSimple`, `completeSimple`, `registerApiProvider`, `getApiProvider`, `getApiProviders`, `unregisterApiProviders`, `clearApiProviders`, `registerBuiltInApiProviders`, `resetApiProviders`, `setBedrockProviderModule`, `getProviders`, `getModel`, `getModels`, `calculateCost`, `supportsXhigh`, `modelsAreEqual`, `getEnvApiKey`, `parseStreamingJson`, `validateToolCall`, `validateToolArguments`, `isContextOverflow`, `getOverflowPatterns`, `StringEnum`, the lazy per-provider `stream*`/`streamSimple*` functions, `createAssistantMessageEventStream`, `EventStream`, `AssistantMessageEventStream`, and the faux provider helpers (`registerFauxProvider`, `fauxText`, `fauxThinking`, `fauxToolCall`, `fauxAssistantMessage`, `FauxModelDefinition`, `FauxContentBlock`, `FauxResponseFactory`, `FauxResponseStep`, `RegisterFauxProviderOptions`, `FauxProviderRegistration`).
- `src/engine/agent.ts` re-exports `Agent`, `agentLoop`, `agentLoopContinue`, `runAgentLoop`, `runAgentLoopContinue`, `streamProxy`, `ProxyAssistantMessageEvent`, `ProxyStreamOptions`, and `AgentEventSink`.
- `src/engine/tui.ts` re-exports `TUI`, `Container`, `Component`, `Focusable`, `isFocusable`, `CURSOR_MARKER`, `OverlayAnchor`, `OverlayMargin`, `OverlayOptions`, `OverlayHandle`, `SizeValue`, the component classes (`Box`, `CancellableLoader`, `Editor`, `Image`, `Input`, `Loader`, `Markdown`, `SelectList`, `SettingsList`, `Spacer`, `Text`, `TruncatedText`), the theme/options types (`EditorTheme`, `EditorOptions`, `TextChunk`, `wordWrapLine`, `ImageOptions`, `ImageTheme`, `MarkdownTheme`, `DefaultTextStyle`, `SelectItem`, `SelectListTheme`, `SelectListLayoutOptions`, `SelectListTruncatePrimaryContext`, `SettingItem`, `SettingsListTheme`), autocomplete (`AutocompleteItem`, `AutocompleteSuggestions`, `AutocompleteProvider`, `SlashCommand`, `CombinedAutocompleteProvider`), fuzzy helpers (`FuzzyMatch`, `fuzzyMatch`, `fuzzyFilter`), keybinding exports (`TUI_KEYBINDINGS`, `Keybindings`, `Keybinding`, `KeybindingDefinition`, `KeybindingDefinitions`, `KeybindingsConfig`, `KeybindingConflict`, `KeybindingsManager`, `getKeybindings`, `setKeybindings`), key parsing (`Key`, `KeyId`, `KeyEventType`, `isKeyRelease`, `isKeyRepeat`, `isKittyProtocolActive`, `setKittyProtocolActive`, `matchesKey`, `parseKey`, `decodeKittyPrintable`), stdin buffering (`StdinBuffer`, `StdinBufferOptions`, `StdinBufferEventMap`), terminal (`Terminal`, `ProcessTerminal`), image utilities (`ImageProtocol`, `TerminalCapabilities`, `CellDimensions`, `ImageDimensions`, `ImageRenderOptions`, `allocateImageId`, `calculateImageRows`, `deleteAllKittyImages`, `deleteKittyImage`, `detectCapabilities`, `encodeITerm2`, `encodeKitty`, `getCapabilities`, `getCellDimensions`, `getGifDimensions`, `getImageDimensions`, `getJpegDimensions`, `getPngDimensions`, `getWebpDimensions`, `imageFallback`, `renderImage`, `resetCapabilitiesCache`, `setCellDimensions`), and width utilities (`truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`).

If a future phase needs an additional symbol, extend this document AND the engine barrel in the same commit. Never import from pi-mono outside `src/engine/`.
