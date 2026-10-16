import { isMcpToolName } from "../../core/tool-names.js";
import {
	canonicalProjectRoot,
	mcpToolActionClass,
	mcpToolOwner,
	readMcpServerCatalog,
	resolveMcpServers,
} from "../gateway/mcp/index.js";
import type { WorkerMcpAttestation, WorkerMcpToolAttestation } from "../safety/worker-permit.js";

/**
 * Worker MCP admission. A recipe names exact `mcp_<id>__<tool>` capabilities;
 * admission resolves each one once, from the dispatch's project root and
 * without launching anything, through the same owner rule and classifier the
 * session gateway uses. The result is attested into the worker permit, and
 * the worker launches only a declaration whose digest still matches it.
 */

export interface WorkerMcpAdmissionInput {
	agentId: string;
	/** The checkout the dispatch belongs to; a task worktree resolves to the checkout it was cut from. */
	projectCwd: string;
	tools: ReadonlyArray<string>;
	/** Override for the user config directory; defaults to clioConfigDir(). */
	configDir?: string;
	/** A read-only worker takes a read class only from the operator, never from a server's readOnlyHint. */
	readOnly?: boolean;
}

/** Null when the tool list names no MCP capability. Throws a refusal naming the server and its remedy. */
export function resolveWorkerMcpAdmission(input: WorkerMcpAdmissionInput): WorkerMcpAttestation | null {
	const names = [...new Set(input.tools.filter((tool) => isMcpToolName(tool)))].sort();
	if (names.length === 0) return null;
	const who = `agent '${input.agentId}'`;
	const resolved = resolveMcpServers({
		cwd: input.projectCwd,
		...(input.configDir !== undefined ? { configDir: input.configDir } : {}),
	});
	const projectRoot = canonicalProjectRoot(input.projectCwd);
	const tools: WorkerMcpToolAttestation[] = [];
	for (const name of names) {
		const owner = mcpToolOwner(resolved.servers, name);
		if (owner === null || owner.tool.length === 0) {
			const problems = [
				...resolved.diagnostics.map((entry) => `${entry.path}: ${entry.message}`),
				...resolved.trustDiagnostics,
			];
			throw new Error(
				`dispatch: admission denied: ${who} names MCP capability ${name}, but no MCP server declared for ${projectRoot} owns it; declare the server in .clio-coder/mcp.yaml or the user mcp.yaml${problems.length > 0 ? `; config diagnostics: ${problems.join("; ")}` : ""}`,
			);
		}
		const { declaration } = owner;
		if (declaration.trust.status !== "trusted") {
			throw new Error(
				`dispatch: admission denied: ${who} names MCP capability ${name}, but MCP server '${declaration.id}' is ${declaration.trust.status} for ${projectRoot} (${declaration.trust.reason}); review its declaration and run \`clio-coder mcp trust ${declaration.id}\``,
			);
		}
		// Admission has no live listing. The recorded catalog carries the hints a
		// live session would see; without one a hint-decided class is unknown.
		const catalog = readMcpServerCatalog({
			projectRoot,
			scope: declaration.scope,
			declarationPath: declaration.path,
			serverId: declaration.id,
			digest: declaration.digest,
			cwd: declaration.cwd,
		});
		const recorded = catalog?.tools.find((tool) => tool.name === owner.tool);
		tools.push({
			serverId: declaration.id,
			digest: declaration.digest,
			tool: owner.tool,
			actionClass: mcpToolActionClass(
				declaration,
				{ name: owner.tool, annotations: recorded?.annotations ?? null },
				input.readOnly === true ? { readOnly: true } : undefined,
			),
		});
	}
	return { projectRoot, tools };
}

/** Why a runtime cannot carry an admitted MCP capability, or null when it can. */
export function workerMcpRuntimeRefusal(
	agentId: string,
	tools: ReadonlyArray<string>,
	runtime: { id: string; kind: string },
): string | null {
	const names = tools.filter((tool) => isMcpToolName(tool));
	if (names.length === 0) return null;
	if (runtime.kind === "http" && runtime.id !== "claude-sdk") return null;
	const loop =
		runtime.id === "claude-sdk"
			? "the Claude SDK runtime runs its own tool loop, which never reaches Clio's MCP gateway"
			: `runtime '${runtime.id}' runs its own tool loop, which never reaches Clio's MCP gateway`;
	return `dispatch: admission denied: agent '${agentId}' names MCP capabilities (${names.join(", ")}), and ${loop}; route the agent to a native target or remove the MCP tools from its recipe`;
}

/** A refusal for an attested class the worker's admitted scope does not take, naming the remedy. */
export function workerMcpScopeRefusal(
	agentId: string,
	attestation: WorkerMcpAttestation | null,
	allowedActions: ReadonlySet<string>,
	scopeLabel: string,
): string | null {
	const readOnly = allowedActions.size === 1 && allowedActions.has("read");
	for (const entry of attestation?.tools ?? []) {
		if (allowedActions.has(entry.actionClass)) continue;
		const hint = readOnly ? ", and a server's own readOnlyHint never counts as read" : "";
		return `dispatch: admission denied: agent '${agentId}' names MCP capability mcp_${entry.serverId}__${entry.tool}, which MCP server '${entry.serverId}' gives action class ${entry.actionClass}; a ${scopeLabel} worker takes only ${[...allowedActions].sort().join(", ")}${hint}. Record the class its tools deserve with \`clio-coder mcp trust ${entry.serverId} --action-class ${readOnly ? "read" : "<class>"}\` for a project server, or actionClass or toolActionClasses in its declaration`;
	}
	return null;
}
