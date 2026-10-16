import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isMcpToolName } from "../../core/tool-names.js";
import {
	canonicalProjectRoot,
	mcpServerFileArguments,
	mcpToolActionClass,
	mcpToolOwner,
	type ResolvedMcpServer,
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
			...(declaration.trust.network === true ? { network: true as const } : {}),
		});
	}
	return { projectRoot, tools };
}

/** A granted server this run starts without network, and why. */
export interface WorkerMcpNetworkWithheld {
	serverId: string;
	reason: string;
}

export interface WorkerMcpWriteScope {
	/** Where the run writes: its write boundaries, else its tree root; empty for a read-only run. */
	writeRoots: ReadonlyArray<string>;
	/** The tree the worker starts project servers in: its task worktree, else its cwd. */
	launchRoot: string;
}

function inside(base: string, target: string): boolean {
	const rel = path.relative(base, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The real path of a path that may not exist yet: the deepest existing
 * ancestor is resolved and the rest appended, so a symlinked dispatch cwd and
 * a write root spelled through the link target compare as the same tree.
 */
function realPathOf(target: string): string {
	const resolved = path.resolve(target);
	const rest: string[] = [];
	let head = resolved;
	for (;;) {
		try {
			return path.join(realpathSync(head), ...rest);
		} catch {
			// This component does not exist yet; resolve its parent instead.
		}
		const parent = path.dirname(head);
		if (parent === head) return resolved;
		rest.unshift(path.basename(head));
		head = parent;
	}
}

/** Every file the launch names, as spelled and as resolved, the way config.ts scans a project entry. */
function liveEntryFiles(server: ResolvedMcpServer): string[] {
	return mcpServerFileArguments(server.command, server.args, server.cwd).flatMap((target) => {
		try {
			return statSync(target).isFile() ? [target, realpathSync(target)] : [];
		} catch {
			// A missing or unstatable path is not a file the server runs.
			return [];
		}
	});
}

/** Either path contains the other, comparing each as spelled and as its real path. */
function overlaps(root: string, target: string): boolean {
	const roots = [root.length > 1 ? root.replace(/\/+$/u, "") : root, realPathOf(root)];
	const targets = [target, realPathOf(target)];
	return roots.some((base) => targets.some((dir) => inside(base, dir) || inside(dir, base)));
}

/**
 * A network grant holds only while the worker cannot change what the server
 * runs. Project servers start from the run's own tree (mcp-capabilities.ts
 * launchPlacement), so the launch cwd, each bound entry file's directory and
 * the project root are placed there. A write root that contains or lies
 * inside any of them withholds the grant: a narrow root beside the entry
 * (tools/json.py next to a Python entry) or a module the server imports is
 * code the server can load, and imports are not followed to prove otherwise.
 * A user or plugin server is checked where it is declared, without a
 * project root.
 */
function networkWithheldReason(server: ResolvedMcpServer, scope: WorkerMcpWriteScope): string | null {
	const project = server.scope === "project";
	// The launch root is the dispatch cwd as given, which may be a symlink to the tree the write roots name.
	const launchRoot = realPathOf(scope.launchRoot);
	const place = (file: string): string =>
		project ? path.resolve(launchRoot, path.relative(server.cwdRoot, path.resolve(server.cwdRoot, file))) : file;
	const entries = project
		? (server.entryScripts ?? [])
				.flatMap((entry) => [entry.path, entry.realPath])
				.filter((file): file is string => file !== undefined)
				.map((file) => (path.isAbsolute(file) && !inside(server.cwdRoot, file) ? file : place(file)))
		: liveEntryFiles(server);
	// The most specific place first, so the reason names what the root reaches.
	const places = [
		{ dir: place(server.cwd), label: (dir: string) => `its launch cwd ${dir}` },
		...entries.map((file) => ({ dir: path.dirname(file), label: () => `the directory of its entry script ${file}` })),
		...(project ? [{ dir: place(server.cwdRoot), label: (dir: string) => `its project root ${dir}` }] : []),
	];
	for (const root of scope.writeRoots) {
		const hit = places.find((candidate) => overlaps(root, candidate.dir));
		if (hit !== undefined) return `this run's write root ${root} overlaps ${hit.label(hit.dir)}`;
	}
	return null;
}

/**
 * Drop the network grant of every attested server whose code this run can
 * write, so the worker starts it under its own network policy. A read-only
 * run passes no write roots and keeps every grant.
 */
export function withholdWritableMcpNetwork(
	attestation: WorkerMcpAttestation,
	scope: WorkerMcpWriteScope,
): { attestation: WorkerMcpAttestation; withheld: WorkerMcpNetworkWithheld[] } {
	if (scope.writeRoots.length === 0 || !attestation.tools.some((entry) => entry.network === true)) {
		return { attestation, withheld: [] };
	}
	const { servers } = resolveMcpServers({ cwd: attestation.projectRoot });
	const withheld = new Map<string, string>();
	for (const entry of attestation.tools) {
		if (entry.network !== true || withheld.has(entry.serverId)) continue;
		const server = servers.find((candidate) => candidate.id === entry.serverId);
		// Admission just resolved it; a declaration gone since cannot launch, so withholding is the safe side.
		const reason = server === undefined ? "its declaration no longer resolves" : networkWithheldReason(server, scope);
		if (reason !== null) withheld.set(entry.serverId, reason);
	}
	if (withheld.size === 0) return { attestation, withheld: [] };
	return {
		attestation: {
			projectRoot: attestation.projectRoot,
			tools: attestation.tools.map((entry) => {
				if (!withheld.has(entry.serverId)) return entry;
				const { network: _granted, ...rest } = entry;
				return rest;
			}),
		},
		withheld: [...withheld].map(([serverId, reason]) => ({ serverId, reason })),
	};
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
