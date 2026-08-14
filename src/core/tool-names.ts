/**
 * Canonical tool names. Everything that dispatches a tool call references these constants
 * so mode matrices, safety classifiers, and audit filters never diverge on spelling.
 *
 * The surface is organized in seven planes; each plane is one policy unit
 * (action class, size posture, details schema, concurrency rule):
 *   OBSERVE      read, grep, find, ls, code_nav, context, credential_present
 *   MUTATE       write, edit
 *   EXECUTE      bash, git, verify
 *   ORCHESTRATE  dispatch, monitor, steer, tasks
 *   RETRIEVE     web_fetch
 *   INTERACT     ask_user
 *   ARTIFACT     artifact
 */

export const ToolNames = {
	// OBSERVE
	Read: "read",
	Grep: "grep",
	Find: "find",
	Ls: "ls",
	CodeNav: "code_nav",
	Context: "context",
	CredentialPresent: "credential_present",
	// MUTATE
	Write: "write",
	Edit: "edit",
	// EXECUTE
	Bash: "bash",
	Git: "git",
	Verify: "verify",
	// ORCHESTRATE
	Dispatch: "dispatch",
	Monitor: "monitor",
	Steer: "steer",
	Tasks: "tasks",
	Ledger: "ledger",
	// RETRIEVE
	WebFetch: "web_fetch",
	// INTERACT
	AskUser: "ask_user",
	// ARTIFACT
	Artifact: "artifact",
	// DESIGN-RESERVED, not implemented: gateway, the MCP/DB proxy. One fixed
	// schema; external capabilities are surfaced through find/describe/call
	// RESULTS, never as per-capability schemas in the prompt prefix. Contract
	// sketch: gateway(op: "find" | "describe" | "call", capability?, args?)
	// -> JSON capability listings / schemas / call results, network action
	// class, sequential. Reserving the name here keeps classifiers and
	// profiles from ever assigning "gateway" to a dynamic tool.
	// Gateway: "gateway",
} as const;

export type BuiltinToolName = (typeof ToolNames)[keyof typeof ToolNames];

declare const dynamicToolNameBrand: unique symbol;
export type DynamicToolName = string & { readonly [dynamicToolNameBrand]: "dynamic-tool-name" };

export type ToolName = BuiltinToolName | DynamicToolName;

export const ALL_TOOL_NAMES: ReadonlyArray<BuiltinToolName> = Object.values(ToolNames);

export function isBuiltinToolName(name: ToolName): name is BuiltinToolName {
	return (ALL_TOOL_NAMES as ReadonlyArray<string>).includes(name);
}
