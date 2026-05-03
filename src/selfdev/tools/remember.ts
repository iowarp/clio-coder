import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import type { ToolResult, ToolSpec } from "../../tools/registry.js";
import { appendDevMemory } from "../memory.js";

export interface ClioRememberDeps {
	repoRoot: string;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const tags: string[] = [];
	for (const item of value) {
		if (typeof item === "string") tags.push(item);
	}
	return tags;
}

export function clioRememberTool(deps: ClioRememberDeps): ToolSpec {
	return {
		name: ToolNames.ClioRemember,
		description:
			"Write one durable self-development memory note for this checkout. Store only facts useful for future Clio source work.",
		parameters: Type.Object({
			note: Type.String({ description: "Memory note to store. Must be non-empty." }),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Optional searchable tags." })),
		}),
		baseActionClass: "write",
		executionMode: "sequential",
		async run(args): Promise<ToolResult> {
			const note = typeof args.note === "string" ? args.note : "";
			try {
				const tags = stringArray(args.tags);
				const result = await appendDevMemory(deps.repoRoot, tags ? { note, tags } : { note });
				return { kind: "ok", output: JSON.stringify({ ok: true, row_count: result.rowCount }) };
			} catch (err) {
				return { kind: "error", message: err instanceof Error ? err.message : String(err) };
			}
		},
	};
}
