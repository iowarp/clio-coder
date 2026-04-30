import type { SessionContract } from "../domains/session/contract.js";
import { ALL_MODES, type ModeName } from "../domains/modes/index.js";
import { probeWorkspace } from "../domains/session/workspace/index.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
import type { ToolRegistry } from "./registry.js";
import { webFetchTool } from "./web-fetch.js";
import { workspaceContextTool } from "./workspace-context.js";
import { writeTool } from "./write.js";
import { writePlanTool } from "./write-plan.js";
import { writeReviewTool } from "./write-review.js";

export interface ToolBootstrapDeps {
	session?: SessionContract;
}

/**
 * Registers every tool on the supplied registry with its admissible mode set.
 * The mode matrix (domains/modes/matrix.ts) remains authoritative for visibility;
 * `allowedModes` provides defence-in-depth at the per-spec layer so invoke paths
 * never admit a tool outside its intended modes even if the matrix drifts.
 *
 * The `workspace_context` tool registers only when a session contract is
 * supplied; workers (which have no session) skip it.
 */
export function registerAllTools(registry: ToolRegistry, deps: ToolBootstrapDeps = {}): void {
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

	const session = deps.session;
	if (session) {
		registry.register({
			...workspaceContextTool({
				hasSession: () => session.current() !== null,
				getSnapshot: () => session.current()?.workspace ?? null,
				probeWorkspace: () => probeWorkspace(session.current()?.cwd ?? process.cwd()),
				saveSnapshot: (snap) => {
					const meta = session.current();
					if (meta) meta.workspace = snap;
				},
			}),
			allowedModes: everyMode,
		});
	}
}
