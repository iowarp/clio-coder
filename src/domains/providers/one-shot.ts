/**
 * A tool-free side completion, and the admission every such request passes. The
 * safety judge and System One's LLM engine both ask through this, so neither
 * owns it.
 */

import type { CallObservation } from "../../core/call-failure.js";

export interface LlmRequestUsage {
	/** True only when fields were read directly from provider usage, including explicit zero (#434). */
	readonly providerReported?: boolean;
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly cacheWrite1h?: number;
	readonly reasoning?: number;
	readonly totalTokens?: number;
	readonly costUsd?: number;
}

/**
 * The per-request accounting sink. `withContext` runs the request inside its journal call, so the engine seam marks
 * the send and a request that never left reads as never sent by its own stages (#429, #434).
 */
export type LlmRequestAccounting = ((usage: LlmRequestUsage | null, observation?: CallObservation) => void) & {
	readonly withContext?: <T>(work: () => T) => T;
};

/** Admission captures the originating session and returns its per-request accounting sink. */
export type LlmRequestAdmission = (request: {
	/** The System One engine asking, which names the call's agent; absent for a caller that is not an engine (#434). */
	readonly engine?: string;
	readonly targetId: string;
	readonly model: string;
	readonly signal: AbortSignal;
}) => Promise<LlmRequestAccounting>;

/** A refused request invalidates the whole decision, including answers from earlier requests. */
export class LlmAdmissionRefused extends Error {}

/**
 * One tool-free completion through a runtime that has no chat-completions
 * wire (subscription and CLI-backed ones). The composition root supplies it
 * because only the engine layer may speak to those runtimes, and the answer
 * is text: an LLM engine behind a port can vote but cannot read logprobs.
 */
export type OneShotPort = (request: {
	/** The System One engine asking, passed through to request admission (#434). */
	engine?: string;
	targetId: string;
	model: string | null;
	system: string;
	user: string;
	schema?: object;
	maxTokens: number;
	signal: AbortSignal;
}) => Promise<{ text: string; usage?: { input: number; output: number }; model?: string }>;

/** What a port reports: a cached prompt is still input the model read, which is what a chat wire's prompt count says. */
export function oneShotTokens(usage: {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
}): { input: number; output: number } {
	return { input: usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0), output: usage.output };
}
