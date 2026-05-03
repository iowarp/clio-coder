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

export type BuiltinToolName = (typeof ToolNames)[keyof typeof ToolNames];

declare const dynamicToolNameBrand: unique symbol;
export type DynamicToolName = string & { readonly [dynamicToolNameBrand]: "dynamic-tool-name" };

export type ToolName = BuiltinToolName | DynamicToolName;

export function dynamicToolName<T extends string>(name: T): T & DynamicToolName {
	return name as T & DynamicToolName;
}

export const ALL_TOOL_NAMES: ReadonlyArray<BuiltinToolName> = Object.values(ToolNames);

export function isBuiltinToolName(name: ToolName): name is BuiltinToolName {
	return (ALL_TOOL_NAMES as ReadonlyArray<string>).includes(name);
}
