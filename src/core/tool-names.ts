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
	WebSearch: "web_search",
	WritePlan: "write_plan",
	WriteReview: "write_review",
} as const;

export type ToolName = (typeof ToolNames)[keyof typeof ToolNames];

export const ALL_TOOL_NAMES: ReadonlyArray<ToolName> = Object.values(ToolNames);
