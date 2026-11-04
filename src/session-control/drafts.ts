/**
 * `/draft [N] <request>`: several candidate answers side by side, one judgment.
 *
 * A diffusion model answers a request in about a second, which makes asking it
 * several times cheaper than asking a frontier model once. That only helps if
 * something can say which answer to read first. A System One model does exactly
 * that: one `choice` over the candidates returns a calibrated distribution, so
 * the overlay can show how decisive the pick was rather than only which one won.
 *
 * Nothing here enters the session. The rounds read the compiled history the
 * next turn would send, like `/btw`, and the judge reads only the request and
 * the candidate texts. Closing the overlay ends the exchange.
 */

import { stripDeadToolCallMarkup } from "../engine/loop-guard.js";

/** Candidate names, in the order the rounds were started. */
export const DRAFT_LABELS = ["A", "B", "C", "D"] as const;
export type DraftLabel = (typeof DRAFT_LABELS)[number];
export const DRAFT_MIN = 2;
export const DRAFT_MAX = 4;
export const DRAFT_DEFAULT = 3;

/**
 * One temperature per candidate. The same request at the same temperature
 * gives a diffusion model little reason to answer differently, and a judge
 * picking between near-copies is a judgment about nothing. The first draft
 * stays close to the model's default answer; the rest move away from it.
 */
export const DRAFT_TEMPERATURES = [0.3, 0.7, 1.0, 1.2] as const;

/**
 * Claude removed `temperature`, `top_p`, and `top_k` with Opus 4.7. Opus 4.7
 * and 4.8, Sonnet 5, and every Opus, Fable, and Mythos 5 model answer an
 * explicit sampler with HTTP 400. pi-ai drops it only where its catalog says
 * so, and its Sonnet 5 and Fable 5 entries do not; Bedrock's Converse
 * transport forwards it for every model. Matching the family in the wire id
 * covers the Anthropic, OpenRouter, Bedrock, and Vertex spellings of one model.
 * A dated snapshot suffix is not a minor version.
 */
const CLAUDE_GENERATION = /claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2}))?(?!\d)/u;

function rejectsSamplingTemperature(modelId: string): boolean {
	const match = CLAUDE_GENERATION.exec(modelId.toLowerCase());
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2] ?? 0);
	return major > 4 || (major === 4 && minor >= 7);
}

/** The fields of a model that decide whether it takes a sampler. Structural so this file stays off the Pi types. */
export interface DraftModelShape {
	id: string;
	api?: string;
	reasoning?: boolean;
	/** Pi's per-model compat block; only `supportsTemperature` is read. */
	compat?: object;
}

/**
 * OpenAI's reasoning models and the Codex backend answer an explicit
 * `temperature` with `Unsupported parameter: temperature` (HTTP 400). pi-ai
 * forwards the sampler on both Responses transports, so the answer is decided
 * here from the transport and the catalog's reasoning flag. Anything this
 * misses is caught by the one-shot retry in {@link runDraftWithSamplerFallback}.
 */
function transportRefusesTemperature(model: DraftModelShape): boolean {
	if ((model.compat as { supportsTemperature?: boolean } | undefined)?.supportsTemperature === false) return true;
	if (model.api === "openai-codex-responses") return true;
	return model.api === "openai-responses" && model.reasoning === true;
}

/**
 * The temperature a candidate is sent with, or undefined where the model
 * refuses one. Those candidates run at the provider's default and get a
 * different angle in their system prompt instead ({@link draftSystemPrompt}).
 */
export function draftTemperature(model: DraftModelShape | string, temperature: number): number | undefined {
	const shape = typeof model === "string" ? { id: model } : model;
	return rejectsSamplingTemperature(shape.id) || transportRefusesTemperature(shape) ? undefined : temperature;
}

/**
 * How a candidate that cannot be spread by temperature is told to differ. The
 * first draft stays the plain answer, so the judge always has a baseline; the
 * rest are asked for a distinct route to the same answer. Prompt variation
 * moves a model less than temperature does, but a judge choosing between
 * identical drafts is judging nothing.
 */
const DRAFT_ANGLES = [
	"",
	"Take a different route to the answer than the most obvious one.",
	"Favor the most minimal answer that is still correct and complete.",
	"Favor the most robust answer: handle the edge cases the request implies.",
] as const;

/** The system prompt for candidate `index`; the angle applies only when its sampler was dropped. */
export function draftSystemPrompt(index: number, samplerDropped: boolean): string {
	const angle = samplerDropped ? (DRAFT_ANGLES[index] ?? "") : "";
	return angle === "" ? DRAFT_SYSTEM_PROMPT : `${DRAFT_SYSTEM_PROMPT} ${angle}`;
}

/** A provider refusing the `temperature` field, in the spellings the OpenAI, Codex and Anthropic backends use. */
export function isTemperatureRejection(message: string): boolean {
	return /unsupported (?:parameter|value)[^\n]{0,40}temperature|temperature[^\n]{0,60}(?:not supported|unsupported|does not support|is deprecated)/iu.test(
		message,
	);
}

/**
 * Run one draft with its sampler, and once more without it when the provider
 * refuses `temperature`. The model catalog cannot list every backend that does,
 * and a candidate that fails outright has nothing to vary, so one retry at the
 * provider's default (with the candidate's angle) is worth more than a red row.
 * Any other failure, or an abort, rejects unchanged.
 */
export async function runDraftWithSamplerFallback<T>(
	index: number,
	temperature: number | undefined,
	run: (sampling: { temperature?: number; systemPrompt: string }) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	try {
		return await run({
			...(temperature !== undefined ? { temperature } : {}),
			systemPrompt: draftSystemPrompt(index, temperature === undefined),
		});
	} catch (error) {
		if (temperature === undefined || signal?.aborted === true) throw error;
		if (!isTemperatureRejection(error instanceof Error ? error.message : String(error))) throw error;
		return run({ systemPrompt: draftSystemPrompt(index, true) });
	}
}

export const DRAFT_SYSTEM_PROMPT = [
	"You are drafting one candidate answer to the operator's request in a coding session.",
	"The conversation above is read-only context. Write one complete answer to the request and nothing else.",
	"Do not call tools, do not propose edits to the session, and do not describe alternatives you did not write.",
].join(" ");

/** Output budget per candidate. A draft is an answer to compare, not a document. */
export const DRAFT_MAX_TOKENS = 4096;

export const DRAFT_TOOL_CALL_REASON = "drafted a tool call instead of a reply";

export function hasDeadDraftToolCallMarkup(text: string): boolean {
	return stripDeadToolCallMarkup(text) !== text;
}

/** A tool-free round can return call syntax as text; it is not a usable draft. */
export function draftCandidateFromText(
	text: string,
): { status: "drafted"; text: string } | { status: "failed"; reason: string } {
	return hasDeadDraftToolCallMarkup(text)
		? { status: "failed", reason: DRAFT_TOOL_CALL_REASON }
		: { status: "drafted", text };
}

export interface DraftRequest {
	count: number;
	request: string;
}

/**
 * Read `/draft` arguments. A leading integer is the candidate count; anything
 * else is the request. Out-of-range counts are refused rather than clamped, so
 * `/draft 9 ...` does not silently spend four rounds on a request that asked
 * for nine.
 */
export function parseDraftArgs(rest: string): DraftRequest | { error: string } {
	const trimmed = rest.trim();
	const match = /^(\d+)\s+([\s\S]+)$/u.exec(trimmed);
	if (match) {
		const count = Number(match[1]);
		const request = (match[2] ?? "").trim();
		if (count < DRAFT_MIN || count > DRAFT_MAX) {
			return { error: `draft count must be ${DRAFT_MIN} to ${DRAFT_MAX}, got ${count}` };
		}
		if (request.length === 0) return { error: "a draft needs a request" };
		return { count, request };
	}
	if (trimmed.length === 0) return { error: "a draft needs a request" };
	return { count: DRAFT_DEFAULT, request: trimmed };
}
