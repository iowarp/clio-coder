import { ToolNames } from "../core/tool-names.js";
import { parseFleet } from "../domains/agents/index.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export const chainDispatchTool: ToolSpec = {
	name: ToolNames.ChainDispatch,
	description: "Dispatch a chained fleet of subagents (recipe1 -> recipe2 -> ...). Phase 5 stub.",
	baseActionClass: "dispatch",
	async run(args): Promise<ToolResult> {
		const fleetArg = typeof args.fleet === "string" ? args.fleet : "";
		if (!fleetArg) return { kind: "error", message: "chain_dispatch: missing fleet argument" };
		try {
			const fleet = parseFleet(fleetArg);
			const recipes = fleet.steps.map((step) => step.recipeId).join(" -> ");
			return {
				kind: "ok",
				output: `chain_dispatch stub: would run ${fleet.steps.length} steps (${recipes})`,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `chain_dispatch: ${message}` };
		}
	},
};
