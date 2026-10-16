import { isMcpToolName } from "../../core/tool-names.js";

/** `mcp_<id>__*`: the tools of one declared MCP server. */
const SERVER_FAMILY = /^mcp_([a-z0-9][a-z0-9_-]*)__\*$/;

/**
 * The id of the declared MCP server that owns a tool name, or null when none
 * does. The session passes its gateway's own `ownerIdOf`, so a hook and the
 * call it guards read one declaration snapshot: an `mcp.yaml` edited mid-session
 * changes neither.
 */
export type McpToolOwnerLookup = (toolName: string) => string | null;

/**
 * How an extension hook's `tools` entries match a call. An exact entry
 * matches its own name, `mcp_*` every MCP tool, and `mcp_<id>__*` the tools
 * server `<id>` owns. Server ids and tool names may both contain `__`, so
 * ownership is the gateway's answer (`mcpOwner`, the longest declared id
 * prefix) rather than the text: `mcp_a__*` never reaches a tool of server
 * `a__b`. Without a lookup, as in a worker, which launches no MCP server, or
 * when the lookup throws, the owner is unknown and the id prefix decides, so a
 * gate stays in force. Only extension hook registrations, the session's and a
 * worker's proxies for them, match this way; a settings or project hook keeps
 * exact names.
 */
export function extensionHookToolMatcher(
	tools: ReadonlyArray<string>,
	mcpOwner?: McpToolOwnerLookup,
): (toolName: string) => boolean {
	const exact = new Set(tools.filter((entry) => !entry.endsWith("*")));
	const everyMcpTool = tools.includes("mcp_*");
	const servers = new Set(tools.flatMap((entry) => SERVER_FAMILY.exec(entry)?.[1] ?? []));
	const byPrefix = (toolName: string): boolean => [...servers].some((id) => toolName.startsWith(`mcp_${id}__`));
	return (toolName) => {
		if (exact.has(toolName)) return true;
		if (!isMcpToolName(toolName)) return false;
		if (everyMcpTool) return true;
		if (servers.size === 0) return false;
		if (mcpOwner === undefined) return byPrefix(toolName);
		let owner: string | null;
		try {
			owner = mcpOwner(toolName);
		} catch {
			// Without the declarations the owner is unknown; the hook sees the call so a gate stays in force.
			return byPrefix(toolName);
		}
		return owner !== null && servers.has(owner);
	};
}
