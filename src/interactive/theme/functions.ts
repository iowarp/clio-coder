import { isHarnessExtensionToolName, isMcpToolName, ToolNames } from "../../core/tool-names.js";
import type { ToolClass } from "../../tools/presentation.js";
import { type ClioTheme, FUNCTION_ROLES, type HarnessFunction } from "./tokens.js";

/** Function identity comes from the tool seam, never from words in prose or paths. */
export function toolFunction(toolName: string, toolClass?: ToolClass, resourceKind?: string | null): HarnessFunction {
	if (isMcpToolName(toolName)) return "mcp";
	if (isHarnessExtensionToolName(toolName)) return "extension";
	if (resourceKind === "skill") return "skill";
	switch (toolName) {
		case ToolNames.Bash:
		case ToolNames.RunScript:
			return "shell";
		case ToolNames.Context:
		case ToolNames.SelfCompact:
			return "context";
		case ToolNames.Dispatch:
		case ToolNames.Monitor:
		case ToolNames.Steer:
		case ToolNames.Consult:
			return "dispatch";
		case ToolNames.AskUser:
		case ToolNames.Decide:
			return "decision";
		case ToolNames.Artifact:
			return "artifact";
		default:
			return toolClass === "external" ? "extension" : toolClass === "delegate" ? "dispatch" : "builtin";
	}
}

/** A concise machine verb or function label, with its family resolved centrally. */
export function functionText(theme: ClioTheme, kind: HarnessFunction, label: string): string {
	return theme.fg(FUNCTION_ROLES[kind], label);
}
