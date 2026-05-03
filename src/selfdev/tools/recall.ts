import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import type { ToolResult, ToolSpec } from "../../tools/registry.js";
import { recallDevMemory } from "../memory.js";

export interface ClioRecallDeps {
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

export function clioRecallTool(deps: ClioRecallDeps): ToolSpec {
	return {
		name: ToolNames.ClioRecall,
		description:
			"Read newest self-development memory entries for this checkout. Filter by tags when that helps focus the result.",
		parameters: Type.Object({
			tags: Type.Optional(
				Type.Array(Type.String(), { description: "Only return entries containing every supplied tag." }),
			),
			limit: Type.Optional(Type.Number({ description: "Maximum entries to return. Defaults to 10." })),
		}),
		baseActionClass: "read",
		executionMode: "parallel",
		async run(args): Promise<ToolResult> {
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			const tags = stringArray(args.tags);
			const options: { tags?: ReadonlyArray<string>; limit?: number } = {};
			if (tags) options.tags = tags;
			if (limit !== undefined) options.limit = limit;
			const entries = await recallDevMemory(deps.repoRoot, options);
			return { kind: "ok", output: JSON.stringify({ entries }) };
		},
	};
}
