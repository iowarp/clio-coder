import { performance } from "node:perf_hooks";
import type { ClioSettings } from "../core/config.js";
import { type LoadResult, loadDomains } from "../core/domain-loader.js";
import { isResponseSchemaRejection, UnsupportedResponseSchemaError } from "../core/response-schema.js";
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
	type BootstrapRunTelemetry,
	type BootstrapStructuredOutput,
	fallbackBootstrapOutput,
} from "../domains/context/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import { MiddlewareDomainModule } from "../domains/middleware/index.js";
import { createObservabilityDomainModule } from "../domains/observability/index.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import type { ThinkingLevel } from "../domains/providers/index.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import { ResourcesDomainModule } from "../domains/resources/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { SchedulingDomainModule } from "../domains/scheduling/index.js";
import { SessionDomainModule } from "../domains/session/index.js";
import { armInternalDispatchDeadline } from "./internal-dispatch.js";

export const BOOTSTRAP_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * The internal agent that reads a repository and returns the handbook payload.
 * It exists as its own recipe rather than as a prompt layered over Scout: a
 * recipe's `resultContract` is enforced in the worker and sealed by the
 * orchestrator, so a task prompt claiming to override it changes nothing a
 * model is graded on. Scout obeying its own recipe was the bug.
 */
const CONTEXT_BOOTSTRAP_AGENT_ID = "context-bootstrap";

/**
 * Model-driven CLIO-CODER.md generation. Dispatches Clio's internal
 * `context-bootstrap` agent with a prompt grounded in the codewiki structure,
 * then validates the structured JSON the model returns. Shared by
 * `clio-coder context init` and the interactive `/context init` command.
 */

export interface ModelBootstrapGenerateOptions {
	dispatch?: DispatchContract;
	route?: BootstrapRoute;
	resolveRoute?: () => BootstrapRoute;
	onFallback?: (err: Error, mode: BootstrapFallbackMode) => void;
}

export interface BootstrapRoute {
	target: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/**
 * The bootstrap agent's route, resolved with the same precedence every other
 * internal dispatch uses: an explicit profile binding first, then
 * `workers.default`. A fresh install with a perfectly good `workers.default`
 * must still produce a model-driven CLIO-CODER.md, so an absent binding is an absent
 * opinion rather than a refusal. A dangling binding still throws, because
 * naming a profile that does not resolve is an operator error.
 *
 * A `scout` binding is honored as the second choice. Operators bound Scout
 * back when bootstrap ran through it, and an upgrade must not silently move
 * their handbook generation onto a different model.
 */
export function resolveBootstrapRoute(settings: Readonly<ClioSettings>): BootstrapRoute {
	for (const agentId of [CONTEXT_BOOTSTRAP_AGENT_ID, "scout"]) {
		const profileName = settings.fleet.agentProfiles[agentId];
		if (!profileName) continue;
		const profile = settings.fleet.profiles[profileName];
		if (!profile) throw new Error(`bootstrap profile '${profileName}' is not configured (bound to '${agentId}')`);
		if (!profile.target) throw new Error(`bootstrap profile '${profileName}' has no target (bound to '${agentId}')`);
		return {
			target: profile.target,
			...(profile.model ? { model: profile.model } : {}),
			...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
		};
	}
	const fallback = settings.fleet.default;
	if (!fallback?.target) {
		throw new Error(
			`bootstrap has no route: workers.agentBindings.${CONTEXT_BOOTSTRAP_AGENT_ID} is unbound and ` +
				`workers.default has no target; bind a profile with ` +
				`'clio-coder targets profile bind ${CONTEXT_BOOTSTRAP_AGENT_ID} <profile>' or set workers.default.target`,
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

class BootstrapAttemptError extends Error {
	readonly parserOutcome: Exclude<BootstrapParserOutcome, "parsed">;
	readonly telemetry: BootstrapRunTelemetry;

	constructor(error: Error, parserOutcome: Exclude<BootstrapParserOutcome, "parsed">, telemetry: BootstrapRunTelemetry) {
		super(error.message);
		this.name = "BootstrapAttemptError";
		this.parserOutcome = parserOutcome;
		this.telemetry = telemetry;
	}
}

class BootstrapOutputLimitError extends Error {
	constructor(readonly observedBytes: number) {
		super(`bootstrap output exceeded ${BOOTSTRAP_MAX_OUTPUT_BYTES} UTF-8 bytes`);
		this.name = "BootstrapOutputLimitError";
	}
}

function durationFromReceipt(receipt: RunReceipt): number | undefined {
	const startedAt = Date.parse(receipt.startedAt);
	const endedAt = Date.parse(receipt.endedAt);
	if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return undefined;
	return Math.max(0, endedAt - startedAt);
}

function bootstrapTelemetry(
	prompt: string,
	output: string,
	startedAtClock: number,
	structuredOutputMode: BootstrapRunTelemetry["structuredOutputMode"],
	runId?: string,
	receipt?: RunReceipt,
	observedOutputBytes?: number,
): BootstrapRunTelemetry {
	const telemetry: BootstrapRunTelemetry = {
		structuredOutputMode,
		promptBytes: Buffer.byteLength(prompt, "utf8"),
		outputBytes: observedOutputBytes ?? Buffer.byteLength(output, "utf8"),
		durationMs: receipt
			? (durationFromReceipt(receipt) ?? Math.round(performance.now() - startedAtClock))
			: Math.round(performance.now() - startedAtClock),
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
				message: "bootstrap routing changed",
				detail: event.message,
			});
		}
		if (isRecord(event) && event.type === "agent_start") {
			input.progress?.({
				phase: "generate",
				status: "running",
				message: "bootstrap agent started repository exploration",
			});
		}
		if (isRecord(event) && event.type === "clio_tool_start") {
			const tool = toolNameFromEvent(event);
			if (tool) {
				input.progress?.({
					phase: "generate",
					status: "running",
					message: `bootstrap running ${tool}`,
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
					message: `bootstrap ${tool} ${outcome}`,
				});
			}
		}
		const delta = textDeltaFromEvent(event);
		if (delta.length > 0) {
			streamedBytes += Buffer.byteLength(delta, "utf8");
			if (streamedBytes > BOOTSTRAP_MAX_OUTPUT_BYTES) {
				throw new BootstrapOutputLimitError(streamedBytes);
			}
			streamedText += delta;
		}
		if (isRecord(event) && event.type === "message_end") {
			const text = assistantTextFromMessage(event.message);
			if (text.length > 0) {
				const bytes = Buffer.byteLength(text, "utf8");
				if (bytes > BOOTSTRAP_MAX_OUTPUT_BYTES) throw new BootstrapOutputLimitError(bytes);
				lastAssistantText = text;
			}
		}
	}
	return (lastAssistantText || streamedText).trim();
}

function receiptFailure(receipt: RunReceipt): string {
	const detail = receipt.failureMessage ? `: ${receipt.failureMessage}` : "";
	return `bootstrap agent failed with exit ${receipt.exitCode}${detail}`;
}

/**
 * The reason to retry this attempt without the native response schema, or
 * null to let the failure stand.
 *
 * Two shapes mean the same thing. Dispatch refuses the schema up front when
 * the resolved runtime cannot enforce it, and llama-server refuses it one
 * round trip later when the schema-derived grammar will not compile beside
 * the tool grammar. Only an attempt that carried the schema can produce
 * either, so the caller gates on that rather than this predicate widening.
 */
function responseSchemaRefusal(err: unknown): string | null {
	if (err instanceof UnsupportedResponseSchemaError) return err.message;
	if (err instanceof BootstrapAttemptError && isResponseSchemaRejection(err.message)) return err.message;
	return null;
}

async function attemptBootstrapDispatch(
	dispatch: DispatchContract,
	input: BootstrapGenerateInput,
	prompt: string,
	startedAtClock: number,
	structuredOutputMode: BootstrapRunTelemetry["structuredOutputMode"],
	dispatchBootstrap: (nativeSchema: boolean) => ReturnType<DispatchContract["dispatch"]>,
): Promise<BootstrapStructuredOutput> {
	const nativeSchema = structuredOutputMode === "native-schema";
	let handle: Awaited<ReturnType<DispatchContract["dispatch"]>>;
	try {
		handle = await dispatchBootstrap(nativeSchema);
	} catch (err) {
		// An admission refusal of the schema is the caller's to act on, so it
		// travels untouched. Everything else is this attempt's failure.
		if (nativeSchema && err instanceof UnsupportedResponseSchemaError) throw err;
		const error = err instanceof Error ? err : new Error(String(err));
		throw new BootstrapAttemptError(
			error,
			"not-run",
			bootstrapTelemetry(prompt, "", startedAtClock, structuredOutputMode),
		);
	}
	// No product cap. The bootstrap agent explores the repository with code_nav, and a
	// 30s ceiling clamped over the operator's guardrail aborted every real run
	// mid-exploration: an observed bootstrap burned 19k tokens across 5 tool calls
	// and returned zero bytes at 29s. The wiki documenter in this same directory
	// budgets minutes for the same shape of work. `internalDispatchTimeoutMs` is
	// the operator's knob for slow targets; nothing here knows better than it does.
	const deadline = armInternalDispatchDeadline(dispatch, handle.runId, "context bootstrap", process.env);
	let text = "";
	let receipt: RunReceipt | undefined;
	let parserAttempted = false;
	try {
		text = await collectDispatchAssistantText(handle.events, input);
		receipt = await handle.finalPromise;
		if (deadline.timedOut()) throw new Error(deadline.message());
		// The receipt outranks the empty transcript. A run the server rejected
		// produces no assistant text by construction, and reporting the silence
		// instead of the rejection described a healthy target as a mute model.
		if (receipt.exitCode !== 0) throw new Error(receiptFailure(receipt));
		if (text.length === 0) throw new Error("bootstrap agent did not return an assistant response");
		parserAttempted = true;
		const output = parseBootstrapModelOutput(text);
		input.progress?.({
			phase: "generate",
			status: "running",
			message: "bootstrap agent returned the handbook payload",
			detail: `${Buffer.byteLength(text, "utf8")} bytes`,
		});
		input.reportGeneration?.({
			mode: "model",
			parserOutcome: "parsed",
			run: bootstrapTelemetry(prompt, text, startedAtClock, structuredOutputMode, handle.runId, receipt),
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
		throw new BootstrapAttemptError(
			error,
			parserAttempted ? "rejected" : "not-run",
			bootstrapTelemetry(
				prompt,
				text,
				startedAtClock,
				structuredOutputMode,
				handle.runId,
				receipt,
				err instanceof BootstrapOutputLimitError ? err.observedBytes : undefined,
			),
		);
	} finally {
		deadline.clear();
	}
}

async function generateBootstrapWithModel(
	dispatch: DispatchContract,
	input: BootstrapGenerateInput,
	route?: BootstrapRoute,
): Promise<BootstrapStructuredOutput> {
	const prompt = buildBootstrapPrompt(input);
	const startedAtClock = performance.now();
	input.progress?.({
		phase: "generate",
		status: "running",
		message: "dispatching internal context-bootstrap agent",
		detail: `agent=${CONTEXT_BOOTSTRAP_AGENT_ID}`,
	});
	const dispatchBootstrap = (nativeSchema: boolean) =>
		dispatch.dispatch({
			agentId: CONTEXT_BOOTSTRAP_AGENT_ID,
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
		return await attemptBootstrapDispatch(dispatch, input, prompt, startedAtClock, "native-schema", dispatchBootstrap);
	} catch (err) {
		const refusal = responseSchemaRefusal(err);
		if (refusal === null) throw err;
		input.progress?.({
			phase: "generate",
			status: "running",
			message: "native schema unavailable; using bounded output parser",
			detail: refusal,
		});
		return await attemptBootstrapDispatch(dispatch, input, prompt, startedAtClock, "prompt-parser", dispatchBootstrap);
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
		// Same shape as the wiki writer: one internal dispatch in a process that
		// exits with it. The SQLite mirror opens `node:sqlite` on the first
		// dispatch event, which costs `clio-coder context init` a module load it never
		// reads back and prints Node's ExperimentalWarning over the command's own
		// output. Receipts and the ledger still record the run.
		createObservabilityDomainModule({ dispatchTrace: false }),
		SchedulingDomainModule,
		DispatchDomainModule,
	]);
	const dispatch = loaded.getContract<DispatchContract>("dispatch");
	const config = loaded.getContract<ConfigContract>("config");
	if (!dispatch || !config) {
		await loaded.stop();
		throw new Error("bootstrap dispatch or configuration unavailable");
	}
	return { dispatch, config, loaded };
}

/**
 * Wrap model-driven generation so any failure (no configured target, offline
 * endpoint, malformed output) degrades cleanly. Existing valid CLIO-CODER.md content
 * is preserved when possible; otherwise the deterministic heuristic is used.
 */
export function modelBootstrapGenerate(options: ModelBootstrapGenerateOptions = {}): BootstrapGenerate {
	return async (input) => {
		let loaded: LoadResult | null = null;
		try {
			if (options.dispatch) {
				const route = options.route ?? options.resolveRoute?.();
				return await generateBootstrapWithModel(options.dispatch, input, route);
			}
			{
				const lazy = await loadBootstrapDispatch();
				loaded = lazy.loaded;
				const route = options.route ?? resolveBootstrapRoute(lazy.config.get());
				return await generateBootstrapWithModel(lazy.dispatch, input, route);
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			const fallback = fallbackBootstrapOutput(input);
			const generation: BootstrapGenerationTelemetry = {
				mode: fallback.mode,
				parserOutcome: err instanceof BootstrapAttemptError ? err.parserOutcome : "not-run",
				fallbackReason: error.message,
				...(err instanceof BootstrapAttemptError ? { run: err.telemetry } : {}),
			};
			input.progress?.({
				phase: "generate",
				status: "running",
				message:
					fallback.mode === "existing"
						? "bootstrap agent unavailable; preserving existing CLIO-CODER.md"
						: "bootstrap agent unavailable; using heuristic bootstrap",
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
