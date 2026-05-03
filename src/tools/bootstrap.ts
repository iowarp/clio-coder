import { ALL_MODES, type ModeName } from "../domains/modes/index.js";
import type { SessionContract } from "../domains/session/contract.js";
import { probeWorkspace } from "../domains/session/workspace/index.js";
import { bashTool } from "./bash.js";
import { entryPointsTool } from "./codewiki/entry-points.js";
import { findSymbolTool } from "./codewiki/find-symbol.js";
import { whereIsTool } from "./codewiki/where-is.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { assertBuiltinToolPolicy } from "./policy.js";
import { readTool } from "./read.js";
import type { ToolRegistry, ToolSourceInfo, ToolSpec } from "./registry.js";
import { webFetchTool } from "./web-fetch.js";
import { workspaceContextTool } from "./workspace-context.js";
import { writeTool } from "./write.js";
import { writePlanTool } from "./write-plan.js";
import { writeReviewTool } from "./write-review.js";

export interface ToolBootstrapDeps {
	session?: SessionContract;
}

function withSourceInfo<T extends ToolSpec>(spec: T, sourceInfo: ToolSourceInfo): T {
	return { ...spec, sourceInfo };
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

	registry.register({
		...withSourceInfo(readTool, { path: "src/tools/read.ts", scope: "core" }),
		allowedModes: everyMode,
	});
	registry.register({
		...withSourceInfo(writeTool, { path: "src/tools/write.ts", scope: "core" }),
		allowedModes: defaultAndSuper,
	});
	registry.register({
		...withSourceInfo(editTool, { path: "src/tools/edit.ts", scope: "core" }),
		allowedModes: defaultAndSuper,
	});
	registry.register({
		...withSourceInfo(bashTool, { path: "src/tools/bash.ts", scope: "core" }),
		allowedModes: defaultAndSuper,
	});
	registry.register({
		...withSourceInfo(grepTool, { path: "src/tools/grep.ts", scope: "core" }),
		allowedModes: everyMode,
	});
	registry.register({
		...withSourceInfo(globTool, { path: "src/tools/glob.ts", scope: "core" }),
		allowedModes: everyMode,
	});
	registry.register({
		...withSourceInfo(lsTool, { path: "src/tools/ls.ts", scope: "core" }),
		allowedModes: everyMode,
	});
	registry.register({
		...withSourceInfo(webFetchTool, { path: "src/tools/web-fetch.ts", scope: "core" }),
		allowedModes: everyMode,
	});
	registry.register({
		...withSourceInfo(writePlanTool, { path: "src/tools/write-plan.ts", scope: "core" }),
		allowedModes: adviseOnly,
	});
	registry.register({
		...withSourceInfo(writeReviewTool, { path: "src/tools/write-review.ts", scope: "core" }),
		allowedModes: adviseOnly,
	});
	registry.register({
		...withSourceInfo(findSymbolTool, { path: "src/tools/codewiki/find-symbol.ts", scope: "core" }),
		allowedModes: everyMode,
	});
	registry.register({
		...withSourceInfo(entryPointsTool, { path: "src/tools/codewiki/entry-points.ts", scope: "core" }),
		allowedModes: everyMode,
	});
	registry.register({
		...withSourceInfo(whereIsTool, { path: "src/tools/codewiki/where-is.ts", scope: "core" }),
		allowedModes: everyMode,
	});

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
			sourceInfo: { path: "src/tools/workspace-context.ts", scope: "core" },
			allowedModes: everyMode,
		});
	}

	assertBuiltinToolPolicy(registry.listAll(), {
		includeSessionTools: Boolean(session),
	});
}
