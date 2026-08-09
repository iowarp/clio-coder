import type { ClioSettings } from "../core/config.js";
import { type LoadResult, loadDomains } from "../core/domain-loader.js";
import { UnsupportedResponseSchemaError } from "../core/response-schema.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import {
	BOOTSTRAP_OUTPUT_JSON_SCHEMA,
	buildBootstrapPrompt,
	parseBootstrapModelOutput,
} from "../domains/context/bootstrap-prompt.js";
import {
	type BootstrapFallbackMode,
	type BootstrapGenerate,
	type BootstrapGenerateInput,
	type BootstrapGenerationTelemetry,
	type BootstrapParserOutcome,
	type BootstrapScoutTelemetry,
	type BootstrapStructuredOutput,
	fallbackBootstrapOutput,
} from "../domains/context/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import { MiddlewareDomainModule } from "../domains/middleware/index.js";
import { ObservabilityDomainModule } from "../domains/observability/index.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import type { ThinkingLevel } from "../domains/providers/index.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import { ResourcesDomainModule } from "../domains/resources/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { SchedulingDomainModule } from "../domains/scheduling/index.js";
import { SessionDomainModule } from "../domains/session/index.js";
import { armInternalDispatchDeadline } from "./internal-dispatch.js";

export const BOOTSTRAP_SCOUT_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Model-driven CLIO.md generation. Dispatches Clio's internal `scout` shadow
 * agent with a bootstrap prompt grounded in the codewiki structure, then
 * validates the structured JSON the model returns. Shared by
 * `clio context init` and the interactive `/context init` command.
 */

export interface ModelBootstrapGenerateOptions {
	dispatch?: DispatchContract;
	route?: BootstrapScoutRoute;
	resolveRoute?: () => BootstrapScoutRoute;
	onFallback?: (err: Error, mode: BootstrapFallbackMode) => void;
}

export interface BootstrapScoutRoute {
	target: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/**
 * Scout's route, resolved with the same precedence every other internal
 * dispatch uses: an explicit `workers.agentBindings.scout` profile first, then
 * `workers.default`. Scout used to be the one internal agent that demanded an
 * explicit binding, so a fresh install with a perfectly good `workers.default`
 * silently never produced a model-driven CLIO.md. A dangling binding still
 * throws, because naming a profile that does not resolve is an operator error
 * rather than an absent opinion.
 */
export function resolveBootstrapScoutRoute(settings: Readonly<ClioSettings>): BootstrapScoutRoute {
	const profileName = settings.workers.agentBindings.scout;
	if (profileName) {
		const profile = settings.workers.profiles[profileName];
		if (!profile) throw new Error(`bootstrap Scout profile '${profileName}' is not configured`);
		if (!profile.target) throw new Error(`bootstrap Scout profile '${profileName}' has no target`);
		return {
			target: profile.target,
			...(profile.model ? { model: profile.model } : {}),
			...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
		};
	}
	const fallback = settings.workers.default;
	if (!fallback?.target) {
		throw new Error(
			"bootstrap Scout has no route: workers.agentBindings.scout is unbound and workers.default has no target; " +
				"bind a profile with 'clio targets profile bind scout <profile>' or set workers.default.target",
		);
	}
	return {
		target: fallback.target,
		...(fallback.model ? { model: fallback.model } : {}),
		...(fallback.thinkingLevel ? { thinkingLevel: fallback.thinkingLevel } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantTextFromMessage(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant") return "";
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (!isRecord(block)) return "";
			return typeof block.text === "string" ? block.text : "";
		})
		.join("")
		.trim();
}

function textDeltaFromEvent(event: unknown): string {
	if (!isRecord(event) || event.type !== "text_delta") return "";
	return typeof event.text === "string" ? event.text : "";
}

function toolNameFromEvent(event: unknown): string | null {
	if (!isRecord(event)) return null;
	const payload = event.payload;
	if (!isRecord(payload)) return null;
	return typeof payload.tool === "string" && payload.tool.length > 0 ? payload.tool : null;
}

function toolOutcomeFromEvent(event: unknown): string | null {
	if (!isRecord(event)) return null;
	const payload = event.payload;
	if (!isRecord(payload)) return null;
	return typeof payload.outcome === "string" && payload.outcome.length > 0 ? payload.outcome : null;
}

class BootstrapScoutAttemptError extends Error {
	readonly parserOutcome: Exclude<BootstrapParserOutcome, "parsed">;
	readonly scout: BootstrapScoutTelemetry;

	constructor(error: Error, parserOutcome: Exclude<BootstrapParserOutcome, "parsed">, scout: BootstrapScoutTelemetry) {
		super(error.message);
		this.name = "BootstrapScoutAttemptError";
		this.parserOutcome = parserOutcome;
		this.scout = scout;
	}
}

class BootstrapScoutOutputLimitError extends Error {
	constructor(readonly observedBytes: number) {
		super(`bootstrap scout output exceeded ${BOOTSTRAP_SCOUT_MAX_OUTPUT_BYTES} UTF-8 bytes`);
		this.name = "BootstrapScoutOutputLimitError";
	}
}

function durationFromReceipt(receipt: RunReceipt): number | undefined {
	const startedAt = Date.parse(receipt.startedAt);
	const endedAt = Date.parse(receipt.endedAt);
	if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return undefined;
	return Math.max(0, endedAt - startedAt);
}

function scoutTelemetry(
	prompt: string,
	output: string,
	startedAt: number,
	structuredOutputMode: BootstrapScoutTelemetry["structuredOutputMode"],
	runId?: string,
	receipt?: RunReceipt,
	observedOutputBytes?: number,
): BootstrapScoutTelemetry {
	const telemetry: BootstrapScoutTelemetry = {
		structuredOutputMode,
		promptBytes: Buffer.byteLength(prompt, "utf8"),
		outputBytes: observedOutputBytes ?? Buffer.byteLength(output, "utf8"),
		durationMs: receipt
			? (durationFromReceipt(receipt) ?? Math.max(0, Date.now() - startedAt))
			: Math.max(0, Date.now() - startedAt),
		...(runId ? { runId } : {}),
	};
	if (!receipt) return telemetry;
	telemetry.runId = receipt.runId;
	telemetry.targetId = receipt.targetId;
	telemetry.wireModelId = receipt.wireModelId;
	telemetry.runtimeId = receipt.runtimeId;
	telemetry.runtimeKind = receipt.runtimeKind;
	if (receipt.runtimeResolution?.effectiveThinkingLevel) {
		telemetry.thinkingLevel = receipt.runtimeResolution.effectiveThinkingLevel;
	}
	telemetry.tokens = {
		total: receipt.tokenCount,
		...(receipt.inputTokenCount !== undefined ? { input: receipt.inputTokenCount } : {}),
		...(receipt.outputTokenCount !== undefined ? { output: receipt.outputTokenCount } : {}),
		...(receipt.cacheReadTokenCount !== undefined ? { cacheRead: receipt.cacheReadTokenCount } : {}),
		...(receipt.cacheWriteTokenCount !== undefined ? { cacheWrite: receipt.cacheWriteTokenCount } : {}),
		...(receipt.reasoningTokenCount !== undefined ? { reasoning: receipt.reasoningTokenCount } : {}),
	};
	telemetry.toolCalls = receipt.toolCalls;
	telemetry.toolFailures = receipt.toolStats.reduce((total, stat) => total + stat.errors, 0);
	telemetry.toolBlocked = receipt.toolStats.reduce((total, stat) => total + stat.blocked, 0);
	return telemetry;
}

async function collectDispatchAssistantText(
	events: AsyncIterable<unknown>,
	input: BootstrapGenerateInput,
): Promise<string> {
	let streamedText = "";
	let streamedBytes = 0;
	let lastAssistantText = "";
	for await (const event of events) {
		if (isRecord(event) && event.type === "route_warning" && typeof event.message === "string") {
			input.progress?.({
				phase: "generate",
				status: "running",
				message: "scout routing changed",
				detail: event.message,
			});
		}
		if (isRecord(event) && event.type === "agent_start") {
			input.progress?.({ phase: "generate", status: "running", message: "scout started repository exploration" });
		}
		if (isRecord(event) && event.type === "clio_tool_start") {
			const tool = toolNameFromEvent(event);
			if (tool) {
				input.progress?.({
					phase: "generate",
					status: "running",
					message: `scout running ${tool}`,
					detail: "read-only repository exploration",
				});
			}
		}
		if (isRecord(event) && event.type === "clio_tool_finish") {
			const tool = toolNameFromEvent(event);
			const outcome = toolOutcomeFromEvent(event) ?? "done";
			if (tool) {
				input.progress?.({
					phase: "generate",
					status: "running",
					message: `scout ${tool} ${outcome}`,
				});
			}
		}
		const delta = textDeltaFromEvent(event);
		if (delta.length > 0) {
			streamedBytes += Buffer.byteLength(delta, "utf8");
			if (streamedBytes > BOOTSTRAP_SCOUT_MAX_OUTPUT_BYTES) {
				throw new BootstrapScoutOutputLimitError(streamedBytes);
			}
			streamedText += delta;
		}
		if (isRecord(event) && event.type === "message_end") {
			const text = assistantTextFromMessage(event.message);
			if (text.length > 0) {
				const bytes = Buffer.byteLength(text, "utf8");
				if (bytes > BOOTSTRAP_SCOUT_MAX_OUTPUT_BYTES) throw new BootstrapScoutOutputLimitError(bytes);
				lastAssistantText = text;
			}
		}
	}
	const text = (lastAssistantText || streamedText).trim();
	if (text.length === 0) throw new Error("bootstrap scout did not return an assistant response");
	return text;
}

function receiptFailure(receipt: RunReceipt): string {
	const detail = receipt.failureMessage ? `: ${receipt.failureMessage}` : "";
	return `bootstrap scout failed with exit ${receipt.exitCode}${detail}`;
}

async function generateBootstrapWithScout(
	dispatch: DispatchContract,
	input: BootstrapGenerateInput,
	route?: BootstrapScoutRoute,
): Promise<BootstrapStructuredOutput> {
	const prompt = buildBootstrapPrompt(input);
	const startedAt = Date.now();
	input.progress?.({
		phase: "generate",
		status: "running",
		message: "dispatching internal scout shadow agent",
		detail: "agent=scout",
	});
	let handle: Awaited<ReturnType<DispatchContract["dispatch"]>>;
	let structuredOutputMode: BootstrapScoutTelemetry["structuredOutputMode"] = "native-schema";
	const dispatchScout = (nativeSchema: boolean) =>
		dispatch.dispatch({
			agentId: "scout",
			executionRole: "researcher",
			task: prompt,
			cwd: input.cwd,
			requestOrigin: "internal",
			thinkingLevel: route?.thinkingLevel ?? "off",
			noSkills: true,
			...(nativeSchema ? { responseSchema: BOOTSTRAP_OUTPUT_JSON_SCHEMA } : {}),
			...(route ? { target: route.target } : {}),
			...(route?.model ? { model: route.model } : {}),
		});
	try {
		handle = await dispatchScout(true);
	} catch (err) {
		if (!(err instanceof UnsupportedResponseSchemaError)) {
			const error = err instanceof Error ? err : new Error(String(err));
			throw new BootstrapScoutAttemptError(error, "not-run", scoutTelemetry(prompt, "", startedAt, structuredOutputMode));
		}
		structuredOutputMode = "prompt-parser";
		input.progress?.({
			phase: "generate",
			status: "running",
			message: "native schema unavailable; using bounded Scout output parser",
			detail: err.message,
		});
		try {
			handle = await dispatchScout(false);
		} catch (fallbackErr) {
			const error = fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
			throw new BootstrapScoutAttemptError(error, "not-run", scoutTelemetry(prompt, "", startedAt, structuredOutputMode));
		}
	}
	// No product cap. Scout is told to explore the repository with code_nav, and a
	// 30s ceiling clamped over the operator's guardrail aborted every real run
	// mid-exploration: an observed bootstrap burned 19k tokens across 5 tool calls
	// and returned zero bytes at 29s. The wiki documenter in this same directory
	// budgets minutes for the same shape of work. `internalDispatchTimeoutMs` is
	// the operator's knob for slow targets; nothing here knows better than it does.
	const deadline = armInternalDispatchDeadline(dispatch, handle.runId, "bootstrap scout", process.env);
	let text = "";
	let receipt: RunReceipt | undefined;
	let parserAttempted = false;
	try {
		text = await collectDispatchAssistantText(handle.events, input);
		receipt = await handle.finalPromise;
		if (deadline.timedOut()) throw new Error(deadline.message());
		if (receipt.exitCode !== 0) throw new Error(receiptFailure(receipt));
		parserAttempted = true;
		const output = parseBootstrapModelOutput(text);
		input.progress?.({
			phase: "generate",
			status: "running",
			message: "scout returned structured bootstrap JSON",
			detail: `${Buffer.byteLength(text, "utf8")} bytes`,
		});
		input.reportGeneration?.({
			mode: "scout",
			parserOutcome: "parsed",
			scout: scoutTelemetry(prompt, text, startedAt, structuredOutputMode, handle.runId, receipt),
		});
		return output;
	} catch (err) {
		if (!deadline.timedOut()) dispatch.abort(handle.runId);
		receipt ??= await handle.finalPromise.catch(() => undefined);
		const error = deadline.timedOut()
			? new Error(deadline.message())
			: err instanceof Error
				? err
				: new Error(String(err));
		throw new BootstrapScoutAttemptError(
			error,
			parserAttempted ? "rejected" : "not-run",
			scoutTelemetry(
				prompt,
				text,
				startedAt,
				structuredOutputMode,
				handle.runId,
				receipt,
				err instanceof BootstrapScoutOutputLimitError ? err.observedBytes : undefined,
			),
		);
	} finally {
		deadline.clear();
	}
}

async function loadBootstrapDispatch(): Promise<{
	dispatch: DispatchContract;
	config: ConfigContract;
	loaded: LoadResult;
}> {
	const loaded = await loadDomains([
		ConfigDomainModule,
		ResourcesDomainModule,
		ProvidersDomainModule,
		SafetyDomainModule,
		createPromptsDomainModule({ noContextFiles: true }),
		AgentsDomainModule,
		MiddlewareDomainModule,
		SessionDomainModule,
		ObservabilityDomainModule,
		SchedulingDomainModule,
		DispatchDomainModule,
	]);
	const dispatch = loaded.getContract<DispatchContract>("dispatch");
	const config = loaded.getContract<ConfigContract>("config");
	if (!dispatch || !config) {
		await loaded.stop();
		throw new Error("bootstrap Scout dispatch or configuration unavailable");
	}
	return { dispatch, config, loaded };
}

/**
 * Wrap model-driven generation so any failure (no configured target, offline
 * endpoint, malformed output) degrades cleanly. Existing valid CLIO.md content
 * is preserved when possible; otherwise the deterministic heuristic is used.
 */
export function modelBootstrapGenerate(options: ModelBootstrapGenerateOptions = {}): BootstrapGenerate {
	return async (input) => {
		let loaded: LoadResult | null = null;
		try {
			if (options.dispatch) {
				const route = options.route ?? options.resolveRoute?.();
				return await generateBootstrapWithScout(options.dispatch, input, route);
			}
			{
				const lazy = await loadBootstrapDispatch();
				loaded = lazy.loaded;
				const route = options.route ?? resolveBootstrapScoutRoute(lazy.config.get());
				return await generateBootstrapWithScout(lazy.dispatch, input, route);
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			const fallback = fallbackBootstrapOutput(input);
			const generation: BootstrapGenerationTelemetry = {
				mode: fallback.mode,
				parserOutcome: err instanceof BootstrapScoutAttemptError ? err.parserOutcome : "not-run",
				fallbackReason: error.message,
				...(err instanceof BootstrapScoutAttemptError ? { scout: err.scout } : {}),
			};
			input.progress?.({
				phase: "generate",
				status: "running",
				message:
					fallback.mode === "existing"
						? "scout unavailable; preserving existing CLIO.md"
						: "scout unavailable; using heuristic bootstrap",
				detail: error.message,
			});
			input.reportGeneration?.(generation);
			options.onFallback?.(error, fallback.mode);
			return fallback.output;
		} finally {
			if (loaded) await loaded.stop();
		}
	};
}
