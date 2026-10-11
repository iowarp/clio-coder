import type { McpToolDescriptor } from "./client.js";
import type { McpTrustActionClass, ResolvedMcpServer } from "./trust.js";

/** Server hints supply advisory defaults only after launch trust is established. */
export function mcpToolActionClass(
	server: Pick<ResolvedMcpServer, "scope" | "actionClassExplicit" | "trust" | "toolActionClasses">,
	tool: Pick<McpToolDescriptor, "name" | "annotations">,
): McpTrustActionClass {
	const override = Object.hasOwn(server.toolActionClasses, tool.name) ? server.toolActionClasses[tool.name] : undefined;
	if (override !== undefined) return override;
	if (server.trust.status !== "trusted") return "unknown";
	if (server.scope === "project" || server.actionClassExplicit || server.trust.actionClass !== "unknown")
		return server.trust.actionClass;
	if (tool.annotations?.readOnlyHint === true) return "read";
	if (tool.annotations?.destructiveHint === true) return "destructive";
	return "unknown";
}
