import { ALL_MODES, type ModeName } from "../domains/modes/index.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
import type { ToolRegistry } from "./registry.js";
import { webFetchTool } from "./web-fetch.js";
import { writePlanTool } from "./write-plan.js";
import { writeReviewTool } from "./write-review.js";
import { writeTool } from "./write.js";

/**
 * Registers every tool on the supplied registry with its admissible mode set.
 * The mode matrix (domains/modes/matrix.ts) remains authoritative for visibility;
 * `allowedModes` provides defence-in-depth at the per-spec layer so invoke paths
 * never admit a tool outside its intended modes even if the matrix drifts.
 */
export function registerAllTools(registry: ToolRegistry): void {
	const everyMode: ReadonlyArray<ModeName> = [...ALL_MODES];
	const defaultAndSuper: ReadonlyArray<ModeName> = ["default", "super"];
	const adviseOnly: ReadonlyArray<ModeName> = ["advise"];

	registry.register({ ...readTool, allowedModes: everyMode });
	registry.register({ ...writeTool, allowedModes: defaultAndSuper });
	registry.register({ ...editTool, allowedModes: defaultAndSuper });
	registry.register({ ...bashTool, allowedModes: defaultAndSuper });
	registry.register({ ...grepTool, allowedModes: everyMode });
	registry.register({ ...globTool, allowedModes: everyMode });
	registry.register({ ...lsTool, allowedModes: everyMode });
	registry.register({ ...webFetchTool, allowedModes: everyMode });
	registry.register({ ...writePlanTool, allowedModes: adviseOnly });
	registry.register({ ...writeReviewTool, allowedModes: adviseOnly });
}
