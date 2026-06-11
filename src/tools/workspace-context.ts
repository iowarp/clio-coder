import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { WorkspaceSnapshot } from "../domains/session/workspace/index.js";
import type { ToolSpec } from "./registry.js";

export interface WorkspaceContextDeps {
	getSnapshot(): WorkspaceSnapshot | null;
	probeWorkspace(): WorkspaceSnapshot;
	saveSnapshot(snapshot: WorkspaceSnapshot): void;
	hasSession(): boolean;
}

export function workspaceContextTool(deps: WorkspaceContextDeps): ToolSpec {
	return {
		name: ToolNames.WorkspaceContext,
		description:
			"An explicit, manual workspace snapshot tool: git state, recent commits, remote URL, and project type. Do not assume this tool is run automatically.",
		parameters: Type.Object({}),
		baseActionClass: "read",
		executionMode: "parallel",
		async run() {
			if (!deps.hasSession()) {
				return { kind: "error", message: "no current session; call after session bind" };
			}
			let snap = deps.getSnapshot();
			if (!snap) {
				snap = deps.probeWorkspace();
				deps.saveSnapshot(snap);
			}
			return { kind: "ok", output: JSON.stringify(snap, null, 2) };
		},
	};
}
