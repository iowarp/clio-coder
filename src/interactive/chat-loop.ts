import { BusChannels } from "../core/bus-events.js";
import { type ClioSettings, settingsPath } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { ToolName } from "../core/tool-names.js";
import type { ModesContract } from "../domains/modes/contract.js";
import type { ObservabilityContract } from "../domains/observability/contract.js";
import type { CompileResult, DynamicInputs } from "../domains/prompts/compiler.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import { sha256 } from "../domains/prompts/hash.js";
import { toContextOverflowError } from "../domains/providers/errors.js";
import {
	type EndpointDescriptor,
	type ProvidersContract,
	type RuntimeDescriptor,
	resolveModelCapabilities,
	type ThinkingLevel,
	targetRequiresAuth,
} from "../domains/providers/index.js";
import type { LocalModelQuirks } from "../domains/providers/types/local-model-quirks.js";
import { assessFinishContract } from "../domains/safety/finish-contract.js";
import { AutoCompactionTrigger, shouldCompact } from "../domains/session/compaction/auto.js";
import type { CompactResult } from "../domains/session/compaction/compact.js";
import {
	type ContextUsageSnapshot,
	contextUsageSnapshot,
	estimateAgentContextTokens,
	extractReasoningTokens,
} from "../domains/session/context-accounting.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import { protectedArtifactStateFromSessionEntries } from "../domains/session/protected-artifacts.js";
import {
	computeRetryDelayMs,
	createRetryCountdown,
	DEFAULT_RETRY_SETTINGS,
	isRetryableErrorMessage,
	type RetryCountdownHandle,
	type RetrySettings,
} from "../domains/session/retry.js";
import { createEngineAgent } from "../engine/agent.js";
import { evictOtherOllamaModels } from "../engine/apis/ollama-native.js";
import { applyThinkingMechanism } from "../engine/apis/thinking-mechanism.js";
import { patchReasoningSummaryPayload } from "../engine/provider-payload.js";
import type { AgentEvent, AgentMessage, Model, MutableAgentState } from "../engine/types.js";
import { resolveAgentTools } from "../engine/worker-tools.js";
import type { ToolRegistry } from "../tools/registry.js";
import { buildReplayAgentMessagesFromTurns } from "./chat-renderer.js";
import { renderCompactionSummaryLine } from "./renderers/compaction-summary.js";
import type { AgentStatusEvent } from "./status/types.js";

type AssistantDeltaEvent =
	| {
			type: "text_delta";
			contentIndex: number;
			delta: string;
			partialText: string;
	  }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			partialThinking: string;
	  };

export type RetryStatusPhase = "scheduled" | "waiting" | "retrying" | "cancelled" | "exhausted" | "recovered";

export interface RetryStatusPayload {
	phase: RetryStatusPhase;
	attempt: number;
	maxAttempts: number;
	errorMessage?: string;
	delayMs?: number;
	seconds?: number;
}

export interface RetryStatusEvent {
	type: "retry_status";
	status: RetryStatusPayload;
}

export type ChatLoopEvent = AgentEvent | AssistantDeltaEvent | RetryStatusEvent | AgentStatusEvent;

export interface ChatLoop {
	submit(text: string): Promise<void>;
	cancel(): void;
	onEvent(handler: (event: ChatLoopEvent) => void): () => void;
	getSessionId(): string | null;
	isStreaming(): boolean;
	contextUsage(): ContextUsageSnapshot;
	/**
	 * Force-run the compaction flow for the current session, swap the agent's
	 * in-memory `state.messages` for a single bridge message carrying the
	 * summary, and emit the standard summary notice. Used by the `/compact`
	 * slash command so the next user turn ships only the bridge plus the new
	 * text to the provider (slice 12.5b bug 4). Silent no-op when no session
	 * or no compaction deps are wired; in both cases emits a user-visible
	 * notice so the `/compact` handler does not have to mirror the logic.
	 */
	compact(instructions?: string): Promise<void>;
	/**
	 * Drop or replace the chat-loop's in-memory state after a session switch
	 * (/resume, /fork, /new). `leafTurnId` is the id the next user turn
	 * should parent under. `replayMessages` is the provider context rebuilt
	 * from the selected session entries; omit it for a fresh session.
	 */
	resetForSession(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void;
}

export interface CreateChatLoopDeps {
	getSettings: () => Readonly<ClioSettings>;
	modes: ModesContract;
	providers: ProvidersContract;
	/**
	 * Whitelist of target ids that the chat-loop is allowed to drive. The
	 * orchestrator composes this from `providers.list()` so an unknown
	 * `settings.orchestrator.endpoint` surfaces a configuration error before
	 * the agent is constructed.
	 */
	knownEndpoints: () => ReadonlySet<string>;
	session?: SessionContract;
	/**
	 * Prompt compiler. When wired, every `submit()` re-runs
	 * `prompts.compileForTurn` with the current mode + safety level, writes the
	 * compiled text into `state.systemPrompt`, and threads the resulting
	 * `renderedPromptHash` onto the user + assistant session entries.
	 *
	 * Optional so unit tests can inject stubs and a degraded boot (prompts
	 * failed to load) still runs with the built-in identity fallback below.
	 * In production this is always wired by `entry/orchestrator.ts`.
	 */
	prompts?: PromptsContract;
	createAgent?: typeof createEngineAgent;
	/**
	 * Return the current session's entries for token estimation. The chat-loop
	 * calls this on every submit so the auto-compaction threshold sees the
	 * latest transcript. Returns an empty array when there is no current
	 * session or when the session contract is absent.
	 */
	readSessionEntries?: () => ReadonlyArray<SessionEntry>;
	/**
	 * Run the compaction flow end-to-end (read entries, resolve model,
	 * summarize, persist a compactionSummary entry) and return the result,
	 * or null when the flow is a no-op (no entries, no cut crossed, no model
	 * configured). Chat-loop invokes this from two sites:
	 *   1. Before every agent.prompt when the threshold is crossed or
	 *      CLIO_FORCE_COMPACT=1 is set.
	 *   2. After catching a ContextOverflowError, as the first half of the
	 *      one-shot compact-and-retry recovery path.
	 * Both sites share an AutoCompactionTrigger so two fires in the same tick
	 * coalesce onto one summarization call.
	 */
	autoCompact?: (instructions?: string, trigger?: CompactionTrigger) => Promise<CompactResult | null>;
	/** Optional observability sink for orchestrator chat token usage. */
	observability?: ObservabilityContract;
	/** Optional prompt supplement installed when Clio is editing its own repository. */
	selfDevPrompt?: string;
	/**
	 * Production tool admission path. When wired, every agent-facing tool runs
	 * through `ToolRegistry.invoke(...)` so safety classification and mode
	 * admission happen on the actual execution path.
	 */
	toolRegistry?: ToolRegistry;
	/**
	 * Shared event bus. When wired, `cancel()` fans a `BusChannels.RunAborted`
	 * payload with `source: "stream_cancel"` so the safety audit subscriber
	 * persists a kind: "abort" row for every Esc-on-stream / Ctrl+C cancel.
	 * Optional so unit tests that drive chat-loop in isolation do not need
	 * to construct a bus.
	 */
	bus?: SafeEventBus;
	/**
	 * Build the approved-memory prompt section for the current turn. Returns
	 * the empty string when no approved, evidence-linked, in-scope memory
	 * applies; otherwise returns a compact markdown section that the prompt
	 * compiler injects via the memory dynamic fragment. Optional so unit
	 * tests omit it when memory is irrelevant.
	 */
	getMemorySection?: () => string;
}

interface ChatLoopTarget {
	endpoint: EndpointDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	thinkingLevel: ThinkingLevel;
}

interface AgentRuntime {
	agent: ReturnType<typeof createEngineAgent>["agent"];
	endpointId: string;
	runtimeId: string;
	wireModelId: string;
}

function notConfiguredNotice(): string {
	return `[Clio Coder] orchestrator not configured. Edit ${settingsPath()} (orchestrator.target + orchestrator.model) to enable chat.`;
}

const LOCAL_API_KEY_FALLBACK = "clio-local-endpoint";

function extractText(message: AgentMessage | undefined): string {
	if (
		!message ||
		typeof message !== "object" ||
		message === null ||
		!("role" in message) ||
		message.role !== "assistant"
	) {
		return "";
	}
	const content = "content" in message && Array.isArray(message.content) ? message.content : [];
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("");
}

function extractThinking(message: AgentMessage | undefined): string {
	if (
		!message ||
		typeof message !== "object" ||
		message === null ||
		!("role" in message) ||
		message.role !== "assistant"
	) {
		return "";
	}
	const content = "content" in message && Array.isArray(message.content) ? message.content : [];
	return content
		.filter(
			(item): item is { type: "thinking"; thinking: string } =>
				item?.type === "thinking" && typeof item.thinking === "string",
		)
		.map((item) => item.thinking)
		.join("");
}

interface TerminalAssistantFailure {
	stopReason: "error" | "aborted";
	errorMessage: string;
	message?: AgentMessage;
}

function terminalFailureFromAssistantMessage(message: AgentMessage | undefined): TerminalAssistantFailure | null {
	if (
		!message ||
		typeof message !== "object" ||
		message === null ||
		!("role" in message) ||
		message.role !== "assistant"
	) {
		return null;
	}
	const stopReason = (message as { stopReason?: unknown }).stopReason;
	if (stopReason !== "error" && stopReason !== "aborted") return null;
	const rawError = (message as { errorMessage?: unknown }).errorMessage;
	const errorMessage =
		typeof rawError === "string" && rawError.length > 0
			? rawError
			: stopReason === "aborted"
				? "request aborted"
				: "provider returned an error";
	return { stopReason, errorMessage, message };
}

function finalAssistantStopMessage(messages: ReadonlyArray<AgentMessage>): AgentMessage | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (
			!message ||
			typeof message !== "object" ||
			message === null ||
			!("role" in message) ||
			message.role !== "assistant"
		) {
			continue;
		}
		const stopReason = (message as { stopReason?: unknown }).stopReason;
		if (stopReason !== undefined && stopReason !== "stop") continue;
		return message;
	}
	return null;
}

function noticeMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
}

/**
 * Built-in identity text used when `deps.prompts` is not wired (tests, degraded
 * boot). Production always overrides this via the prompts compiler; the
 * fallback exists so a chat-loop without a compiler still identifies as Clio.
 *
 * Kept short on purpose: small instruction-tuned models will copy the most
 * emphatic verbatim phrasing out of the system prompt into their replies. A
 * compact persona description lets the model speak naturally; the canonical
 * identity block lives in src/domains/prompts/fragments/identity/clio.md.
 */
function fallbackIdentityPrompt(): string {
	return [
		"You are Clio, a coding agent in IOWarp's CLIO ecosystem of agentic science (NSF-funded, iowarp.ai).",
		"You focus on HPC and scientific-software engineering.",
		"Whichever weights run you, your name and persona are Clio. You are not Claude, GPT, Qwen, Gemini, Llama, Mistral, or any other vendor's assistant.",
	].join(" ");
}

function visibleToolSnapshot(modes: ModesContract): ToolName[] {
	return Array.from(modes.visibleTools());
}

function resolveRuntimeTools(deps: CreateChatLoopDeps): ReturnType<typeof resolveAgentTools> {
	if (!deps.toolRegistry) return [];
	return resolveAgentTools({
		registry: deps.toolRegistry,
		allowedTools: visibleToolSnapshot(deps.modes),
		mode: deps.modes.current(),
	});
}

interface RunUsageSummary {
	tokens: number;
	costUsd: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	apiCalls: number;
	hadReasoning: boolean;
	hadUsage: boolean;
}

/**
 * Sum per-call usage across every assistant message in a single agent run.
 * pi-ai emits one `AssistantMessage` per API call, each carrying its own
 * `Usage` object; a multi-turn tool-calling loop produces several assistant
 * messages. Earlier versions of this function walked the list from the tail
 * and returned the first match, which silently dropped every intermediate
 * API call from the cost tally. Summing instead matches what the provider
 * actually billed and keeps the `/cost` overlay and footer counters
 * aligned across tool-heavy runs.
 */
export function sumRunUsage(messages: ReadonlyArray<AgentMessage>): RunUsageSummary {
	const summary: RunUsageSummary = {
		tokens: 0,
		costUsd: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		apiCalls: 0,
		hadReasoning: false,
		hadUsage: false,
	};
	for (const raw of messages) {
		const message = raw as
			| AgentMessage
			| {
					role?: unknown;
					usage?: {
						input?: unknown;
						output?: unknown;
						cacheRead?: unknown;
						cacheWrite?: unknown;
						totalTokens?: unknown;
						cost?: { total?: unknown };
					};
			  };
		if (!message || typeof message !== "object") continue;
		if (message.role !== "assistant") continue;
		const usage = message.usage;
		if (!usage || typeof usage !== "object") continue;
		summary.hadUsage = true;
		summary.apiCalls += 1;
		const input = typeof usage.input === "number" ? usage.input : 0;
		const output = typeof usage.output === "number" ? usage.output : 0;
		const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
		const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
		summary.input += input;
		summary.output += output;
		summary.cacheRead += cacheRead;
		summary.cacheWrite += cacheWrite;
		const reasoning = extractReasoningTokens(usage);
		if (reasoning !== null) {
			summary.reasoning += reasoning;
			summary.hadReasoning = true;
		}
		if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
			summary.tokens += usage.totalTokens;
		} else {
			summary.tokens += input + output + cacheRead + cacheWrite;
		}
		const total = usage.cost?.total;
		if (typeof total === "number") summary.costUsd += total;
	}
	return summary;
}

function assistantSessionPayload(
	message: AgentMessage,
	failure: TerminalAssistantFailure | null,
): Record<string, unknown> {
	const text = extractText(message).trim();
	const thinking = extractThinking(message).trim();
	const payload: Record<string, unknown> = { text };
	const raw = message as unknown as Record<string, unknown>;
	if (Array.isArray(raw.content)) payload.content = raw.content;
	if (thinking.length > 0) payload.thinking = thinking;
	for (const key of ["usage", "api", "provider", "model", "responseId"]) {
		if (raw[key] !== undefined) payload[key] = raw[key];
	}
	if (failure) {
		payload.stopReason = failure.stopReason;
		payload.errorMessage = failure.errorMessage;
	} else {
		const stopReason = raw.stopReason;
		if (stopReason !== undefined) payload.stopReason = stopReason;
	}
	return payload;
}

function hasPersistableAssistantContent(
	payload: Record<string, unknown>,
	failure: TerminalAssistantFailure | null,
): boolean {
	if (failure) return true;
	if (typeof payload.text === "string" && payload.text.trim().length > 0) return true;
	if (typeof payload.thinking === "string" && payload.thinking.trim().length > 0) return true;
	if (Array.isArray(payload.content) && payload.content.length > 0) return true;
	return false;
}

export function createChatLoop(deps: CreateChatLoopDeps): ChatLoop {
	const listeners = new Set<(event: ChatLoopEvent) => void>();
	const createAgent = deps.createAgent ?? createEngineAgent;
	const compactionTrigger = new AutoCompactionTrigger<CompactResult | null>();
	let runtime: AgentRuntime | null = null;
	let lastTurnId: string | null = null;
	let streaming = false;
	let currentThinkingLevel: ThinkingLevel = deps.getSettings().orchestrator.thinkingLevel ?? "off";
	let replayedContextMessages: AgentMessage[] = [];
	let retryCountdown: RetryCountdownHandle | null = null;
	const persistedAssistantMessages = new WeakSet<object>();
	// Hash of the prompt compiled for the in-flight turn. User + assistant
	// entries appended during that turn stamp this value so downstream
	// analysis can reproduce exactly which fragments the model saw.
	let currentTurnHash: string | null = null;

	const emit = (event: ChatLoopEvent): void => {
		for (const listener of listeners) {
			listener(event);
		}
	};

	const appendAssistantTurn = (message: AgentMessage): void => {
		if (!message || message.role !== "assistant") return;
		const failure = terminalFailureFromAssistantMessage(message);
		const payload = assistantSessionPayload(message, failure);
		if (!deps.session || !hasPersistableAssistantContent(payload, failure)) return;
		if (message && typeof message === "object") persistedAssistantMessages.add(message as object);
		const turn = deps.session.append({
			kind: "assistant",
			parentId: lastTurnId,
			payload,
			...(currentTurnHash !== null ? { renderedPromptHash: currentTurnHash } : {}),
		});
		lastTurnId = turn.id;
	};

	const appendToolCallTurn = (event: Extract<AgentEvent, { type: "tool_execution_start" }>): void => {
		if (!deps.session) return;
		const turn = deps.session.append({
			kind: "tool_call",
			parentId: lastTurnId,
			payload: {
				toolCallId: event.toolCallId,
				name: event.toolName,
				args: event.args,
			},
		});
		lastTurnId = turn.id;
	};

	const appendToolResultTurn = (event: Extract<AgentEvent, { type: "tool_execution_end" }>): void => {
		if (!deps.session) return;
		const turn = deps.session.append({
			kind: "tool_result",
			parentId: lastTurnId,
			payload: {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			},
		});
		lastTurnId = turn.id;
	};

	const emitNotice = (text: string): void => {
		const message = noticeMessage(text);
		emit({ type: "message_end", message });
		emit({ type: "agent_end", messages: [message] });
	};

	const appendFinishContractAdvisory = (message: string): void => {
		if (!deps.session?.current()) return;
		try {
			deps.session.appendEntry({
				kind: "custom",
				parentTurnId: lastTurnId,
				customType: "finishContractAdvisory",
				display: true,
				data: { message },
			});
		} catch {
			// Advisory persistence is best-effort; the live notice still
			// reaches the operator through the existing chat event path.
		}
	};

	const emitFinishContractAdvisory = (messages: ReadonlyArray<AgentMessage>): void => {
		if (!deps.session?.current() || !deps.readSessionEntries) return;
		const message = finalAssistantStopMessage(messages);
		if (message === null) return;
		const text = extractText(message).trim();
		if (text.length === 0) return;
		let entries: ReadonlyArray<SessionEntry>;
		try {
			entries = deps.readSessionEntries();
		} catch {
			return;
		}
		const assessment = assessFinishContract({
			assistantText: text,
			sessionEntries: entries,
			assistantTurnId: lastTurnId,
		});
		if (assessment.kind !== "advisory") return;
		appendFinishContractAdvisory(assessment.message);
		emitNotice(assessment.message);
	};

	const retrySettings = (): RetrySettings => {
		const raw = deps.getSettings().retry;
		return {
			enabled: raw?.enabled ?? DEFAULT_RETRY_SETTINGS.enabled,
			maxRetries:
				typeof raw?.maxRetries === "number" && Number.isFinite(raw.maxRetries)
					? Math.max(0, Math.floor(raw.maxRetries))
					: DEFAULT_RETRY_SETTINGS.maxRetries,
			baseDelayMs:
				typeof raw?.baseDelayMs === "number" && Number.isFinite(raw.baseDelayMs)
					? Math.max(0, Math.floor(raw.baseDelayMs))
					: DEFAULT_RETRY_SETTINGS.baseDelayMs,
			maxDelayMs:
				typeof raw?.maxDelayMs === "number" && Number.isFinite(raw.maxDelayMs)
					? Math.max(0, Math.floor(raw.maxDelayMs))
					: DEFAULT_RETRY_SETTINGS.maxDelayMs,
		};
	};

	const emitRetryStatus = (status: RetryStatusPayload): void => {
		emit({ type: "retry_status", status });
	};

	const appendRetryStatus = (status: RetryStatusPayload): void => {
		if (!deps.session?.current()) return;
		deps.session.appendEntry({
			kind: "custom",
			parentTurnId: lastTurnId,
			customType: "retryStatus",
			display: true,
			data: status,
		});
	};

	const recordRetryStatus = (status: RetryStatusPayload, durable = true): void => {
		if (durable) appendRetryStatus(status);
		emitRetryStatus(status);
	};

	const ensureFailureVisibleAndPersisted = (failure: TerminalAssistantFailure): void => {
		const message = failure.message;
		if (!message || typeof message !== "object" || persistedAssistantMessages.has(message as object)) return;
		appendAssistantTurn(message);
		emit({ type: "message_end", message });
	};

	const detectTerminalFailureFromState = (
		agent: ReturnType<typeof createEngineAgent>["agent"],
	): TerminalAssistantFailure | null => {
		const msgs = agent.state.messages;
		const tail = Array.isArray(msgs) ? msgs[msgs.length - 1] : undefined;
		const failure = terminalFailureFromAssistantMessage(tail);
		if (failure) return failure;
		return null;
	};

	const pruneFailedAssistantFromContext = (agent: ReturnType<typeof createEngineAgent>["agent"]): void => {
		const messages = agent.state.messages;
		const tail = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
		if (!terminalFailureFromAssistantMessage(tail)) return;
		agent.state.messages = messages.slice(0, -1);
	};

	const waitForRetryCountdown = async (status: RetryStatusPayload): Promise<"done" | "cancelled"> => {
		return new Promise((resolve) => {
			let settled = false;
			let currentHandle: RetryCountdownHandle | null = null;
			const handle = createRetryCountdown({
				attempt: status.attempt,
				maxAttempts: status.maxAttempts,
				delayMs: status.delayMs ?? 0,
				onTick: (state) => {
					emitRetryStatus({
						...status,
						phase: "waiting",
						seconds: state.seconds,
					});
				},
				onDone: () => {
					settled = true;
					if (retryCountdown === currentHandle) retryCountdown = null;
					resolve("done");
				},
				onCancel: () => {
					settled = true;
					if (retryCountdown === currentHandle) retryCountdown = null;
					resolve("cancelled");
				},
			});
			currentHandle = handle;
			retryCountdown = settled ? null : handle;
		});
	};

	const readTarget = (): ChatLoopTarget | null => {
		const settings = deps.getSettings();
		const endpointId = settings.orchestrator.endpoint?.trim();
		const wireModelId = settings.orchestrator.model?.trim();
		if (!endpointId || !wireModelId) return null;
		const endpoint = deps.providers.getEndpoint(endpointId);
		if (!endpoint) {
			throw new Error(`[Clio Coder] orchestrator target='${endpointId}' not found in settings.targets`);
		}
		const runtimeDesc = deps.providers.getRuntime(endpoint.runtime);
		if (!runtimeDesc) {
			throw new Error(`[Clio Coder] orchestrator runtime='${endpoint.runtime}' not registered`);
		}
		if (runtimeDesc.kind === "subprocess") {
			throw new Error(
				`[Clio Coder] target '${endpointId}' uses a subprocess runtime (${runtimeDesc.id}); subprocess runtimes can only be used as worker targets, not as the orchestrator chat target`,
			);
		}
		return {
			endpoint,
			runtime: runtimeDesc,
			wireModelId,
			thinkingLevel: settings.orchestrator.thinkingLevel ?? "off",
		};
	};

	const synthesizeModel = (target: ChatLoopTarget): Model<never> => {
		const kbHit = deps.providers.knowledgeBase?.lookup(target.wireModelId) ?? null;
		const synth = target.runtime.synthesizeModel(target.endpoint, target.wireModelId, kbHit);
		const detectedReasoning = deps.providers.getDetectedReasoning(target.endpoint.id, target.wireModelId);
		const mutable = synth as { contextWindow?: number; maxTokens?: number; reasoning?: boolean };
		const status = deps.providers.list().find((entry) => entry.endpoint.id === target.endpoint.id);
		if (status) {
			const caps = resolveModelCapabilities(status, target.wireModelId, deps.providers.knowledgeBase, {
				detectedReasoning,
			});
			mutable.contextWindow = caps.contextWindow;
			mutable.maxTokens = caps.maxTokens;
			mutable.reasoning = caps.reasoning;
		} else if (detectedReasoning === true && mutable.reasoning !== true) {
			mutable.reasoning = true;
		}
		return synth as unknown as Model<never>;
	};

	const ensureReasoningProbe = (target: ChatLoopTarget): void => {
		if (deps.providers.getDetectedReasoning(target.endpoint.id, target.wireModelId) !== null) return;
		void deps.providers
			.probeReasoningForModel(target.endpoint.id, target.wireModelId)
			.then((reasoning) => {
				if (
					reasoning !== null &&
					runtime &&
					runtime.endpointId === target.endpoint.id &&
					runtime.wireModelId === target.wireModelId
				) {
					const liveModel = runtime.agent.state.model as { reasoning?: boolean } | undefined;
					if (liveModel && liveModel.reasoning !== reasoning) liveModel.reasoning = reasoning;
					const requested = deps.getSettings().orchestrator.thinkingLevel ?? "off";
					if (requested !== "off") {
						runtime.agent.state.thinkingLevel = clampThinkingLevelForModel(
							runtime.agent.state.model as Model<never>,
							requested,
						);
					}
				}
			})
			.catch(() => {
				// Probe failures are non-fatal; the cache stays cold and /thinking
				// keeps showing the runtime defaults until the next probe attempt.
			});
	};

	/**
	 * Mirror of pi-coding-agent's setThinkingLevel clamp: when the resolved
	 * model lacks reasoning capability, force "off" so providers do not see a
	 * thinking budget they cannot honor. The orchestrator's requested level is
	 * preserved on settings; this only governs what reaches pi-agent-core.
	 */
	const clampThinkingLevelForModel = (model: Model<never>, requested: ThinkingLevel): ThinkingLevel => {
		const reasons = (model as unknown as { reasoning?: unknown }).reasoning === true;
		return reasons ? requested : "off";
	};

	/**
	 * Append a `modelChange` session entry so /resume and /fork can replay the
	 * sequence of models a long-running session ran under. Silent no-op when
	 * the session contract is absent or no session is current. The
	 * orchestrator's chat-loop is the only writer; chat-renderer.ts already
	 * knows how to display the entry.
	 */
	const appendModelChangeEntry = (target: ChatLoopTarget): void => {
		if (!deps.session?.current()) return;
		try {
			deps.session.appendEntry({
				kind: "modelChange",
				parentTurnId: lastTurnId,
				provider: target.runtime.id,
				modelId: target.wireModelId,
				endpoint: target.endpoint.id,
			});
		} catch {
			// Persistence failures must not break chat. The marker is a
			// best-effort breadcrumb; absence falls back to current behavior.
		}
	};

	const ensureRuntime = (): AgentRuntime | null => {
		const target = readTarget();
		if (!target) return null;
		if (!deps.knownEndpoints().has(target.endpoint.id)) {
			throw new Error(
				`[Clio Coder] orchestrator target=${target.endpoint.id} unknown. Run \`clio targets\` to see configured targets.`,
			);
		}
		if (
			runtime &&
			runtime.endpointId === target.endpoint.id &&
			runtime.runtimeId === target.runtime.id &&
			runtime.wireModelId === target.wireModelId
		) {
			// Same endpoint+runtime+model. Settings may still have moved
			// thinkingLevel since the last call (the user invoked /thinking
			// or Alt+T); reconcile the clamped level so the next prompt
			// dispatches under the current intent without forcing a rebuild.
			ensureReasoningProbe(target);
			const desiredLevel = clampThinkingLevelForModel(runtime.agent.state.model as Model<never>, target.thinkingLevel);
			if (runtime.agent.state.thinkingLevel !== desiredLevel) {
				runtime.agent.state.thinkingLevel = desiredLevel;
			}
			return runtime;
		}

		// Same endpoint+runtime, new wireModelId: hot-swap the model in place on
		// the live agent. Mirrors the pi-coding-agent setModel pattern (mutate
		// `agent.state.model`, re-clamp thinking level, persist) so the runtime
		// keeps its conversation, subscribers, and pending tool calls. Local
		// runtimes (LM Studio, Ollama) manage their own resident-model lifecycle
		// via JIT load and TTL; Clio does not micromanage server-side eviction.
		if (
			runtime &&
			runtime.endpointId === target.endpoint.id &&
			runtime.runtimeId === target.runtime.id &&
			runtime.wireModelId !== target.wireModelId
		) {
			const nextModel = synthesizeModel(target);
			runtime.agent.state.model = nextModel;
			runtime.wireModelId = target.wireModelId;
			runtime.agent.state.thinkingLevel = clampThinkingLevelForModel(nextModel, target.thinkingLevel);
			appendModelChangeEntry(target);
			ensureReasoningProbe(target);
			// Ollama pins the active model with keep_alive=-1; fire a one-shot
			// keep_alive=0 sweep against any other resident model so the prior
			// pinned weight releases VRAM. Fire-and-forget so a slow server
			// never blocks the model swap.
			if (target.runtime.id === "ollama-native" && target.endpoint.url) {
				void evictOtherOllamaModels(target.endpoint.url, target.wireModelId, target.endpoint.auth?.headers);
			}
			return runtime;
		}

		const model = synthesizeModel(target);
		const initialThinkingLevel = clampThinkingLevelForModel(model, target.thinkingLevel);
		const tools = resolveRuntimeTools(deps);
		// Seed the system prompt with the fallback identity text. `submit` then
		// runs `compilePromptForTurn` before every `agent.prompt` call and
		// overwrites this in place, so the fallback only shows up when the
		// prompts contract is absent (tests, degraded boot).
		const hadPriorRuntime = runtime !== null;
		const priorMessages = runtime ? [...runtime.agent.state.messages] : [...replayedContextMessages];
		// Drop any in-flight stream on the prior agent before discarding it.
		runtime?.agent.abort();
		const handle = createAgent({
			initialState: {
				systemPrompt: fallbackIdentityPrompt(),
				model,
				thinkingLevel: initialThinkingLevel,
				tools,
				messages: priorMessages,
			},
			maxRetryDelayMs: retrySettings().maxDelayMs,
			onPayload: async (payload, currentModel) =>
				patchReasoningSummaryPayload(payload, currentModel as Model<never>, currentThinkingLevel),
			getApiKey: async () => {
				if (!targetRequiresAuth(target.endpoint, target.runtime)) {
					return LOCAL_API_KEY_FALLBACK;
				}
				const resolved = await deps.providers.auth.resolveForTarget(target.endpoint, target.runtime);
				return resolved.apiKey;
			},
		});

		// Build the runtime object before subscribing so the callback closes
		// over the same heap object the hot-swap path mutates. Reading
		// `localRuntime.endpointId` / `localRuntime.wireModelId` at event time
		// instead of the captured `target` guarantees per-turn observability
		// rows are tagged with whatever model is active right now, not the
		// model this agent was originally built with.
		const localRuntime: AgentRuntime = {
			agent: handle.agent,
			endpointId: target.endpoint.id,
			runtimeId: target.runtime.id,
			wireModelId: target.wireModelId,
		};

		handle.agent.subscribe(async (event) => {
			emit(event);
			if (event.type === "message_update") {
				const assistantEvent = event.assistantMessageEvent as {
					type: string;
					contentIndex?: number;
					delta?: string;
					partial?: AgentMessage;
				};
				if (assistantEvent.type === "text_delta") {
					emit({
						type: "text_delta",
						contentIndex: assistantEvent.contentIndex ?? 0,
						delta: assistantEvent.delta ?? "",
						partialText: extractText(assistantEvent.partial),
					});
				}
				if (assistantEvent.type === "thinking_delta") {
					emit({
						type: "thinking_delta",
						contentIndex: assistantEvent.contentIndex ?? 0,
						delta: assistantEvent.delta ?? "",
						partialThinking: extractThinking(assistantEvent.partial),
					});
				}
			}
			if (event.type === "message_end") {
				appendAssistantTurn(event.message);
			}
			if (event.type === "tool_execution_start") {
				appendToolCallTurn(event);
			}
			if (event.type === "tool_execution_end") {
				appendToolResultTurn(event);
			}
			if (event.type === "agent_end" && deps.observability) {
				const summary = sumRunUsage(event.messages);
				if (summary.hadUsage && (summary.tokens > 0 || summary.costUsd > 0)) {
					deps.observability.recordTokens(
						localRuntime.endpointId,
						localRuntime.wireModelId,
						summary.tokens,
						summary.costUsd,
						{
							input: summary.input,
							output: summary.output,
							cacheRead: summary.cacheRead,
							cacheWrite: summary.cacheWrite,
							reasoningTokens: summary.reasoning,
							totalTokens: summary.tokens,
							apiCalls: summary.apiCalls,
						},
					);
				}
			}
			if (event.type === "agent_end") {
				emitFinishContractAdvisory(event.messages);
			}
		});

		runtime = localRuntime;
		// Append a modelChange marker only when this rebuild replaces a prior
		// runtime, which is the cross-target swap case (mid-session change of
		// endpoint or runtime id). On the initial build, the session header's
		// `meta.model` (written by `session.create()` in submit()) captures
		// the first model and a marker would be redundant.
		if (hadPriorRuntime) appendModelChangeEntry(target);
		ensureReasoningProbe(target);
		return runtime;
	};

	/**
	 * Inspect the agent's state after `agent.prompt` resolves. pi-agent-core
	 * 0.70.x's `handleRunFailure` records the upstream error on the assistant
	 * message (stopReason="error", errorMessage="<text>") and on
	 * `state.errorMessage`, then resolves the prompt() Promise normally.
	 * Returns a ContextOverflowError when either surface matches the heuristic
	 * in src/domains/providers/errors.ts; null otherwise.
	 */
	const detectOverflowFromState = (
		agent: ReturnType<typeof createEngineAgent>["agent"],
	): ReturnType<typeof toContextOverflowError> => {
		const direct = agent.state.errorMessage;
		if (typeof direct === "string" && direct.length > 0) {
			const match = toContextOverflowError(direct);
			if (match) return match;
		}
		const msgs = agent.state.messages;
		const tail = Array.isArray(msgs) ? msgs[msgs.length - 1] : undefined;
		if (tail && typeof tail === "object" && (tail as { stopReason?: unknown }).stopReason === "error") {
			const em = (tail as { errorMessage?: unknown }).errorMessage;
			if (typeof em === "string") {
				const match = toContextOverflowError(em);
				if (match) return match;
			}
		}
		return null;
	};

	/**
	 * Shared compact-and-retry worker used by both the post-resolve
	 * (state-based) and catch (throw-based) overflow paths in `submit`.
	 * Emits the "context overflow" notice when compaction is a no-op,
	 * the "compact-on-overflow failed" notice when compaction itself
	 * throws, and a "persisted" notice when the retry still surfaces an
	 * overflow.
	 */
	const runCompactAndRetry = async (
		agentRuntime: AgentRuntime,
		text: string,
		overflow: NonNullable<ReturnType<typeof toContextOverflowError>>,
	): Promise<void> => {
		let compacted = false;
		try {
			pruneFailedAssistantFromContext(agentRuntime.agent);
			const mutableState = agentRuntime.agent.state as MutableAgentState;
			mutableState.errorMessage = undefined;
			compacted = await runAutoCompact(agentRuntime, true, undefined, "overflow");
		} catch (compactErr) {
			emitNotice(
				`[Clio Coder] compact-on-overflow failed: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`,
			);
		}
		if (!compacted) {
			emitNotice(`[Clio Coder] context overflow: ${overflow.message}`);
			return;
		}
		try {
			await agentRuntime.agent.prompt(text);
			const stillOverflowed = detectOverflowFromState(agentRuntime.agent);
			if (stillOverflowed) {
				emitNotice(`[Clio Coder] context overflow persisted after compaction: ${stillOverflowed.message}`);
			}
		} catch (retryErr) {
			emitNotice(
				`[Clio Coder] context overflow persisted after compaction: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
			);
		}
	};

	const runTransientRetryChain = async (
		agentRuntime: AgentRuntime,
		text: string,
		initialFailure: TerminalAssistantFailure,
	): Promise<boolean> => {
		const settings = retrySettings();
		if (!settings.enabled || settings.maxRetries <= 0) return false;
		if (initialFailure.stopReason === "aborted" || !isRetryableErrorMessage(initialFailure.errorMessage)) return false;

		let failure = initialFailure;
		for (let attempt = 1; attempt <= settings.maxRetries; attempt += 1) {
			ensureFailureVisibleAndPersisted(failure);
			pruneFailedAssistantFromContext(agentRuntime.agent);

			const scheduled: RetryStatusPayload = {
				phase: "scheduled",
				attempt,
				maxAttempts: settings.maxRetries,
				delayMs: computeRetryDelayMs(attempt, settings),
				errorMessage: failure.errorMessage,
			};
			recordRetryStatus(scheduled);
			const countdown = await waitForRetryCountdown(scheduled);
			if (countdown === "cancelled") {
				recordRetryStatus({
					phase: "cancelled",
					attempt,
					maxAttempts: settings.maxRetries,
					errorMessage: failure.errorMessage,
				});
				pruneFailedAssistantFromContext(agentRuntime.agent);
				return true;
			}

			recordRetryStatus(
				{
					phase: "retrying",
					attempt,
					maxAttempts: settings.maxRetries,
					errorMessage: failure.errorMessage,
				},
				false,
			);

			try {
				await agentRuntime.agent.continue();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (!isRetryableErrorMessage(message) || attempt >= settings.maxRetries) {
					recordRetryStatus({
						phase: "exhausted",
						attempt,
						maxAttempts: settings.maxRetries,
						errorMessage: message,
					});
					emitNotice(message);
					pruneFailedAssistantFromContext(agentRuntime.agent);
					return true;
				}
				failure = { stopReason: "error", errorMessage: message };
				continue;
			}

			const overflow = detectOverflowFromState(agentRuntime.agent);
			if (overflow) {
				await runCompactAndRetry(agentRuntime, text, overflow);
				return true;
			}

			const nextFailure = detectTerminalFailureFromState(agentRuntime.agent);
			if (!nextFailure) {
				recordRetryStatus({
					phase: "recovered",
					attempt,
					maxAttempts: settings.maxRetries,
				});
				return true;
			}
			ensureFailureVisibleAndPersisted(nextFailure);
			if (nextFailure.stopReason === "aborted" || !isRetryableErrorMessage(nextFailure.errorMessage)) {
				pruneFailedAssistantFromContext(agentRuntime.agent);
				return true;
			}
			failure = nextFailure;
		}

		recordRetryStatus({
			phase: "exhausted",
			attempt: settings.maxRetries,
			maxAttempts: settings.maxRetries,
			errorMessage: failure.errorMessage,
		});
		pruneFailedAssistantFromContext(agentRuntime.agent);
		return true;
	};

	/**
	 * Compile the prompt for the current turn, write the rendered text into
	 * `state.systemPrompt`, and capture the renderedPromptHash so the user
	 * and assistant entries appended this turn can carry it. Runs on every
	 * `submit` so any mode/safety/provider change since the last turn is
	 * picked up; compile is O(fragment table) and sha256 hashing, well under
	 * a millisecond, so unconditional recompile beats per-turn change
	 * detection.
	 *
	 * Throws are swallowed and downgraded to a user-visible notice because
	 * a dead prompts domain must not block chat. The fallback identity
	 * stays on `state.systemPrompt` from the previous compile (or from
	 * `ensureRuntime`).
	 */
	const compilePromptForTurn = (agentRuntime: AgentRuntime): CompileResult | null => {
		if (!deps.prompts) {
			currentTurnHash = null;
			return null;
		}
		const settings = deps.getSettings();
		const modelState = agentRuntime.agent.state.model as
			| { contextWindow?: number; reasoning?: boolean; clio?: { quirks?: LocalModelQuirks } }
			| undefined;
		const contextWindow = typeof modelState?.contextWindow === "number" ? modelState.contextWindow : null;
		// Read the thinking budget from the live agent state, which reflects
		// `clampThinkingLevelForModel` after a hot-swap onto a non-reasoning
		// model. If we read raw settings the prompt would advertise e.g.
		// `thinkingBudget: high` while the runtime actually sends "off",
		// telling the model a budget it does not have.
		const runtimeThinkingLevel = agentRuntime.agent.state.thinkingLevel as ThinkingLevel | undefined;
		const effectiveLevel: ThinkingLevel = runtimeThinkingLevel ?? settings.orchestrator.thinkingLevel ?? "off";
		const applied = applyThinkingMechanism(modelState?.clio?.quirks, effectiveLevel, {
			reasoning: modelState?.reasoning === true,
		});
		const guidance = modelState?.clio?.quirks?.thinking?.guidance;
		const dynamicInputs: DynamicInputs = {
			provider: agentRuntime.endpointId,
			model: agentRuntime.wireModelId,
			contextWindow,
			thinkingBudget: effectiveLevel,
			thinkingMechanism: applied.mechanism,
			thinkingApplied: applied.noticeKind,
			thinkingNotice: applied.notice,
			...(guidance ? { thinkingGuidance: guidance } : {}),
			turnCount: 0,
		};
		if (deps.getMemorySection) {
			try {
				const memorySection = deps.getMemorySection();
				if (memorySection.length > 0) dynamicInputs.memorySection = memorySection;
			} catch (err) {
				emitNotice(
					`[Clio Coder] memory load failed; continuing without memory injection: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		const safetyLevel = settings.safetyLevel ?? "auto-edit";
		try {
			const result = deps.prompts.compileForTurn({
				dynamicInputs,
				overrideMode: deps.modes.current(),
				safetyLevel,
				cwd: process.cwd(),
			});
			if (!deps.selfDevPrompt) {
				agentRuntime.agent.state.systemPrompt = result.text;
				currentTurnHash = result.renderedPromptHash;
				return result;
			}
			const text = `${result.text}\n\n${deps.selfDevPrompt}`;
			const renderedPromptHash = sha256(text);
			agentRuntime.agent.state.systemPrompt = text;
			currentTurnHash = renderedPromptHash;
			return { ...result, text, renderedPromptHash };
		} catch (err) {
			currentTurnHash = null;
			emitNotice(
				`[Clio Coder] prompt compile failed; using fallback identity: ${err instanceof Error ? err.message : String(err)}`,
			);
			return null;
		}
	};

	/**
	 * Evaluate the auto-compaction trigger against the current session and,
	 * when it fires, rebuild `agent.state.messages` from the live session view
	 * so the agent state mirrors the compaction summary plus the kept suffix.
	 * Returns true when compaction ran AND produced a non-empty summary; false
	 * otherwise (no deps wired, threshold not crossed, no-op compaction, etc.).
	 * Throws are caller-contained.
	 *
	 * `force = true` bypasses the threshold check. Used for:
	 *   - CLIO_FORCE_COMPACT=1 (deterministic drills / e2e tests).
	 *   - The overflow-recovery retry path after a ContextOverflowError.
	 */
	const runAutoCompact = async (
		agentRuntime: AgentRuntime,
		force: boolean,
		instructions?: string,
		triggerOverride?: CompactionTrigger,
		pendingUserText?: string,
	): Promise<boolean> => {
		if (!deps.autoCompact || !deps.readSessionEntries) return false;
		const settings = deps.getSettings();
		const cfg = settings.compaction;
		const autoEnabled = cfg?.auto !== false;
		if (!force && !autoEnabled) return false;

		if (!force) {
			const modelState = agentRuntime.agent.state.model as { contextWindow?: number } | undefined;
			const contextWindow = typeof modelState?.contextWindow === "number" ? modelState.contextWindow : 0;
			const threshold = typeof cfg?.threshold === "number" ? cfg.threshold : 0.8;
			const estimateInput = {
				systemPrompt: agentRuntime.agent.state.systemPrompt,
				messages: agentRuntime.agent.state.messages,
				...(pendingUserText !== undefined ? { pendingUserText } : {}),
			};
			const tokens = estimateAgentContextTokens(estimateInput);
			if (!shouldCompact(tokens, threshold, contextWindow)) return false;
		}

		const trigger: CompactionTrigger = triggerOverride ?? (force ? "force" : "auto");
		deps.bus?.emit(BusChannels.CompactionBegin, { trigger, at: Date.now() });
		let result: CompactResult | null = null;
		try {
			result = await compactionTrigger.fire(() => (deps.autoCompact ?? (async () => null))(instructions, trigger));
		} finally {
			deps.bus?.emit(BusChannels.CompactionEnd, { trigger, at: Date.now() });
		}
		if (!result || result.summary.length === 0) return false;

		// Rebuild agent state from the live session view. The orchestrator's
		// compaction flow already appended a `compactionSummary` entry; reading
		// the entries again and feeding them through `buildReplayAgentMessagesFromTurns`
		// produces the canonical [summary-as-context, ...kept suffix] message
		// list, mirroring pi-coding-agent's `agent.replaceMessages(buildSessionContext().messages)`
		// contract. The replay builder also filters out error-stopReason
		// assistant entries, which subsumes the pre-compaction prune of failed
		// assistant tails on the overflow path.
		const refreshedEntries = deps.readSessionEntries();
		agentRuntime.agent.state.messages = buildReplayAgentMessagesFromTurns(refreshedEntries);

		emitNotice(
			renderCompactionSummaryLine({
				messagesSummarized: result.messagesSummarized,
				summaryChars: result.summary.length,
				tokensBefore: result.tokensBefore,
				isSplitTurn: result.isSplitTurn,
			}),
		);
		return true;
	};

	return {
		async submit(text: string): Promise<void> {
			if (streaming) {
				emitNotice("[Clio Coder] response already in progress. Press Esc to cancel the active run.");
				return;
			}

			let agentRuntime: AgentRuntime | null;
			try {
				agentRuntime = ensureRuntime();
			} catch (err) {
				emitNotice(err instanceof Error ? err.message : String(err));
				return;
			}
			if (!agentRuntime) {
				emitNotice(notConfiguredNotice());
				return;
			}

			// Recompile the prompt before every turn so mode (/mode, Alt+M),
			// safety level, provider, and model changes since the last turn
			// flow into `state.systemPrompt`. Sets `currentTurnHash` as a
			// side-effect so the user + assistant appends below stamp it.
			compilePromptForTurn(agentRuntime);

			// Pre-submit auto-compaction trigger. CLIO_FORCE_COMPACT=1 bypasses
			// the threshold so /compact integration tests and live drills can
			// force a run without driving real token usage. Compaction failures
			// here are non-fatal: the user's turn still goes through, possibly
			// oversized; the overflow-recovery path will catch that.
			const forceNow = process.env.CLIO_FORCE_COMPACT === "1";
			try {
				await runAutoCompact(agentRuntime, forceNow, undefined, undefined, text);
			} catch (err) {
				emitNotice(`[Clio Coder] auto-compaction skipped: ${err instanceof Error ? err.message : String(err)}`);
			}

			if (deps.session) {
				if (!deps.session.current()) {
					deps.session.create({
						cwd: process.cwd(),
						endpoint: agentRuntime.endpointId,
						model: agentRuntime.wireModelId,
					});
				}
				const userTurn = deps.session.append({
					kind: "user",
					parentId: lastTurnId,
					payload: { text },
					...(currentTurnHash !== null ? { renderedPromptHash: currentTurnHash } : {}),
				});
				lastTurnId = userTurn.id;
				const sessionId = deps.session.current()?.id ?? null;
				if (sessionId) {
					agentRuntime.agent.sessionId = sessionId;
				}
			}

			agentRuntime.agent.state.tools = resolveRuntimeTools(deps);
			agentRuntime.agent.maxRetryDelayMs = retrySettings().maxDelayMs;
			currentThinkingLevel = agentRuntime.agent.state.thinkingLevel;

			streaming = true;
			try {
				await agentRuntime.agent.prompt(text);
				// pi-agent-core 0.70.x does NOT throw on provider failures:
				// it pushes an assistant message with stopReason="error" and
				// errorMessage="<provider text>" onto state.messages, sets
				// state.errorMessage, emits agent_end, and resolves normally.
				// The overflow-recovery heuristic must inspect the state after
				// a resolve, not only the catch arm.
				const overflowPostResolve = detectOverflowFromState(agentRuntime.agent);
				if (overflowPostResolve) {
					await runCompactAndRetry(agentRuntime, text, overflowPostResolve);
				} else {
					const failure = detectTerminalFailureFromState(agentRuntime.agent);
					if (failure) {
						ensureFailureVisibleAndPersisted(failure);
						await runTransientRetryChain(agentRuntime, text, failure);
					}
				}
			} catch (err) {
				// Genuine throws (network, abort, pre-stream bugs) still land
				// here. The heuristic is the same so a thrown overflow from
				// an older pi-agent-core still routes through compact-retry.
				const overflow = toContextOverflowError(err);
				if (!overflow) {
					const message = err instanceof Error ? err.message : String(err);
					if (isRetryableErrorMessage(message)) {
						const failureMessage = {
							role: "assistant",
							content: [{ type: "text", text: "" }],
							stopReason: "error",
							errorMessage: message,
							timestamp: Date.now(),
						} as AgentMessage;
						await runTransientRetryChain(agentRuntime, text, {
							stopReason: "error",
							errorMessage: message,
							message: failureMessage,
						});
						return;
					}
					emitNotice(err instanceof Error ? err.message : String(err));
					return;
				}
				await runCompactAndRetry(agentRuntime, text, overflow);
			} finally {
				streaming = false;
			}
		},
		cancel(): void {
			const wasStreaming = streaming;
			retryCountdown?.cancel();
			runtime?.agent.abort();
			if (wasStreaming && deps.bus) {
				deps.bus.emit(BusChannels.RunAborted, {
					source: "stream_cancel",
					runId: null,
					startedAt: null,
					elapsedMs: null,
					at: Date.now(),
					reason: "user cancelled stream",
				});
			}
		},
		onEvent(handler: (event: ChatLoopEvent) => void): () => void {
			listeners.add(handler);
			return () => {
				listeners.delete(handler);
			};
		},
		getSessionId(): string | null {
			return deps.session?.current()?.id ?? null;
		},
		isStreaming(): boolean {
			return streaming;
		},
		contextUsage(): ContextUsageSnapshot {
			if (!runtime) return contextUsageSnapshot(null, 0);
			const modelState = runtime.agent.state.model as { contextWindow?: number } | undefined;
			const contextWindow = typeof modelState?.contextWindow === "number" ? modelState.contextWindow : 0;
			if (runtime.agent.state.messages.length <= replayedContextMessages.length) {
				return contextUsageSnapshot(null, contextWindow);
			}
			const tokens = estimateAgentContextTokens({
				systemPrompt: runtime.agent.state.systemPrompt,
				messages: runtime.agent.state.messages,
			});
			return contextUsageSnapshot(tokens > 0 ? tokens : null, contextWindow);
		},
		resetForSession(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void {
			runtime?.agent.abort();
			retryCountdown?.cancel();
			lastTurnId = leafTurnId;
			currentTurnHash = null;
			replayedContextMessages = replayMessages ? [...replayMessages] : [];
			if (runtime) {
				runtime.agent.state.messages = [...replayedContextMessages];
			}
			if (deps.toolRegistry) {
				try {
					const entries = deps.readSessionEntries ? deps.readSessionEntries() : [];
					deps.toolRegistry.replaceProtectedArtifacts(protectedArtifactStateFromSessionEntries(entries));
				} catch {
					deps.toolRegistry.replaceProtectedArtifacts({ artifacts: [] });
				}
			}
		},
		async compact(instructions?: string): Promise<void> {
			// Session check runs BEFORE orchestrator-configuration so a fresh
			// TUI with nothing configured still reports the actionable "no
			// current session" message rather than the "not configured"
			// banner. The e2e regex in tests/e2e/interactive.test.ts locks
			// this ordering.
			if (!deps.session?.current()) {
				emitNotice("[/compact] no current session to compact; start one with /new or /resume first");
				return;
			}
			let agentRuntime: AgentRuntime | null;
			try {
				agentRuntime = ensureRuntime();
			} catch (err) {
				emitNotice(`[/compact] ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			if (!agentRuntime) {
				emitNotice(`[/compact] ${notConfiguredNotice()}`);
				return;
			}
			let compacted = false;
			try {
				compacted = await runAutoCompact(agentRuntime, true, instructions, "force");
			} catch (err) {
				emitNotice(`[/compact] ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			if (!compacted) {
				emitNotice("[/compact] nothing to compact; session is empty or no cut crossed");
			}
		},
	};
}
