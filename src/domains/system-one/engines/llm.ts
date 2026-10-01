/**
 * An engine over an ordinary chat target: any model Clio already knows, used
 * as a one-shot decider.
 *
 * Where the runtime returns logprobs the engine reads the first token's letter
 * alternatives, which is the only way an LLM yields a probability rather than
 * a claim of one. Where it does not, it asks for five votes and says so by
 * marking the answers uncalibrated. The mode is decided per target, model and
 * URL by the warm request of a real call, so there is no separate probe to pay
 * for, and both verdicts expire so a server that changes is asked again. A
 * binding whose option orders keep coming back unreadable flips to votes too.
 * A call never mixes the two readouts, and its reply carries a `note` saying
 * why it is not the readout the operator configured.
 */

import { performance } from "node:perf_hooks";
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
import { errorText, LlmAdmissionRefused } from "./shared.js";

/** Concurrent requests when the host cannot say how many the endpoint serves. */
const DEFAULT_ENDPOINT_CAPACITY = 4;
/** How long a no-logprobs or partial-logprobs verdict is trusted before the next call probes again. */
const ANSWER_VERDICT_TTL_MS = 10 * 60_000;
/** How long a logprobs verdict is trusted. Its only state is the partial streak, so it ages out on a slower clock. */
const LOGPROBS_VERDICT_TTL_MS = 30 * 60_000;
/** Consecutive calls with half or more of their option orders unreadable that flip an auto binding to votes. */
const PARTIAL_CALLS_TO_FLIP = 3;
/** Headroom for the system prompt and framing that the state estimate does not count. */
const PROMPT_RESERVE_TOKENS = 256;

type ResolvedMode = "logprobs" | "answer";
type Downgrade = "no-logprobs" | "partial-logprobs";

interface ModeVerdict {
	readonly mode: ResolvedMode;
	/** When the verdict was decided. Later calls do not extend it. */
	readonly at: number;
	/** Why an answer verdict is not the configured readout. */
	readonly reason?: Downgrade;
	/** Consecutive logprob calls with half or more of their option orders unreadable. */
	partialStreak: number;
}

// Process-wide: engines are rebuilt on every settings change, and a server's
// logprob support does not change with them.
const modeVerdicts = new Map<string, ModeVerdict>();

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
		runtime: runtime.id,
		url: target.url ?? null,
		profile: null,
		renderer: "llm-prompt",
		// The prompt carries any task and shape the wire validates; votes and logprobs read every one.
		unsupported: () => null,
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

			const resolveMode = (): { mode: ResolvedMode; downgraded: Downgrade | null } => {
				// A port returns text, never logprobs.
				if (baseUrl === null || configured === "answer") return { mode: "answer", downgraded: null };
				if (configured === "logprobs") return { mode: "logprobs", downgraded: null };
				const verdict = modeVerdicts.get(verdictKey);
				if (verdict === undefined) return { mode: "logprobs", downgraded: null };
				const ttl = verdict.mode === "answer" ? ANSWER_VERDICT_TTL_MS : LOGPROBS_VERDICT_TTL_MS;
				if (performance.now() - verdict.at > ttl) {
					modeVerdicts.delete(verdictKey);
					return { mode: "logprobs", downgraded: null };
				}
				return { mode: verdict.mode, downgraded: verdict.reason ?? null };
			};

			/**
			 * Counts a logprob call toward the binding's partial streak. Only a call whose
			 * answers were read counts, so a canceled or downgraded one leaves it alone.
			 */
			const learnFromOrders = (orders: { read: number; missing: number }): void => {
				if (configured !== "auto" || baseUrl === null) return;
				let verdict = modeVerdicts.get(verdictKey);
				if (verdict === undefined) {
					verdict = { mode: "logprobs", at: performance.now(), partialStreak: 0 };
					modeVerdicts.set(verdictKey, verdict);
				}
				if (verdict.mode !== "logprobs") return;
				const total = orders.read + orders.missing;
				verdict.partialStreak = total > 0 && orders.missing * 2 >= total ? verdict.partialStreak + 1 : 0;
				if (verdict.partialStreak >= PARTIAL_CALLS_TO_FLIP) {
					modeVerdicts.set(verdictKey, {
						mode: "answer",
						at: performance.now(),
						reason: "partial-logprobs",
						partialStreak: 0,
					});
				}
			};

			const attempt = async (mode: ResolvedMode, downgraded: Downgrade | null): Promise<EngineReply> => {
				// Requests still in flight when a mode fails or the call finishes are
				// cancelled with the attempt rather than left to run to completion.
				const controller = new AbortController();
				const onAbort = () => controller.abort(request.signal.reason);
				request.signal.addEventListener("abort", onAbort, { once: true });
				if (request.signal.aborted) onAbort();
				let refuse!: (error: LlmAdmissionRefused) => void;
				const admissionRefused = new Promise<never>((_resolve, reject) => {
					refuse = reject;
				});
				const onAdmissionRefused = (error: LlmAdmissionRefused): void => {
					refuse(error);
					controller.abort(error);
				};
				const channel =
					baseUrl !== null
						? createHttpChannel({
								target,
								runtime,
								model: wireModel,
								baseUrl,
								host,
								signal: controller.signal,
								onAdmissionRefused,
							})
						: createOneShotChannel({
								targetId: target.id,
								model: wireModel,
								port: input.oneShot as OneShotPort,
								signal: controller.signal,
								onAdmissionRefused,
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
					orders: { read: 0, missing: 0 },
				};
				try {
					const settled = await Promise.race([
						admissionRefused,
						Promise.allSettled(
							Object.entries(request.questions).map(async ([id, question]) => {
								try {
									return [id, await answerQuestion(ctx, question)] as const;
								} catch (error) {
									// A mode downgrade or admission refusal invalidates the attempt,
									// so queued requests cannot contribute a usable decision.
									if (error instanceof LogprobsUnavailable || error instanceof LlmAdmissionRefused) controller.abort(error);
									throw error;
								}
							}),
						),
					]);
					for (const entry of settled) {
						if (entry.status === "rejected" && entry.reason instanceof LlmAdmissionRefused) throw entry.reason;
					}
					for (const entry of settled) {
						if (entry.status === "rejected" && entry.reason instanceof LogprobsUnavailable) throw entry.reason;
					}
					request.signal.throwIfAborted();
					if (mode === "logprobs") learnFromOrders(ctx.orders);
					const answers: Record<string, Answer> = {};
					for (const entry of settled) {
						if (entry.status === "fulfilled" && entry.value[1] !== null) {
							const answer = entry.value[1];
							answers[entry.value[0]] = { ...answer, readout: mode === "logprobs" ? "logprob" : "vote" };
						}
					}
					if (Object.keys(answers).length === 0) {
						const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
						throw failed !== undefined
							? failed.reason
							: new Error(`llm engine '${name}' returned no usable answer (${mode} readout)`);
					}
					const usage = ctx.usage.input + ctx.usage.output > 0 ? { usage: { ...ctx.usage } } : {};
					const unread = ctx.orders.missing;
					const note =
						downgraded !== null
							? `downgraded: ${downgraded}`
							: unread > 0
								? `partial: ${unread} of ${unread + ctx.orders.read} logprob orders unreadable`
								: undefined;
					return { build, answers, ...usage, ...(note !== undefined ? { note } : {}) };
				} finally {
					request.signal.removeEventListener("abort", onAbort);
					controller.abort();
				}
			};

			let { mode, downgraded } = resolveMode();
			for (;;) {
				try {
					return await attempt(mode, downgraded);
				} catch (error) {
					if (!(error instanceof LogprobsUnavailable)) throw error;
					if (configured !== "auto" || mode === "answer") {
						throw new Error(
							`target '${target.id}' returned no usable logprobs (${errorText(error)}); set the engine mode to auto or answer`,
						);
					}
					modeVerdicts.set(verdictKey, { mode: "answer", at: performance.now(), reason: "no-logprobs", partialStreak: 0 });
					mode = "answer";
					downgraded = "no-logprobs";
				}
			}
		},
	};
}
