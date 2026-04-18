import { type ClioSettings, settingsPath } from "../core/config.js";
import type { EndpointSpec, LocalProvidersSettings } from "../core/defaults.js";
import type { ToolName } from "../core/tool-names.js";
import type { ModesContract } from "../domains/modes/contract.js";
import type { CompileResult, DynamicInputs } from "../domains/prompts/compiler.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import { isLocalEngineId } from "../domains/providers/catalog.js";
import { toContextOverflowError } from "../domains/providers/errors.js";
import { AutoCompactionTrigger, shouldCompact } from "../domains/session/compaction/auto.js";
import type { CompactResult } from "../domains/session/compaction/compact.js";
import { calculateContextTokens } from "../domains/session/compaction/tokens.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { createEngineAgent } from "../engine/agent.js";
import {
	resolveLocalModelId,
	getModel as resolveModel,
	registerLocalProviders as seedLocalProviders,
} from "../engine/ai.js";
import type { AgentEvent, AgentMessage, Model } from "../engine/types.js";
import { resolveAgentTools } from "../engine/worker-tools.js";
import type { ToolRegistry } from "../tools/registry.js";
import { renderCompactionSummaryLine } from "./renderers/compaction-summary.js";

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

export type ChatLoopEvent = AgentEvent | AssistantDeltaEvent;

export interface ChatLoop {
	submit(text: string): Promise<void>;
	cancel(): void;
	onEvent(handler: (event: ChatLoopEvent) => void): () => void;
	getSessionId(): string | null;
	isStreaming(): boolean;
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
}

export interface CreateChatLoopDeps {
	getSettings: () => Readonly<ClioSettings>;
	modes: ModesContract;
	knownProviders: () => ReadonlySet<string>;
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
	getModel?: (providerId: string, modelId: string) => Model<never>;
	registerLocalProviders?: (providers: Partial<LocalProvidersSettings>) => void;
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
	autoCompact?: (instructions?: string) => Promise<CompactResult | null>;
	/**
	 * Production tool admission path. When wired, every agent-facing tool runs
	 * through `ToolRegistry.invoke(...)` so safety classification and mode
	 * admission happen on the actual execution path.
	 */
	toolRegistry?: ToolRegistry;
}

interface AgentRuntime {
	agent: ReturnType<typeof createEngineAgent>["agent"];
	providerId: string;
	modelId: string;
}

function notConfiguredNotice(): string {
	return `[clio] orchestrator not configured. Edit ${settingsPath()} (orchestrator.* block) to enable chat.`;
}

const LOCAL_API_KEY_FALLBACK = "clio-local-endpoint";

function envApiKeyName(providerId: string): string {
	return `${providerId.replaceAll("-", "_").toUpperCase()}_API_KEY`;
}

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
 */
function fallbackIdentityPrompt(): string {
	return [
		"You are Clio. You are Clio. You are Clio.",
		"You are the orchestrator coding-agent for the Clio Coder harness, built by IOWarp.",
		'If asked who made you or what model you are, reply: "I am Clio, built by IOWarp."',
		"You are not Claude, GPT, Qwen, Gemini, Llama, or Mistral.",
		"You are not from Anthropic, OpenAI, Alibaba, Google, Meta, or any other model vendor.",
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

/**
 * Bridge message injected into the agent's in-memory `state.messages` after
 * a compaction run. Prior turns are dropped; the single synthetic user
 * message frames the summary as "prior context" and instructs the LLM to
 * continue from there. pi-agent-core appends the real user text next so the
 * final prompt sent to the model is [bridge, newUserText].
 */
function buildCompactionBridgeMessage(summary: string): AgentMessage {
	const text = [
		"<prior-context-summary>",
		summary,
		"</prior-context-summary>",
		"",
		"The above summary replaces earlier conversation to save tokens. Continue from here.",
	].join("\n");
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

export function createChatLoop(deps: CreateChatLoopDeps): ChatLoop {
	const listeners = new Set<(event: ChatLoopEvent) => void>();
	const getModel = deps.getModel ?? resolveModel;
	const registerLocalProviders = deps.registerLocalProviders ?? seedLocalProviders;
	const createAgent = deps.createAgent ?? createEngineAgent;
	const compactionTrigger = new AutoCompactionTrigger<CompactResult | null>();
	let runtime: AgentRuntime | null = null;
	let lastTurnId: string | null = null;
	let streaming = false;
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
		const text = extractText(message).trim();
		if (!deps.session || text.length === 0) return;
		const turn = deps.session.append({
			kind: "assistant",
			parentId: lastTurnId,
			payload: { text },
			...(currentTurnHash !== null ? { renderedPromptHash: currentTurnHash } : {}),
		});
		lastTurnId = turn.id;
	};

	const emitNotice = (text: string): void => {
		const message = noticeMessage(text);
		emit({ type: "message_end", message });
		emit({ type: "agent_end", messages: [message] });
	};

	const readTarget = (): {
		providerId: string;
		modelId: string;
		endpointName: string | undefined;
		endpointSpec: EndpointSpec | undefined;
	} | null => {
		const settings = deps.getSettings();
		const providerId = settings.orchestrator.provider?.trim();
		const rawModelId = settings.orchestrator.model?.trim();
		if (!providerId || !rawModelId) return null;

		const endpointName = settings.orchestrator.endpoint?.trim();
		let endpointSpec: EndpointSpec | undefined;
		if (isLocalEngineId(providerId)) {
			if (!endpointName) return null;
			endpointSpec = settings.providers[providerId]?.endpoints?.[endpointName];
			if (!endpointSpec) {
				throw new Error(`[clio] orchestrator endpoint=${endpointName} not found under providers.${providerId}.endpoints.`);
			}
			registerLocalProviders({
				[providerId]: { endpoints: { [endpointName]: endpointSpec } },
			} as Partial<LocalProvidersSettings>);
		}

		const modelId = resolveLocalModelId(providerId, rawModelId, endpointName ?? undefined);

		return { providerId, modelId, endpointName, endpointSpec };
	};

	const ensureRuntime = (): AgentRuntime | null => {
		const target = readTarget();
		if (!target) return null;
		if (!deps.knownProviders().has(target.providerId)) {
			throw new Error(
				`[clio] orchestrator provider=${target.providerId} unknown. Run \`clio providers\` to see configured engines.`,
			);
		}
		if (runtime && runtime.providerId === target.providerId && runtime.modelId === target.modelId) {
			return runtime;
		}

		const model = getModel(target.providerId, target.modelId);
		const tools = resolveRuntimeTools(deps);
		const thinkingLevel = deps.getSettings().orchestrator.thinkingLevel ?? "off";
		// Seed the system prompt with the fallback identity text. `submit` then
		// runs `compilePromptForTurn` before every `agent.prompt` call and
		// overwrites this in place, so the fallback only shows up when the
		// prompts contract is absent (tests, degraded boot).
		const handle = createAgent({
			initialState: {
				systemPrompt: fallbackIdentityPrompt(),
				model,
				thinkingLevel,
				tools,
				messages: [],
			},
			getApiKey: async (provider) => {
				if (target.endpointSpec?.api_key && target.endpointSpec.api_key.length > 0) {
					return target.endpointSpec.api_key;
				}
				return process.env[envApiKeyName(provider)] ?? (target.endpointSpec ? LOCAL_API_KEY_FALLBACK : undefined);
			},
		});

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
		});

		runtime = {
			agent: handle.agent,
			providerId: target.providerId,
			modelId: target.modelId,
		};
		return runtime;
	};

	/**
	 * Inspect the agent's state after `agent.prompt` resolves. pi-agent-core
	 * 0.67.4's `handleRunFailure` records the upstream error on the assistant
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
			compacted = await runAutoCompact(agentRuntime, true);
		} catch (compactErr) {
			emitNotice(
				`[clio] compact-on-overflow failed: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`,
			);
		}
		if (!compacted) {
			emitNotice(`[clio] context overflow: ${overflow.message}`);
			return;
		}
		try {
			await agentRuntime.agent.prompt(text);
			const stillOverflowed = detectOverflowFromState(agentRuntime.agent);
			if (stillOverflowed) {
				emitNotice(`[clio] context overflow persisted after compaction: ${stillOverflowed.message}`);
			}
		} catch (retryErr) {
			emitNotice(
				`[clio] context overflow persisted after compaction: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
			);
		}
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
		const modelState = agentRuntime.agent.state.model as { contextWindow?: number } | undefined;
		const contextWindow = typeof modelState?.contextWindow === "number" ? modelState.contextWindow : null;
		const dynamicInputs: DynamicInputs = {
			provider: agentRuntime.providerId,
			model: agentRuntime.modelId,
			contextWindow,
			thinkingBudget: settings.orchestrator.thinkingLevel ?? "off",
			turnCount: 0,
		};
		const safetyLevel = settings.safetyLevel ?? "auto-edit";
		try {
			const result = deps.prompts.compileForTurn({
				dynamicInputs,
				overrideMode: deps.modes.current(),
				safetyLevel,
			});
			agentRuntime.agent.state.systemPrompt = result.text;
			currentTurnHash = result.renderedPromptHash;
			return result;
		} catch (err) {
			currentTurnHash = null;
			emitNotice(
				`[clio] prompt compile failed; using fallback identity: ${err instanceof Error ? err.message : String(err)}`,
			);
			return null;
		}
	};

	/**
	 * Evaluate the auto-compaction trigger against the current session and,
	 * when it fires, swap `agent.state.messages` for a single bridge message
	 * carrying the summary. Returns true when compaction ran AND produced a
	 * non-empty summary; false otherwise (no deps wired, threshold not
	 * crossed, no-op compaction, etc.). Throws are caller-contained.
	 *
	 * `force = true` bypasses the threshold check. Used for:
	 *   - CLIO_FORCE_COMPACT=1 (deterministic drills / e2e tests).
	 *   - The overflow-recovery retry path after a ContextOverflowError.
	 */
	const runAutoCompact = async (agentRuntime: AgentRuntime, force: boolean, instructions?: string): Promise<boolean> => {
		if (!deps.autoCompact || !deps.readSessionEntries) return false;
		const settings = deps.getSettings();
		const cfg = settings.compaction;
		const autoEnabled = cfg?.auto !== false;
		if (!force && !autoEnabled) return false;

		if (!force) {
			const modelState = agentRuntime.agent.state.model as { contextWindow?: number } | undefined;
			const contextWindow = typeof modelState?.contextWindow === "number" ? modelState.contextWindow : 0;
			const threshold = typeof cfg?.threshold === "number" ? cfg.threshold : 0.8;
			const entries = deps.readSessionEntries();
			const tokens = calculateContextTokens(entries);
			if (!shouldCompact(tokens, threshold, contextWindow)) return false;
		}

		const result = await compactionTrigger.fire(() => (deps.autoCompact ?? (async () => null))(instructions));
		if (!result || result.summary.length === 0) return false;

		agentRuntime.agent.state.messages = [buildCompactionBridgeMessage(result.summary)];

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
				emitNotice("[clio] response already in progress. Press Esc to cancel the active run.");
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
			// oversized — the overflow-recovery path will catch that.
			const forceNow = process.env.CLIO_FORCE_COMPACT === "1";
			try {
				await runAutoCompact(agentRuntime, forceNow);
			} catch (err) {
				emitNotice(`[clio] auto-compaction skipped: ${err instanceof Error ? err.message : String(err)}`);
			}

			if (deps.session) {
				if (!deps.session.current()) {
					deps.session.create({
						cwd: process.cwd(),
						provider: agentRuntime.providerId,
						model: agentRuntime.modelId,
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

			streaming = true;
			try {
				await agentRuntime.agent.prompt(text);
				// pi-agent-core 0.67.4 does NOT throw on provider failures:
				// it pushes an assistant message with stopReason="error" and
				// errorMessage="<provider text>" onto state.messages, sets
				// state.errorMessage, emits agent_end, and resolves normally.
				// The overflow-recovery heuristic must inspect the state after
				// a resolve, not only the catch arm.
				const overflowPostResolve = detectOverflowFromState(agentRuntime.agent);
				if (overflowPostResolve) {
					await runCompactAndRetry(agentRuntime, text, overflowPostResolve);
				}
			} catch (err) {
				// Genuine throws (network, abort, pre-stream bugs) still land
				// here. The heuristic is the same so a thrown overflow from
				// an older pi-agent-core still routes through compact-retry.
				const overflow = toContextOverflowError(err);
				if (!overflow) {
					emitNotice(err instanceof Error ? err.message : String(err));
					return;
				}
				await runCompactAndRetry(agentRuntime, text, overflow);
			} finally {
				streaming = false;
			}
		},
		cancel(): void {
			runtime?.agent.abort();
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
		async compact(instructions?: string): Promise<void> {
			// Session check runs BEFORE orchestrator-configuration so a fresh
			// TUI with nothing configured still reports the actionable "no
			// current session" message rather than the "not configured"
			// banner. The e2e regex in tests/e2e/interactive.test.ts locks
			// this ordering.
			if (!deps.session || !deps.session.current()) {
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
				compacted = await runAutoCompact(agentRuntime, true, instructions);
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
