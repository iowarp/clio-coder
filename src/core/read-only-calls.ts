import { ToolNames } from "./tool-names.js";

export const EXPLORATION_TOOL_NAMES = new Set<string>([
	ToolNames.Read,
	ToolNames.Grep,
	ToolNames.Find,
	ToolNames.Ls,
	ToolNames.CodeNav,
	ToolNames.Context,
	ToolNames.Git,
]);
export const READ_ONLY_SHELL_COMMAND_PATTERN = /^\s*(?:awk|cat|fd|find|git|grep|head|jq|ls|rg|sed|tail|tree|wc)\b/;

export function isReadOnlyCall(toolName: string, args: Readonly<Record<string, unknown>> | undefined): boolean {
	if (EXPLORATION_TOOL_NAMES.has(toolName)) return true;
	return (
		toolName === ToolNames.Bash && typeof args?.command === "string" && READ_ONLY_SHELL_COMMAND_PATTERN.test(args.command)
	);
}
