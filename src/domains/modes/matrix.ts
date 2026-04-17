import { type ToolName, ToolNames } from "../../core/tool-names.js";
import type { ActionClass } from "../safety/action-classifier.js";

/**
 * Encodes the spec §7 "Three Modes" table. The matrix defines, for each mode,
 * which tool names the registry exposes and which ActionClasses the registry
 * allows at the policy gate. `system_modify` and `git_destructive` never enter
 * a matrix except where explicitly permitted (super may enable system_modify;
 * git_destructive is hard-blocked regardless of mode).
 */

export type ModeName = "default" | "advise" | "super";

export interface ModeProfile {
	tools: ReadonlySet<ToolName>;
	/** ActionClasses allowed at the policy gate. git_destructive is never allowed. */
	allowedActions: ReadonlySet<ActionClass>;
	/** Dispatch-agent scope for this mode. "any" allows full scope; "readonly" restricts. */
	dispatchScope: "any" | "readonly" | "none";
}

export const MODE_MATRIX: Readonly<Record<ModeName, ModeProfile>> = {
	default: {
		tools: new Set<ToolName>([
			ToolNames.Read,
			ToolNames.Write,
			ToolNames.Edit,
			ToolNames.Bash,
			ToolNames.Grep,
			ToolNames.Glob,
			ToolNames.Ls,
			ToolNames.WebFetch,
			ToolNames.WebSearch,
			ToolNames.ChainDispatch,
		]),
		allowedActions: new Set<ActionClass>(["read", "write", "execute", "dispatch"]),
		dispatchScope: "any",
	},
	advise: {
		tools: new Set<ToolName>([
			ToolNames.Read,
			ToolNames.Grep,
			ToolNames.Glob,
			ToolNames.Ls,
			ToolNames.WebFetch,
			ToolNames.WebSearch,
			ToolNames.WritePlan,
			ToolNames.WriteReview,
		]),
		// write_plan/write_review are the only "write" tools in advise, so the
		// action class "write" is allowed ONLY for those two tools. The registry
		// (slice 6) enforces tool-name filtering; the action class is permissive
		// because the only exposed writers are the path-restricted ones.
		allowedActions: new Set<ActionClass>(["read", "write", "dispatch"]),
		dispatchScope: "readonly",
	},
	super: {
		tools: new Set<ToolName>([
			ToolNames.Read,
			ToolNames.Write,
			ToolNames.Edit,
			ToolNames.Bash,
			ToolNames.Grep,
			ToolNames.Glob,
			ToolNames.Ls,
			ToolNames.WebFetch,
			ToolNames.WebSearch,
			ToolNames.ChainDispatch,
		]),
		// git_destructive remains hard-blocked regardless of mode.
		allowedActions: new Set<ActionClass>(["read", "write", "execute", "dispatch", "system_modify"]),
		dispatchScope: "any",
	},
} as const;

export const ALL_MODES: ReadonlyArray<ModeName> = ["default", "advise", "super"];

export function isToolVisible(mode: ModeName, tool: ToolName): boolean {
	return MODE_MATRIX[mode].tools.has(tool);
}

export function isActionAllowed(mode: ModeName, action: ActionClass): boolean {
	return MODE_MATRIX[mode].allowedActions.has(action);
}
