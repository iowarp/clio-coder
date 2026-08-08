/**
 * Tool-prose loop assessor, packaged as a turn_end hook registration.
 *
 * The decision of record for local models that narrate tool calls instead of
 * making them: when the final assistant text of a turn repeats tool-call
 * narration without a structured tool call, this registration emits an
 * `inject_reminder` with `hard-block` severity. The chat-loop's generic
 * effect application interrupts the turn (unless its streaming cutoff already
 * aborted it mid-delta) and flushes the reminder into the next model request
 * as recovery guidance.
 */

import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareHookRegistration } from "../domains/middleware/index.js";
import { assessToolProseLoop, runtimeNarratesToolCalls } from "./tool-prose-loop.js";

export const TOOL_PROSE_REGISTRATION_ID = "assessor.tool-prose-loop";

export function createToolProseRegistration(): MiddlewareHookRegistration {
	return {
		id: TOOL_PROSE_REGISTRATION_ID,
		description: "interrupt local model turns that narrate tool calls instead of emitting structured tool calls",
		hooks: ["turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			if (input.hook !== "turn_end") return [];
			const runtimeTier = typeof input.metadata?.runtimeTier === "string" ? input.metadata.runtimeTier : undefined;
			if (!runtimeNarratesToolCalls(runtimeTier)) return [];
			const text = input.text ?? "";
			if (text.length === 0) return [];
			const activeToolNames =
				typeof input.metadata?.activeToolNames === "string"
					? input.metadata.activeToolNames.split(",").filter((name) => name.length > 0)
					: [];
			const assessment = assessToolProseLoop({
				text,
				activeToolNames,
				hasStructuredToolCall: input.metadata?.hasStructuredToolCall === true,
			});
			if (assessment.kind !== "loop") return [];
			return [
				{
					kind: "inject_reminder",
					message: `[Clio Coder] aborted local model turn: ${assessment.reason}.`,
					severity: "hard-block",
				},
			];
		},
	};
}
