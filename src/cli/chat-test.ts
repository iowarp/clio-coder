/**
 * Setup's one test request: before a route is saved, ask its model one short
 * question through the round a session's engine uses for an out-of-turn ask,
 * with the draft target and credential held in memory. What the provider says
 * on failure is mapped to one fix the person at the screen can act on.
 */

import { proxyForUrl } from "../core/proxy-env.js";
import type { RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import { redactSecretString } from "../domains/safety/redaction.js";

export const CHAT_TEST_TIMEOUT_MS = 15_000;

export interface ChatTestRequest {
	runtime: RuntimeDescriptor;
	target: TargetDescriptor;
	model: string;
	/** A key the person typed or named this session; absent reads the stored credential. */
	apiKey?: string;
}

export type ChatTestOutcome =
	| { ok: true; latencyMs: number }
	| { ok: false; message: string; httpStatus: number | null; errorClass?: string; stage?: string; timedOut?: boolean };

export type SendChatTest = (request: ChatTestRequest) => Promise<ChatTestOutcome>;

export const sendChatTest: SendChatTest = async (request) => {
	const started = performance.now();
	const signal = AbortSignal.timeout(CHAT_TEST_TIMEOUT_MS);
	let failure: { httpStatus: number | null; errorClass: string; stage: string } | undefined;
	try {
		const { runOutOfTurnRound } = await import("../session-control/side-question.js");
		const { openAuthStorage, resolveAuthTarget, targetRequiresAuth } = await import("../domains/providers/auth/index.js");
		const { LOCAL_API_KEY_FALLBACK, resolveSideCallAuth } = await import("../domains/providers/side-call-auth.js");
		const { runtime, target } = request;
		const auth =
			request.apiKey !== undefined
				? { apiKey: request.apiKey }
				: !targetRequiresAuth(target, runtime)
					? { apiKey: LOCAL_API_KEY_FALLBACK }
					: await resolveSideCallAuth(
							{
								resolveForTarget: (
									t: TargetDescriptor,
									r: RuntimeDescriptor,
									options?: { signal?: AbortSignal; rejectedApiKey?: string },
								) => openAuthStorage().resolveForTarget(resolveAuthTarget(t, r), options ?? {}),
							} as never,
							target,
							runtime,
							LOCAL_API_KEY_FALLBACK,
							signal,
						);
		const result = await runOutOfTurnRound({
			model: runtime.synthesizeModel(target, request.model, null),
			messages: [],
			systemPrompt: "Reply with OK.",
			userText: "ping",
			maxTokens: 16,
			thinkingLevel: "off",
			signal,
			runtimeId: runtime.id,
			cacheRetention: "none",
			onUsage: (_usage, observation) => {
				if (observation?.failure) failure = observation.failure;
			},
			...auth,
		});
		if (result.aborted || signal.aborted)
			return { ok: false, message: "no answer", httpStatus: null, timedOut: true, stage: "transport" };
		return { ok: true, latencyMs: performance.now() - started };
	} catch (error) {
		const message = redactSecretString(error instanceof Error ? error.message : String(error));
		if (signal.aborted) return { ok: false, message, httpStatus: null, timedOut: true, stage: "transport" };
		const status = failure?.httpStatus ?? statusIn(message);
		return {
			ok: false,
			message,
			httpStatus: status,
			...(failure ? { errorClass: failure.errorClass, stage: failure.stage } : {}),
		};
	}
};

function statusIn(message: string): number | null {
	const match = /\b(40[134]|429|5\d\d)\b/u.exec(message);
	return match ? Number(match[1]) : null;
}

/** The one fix shown under the provider's own message. */
export function chatTestFix(
	outcome: Extract<ChatTestOutcome, { ok: false }>,
	route: { provider: string; model: string; url?: string },
): string {
	const where = route.url ?? `${route.provider}'s address`;
	const proxy = proxyForUrl(route.url);
	if (outcome.timedOut)
		return `${where} gave no answer within ${CHAT_TEST_TIMEOUT_MS / 1000} s${proxy ? ` (through the proxy ${proxy})` : ""}. Check the address, or save anyway and try later.`;
	if (outcome.httpStatus === 401 || outcome.httpStatus === 403)
		return `${route.provider} refused the key (${outcome.httpStatus}). Change the key, or check that it belongs to ${route.provider}.`;
	if (outcome.httpStatus === 404)
		return `${route.provider} has no model ${route.model} for this account. Choose a different model.`;
	if (outcome.stage === "transport" || /ECONNREFUSED|ENOTFOUND|fetch failed|EAI_AGAIN|ECONNRESET/u.test(outcome.message))
		return `Clio could not connect to ${where}${proxy ? ` through the proxy ${proxy}` : ""}. Check the address.`;
	if (/content[- ]type|not a model reply|Unexpected token|JSON/iu.test(outcome.message))
		return `${where} answered, but not as a model: check that the address is the API, not a web page.`;
	return "Try again, change the key or address, or save anyway.";
}
