import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { ToolSpec } from "./registry.js";

export type RequestSelfCompact = (note: unknown, toolCallId: string, signal?: AbortSignal) => Promise<string>;

/** Admission only. The native host owns reduction after this receipt settles. */
export function createSelfCompactTool(request: RequestSelfCompact): ToolSpec {
	return {
		name: ToolNames.SelfCompact,
		description:
			"Save an exact handoff note and compact context before continuing this task. Call alone, with no sibling tools. Include current objective, decisions, evidence, paths, and next steps. A pending receipt is not proof of completion.",
		parameters: Type.Object({
			note_to_self: Type.String({
				maxLength: 8192,
				description: "Assistant-authored handoff text; nonblank, at most 8192 UTF-8 bytes. Preserved exactly.",
			}),
		}),
		baseActionClass: "read",
		executionMode: "sequential",
		async run(args, options) {
			try {
				const note = (args as { note_to_self?: unknown }).note_to_self;
				const output = await request(note, options?.toolCallId ?? "", options?.signal);
				return { kind: "ok", output };
			} catch (error) {
				return { kind: "error", message: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
