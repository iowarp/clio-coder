/**
 * An engine over an ordinary chat target: any model Clio already knows, used
 * as a one-shot decider.
 *
 * Where the runtime returns logprobs the engine reads the first token's letter
 * alternatives, which is the only way an LLM yields a probability rather than
 * a claim of one. Where it does not, it asks for five votes and says so by
 * marking the answers uncalibrated. The mode is chosen once per target, model
 * and URL by the first real request, so there is no separate probe to pay for.
 */

import type { SystemOneMode } from "../../../core/defaults.js";
import type { RuntimeDescriptor } from "../../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../providers/types/target-descriptor.js";
import type { OneShotPort } from "../factory.js";
import type { Answer, DecisionEngine, EngineReply, EngineRequest } from "../types.js";
import { PROMPT_VERSION, renderState } from "./llm-prompt.js";
import type { ReadContext } from "./llm-readout.js";
import { answerQuestion, LogprobsUnavailable } from "./llm-readout.js";
import { createScheduler } from "./llm-schedule.js";
import { chatBaseUrl, createHttpChannel, createOneShotChannel, hasChatWire } from "./llm-wire.js";
import type { EngineHost } from "./shared.js";
import { errorText } from "./shared.js";

/** Concurrent requests when the host cannot say how many the endpoint serves. */
const DEFAULT_ENDPOINT_CAPACITY = 4;
/** How long a no-logprobs verdict is trusted before the next call probes again. */
const ANSWER_VERDICT_TTL_MS = 10 * 60_000;
/** Headroom for the system prompt and framing that the state estimate does not count. */
const PROMPT_RESERVE_TOKENS = 256;

type ResolvedMode = "logprobs" | "answer";

// Process-wide: engines are rebuilt on every settings change, and a server's
// logprob support does not change with them.
const modeVerdicts = new Map<string, { mode: ResolvedMode; at: number }>();

export interface LlmEngineInput {
	readonly name: string;
	readonly target: TargetDescriptor;
	readonly runtime: RuntimeDescriptor;
	readonly model: string | null;
	readonly mode: SystemOneMode;
	readonly host: EngineHost;
	readonly oneShot?: OneShotPort | undefined;
	readonly endpointCapacity?: ((targetId: string) => number) | undefined;
}

/** Why an LLM engine over this target cannot answer, or null when it can. */
export function llmEngineProblem(input: {
	readonly target: TargetDescriptor;
	readonly runtime: RuntimeDescriptor;
	readonly model: string | null;
	readonly oneShot: boolean;
}): string | null {
	const { target, runtime } = input;
	if (!runtime.defaultCapabilities.chat && target.capabilities?.chat !== true) {
		return `runtime '${runtime.id}' has no chat wire`;
	}
	if (hasChatWire(runtime.id)) {
		if (chatBaseUrl(runtime.id, target) === null) return `target '${target.id}' has no url`;
	} else if (!input.oneShot) {
		return `runtime '${runtime.id}' has no HTTP chat wire and no one-shot port is available`;
	}
	if ((input.model ?? target.defaultModel) === undefined) {
		return `no model: name one on the engine or give target '${target.id}' a default model`;
	}
	return null;
}

function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		// A malformed URL still has to yield a stable build key; the request itself fails loudly.
		return baseUrl;
	}
}

export function createLlmEngine(input: LlmEngineInput): DecisionEngine {
	const { name, target, runtime, model, mode: configured, host } = input;
	const window = target.capabilities?.contextWindow ?? runtime.defaultCapabilities.contextWindow;
	return {
		name,
		kind: "llm",
		target: target.id,
		model,
		windowTokens:
			typeof window === "number" && Number.isFinite(window) && window > 0
				? window > PROMPT_RESERVE_TOKENS * 4
					? window - PROMPT_RESERVE_TOKENS
					: window
				: null,
		async decide(request: EngineRequest): Promise<EngineReply> {
			const wireModel = model ?? target.defaultModel;
			if (wireModel === undefined) throw new Error(`llm engine '${name}' has no model`);
			const baseUrl = hasChatWire(runtime.id) ? chatBaseUrl(runtime.id, target) : null;
			if (baseUrl === null && input.oneShot === undefined) {
				throw new Error(`llm engine '${name}' has no chat wire and no one-shot port`);
			}
			const verdictKey = `${target.id}|${wireModel}|${baseUrl ?? "oneshot"}`;
			const stateText = renderState(request.state);
			const capacity = input.endpointCapacity?.(target.id);

			const resolveMode = (): ResolvedMode => {
				// A port returns text, never logprobs.
				if (baseUrl === null || configured === "answer") return "answer";
				if (configured === "logprobs") return "logprobs";
				const verdict = modeVerdicts.get(verdictKey);
				if (verdict === undefined) return "logprobs";
				if (verdict.mode === "answer" && Date.now() - verdict.at > ANSWER_VERDICT_TTL_MS) {
					modeVerdicts.delete(verdictKey);
					return "logprobs";
				}
				return verdict.mode;
			};

			const attempt = async (mode: ResolvedMode): Promise<EngineReply> => {
				// Requests still in flight when a mode fails or the call finishes are
				// cancelled with the attempt rather than left to run to completion.
				const controller = new AbortController();
				const onAbort = () => controller.abort(request.signal.reason);
				request.signal.addEventListener("abort", onAbort, { once: true });
				if (request.signal.aborted) onAbort();
				const channel =
					baseUrl !== null
						? createHttpChannel({ target, runtime, model: wireModel, baseUrl, host, signal: controller.signal })
						: createOneShotChannel({
								targetId: target.id,
								model: wireModel,
								port: input.oneShot as OneShotPort,
								signal: controller.signal,
							});
				const build = `llm:${runtime.id}@${baseUrl === null ? "oneshot" : hostOf(baseUrl)}/${wireModel}#${mode}:${PROMPT_VERSION}`;
				const ctx: ReadContext = {
					mode,
					build,
					channel,
					scheduler: createScheduler(
						capacity !== undefined && Number.isFinite(capacity) ? capacity : DEFAULT_ENDPOINT_CAPACITY,
					),
					stateText,
					signal: controller.signal,
					mayDowngrade: configured === "auto" && mode === "logprobs",
					usage: { input: 0, output: 0 },
				};
				try {
					const settled = await Promise.allSettled(
						Object.entries(request.questions).map(async ([id, question]) => {
							try {
								return [id, await answerQuestion(ctx, question)] as const;
							} catch (error) {
								// One question learned the target has no logprobs: the rest of the
								// attempt is moot, so requests still queued are dropped, not sent.
								if (error instanceof LogprobsUnavailable) controller.abort(error);
								throw error;
							}
						}),
					);
					for (const entry of settled) {
						if (entry.status === "rejected" && entry.reason instanceof LogprobsUnavailable) throw entry.reason;
					}
					request.signal.throwIfAborted();
					const answers: Record<string, Answer> = {};
					for (const entry of settled) {
						if (entry.status === "fulfilled" && entry.value[1] !== null) answers[entry.value[0]] = entry.value[1];
					}
					if (Object.keys(answers).length === 0) {
						const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
						throw failed !== undefined
							? failed.reason
							: new Error(`llm engine '${name}' returned no usable answer (${mode} readout)`);
					}
					const usage = ctx.usage.input + ctx.usage.output > 0 ? { usage: { ...ctx.usage } } : {};
					return { build, answers, ...usage };
				} finally {
					request.signal.removeEventListener("abort", onAbort);
					controller.abort();
				}
			};

			let mode = resolveMode();
			for (;;) {
				try {
					const reply = await attempt(mode);
					if (configured === "auto" && baseUrl !== null) modeVerdicts.set(verdictKey, { mode, at: Date.now() });
					return reply;
				} catch (error) {
					if (!(error instanceof LogprobsUnavailable)) throw error;
					if (configured !== "auto" || mode === "answer") {
						throw new Error(
							`target '${target.id}' returned no usable logprobs (${errorText(error)}); set the engine mode to auto or answer`,
						);
					}
					modeVerdicts.set(verdictKey, { mode: "answer", at: Date.now() });
					mode = "answer";
				}
			}
		},
	};
}
