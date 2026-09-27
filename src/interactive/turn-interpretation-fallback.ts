import type { HarnessIntent } from "../domains/providers/index.js";
import { HARNESS_INTENTS, TURN_INTERPRETATION_SYSTEM_PROMPT } from "../domains/providers/index.js";
import type { TurnInterpretation } from "../domains/turn-control/index.js";
import { TURN_INTERPRETATION_VERSION } from "../domains/turn-control/index.js";
import { draftTemperature } from "./drafts.js";
import type { OutOfTurnRoundInput, SideQuestionResult } from "./side-question.js";
import { runOutOfTurnRound } from "./side-question.js";

export interface TurnInterpretationFallbackInput
	extends Pick<OutOfTurnRoundInput, "model" | "apiKey" | "runtimeId" | "signal"> {
	task: string;
	previous?: string;
}

const RESPONSE_SCHEMA = {
	name: "turn_interpretation",
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["intent", "intentCertainty", "orientationWanted", "breadth", "directionRequested", "shape"],
		properties: {
			intent: { type: "string", enum: HARNESS_INTENTS },
			intentCertainty: { type: "number", minimum: 0, maximum: 1 },
			orientationWanted: { type: "number", minimum: 0, maximum: 1 },
			breadth: { type: ["string", "null"], enum: ["repository", "area", "focused", null] },
			directionRequested: { type: "number", minimum: 0, maximum: 1 },
			shape: { type: ["string", "null"], enum: ["single", "parallel", "sequence", "council", null] },
		},
	},
};

function bounded(value: string, limit: number, tail = false): string {
	const points = [...value.replace(/\s+/gu, " ").trim()];
	if (points.length <= limit) return points.join("");
	return tail ? `…${points.slice(-limit + 1).join("")}` : `${points.slice(0, limit - 1).join("")}…`;
}

function probability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parse(text: string): TurnInterpretation | null {
	const value: unknown = JSON.parse(text);
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const fields = value as Record<string, unknown>;
	if (
		Object.keys(fields).length !== 6 ||
		!HARNESS_INTENTS.includes(fields.intent as HarnessIntent) ||
		!probability(fields.intentCertainty) ||
		!probability(fields.orientationWanted) ||
		!probability(fields.directionRequested) ||
		!(
			fields.breadth === null ||
			fields.breadth === "repository" ||
			fields.breadth === "area" ||
			fields.breadth === "focused"
		) ||
		!(
			fields.shape === null ||
			fields.shape === "single" ||
			fields.shape === "parallel" ||
			fields.shape === "sequence" ||
			fields.shape === "council"
		)
	)
		return null;
	return {
		version: TURN_INTERPRETATION_VERSION,
		intent: fields.intent as HarnessIntent,
		intentCertainty: fields.intent === "unknown" ? 0 : fields.intentCertainty,
		orientation: { wanted: fields.orientationWanted, breadth: fields.breadth, subject: null },
		direction: { requested: fields.directionRequested },
		shape: fields.shape,
	};
}

export async function interpretTurnWithMainModel(input: TurnInterpretationFallbackInput): Promise<{
	interpretation: TurnInterpretation | null;
	usage: SideQuestionResult["usage"] | null;
}> {
	let usage: SideQuestionResult["usage"] = null;
	const controller = new AbortController();
	const onAbort = () => controller.abort(input.signal?.reason);
	input.signal?.addEventListener("abort", onAbort, { once: true });
	if (input.signal?.aborted) onAbort();
	const timer = setTimeout(() => controller.abort(new Error("turn interpretation timed out after 8000ms")), 8000);
	try {
		if (controller.signal.aborted) return { interpretation: null, usage };
		const temperature = draftTemperature(input.model.id, 0);
		const result = await runOutOfTurnRound({
			model: input.model,
			messages: [],
			systemPrompt: TURN_INTERPRETATION_SYSTEM_PROMPT,
			userText: `task: ${bounded(input.task, 600)}\nprevious: ${bounded(input.previous ?? "", 400, true)}`,
			responseSchema: RESPONSE_SCHEMA,
			maxTokens: 200,
			signal: controller.signal,
			...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
			...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}),
			...(temperature !== undefined ? { temperature } : {}),
		});
		usage = result.usage;
		return { interpretation: result.aborted || controller.signal.aborted ? null : parse(result.text), usage };
	} catch {
		// S5: unavailable or malformed producers leave the turn without an interpretation.
		return { interpretation: null, usage };
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", onAbort);
	}
}
