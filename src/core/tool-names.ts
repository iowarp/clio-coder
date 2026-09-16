/**
 * Canonical tool names. Everything that dispatches a tool call references these constants
 * so mode matrices, safety classifiers, and audit filters never diverge on spelling.
 *
 * The surface is organized in eight planes; each plane is one policy unit
 * (action class, size posture, details schema, concurrency rule):
 *   OBSERVE      evidence, read, grep, find, ls, code_nav, context, credential_present, clio_docs, clio_library, data
 *   MUTATE       write, edit
 *   EXECUTE      bash, git, verify, run_script
 *   ORCHESTRATE  dispatch, monitor, steer, tasks, ledger, panes, limitation, decide
 *   RETRIEVE     web_read, web_fetch
 *   INTERACT     ask_user
 *   ARTIFACT     artifact
 *   GATEWAY      gateway
 *
 * Placement (which names carry an attached schema and which are reached
 * through the gateway) is a separate axis, declared in src/tools/surface.ts.
 */

export const ToolNames = {
	// OBSERVE
	Read: "read",
	Evidence: "evidence",
	Grep: "grep",
	Find: "find",
	Ls: "ls",
	CodeNav: "code_nav",
	Context: "context",
	CredentialPresent: "credential_present",
	ClioDocs: "clio_docs",
	ClioLibrary: "clio_library",
	Data: "data",
	// MUTATE
	Write: "write",
	Edit: "edit",
	// EXECUTE
	Bash: "bash",
	Git: "git",
	Verify: "verify",
	RunScript: "run_script",
	// ORCHESTRATE
	Dispatch: "dispatch",
	Monitor: "monitor",
	Steer: "steer",
	Tasks: "tasks",
	Ledger: "ledger",
	Panes: "panes",
	Limitation: "limitation",
	Decide: "decide",
	// RETRIEVE
	WebRead: "web_read",
	WebFetch: "web_fetch",
	// INTERACT
	AskUser: "ask_user",
	// ARTIFACT
	Artifact: "artifact",
	// GATEWAY: one fixed schema; secondary capabilities are surfaced through
	// find/describe/call RESULTS, never as per-capability schemas in the
	// prompt prefix.
	Gateway: "gateway",
} as const;

export type BuiltinToolName = (typeof ToolNames)[keyof typeof ToolNames];

declare const dynamicToolNameBrand: unique symbol;
export type DynamicToolName = string & { readonly [dynamicToolNameBrand]: "dynamic-tool-name" };

export type ToolName = BuiltinToolName | DynamicToolName;

export const ALL_TOOL_NAMES: ReadonlyArray<BuiltinToolName> = Object.values(ToolNames);

export function isBuiltinToolName(name: ToolName): name is BuiltinToolName {
	return (ALL_TOOL_NAMES as ReadonlyArray<string>).includes(name);
}

/** Reserved command-capability namespace. Syntax conveys execution class, never availability. */
export function isHarnessExtensionToolName(name: string): name is DynamicToolName {
	return name.length <= 64 && /^extension_[a-z0-9][a-z0-9_-]*__[a-z][a-z0-9_]*$/.test(name);
}

/**
 * Reserved MCP capability namespace: `mcp_<serverId>__<tool>`. The server id
 * follows the mcp.yaml id charset; the tool segment keeps the server's own
 * spelling (letters, digits, `_`, `-`, `.`). Syntax conveys origin, never trust
 * or availability: the gateway launches only trusted servers.
 */
export function isMcpToolName(name: string): name is DynamicToolName {
	return name.length <= 96 && /^mcp_[a-z0-9][a-z0-9_-]*__[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}

/** Compose the registry name of one MCP server tool; null when the tool's name cannot be carried. */
export function mcpToolName(serverId: string, tool: string): DynamicToolName | null {
	const composed = `mcp_${serverId}__${tool}`;
	return isMcpToolName(composed) ? composed : null;
}
