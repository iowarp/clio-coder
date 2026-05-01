/**
 * Canonical tool names. Everything that dispatches a tool call references these constants
 * so mode matrices, safety classifiers, and audit filters never diverge on spelling.
 */

export const ToolNames = {
	Read: "read",
	Write: "write",
	Edit: "edit",
	Bash: "bash",
	Grep: "grep",
	Glob: "glob",
	Ls: "ls",
	WebFetch: "web_fetch",
	WritePlan: "write_plan",
	WriteReview: "write_review",
	WorkspaceContext: "workspace_context",
	FindSymbol: "find_symbol",
	EntryPoints: "entry_points",
	WhereIs: "where_is",
} as const;

export type ToolName = (typeof ToolNames)[keyof typeof ToolNames];

export const ALL_TOOL_NAMES: ReadonlyArray<ToolName> = Object.values(ToolNames);
