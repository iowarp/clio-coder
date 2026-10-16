import type { McpToolDescriptor } from "./client.js";
import type { McpTrustActionClass, ResolvedMcpServer } from "./trust.js";

/**
 * A declaration the classifier can judge. An ACP client's servers live only
 * for the hosted session and carry the `client` scope, which no trust record
 * can reach.
 */
export type McpClassifiedServer = Pick<
	ResolvedMcpServer,
	"id" | "actionClassExplicit" | "trust" | "toolActionClasses"
> & {
	scope: ResolvedMcpServer["scope"] | "client";
};

/**
 * Tool names of the Slurm MCP servers Clio knows by id. Reads are listed so a
 * trusted declaration without per-tool classes can still query its queue; the
 * mutating set asks for confirmation on every surface.
 */
const SLURM_READ_TOOLS = new Set([
	"slurm_list",
	"slurm_describe",
	"slurm_cluster",
	"check_job_status",
	"list_slurm_jobs",
	"get_slurm_info",
	"get_job_details",
	"get_job_output",
	"get_queue_info",
	"get_node_info",
	"get_allocation_status",
]);
const SLURM_CONFIRM_TOOLS = new Set([
	"slurm_submit",
	"slurm_cancel",
	"submit_slurm_job",
	"cancel_slurm_job",
	"submit_array_job",
	"allocate_slurm_nodes",
	"deallocate_slurm_nodes",
]);

/**
 * The one action class of an MCP tool, for discovery, session execution,
 * worker admission and the worker permit ceiling alike. Trust is decided
 * first: an untrusted or stale declaration controls none of its own fields,
 * so its per-tool classes must never reach the policy engine (the old order
 * let an unreviewed project file mark its tools `read`). Server hints supply
 * advisory defaults only after launch trust is established. A caller without
 * live metadata passes the recorded catalog entry or `annotations: null`,
 * which yields `unknown` wherever only a hint could have decided.
 */
export function mcpToolActionClass(
	server: McpClassifiedServer,
	tool: Pick<McpToolDescriptor, "name" | "annotations">,
	options?: {
		/**
		 * A read-only ceiling admits only a read class Clio or the operator set,
		 * through the trust record or toolActionClasses; the server's own
		 * readOnlyHint is a claim about itself and classes the tool unknown.
		 */
		readOnly?: boolean;
	},
): McpTrustActionClass {
	if (server.trust.status !== "trusted") return "unknown";
	if (server.scope === "client") return "unknown";
	const override = Object.hasOwn(server.toolActionClasses, tool.name) ? server.toolActionClasses[tool.name] : undefined;
	if (override !== undefined) return override;
	if (server.id === "slurm") {
		if (SLURM_CONFIRM_TOOLS.has(tool.name)) return "execute";
		if (SLURM_READ_TOOLS.has(tool.name)) return "read";
	}
	if (server.scope === "project" || server.actionClassExplicit || server.trust.actionClass !== "unknown")
		return server.trust.actionClass;
	if (tool.annotations?.readOnlyHint === true) return options?.readOnly === true ? "unknown" : "read";
	if (tool.annotations?.destructiveHint === true) return "destructive";
	return "unknown";
}

/** The confirmation rule a tool's calls carry on every surface, or null. */
export function mcpToolConfirmationRule(server: Pick<McpClassifiedServer, "id">, toolName: string): string | null {
	return server.id === "slurm" && SLURM_CONFIRM_TOOLS.has(toolName) ? "slurm-allocation" : null;
}

/**
 * The declaration that owns a composed `mcp_<id>__<tool>` name. IDs and tool
 * names may both contain `__`, so each name is reserved for the longest
 * declared server prefix, untrusted declarations included, and neither
 * discovery order nor trust can change routing or authority.
 */
export function mcpToolOwner<T extends { id: string }>(
	declarations: Iterable<T>,
	name: string,
): { declaration: T; tool: string } | null {
	let owner: T | null = null;
	for (const declaration of declarations) {
		if (name.startsWith(`mcp_${declaration.id}__`) && (owner === null || declaration.id.length > owner.id.length)) {
			owner = declaration;
		}
	}
	return owner === null ? null : { declaration: owner, tool: name.slice(`mcp_${owner.id}__`.length) };
}
