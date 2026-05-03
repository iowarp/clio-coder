import { Type } from "typebox";
import type { ToolResult, ToolSpec } from "../../tools/registry.js";
import { pruneDevMemory } from "../memory.js";
import { SelfDevToolNames } from "../tool-names.js";

export interface ClioMemoryMaintainDeps {
	repoRoot: string;
}

export function clioMemoryMaintainTool(deps: ClioMemoryMaintainDeps): ToolSpec {
	return {
		name: SelfDevToolNames.ClioMemoryMaintain,
		description:
			"Maintain checkout-local self-development memory. By default this previews pruning; pass dry_run=false to rewrite the JSONL file with only the newest valid entries.",
		parameters: Type.Object({
			keep: Type.Optional(Type.Number({ description: "Newest valid entries to keep. Defaults to 50; max 500." })),
			dry_run: Type.Optional(Type.Boolean({ description: "Preview only when true or omitted. Set false to apply." })),
		}),
		baseActionClass: "write",
		executionMode: "sequential",
		async run(args): Promise<ToolResult> {
			const keep = typeof args.keep === "number" ? args.keep : undefined;
			const dryRun = typeof args.dry_run === "boolean" ? args.dry_run : undefined;
			const options: { keep?: number; dryRun?: boolean } = {};
			if (keep !== undefined) options.keep = keep;
			if (dryRun !== undefined) options.dryRun = dryRun;
			const result = await pruneDevMemory(deps.repoRoot, options);
			return {
				kind: "ok",
				output: JSON.stringify({
					ok: true,
					dry_run: result.dryRun,
					total_count: result.totalCount,
					kept_count: result.keptCount,
					dropped_count: result.droppedCount,
					malformed_count: result.malformedCount,
					rotated_exists: result.rotatedExists,
					limit_applied: result.limitApplied,
				}),
			};
		},
	};
}
