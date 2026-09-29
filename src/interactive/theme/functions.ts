import { isHarnessExtensionToolName, isMcpToolName, ToolNames } from "../../core/tool-names.js";
import type { ToolClass } from "../../tools/presentation.js";
import type { ClioTheme, HarnessFunction, SemanticRole } from "./tokens.js";

const TRANSCRIPT_FUNCTION_ROLES = {
	builtin: "transcriptObserveAction",
	shell: "shellAction",
	mutation: "toolAction",
	network: "transcriptKnowledgeAction",
	dispatch: "dispatchAction",
	shadowDispatch: "transcriptHelperAction",
	skill: "transcriptKnowledgeAction",
	mcp: "transcriptExternalAction",
	extension: "transcriptExternalAction",
	context: "transcriptKnowledgeAction",
	decision: "decisionAction",
	artifact: "transcriptExternalAction",
} as const satisfies Record<HarnessFunction, SemanticRole>;

/** Function identity comes from the tool seam, never from words in prose or paths. */
export function toolFunction(toolName: string, toolClass?: ToolClass, resourceKind?: string | null): HarnessFunction {
	if (isMcpToolName(toolName)) return "mcp";
	if (isHarnessExtensionToolName(toolName)) return "extension";
	if (resourceKind === "skill") return "skill";
	switch (toolName) {
		case ToolNames.Bash:
		case ToolNames.RunScript:
			return "shell";
		case ToolNames.Write:
		case ToolNames.Edit:
			return "mutation";
		case ToolNames.WebRead:
		case ToolNames.WebFetch:
			return "network";
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
			if (toolClass === "external") return "extension";
			if (toolClass === "delegate") return "dispatch";
			if (toolClass === "mutate") return "mutation";
			if (toolClass === "network") return "network";
			return "builtin";
	}
}

/** A concise machine verb or function label, with its family resolved centrally. */
export function functionText(theme: ClioTheme, kind: HarnessFunction, label: string): string {
	return theme.fg(TRANSCRIPT_FUNCTION_ROLES[kind], label);
}
