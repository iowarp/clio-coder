/**
 * The `POST /v1/systemone` wire every System One server speaks: TypeSafe's
 * hosted Jev, `laya-serve`, `clm-serve`. One parser for all of them, so an
 * answer that would mislead a gate is dropped the same way whoever sent it.
 */

import { probeJson } from "../../probe/http.js";
import type { DecideOptions, DecideResult, DecisionAnswer, DecisionQuestion } from "../../types/inference.js";
import type { ProbeContext } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

interface SystemOneResponse {
	model?: unknown;
	answers?: Record<string, unknown>;
	usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

function trimTrailingSlash(value: string): string {
	return value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value;
}

/**
 * The API root. An operator pasting the endpoint they read in the provider's
 * docs writes `.../v1/systemone`, and the verb appends that segment itself, so
 * a URL already ending in it is taken as the root it was meant to be rather
 * than posted to `/systemone/systemone`.
 */
export function systemOneBaseUrl(target: TargetDescriptor, fallback: string): string {
	const base = trimTrailingSlash(target.url ?? fallback);
	return base.endsWith("/systemone") ? base.slice(0, -"/systemone".length) : base;
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") out[key] = entry;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function distribution(value: unknown, keys: ReadonlyArray<string>): Record<string, number> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (Object.keys(raw).length !== keys.length) return null;
	const out: Record<string, number> = {};
	let total = 0;
	for (const key of keys) {
		const entry = raw[key];
		if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1) return null;
		out[key] = entry;
		total += entry;
	}
	// Wire values are rounded for display. Allow that rounding, but not a map
	// that is no longer a probability distribution.
	return Math.abs(total - 1) <= Math.max(0.02, keys.length * 0.005) ? out : null;
}

/**
 * Narrow one wire answer. An answer whose `type` is unrecognised is dropped
 * rather than coerced: a caller gating on a decision must not receive a
 * silently defaulted one.
 */
function parseAnswer(raw: unknown, question: DecisionQuestion): DecisionAnswer | null {
	if (typeof raw !== "object" || raw === null) return null;
	const row = raw as Record<string, unknown>;
	const type = question.type;
	if (row.type !== type) return null;
	const answer: DecisionAnswer = { type };
	const noul = numberOrUndefined(row.noul);
	if (type === "noul" && (noul === undefined || noul < 0 || noul > 1)) return null;
	if (noul !== undefined) answer.noul = noul;
	if (type === "choice" && (typeof row.choice !== "string" || !Object.hasOwn(question.criteria, row.choice)))
		return null;
	if (typeof row.choice === "string") answer.choice = row.choice;
	const probabilities =
		question.type === "choice"
			? distribution(row.probabilities, Object.keys(question.criteria))
			: question.type === "score"
				? distribution(
						row.probabilities,
						question.criteria.map((_level, index) => String(index)),
					)
				: null;
	if (type !== "noul" && probabilities === null) return null;
	if (probabilities !== null) answer.probabilities = probabilities;
	if (type === "choice" && probabilities !== null) {
		const chosen = probabilities[row.choice as string] as number;
		if (chosen + 0.01 < Math.max(...Object.values(probabilities))) return null;
	}
	const score = numberOrUndefined(row.score);
	if (question.type === "score" && (score === undefined || score < 0 || score > question.criteria.length - 1))
		return null;
	if (question.type === "score" && score !== undefined && probabilities !== null) {
		const weighted = Object.entries(probabilities).reduce((sum, [index, mass]) => sum + Number(index) * mass, 0);
		if (Math.abs(score - weighted) > Math.max(0.03, 0.02 * (question.criteria.length - 1))) return null;
	}
	if (score !== undefined) answer.score = score;
	const legend = stringMap(row.legend);
	if (legend) answer.legend = legend;
	// A noul's certainty is read from its probability (`answerCertainty`). Jev
	// sends no confidence on a noul; laya-serve, which speaks this wire, sends
	// max(p, 1 - p), a scale that never falls below 0.5 and so would clear every
	// abstention floor with a coin-flip.
	const confidence = type === "noul" ? undefined : numberOrUndefined(row.confidence);
	if (type !== "noul" && (confidence === undefined || confidence < 0 || confidence > 1)) return null;
	if (confidence !== undefined) answer.confidence = confidence;
	return answer;
}

export interface SystemOneRequest {
	readonly baseUrl: string;
	readonly headers: Record<string, string>;
	/** Sent only when set; servers that pick their own model take none. */
	readonly model: string | undefined;
	readonly label: string;
}

export async function postSystemOne(
	request: SystemOneRequest,
	opts: DecideOptions,
	ctx: ProbeContext,
): Promise<DecideResult> {
	const questionIds = Object.keys(opts.questions);
	if (questionIds.length === 0) throw new Error("decide() requires at least one question");
	const signal = opts.signal ?? ctx.signal;
	const body = {
		state: opts.state,
		...(request.model !== undefined ? { model: request.model } : {}),
		questions: opts.questions,
	};
	const http = {
		url: `${request.baseUrl}/systemone`,
		method: "POST" as const,
		timeoutMs: ctx.httpTimeoutMs,
		headers: { ...request.headers, "content-type": "application/json" },
		body: JSON.stringify(body),
	};
	const response = await (signal
		? probeJson<SystemOneResponse>({ ...http, signal })
		: probeJson<SystemOneResponse>(http));
	if (!response.ok || !response.data) {
		throw new Error(`${request.label} decide failed: ${response.error ?? "unknown"}`);
	}
	const answers: Record<string, DecisionAnswer> = {};
	for (const [id, raw] of Object.entries(response.data.answers ?? {})) {
		const question = opts.questions[id];
		if (question === undefined) continue;
		const parsed = parseAnswer(raw, question);
		if (parsed) answers[id] = parsed;
	}
	// Questions in one request are independent. Preserve valid siblings when
	// one answer is missing or malformed; their readers treat absence as an
	// abstention. A wholly unusable batch remains a failed request.
	if (Object.keys(answers).length === 0) {
		throw new Error(`${request.label} decide returned no usable answer for: ${questionIds.join(", ")}`);
	}
	const result: DecideResult = {
		model: typeof response.data.model === "string" ? response.data.model : (request.model ?? "unknown"),
		answers,
	};
	const input = numberOrUndefined(response.data.usage?.input_tokens);
	const output = numberOrUndefined(response.data.usage?.output_tokens);
	if (input !== undefined && output !== undefined) result.tokensUsed = { input, output };
	return result;
}
