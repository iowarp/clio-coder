/**
 * Harmony failure codes and recovery observations for gpt-oss (#435). A leaf
 * module on purpose: `src/engine/ai.ts` re-exports the classification for the
 * session retry path, and `harmony-response.ts` reaches into the providers
 * domain, which reaches `catalog.ts`, which evaluates `createEngineAi()` at
 * load; a re-export of that module from `ai.ts` closed the cycle and threw a
 * temporal dead zone error on the first provider import.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { type HarmonyServerParsing, VLLM_GPT_OSS_SERVE_FLAGS } from "../domains/providers/harmony-server.js";

export type { HarmonyServerParsing };

export interface HarmonyDroppedToolCall {
	name: string;
	reason: "artifact" | "duplicate" | "incomplete";
}

export interface HarmonyRecoveryObservation {
	/** Raw Harmony markers were present in `content`. */
	rawMarkers: boolean;
	/** Analysis or commentary text was recovered from raw markers. */
	recoveredThinking: boolean;
	/** The analysis channel itself arrived raw, so the server runs no reasoning parser. */
	recoveredAnalysis: boolean;
	/** Tool calls synthesized from raw `to=functions.*` bodies. */
	synthesizedToolCalls: number;
	/** Structured `tool_calls` the server parsed itself (after artifact removal). */
	structuredToolCalls: number;
	/** The server streamed a reasoning field (`reasoning`, `reasoning_content`, `reasoning_text`). */
	structuredReasoning: boolean;
	droppedToolCalls: HarmonyDroppedToolCall[];
	notes: string[];
	/** Set when the engine re-ran the request once (#435). */
	retry?: { reason: "server-error" | "incomplete"; firstAttemptUsage?: Usage };
}

/**
 * What the server parsed on its side, read from one response. A raw analysis
 * channel means no reasoning parser; any other raw marker (a commentary
 * preamble, a tool frame, final-channel markers) means the reasoning parser
 * ran but nothing else did. `unknown` means a clean answer gave no evidence.
 */
export function harmonyServerParsing(observation: HarmonyRecoveryObservation | undefined): HarmonyServerParsing {
	if (observation === undefined) return "unknown";
	if (observation.recoveredAnalysis) return "none";
	if (observation.rawMarkers || observation.droppedToolCalls.some((d) => d.reason !== "artifact")) {
		return "reasoning-only";
	}
	if (observation.structuredToolCalls > 0 || observation.structuredReasoning) return "full";
	return "unknown";
}

/**
 * Error text of a vLLM `HarmonyError` (vllm#51977, giantswarm/vllm#91). The
 * server's own Harmony parser failed on the model output, so the same request
 * fails the same way; pi's generic retry pattern reads its HTTP 500 as
 * transient and would retry it three times (#435).
 */
export const HARMONY_SERVER_ERROR_PATTERN = /HarmonyError|unexpected tokens remaining in message header/i;

export const HARMONY_ERROR_CODE = "provider_harmony_error";
export const HARMONY_INCOMPLETE_CODE = "provider_harmony_incomplete";

const HARMONY_TERMINAL_PATTERN = new RegExp(`^(?:${HARMONY_ERROR_CODE}|${HARMONY_INCOMPLETE_CODE}):`);

/**
 * True for the terminal message the engine writes after its single Harmony
 * retry. Retry paths must treat it as final whatever else the text contains;
 * the engine also words it to miss pi's transient pattern, but that wording is
 * incidental and this check is the guard (#435).
 */
export function isHarmonyTerminalFailure(errorMessage: string | null | undefined): boolean {
	return typeof errorMessage === "string" && HARMONY_TERMINAL_PATTERN.test(errorMessage);
}

/** The failing request's wire effort, so the message can name the known low-effort defect (giantswarm/vllm#91). */
export function harmonyServerErrorMessage(modelId: string, providerMessage: string, effort?: string): string {
	const detail = /HarmonyError[^"\n}]{0,160}/.exec(providerMessage)?.[0] ?? "HarmonyError";
	const lowEffort =
		effort === "low"
			? " This request used low effort, and a deterministic failure at reasoning_effort low is a known vLLM defect; Clio keeps the effort as configured, so try another level."
			: "";
	return (
		`${HARMONY_ERROR_CODE}: the server-side Harmony parser rejected the response for '${modelId}' twice (${detail}). ` +
		`Clio does not retry it further. For vLLM, serve gpt-oss with ${VLLM_GPT_OSS_SERVE_FLAGS} and check the server version.${lowEffort}`
	);
}

export function harmonyIncompleteMessage(modelId: string): string {
	return (
		`${HARMONY_INCOMPLETE_CODE}: '${modelId}' returned a Harmony stop with no answer and no tool call twice, ` +
		"so the server-side Harmony parser likely ended in a non-terminal state (vllm#45736). Clio does not record it as an empty answer. " +
		`For vLLM, serve gpt-oss with ${VLLM_GPT_OSS_SERVE_FLAGS}.`
	);
}
