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
	Find: "find",
	Glob: "glob",
	Ls: "ls",
	WebFetch: "web_fetch",
	Git: "git",
	RunTask: "run_task",
	ValidateFrontend: "validate_frontend",
	WritePlan: "write_plan",
	WriteReview: "write_review",
	WorkspaceContext: "workspace_context",
	CodeNav: "code_nav",
	DocsSearch: "docs_search",
	Dispatch: "dispatch",
	DispatchBatch: "dispatch_batch",
	AskUser: "ask_user",
	ReadSkill: "read_skill",
	CreateSkill: "create_skill",
} as const;

export type BuiltinToolName = (typeof ToolNames)[keyof typeof ToolNames];

declare const dynamicToolNameBrand: unique symbol;
export type DynamicToolName = string & { readonly [dynamicToolNameBrand]: "dynamic-tool-name" };

export type ToolName = BuiltinToolName | DynamicToolName;

export const ALL_TOOL_NAMES: ReadonlyArray<BuiltinToolName> = Object.values(ToolNames);

export function isBuiltinToolName(name: ToolName): name is BuiltinToolName {
	return (ALL_TOOL_NAMES as ReadonlyArray<string>).includes(name);
}
