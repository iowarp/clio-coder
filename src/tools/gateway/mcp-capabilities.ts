import path from "node:path";
import type { TSchema } from "typebox";
import { workerSandboxApplies } from "../../core/sandbox/worker-process.js";
import type { DynamicToolName } from "../../core/tool-names.js";
import { mcpToolName } from "../../core/tool-names.js";
import { mcpToolActionClass, mcpToolConfirmationRule, mcpToolOwner } from "../../domains/gateway/mcp/action-classes.js";
import type {
	McpCatalogIdentity,
	McpClient,
	McpClientOptions,
	McpServerCatalog,
	McpServerSpec,
	McpTeardownOutcome,
	McpToolCallResult,
	McpToolDescriptor,
	McpToolListing,
	McpTrustActionClass,
	ResolvedMcpServer,
} from "../../domains/gateway/mcp/index.js";
import {
	canonicalProjectRoot,
	createMcpStdioClient,
	McpError,
	pluginServerRevocation,
	readMcpServerCatalog,
	resolveMcpServers,
	writeMcpServerCatalog,
} from "../../domains/gateway/mcp/index.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import type { SafetyDecision } from "../../domains/safety/contract.js";
import { mcpServerPolicyRefusal } from "../../domains/safety/denial.js";
import { mcpTransportIdentity } from "../../domains/safety/information-flow.js";
import type { WorkerMcpAttestation } from "../../domains/safety/worker-permit.js";
import type { ImageContent } from "../../engine/types.js";
import type { ToolRegistry, ToolResult, ToolSpec } from "../registry.js";
import { nestedBlockedResult } from "../registry.js";

/** An ACP client's declaration lives only for its hosted session. */
export interface McpClientServerSpec {
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
}

type GatewayMcpServer = ResolvedMcpServer | (Omit<ResolvedMcpServer, "scope"> & { scope: "client" });

/** Model-visible bytes of one MCP result before the rest is offloaded. */
const MCP_RESULT_CONTEXT_BYTES = 16 * 1024;

function actionClassFor(declaration: GatewayMcpServer, tool: NamedTool): McpTrustActionClass {
	return mcpToolActionClass(declaration, { name: tool.name, annotations: tool.annotations ?? null });
}

/**
 * Local stdio MCP servers as gateway capabilities. The source reads the
 * declared servers once per session, launches a server only when it is
 * trusted and only when the first find, describe, or call needs it, registers
 * each of its tools in the registry as `mcp_<id>__<tool>` (placement gateway,
 * action class from operator policy or advisory hints), and closes every client it opened at
 * session end. In the orchestrator launching a server does not sandbox it, and
 * the trust record is the operator's explicit acceptance of that; a worker's
 * servers start under the worker's OS sandbox when one applies.
 */

/** What confines a launched server, as discovery tells the model. */
function launchConfinement(): string {
	return workerSandboxApplies() ? "it runs under this worker's OS sandbox" : "launching it does not sandbox it";
}

/**
 * Where a server's tool metadata came from. Deliberately separate from
 * `status`: a catalog read off disk says nothing about whether a process is
 * running, and conflating the two would let an offline answer look like a live
 * connection.
 */
export type McpCatalogProvenance = "live" | "cached" | "missing";

/** What the gateway's find listing says about one declared server. */
export interface McpServerListing {
	id: string;
	scope: GatewayMcpServer["scope"];
	/** connected: launched this session; failed: launched and lost; trusted: not launched yet. */
	status: "connected" | "trusted" | "failed" | "untrusted" | "stale";
	actionClass: McpTrustActionClass;
	/** Why the server is not usable, for every status but connected and trusted. */
	reason?: string;
	/** The exact command that makes an untrusted or stale server usable. */
	remedy?: string;
	/** The same remedy for an interactive session. */
	interactiveRemedy?: string;
	/** Registered tool names, for a connected server. */
	tools?: string[];
	/** The server's tool list was cut at the client cap. */
	truncated?: boolean;
	/** Tool names the server offered that cannot be carried as registry names. */
	unregistrable?: string[];
	/** Provenance of this server's tool metadata, for a trusted server only. */
	catalog?: McpCatalogProvenance;
	/** Tools this server's catalog records; the names themselves are in the capability list. */
	catalogCount?: number;
	/** The command that lists this server's tools when its catalog is missing. */
	catalogRemedy?: string;
}

export interface McpListing {
	servers: McpServerListing[];
	/** Config and trust-file problems, verbatim. */
	diagnostics: string[];
}

/** One MCP capability as discovery lists it, from a live listing or a cached catalog. */
export interface McpCatalogEntry {
	name: DynamicToolName;
	description: string;
	actionClass: McpTrustActionClass;
}

export interface McpDiscoveryNote {
	serverHint?: "read-only" | "destructive";
	/** Set once the server refused this capability under its own policy this session. */
	unavailable?: string;
}

export interface McpCatalog extends McpListing {
	entries: McpCatalogEntry[];
	/** Trusted servers with no usable catalog, so discovery can name what it could not answer. */
	missing: string[];
}

/** One MCP capability's full metadata, enough to describe it without a connection. */
export interface McpCapabilityMetadata {
	name: string;
	/** The declared server that owns the name, by the longest-prefix rule. */
	serverId: string;
	description: string;
	parameters: Record<string, unknown>;
	actionClass: McpTrustActionClass;
	provenance: "live" | "cached";
	/** The catalog this came from recorded only part of the server's tools. */
	truncated: boolean;
}

export interface McpMetadataResult {
	metadata: McpCapabilityMetadata | null;
	/** Why the metadata is unavailable when `metadata` is null. */
	reason?: string;
}

export interface McpRefreshResult {
	/** The server's listing after the attempt, or null when no such server is declared. */
	listing: McpServerListing | null;
	/** Why the refresh listed nothing new. */
	reason?: string;
}

export interface McpLaunchOptions {
	signal?: AbortSignal;
	/**
	 * The calling turn is read-only. Starting a server runs its code before any
	 * call reaches admission, so a server trusted above read is never started (Z1).
	 */
	readOnly?: boolean;
}

/**
 * Why a read-only turn may not start `declaration`'s server, or null when it
 * may. A call to a tool the operator classes read, through toolActionClasses,
 * may start it too: admission would admit that call by the same rule
 * (f1cae16c5), and the server's own readOnlyHint is unknown before launch.
 */
function readOnlyLaunchRefusal(
	declaration: GatewayMcpServer,
	readOnly: boolean | undefined,
	toolName?: string,
): string | null {
	if (readOnly !== true || declaration.trust.actionClass === "read") return null;
	if (
		toolName !== undefined &&
		mcpToolActionClass(declaration, { name: toolName, annotations: null }, { readOnly: true }) === "read"
	) {
		return null;
	}
	return `mcp server ${declaration.id} is trusted as ${declaration.trust.actionClass}, and a read-only turn starts only servers trusted as read or for a tool the operator classes read`;
}

export interface McpEnsureResult {
	spec: ToolSpec | null;
	/** Why the capability is unavailable when `spec` is null. */
	reason?: string;
}

export interface McpCapabilitySourceOptions {
	/** Project root the config is resolved against and the launched servers are contained in. */
	cwd: string;
	/** Override of the Clio config directory that holds the user config and the trust file. */
	configDir?: string;
	registry: ToolRegistry;
	/** Request timeout applied when a declaration names none. */
	requestTimeoutMs?: number;
	/** Test seam: the client constructor. */
	clientFactory?: (spec: McpServerSpec, options: McpClientOptions) => McpClient;
	/** False for a worker: it may read recorded catalogs but never writes operator-owned state. */
	persistCatalog?: boolean;
	/**
	 * A worker's admitted MCP surface. Only the attested declarations are
	 * launchable, each only while its digest still matches, and each tool runs
	 * under the class admission sealed into the permit.
	 */
	admitted?: WorkerMcpAttestation;
	/**
	 * The worker's own tree, where its project servers start. A project
	 * declaration's cwd keeps its place relative to the repository but lands
	 * here, inside the sandbox's write roots, instead of in the checkout that
	 * admission read the declaration from.
	 */
	launchRoot?: string;
}

export interface McpCapabilitySource {
	/** Connect client supplied stdio servers without persisting their declarations or catalogs. */
	attachClientServers(servers: ReadonlyArray<McpClientServerSpec>): Promise<void>;
	/** Tear down only the servers supplied by the ACP client for this session. */
	detachClientServers(): Promise<void>;
	/** Launch every trusted server not yet launched, register its tools, and describe every declared server. */
	list(options?: { signal?: AbortSignal }): Promise<McpListing>;
	/**
	 * Every declared server and the capabilities its metadata records, without
	 * constructing a client. A trusted server that has neither been launched this
	 * session nor left a valid catalog is reported as missing, not launched.
	 */
	catalog(): McpCatalog;
	/** One capability's metadata from the registry or the catalog, again without constructing a client. */
	metadata(name: string): McpMetadataResult;
	/**
	 * Launch one declared trusted server, register its tools, and publish its
	 * catalog. With `readOnly`, only a server trusted as read is launched.
	 */
	refresh(id: string, options?: McpLaunchOptions): Promise<McpRefreshResult>;
	/** Ids of every declared server, trusted or not, for validating a scoped discovery request. */
	declaredIds(): string[];
	/**
	 * Make `name`'s server available (launching it when trusted) and return its
	 * registered spec. With `readOnly`, only a server trusted as read is launched.
	 */
	ensure(name: string, options?: McpLaunchOptions): Promise<McpEnsureResult>;
	/** One sentence of provenance and authority for describe, or null for a name this source does not own. */
	authorityNote(name: string): string | null;
	/**
	 * The declared server that owns `name` under the longest-prefix rule, or
	 * null when no declaration owns it. Callers that scope results to one server
	 * must ask rather than testing the `mcp_<id>__` prefix themselves: server ids
	 * may contain `__`, so with declarations `a` and `a__b` the prefix test
	 * claims `a__b`'s capabilities for `a`.
	 */
	ownerIdOf(name: string): string | null;
	/**
	 * What discovery can add to a capability's enforced action class: the
	 * server's own read-only or destructive annotation, and a refusal under the
	 * server's policy recorded this session. Null for a name this source does not own.
	 */
	discoveryNote(name: string): McpDiscoveryNote | null;
	/** The pinned launch identity of the declared server owning `name`, for information-flow recipients; null when unowned. */
	transportOf(name: string): string | null;
	/** Ids of the servers launched this session and still open. */
	connectedIds(options?: { readyOnly?: boolean }): string[];
	/**
	 * Close every launched client. Idempotent. A process group that survived
	 * the client's own SIGKILL is reported here and on stderr, with its pgid,
	 * and is never signalled again by the gateway: the client already did
	 * everything it may do, and a second signal from this side could hit a
	 * recycled pid.
	 */
	close(): Promise<McpCloseReport>;
	/** Every teardown outcome recorded so far, for evidence. */
	teardownReports(): ReadonlyArray<McpTeardownReport>;
}

export interface McpTeardownReport {
	id: string;
	outcome: McpTeardownOutcome;
}

export interface McpCloseReport {
	/** Servers whose process group outlived the teardown, with the pgid the client observed. */
	incomplete: Array<{ id: string; pgid: number; boundMs: number }>;
}

interface OwnedConnection {
	ready: Promise<void>;
	close(): Promise<McpTeardownOutcome>;
}

interface ServerState {
	recovery?: Promise<void>;
	declaration: GatewayMcpServer;
	client: McpClient | null;
	connection: OwnedConnection | null;
	tools: McpToolDescriptor[];
	truncated: boolean;
	registered: DynamicToolName[];
	unregistrable: string[];
	failure: string | null;
	/**
	 * The catalog read for this declaration, or null for a miss. Undefined until
	 * looked up. Memoized for the same reason the declarations themselves are
	 * snapshotted: one session answers discovery from one consistent view, and a
	 * find is not the place to re-stat every cache file.
	 */
	catalog: McpServerCatalog | null | undefined;
	/**
	 * Tools this session's server refused under its own policy, by tool name,
	 * with the server's code. Discovery reports them as unavailable; a recovered
	 * or relaunched server starts with a clean slate.
	 */
	refused: Map<string, string>;
}

/** The one call that fills a missing catalog, named so the model does not guess at a broader one. */
function catalogRemedy(id: string): string {
	return `gateway(op="find", server="${id}", refresh=true)`;
}

interface NamedTool {
	name: string;
	description: string;
	annotations?: Record<string, unknown> | null;
}

function objectiveOf(tool: NamedTool): string {
	return tool.description.trim().length > 0 ? tool.description.trim() : `MCP tool ${tool.name}`;
}

/**
 * The description a registered spec and a cached descriptor both carry, so
 * discovery reads identically whether the metadata came off a live listing or
 * off disk and a caller can never tell the two apart by shape alone.
 */
function describeTool(declaration: GatewayMcpServer, tool: NamedTool): string {
	if (declaration.scope === "client") {
		return `${objectiveOf(tool)}\nLocal MCP server ${declaration.id}, supplied by the ACP client for this session. Its calls use the gateway's unknown action class and session autonomy.`;
	}
	return `${objectiveOf(tool)}\nLocal MCP server ${declaration.id} (${declaration.scope} scope), trusted with action class ${actionClassFor(declaration, tool)}; ${launchConfinement()}.`;
}

/** The server's own read-only or destructive annotation, which Clio reports but never enforces. */
function serverHintOf(tool: Partial<Pick<McpToolDescriptor, "annotations">>): "read-only" | "destructive" | undefined {
	if (tool.annotations?.readOnlyHint === true) return "read-only";
	if (tool.annotations?.destructiveHint === true) return "destructive";
	return undefined;
}

/**
 * A call the server refused under its own policy, settled as a refusal rather
 * than a tool error: the server answered with a structured non-retryable
 * denial, so the identical call cannot succeed, and no Clio trust record or
 * approval reaches the server's policy. The registry refuses an identical
 * repeat in the same turn without calling the server again.
 */
function serverPolicyRefusalResult(
	state: ServerState,
	tool: McpToolDescriptor,
	name: string,
	trustClass: McpTrustActionClass,
	result: McpToolCallResult,
): ToolResult | null {
	const refusal = mcpServerPolicyRefusal(result.structuredContent ?? jsonObjectText(result.text));
	if (refusal === null) return null;
	const { id } = state.declaration;
	state.refused.set(tool.name, refusal.code);
	const reason = `${name} refused by MCP server ${id}: ${refusal.message}`;
	const decision: SafetyDecision = {
		kind: "block",
		classification: { actionClass: trustClass, reasons: [refusal.message] },
		rejection: {
			short: reason,
			detail: `The server's own policy refused ${tool.name} (${refusal.code}). Clio admitted the call; approving it again in Clio does not change the server's answer.`,
			hints: ["Report the refusal and what would allow it; do not substitute another tool or target for the refused one."],
		},
	};
	const hint = serverHintOf(tool);
	return nestedBlockedResult({
		kind: "blocked",
		reason,
		decision,
		denial: {
			layer: "mcp_server_policy",
			actionClass: trustClass,
			retryable: false,
			allowedBy: `the MCP server ${id} must be configured to permit ${tool.name}${refusal.profile !== undefined ? `; its ${refusal.profile} profile excludes it` : ""}.`,
			code: refusal.code,
			server: id,
			...(hint !== undefined ? { serverHint: hint } : {}),
		},
	});
}

/** A text block that is one JSON object, for a server that reports structure only as text. */
function jsonObjectText(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || trimmed.length > 16_384) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		// Prose that merely starts with a brace is not a structured refusal.
		return undefined;
	}
}

/** Remedies name the CLI first: it exists in every session, interactive or not. */
export function mcpTrustRemedy(id: string): { remedy: string; interactiveRemedy: string } {
	return { remedy: `clio-coder mcp trust ${id}`, interactiveRemedy: `/mcp trust ${id}` };
}

/** Serialize an argv vector for the shell classifier only. No shell executes this text. */
function quoted(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function errorMessage(error: unknown): string {
	if (error instanceof McpError) return `${error.message} (${error.code})`;
	return error instanceof Error ? error.message : String(error);
}

function imageBlocks(result: McpToolCallResult): ImageContent[] {
	const images: ImageContent[] = [];
	for (const block of result.content) {
		if (block.type !== "image") continue;
		const { data, mimeType } = block as { data?: unknown; mimeType?: unknown };
		if (typeof data === "string" && typeof mimeType === "string" && mimeType.startsWith("image/")) {
			images.push({ type: "image", data, mimeType });
		}
	}
	return images;
}

export function createMcpCapabilitySource(options: McpCapabilitySourceOptions): McpCapabilitySource {
	const registry = options.registry;
	const clientFactory = options.clientFactory ?? createMcpStdioClient;
	let states: Map<string, ServerState> | null = null;
	let diagnostics: string[] = [];
	let exitHookInstalled = false;
	let closed = false;
	let closePromise: Promise<McpCloseReport> | null = null;
	const teardowns: McpTeardownReport[] = [];

	// A detached child can outlive a parent that never reaches close(). Only
	// the client knows whether its group is still owned during pending cleanup.
	const killLaunchedOnExit = (): void => {
		for (const state of states?.values() ?? []) state.client?.killOwnedOnExit();
	};
	const installExitHook = (): void => {
		if (exitHookInstalled) return;
		exitHookInstalled = true;
		process.once("exit", killLaunchedOnExit);
	};

	const closeClient = (state: ServerState): Promise<McpTeardownOutcome> | undefined => state.connection?.close();

	const launchPlacement = (declaration: GatewayMcpServer): { cwd: string; workspaceRoot: string } => {
		if (options.launchRoot === undefined || declaration.scope !== "project") {
			return { cwd: declaration.cwd, workspaceRoot: declaration.cwdRoot };
		}
		const relative = path.relative(declaration.cwdRoot, declaration.cwd);
		return { cwd: path.join(options.launchRoot, relative), workspaceRoot: options.launchRoot };
	};

	/**
	 * A worker keeps every declaration so the owner rule routes exactly as
	 * admission did, but only an attested one at its attested digest can
	 * launch. The others read as untrusted for this run and are never started.
	 */
	const admittedDeclaration = (declaration: ResolvedMcpServer): ResolvedMcpServer => {
		const admitted = options.admitted;
		if (admitted === undefined || declaration.trust.status !== "trusted") return declaration;
		const attested = admitted.tools.find((entry) => entry.serverId === declaration.id);
		if (attested === undefined) {
			return {
				...declaration,
				trust: {
					status: "untrusted",
					actionClass: "unknown",
					reason: `MCP server '${declaration.id}' was not admitted for this run`,
				},
			};
		}
		if (attested.digest !== declaration.digest) {
			return {
				...declaration,
				trust: {
					status: "stale",
					actionClass: "unknown",
					reason: `declaration of '${declaration.id}' changed since this run was admitted; review it, run clio-coder mcp trust ${declaration.id}, and dispatch again`,
				},
			};
		}
		return declaration;
	};

	const resolveStates = (): Map<string, ServerState> => {
		if (states !== null) return states;
		const resolved = resolveMcpServers({
			cwd: options.cwd,
			...(options.configDir ? { configDir: options.configDir } : {}),
		});
		diagnostics = [
			...resolved.diagnostics.map((entry) => `${entry.scope} ${entry.path}: ${entry.message}`),
			...resolved.trustDiagnostics,
		];
		states = new Map(
			resolved.servers.map((declaration) => [
				declaration.id,
				{
					declaration: admittedDeclaration(declaration),
					client: null,
					connection: null,
					tools: [],
					truncated: false,
					registered: [],
					unregistrable: [],
					refused: new Map(),
					failure: null,
					catalog: undefined,
				},
			]),
		);
		return states;
	};

	// realpathSync touches disk, and every catalog identity in this session must
	// resolve to the same project the trust record bound to.
	let projectRoot: string | null = null;
	const catalogIdentity = (declaration: GatewayMcpServer): McpCatalogIdentity => {
		projectRoot ??= canonicalProjectRoot(options.cwd);
		return {
			projectRoot,
			scope: declaration.scope === "client" ? "user" : declaration.scope,
			declarationPath: declaration.path,
			serverId: declaration.id,
			digest: declaration.digest,
			cwd: declaration.cwd,
		};
	};

	/**
	 * The recorded catalog for a trusted declaration, read once per session for
	 * the same reason the declarations themselves are snapshotted: one session
	 * answers discovery from one consistent view. An untrusted or stale
	 * declaration never reads one, because a catalog is not an authority record
	 * and listing its tools would suggest they are reachable.
	 */
	const cachedCatalog = (state: ServerState): McpServerCatalog | null => {
		if (state.declaration.scope === "client") return null;
		if (state.catalog !== undefined) return state.catalog;
		state.catalog =
			state.declaration.trust.status === "trusted" ? readMcpServerCatalog(catalogIdentity(state.declaration)) : null;
		return state.catalog;
	};

	/**
	 * Record a live listing so a later session answers find and describe without
	 * launching this server. Best effort by design: a cache that cannot be
	 * written must never fail the connection that produced it.
	 */
	const publishCatalog = (state: ServerState, listing: McpToolListing): void => {
		if (state.declaration.scope === "client" || options.persistCatalog === false) return;
		writeMcpServerCatalog(catalogIdentity(state.declaration), listing);
		// Drop the memo of whatever the file said before this listing replaced it.
		state.catalog = undefined;
	};

	const makeSpec = (state: ServerState, tool: McpToolDescriptor, name: DynamicToolName): ToolSpec => {
		const { declaration } = state;
		const liveClass = actionClassFor(declaration, tool);
		// A worker runs each tool under the class its permit sealed. A server
		// whose live metadata now classes the tool differently is refused below
		// rather than judged again here, where no ceiling can see it.
		const attested = options.admitted?.tools.find(
			(entry) => entry.serverId === declaration.id && entry.tool === tool.name,
		);
		const trustClass = attested?.actionClass ?? liveClass;
		const classDrift =
			attested !== undefined && attested.actionClass !== liveClass
				? `${name}: mcp server ${declaration.id} now gives this tool class ${liveClass}, but this run was admitted with ${attested.actionClass}; dispatch again so admission judges the new class`
				: null;
		// A worker's sealed class stays its class under read-only too; the
		// permit already judged it against the run's ceiling.
		const readOnlyClass =
			attested?.actionClass ??
			mcpToolActionClass(declaration, { name: tool.name, annotations: tool.annotations ?? null }, { readOnly: true });
		const confirmationRuleId = mcpToolConfirmationRule(declaration, tool.name);
		const timeoutMs = declaration.timeoutMs ?? options.requestTimeoutMs;
		const spec: ToolSpec = {
			name,
			description: describeTool(declaration, tool),
			parameters: tool.inputSchema as TSchema,
			baseActionClass: trustClass,
			...(readOnlyClass !== trustClass ? { readOnlyActionClass: readOnlyClass } : {}),
			...(confirmationRuleId !== null ? { confirmationRuleId } : {}),
			executionMode: "sequential",
			placement: "gateway",
			sourceInfo: { path: declaration.path, scope: "domain" },
			metadata: {
				objective: objectiveOf(tool),
				uiLabel: `${declaration.id}/${tool.name}`,
				retrySafety: "unknown",
				repeatableRead:
					trustClass === "read" && tool.annotations?.readOnlyHint === true && tool.annotations?.idempotentHint === true,
				// The session cap alone (64 KiB) let one search result spend a sixth
				// of a 131k window. Bound MCP output like the built-in observation
				// tools; the full text is offloaded and stays readable by path.
				resultSizePolicy: {
					kind: "bounded",
					maxBytes: MCP_RESULT_CONTEXT_BYTES,
					followUpHint:
						"Call again with a narrower query or the server's own limit/page arguments, or read the offloaded file in windows.",
				},
				costLatency: "local_slow",
			},
			async run(args, invokeOptions): Promise<ToolResult> {
				if (classDrift !== null) return { kind: "error", message: classDrift };
				await discover(state, invokeOptions?.signal);
				const client = state.client;
				if (client === null || client.state().status !== "ready") {
					return {
						kind: "error",
						message: `${name}: mcp server ${declaration.id} is not connected${state.failure ? ` (${state.failure})` : ""}; the next call can retry the trusted declaration`,
					};
				}
				try {
					const result = await client.callTool(tool.name, args, {
						...(invokeOptions?.signal ? { signal: invokeOptions.signal } : {}),
						...(timeoutMs !== undefined ? { timeoutMs } : {}),
					});
					const details: Record<string, unknown> = {
						server: declaration.id,
						tool: tool.name,
						contentTypes: result.content.map((block) => block.type),
						textTruncated: result.textTruncated,
						...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
						...(result.structuredContentJson !== undefined ? { structuredContentJson: result.structuredContentJson } : {}),
					};
					if (result.isError) {
						const refusal = serverPolicyRefusalResult(state, tool, name, trustClass, result);
						if (refusal !== null) return refusal;
						return { kind: "error", message: `${name}: ${result.text || "tool error"}`, details };
					}
					const images = imageBlocks(result);
					return { kind: "ok", output: result.text, details, ...(images.length > 0 ? { images } : {}) };
				} catch (error) {
					if (client.state().status === "failed" || client.state().status === "closed") {
						state.failure = errorMessage(error);
						await closeClient(state);
					}
					// A JSON-RPC error answer (invalid params, unknown tool) came from the
					// server, so it carries the server id like any other answer; only a
					// request that got no answer goes without it.
					if (error instanceof McpError && error.code === "server")
						return {
							kind: "error",
							message: `${name}: ${errorMessage(error)}`,
							details: { server: declaration.id, tool: tool.name },
						};
					return { kind: "error", message: `${name}: ${errorMessage(error)}` };
				}
			},
		};
		// The execute trust class projects the launch vector to a bash command
		// so the policy engine applies the shell rules to it, as an extension
		// command does; read runs everywhere and unknown asks everywhere.
		if (trustClass === "execute") {
			spec.safetyCall = (): ClassifierCall => ({
				tool: "bash",
				args: { command: [declaration.command, ...declaration.args].map(quoted).join(" ") },
			});
		}
		return spec;
	};

	const startConnection = (state: ServerState): OwnedConnection => {
		const controller = new AbortController();
		const { declaration } = state;
		const placement = launchPlacement(declaration);
		// PERF W3: reserve ownership before the lazy import, so close can fence acquisition.
		const loaded = (async () => {
			const { createMcpConnection } = await import("../../domains/gateway/mcp/connection-lifecycle.js");
			return createMcpConnection({
				signal: controller.signal,
				acquire: () =>
					clientFactory(
						{
							id: declaration.id,
							command: declaration.command,
							args: declaration.args,
							cwd: placement.cwd,
							env: declaration.env,
						},
						{
							workspaceRoot: placement.workspaceRoot,
							onFailure: (error) => {
								state.failure ??= errorMessage(error);
								void closeClient(state);
							},
							...(declaration.timeoutMs !== null
								? { requestTimeoutMs: declaration.timeoutMs }
								: options.requestTimeoutMs !== undefined
									? { requestTimeoutMs: options.requestTimeoutMs }
									: {}),
						},
					),
				onAcquired: (client) => {
					state.client = client;
					installExitHook();
				},
			});
		})();
		let closing: Promise<McpTeardownOutcome> | null = null;
		const close = (): Promise<McpTeardownOutcome> => {
			controller.abort();
			closing ??= loaded
				.then((connection) => connection.close())
				.then((outcome) => {
					teardowns.push({ id: declaration.id, outcome });
					state.client = null;
					if (!outcome.complete) {
						process.stderr.write(
							`[gateway] mcp server ${declaration.id}: process group ${outcome.pgid} survived SIGKILL for ${outcome.boundMs}ms; recorded, not signalled again\n`,
						);
					}
					return outcome;
				});
			return closing;
		};
		const ready = (async () => {
			try {
				const connection = await loaded;
				const { client, listing } = await connection.ready;
				if (closed || controller.signal.aborted || state.client !== client || state.failure !== null) return;
				state.tools = listing.tools;
				state.truncated = listing.truncated;
				publishCatalog(state, listing);
				for (const tool of listing.tools) {
					const name = mcpToolName(declaration.id, tool.name);
					if (name === null || ownerOf(name) !== state || registry.get(name) !== undefined) {
						state.unregistrable.push(tool.name);
						continue;
					}
					if (closed || controller.signal.aborted || state.client !== client || state.failure !== null) return;
					registry.register(makeSpec(state, tool, name));
					state.registered.push(name);
				}
			} catch (error) {
				state.failure ??= errorMessage(error);
				await close();
			}
		})();
		return { ready, close };
	};

	const discover = async (state: ServerState, signal?: AbortSignal): Promise<void> => {
		const aborted = () => new McpError("aborted", "MCP discovery aborted");
		if (signal?.aborted) throw aborted();
		if (closed || state.declaration.trust.status !== "trusted") return;
		// Declarations are a session snapshot, but a plugin's servers serve only
		// while the plugin still loads the content they were declared from.
		const plugin = state.declaration.plugin;
		const revoked = plugin !== undefined ? pluginServerRevocation(plugin, options.cwd) : null;
		if (revoked !== null || state.failure !== null || state.recovery !== undefined) {
			// Concurrent callers share recovery; never overlap process groups or
			// replay the failed call. Discovery revalidates the live tool list.
			state.recovery ??= (async () => {
				await closeClient(state);
				state.connection = null;
				state.client = null;
				state.failure = null;
				for (const name of state.registered) registry.unregister?.(name);
				state.registered = [];
				state.unregistrable = [];
				state.refused.clear();
			})();
			await state.recovery;
			delete state.recovery;
			if (revoked !== null) {
				state.failure = revoked;
				return;
			}
			if (closed || signal?.aborted) return;
		}
		state.connection ??= startConnection(state);
		const connection = state.connection;
		const onAbort = (): void => {
			state.failure = errorMessage(aborted());
			void connection.close();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await connection.ready;
			if (signal?.aborted) {
				await connection.close();
				throw aborted();
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	};

	const listingFor = (state: ServerState): McpServerListing => {
		const { declaration } = state;
		const base = { id: declaration.id, scope: declaration.scope, actionClass: declaration.trust.actionClass };
		if (declaration.trust.status !== "trusted") {
			return {
				...base,
				status: declaration.trust.status,
				reason: declaration.trust.reason,
				...mcpTrustRemedy(declaration.id),
			};
		}
		if (state.failure !== null) {
			return { ...base, status: "failed", reason: state.failure };
		}
		if (state.client !== null) {
			return {
				...base,
				status: "connected",
				catalog: "live",
				catalogCount: state.registered.length,
				tools: [...state.registered],
				...(state.truncated ? { truncated: true } : {}),
				...(state.unregistrable.length > 0 ? { unregistrable: [...state.unregistrable] } : {}),
			};
		}
		// A trusted server that was never launched is still only trusted. Its
		// catalog provenance is a separate field precisely so a cache hit can
		// never read as a running process.
		const catalog = cachedCatalog(state);
		if (catalog === null) {
			return { ...base, status: "trusted", catalog: "missing", catalogRemedy: catalogRemedy(declaration.id) };
		}
		return {
			...base,
			status: "trusted",
			catalog: "cached",
			catalogCount: catalog.tools.length,
			...(catalog.truncated ? { truncated: true } : {}),
		};
	};

	// The owner rule is shared with worker admission, so a dispatch and the
	// session it runs in can never route one name to two servers.
	const ownerOf = (name: string): ServerState | null => {
		const all = resolveStates();
		const owner = mcpToolOwner(
			[...all.values()].map((state) => state.declaration),
			name,
		);
		return owner === null ? null : (all.get(owner.declaration.id) ?? null);
	};

	/**
	 * Every capability a server's metadata records, live or cached. A cached
	 * name goes through the same ownership rule a live one does, so a tool whose
	 * composed name belongs to a longer-named server is dropped here exactly as
	 * discovery drops it, and cache load order can never decide routing.
	 */
	const entriesFor = (state: ServerState): McpCatalogEntry[] => {
		const { declaration } = state;
		if (declaration.trust.status !== "trusted" || state.failure !== null) return [];
		if (state.client !== null) {
			return state.registered.flatMap((name) => {
				const spec = registry.get(name);
				return spec === undefined
					? []
					: [{ name, description: spec.description, actionClass: spec.baseActionClass as McpTrustActionClass }];
			});
		}
		const catalog = cachedCatalog(state);
		if (catalog === null) return [];
		const entries: McpCatalogEntry[] = [];
		for (const tool of catalog.tools) {
			const name = mcpToolName(declaration.id, tool.name);
			// A name the registry already holds is served by that live spec instead;
			// a cached descriptor must never shadow a connected one.
			if (name === null || ownerOf(name) !== state || registry.get(name) !== undefined) continue;
			entries.push({
				name,
				description: describeTool(declaration, tool),
				actionClass: actionClassFor(declaration, tool),
			});
		}
		return entries;
	};

	return {
		async attachClientServers(servers) {
			if (closed) throw new Error("MCP capability source is closed");
			if (servers.length > 0 && !registry.unregister) {
				throw new Error("MCP registry cannot remove session scoped tools");
			}
			const all = resolveStates();
			const added: ServerState[] = [];
			for (const server of servers) {
				const slug = server.name
					.toLowerCase()
					.replace(/[^a-z0-9_-]+/g, "_")
					.replace(/^_+|_+$/g, "")
					.slice(0, 24);
				const base = `acp_${slug || "server"}`;
				let id = base;
				for (let suffix = 2; all.has(id); suffix += 1) id = `${base.slice(0, 28)}_${suffix}`;
				const declaration: GatewayMcpServer = {
					id,
					scope: "client",
					path: "ACP client session",
					command: server.command,
					args: [...server.args],
					cwd: options.cwd,
					cwdRoot: options.cwd,
					env: { ...server.env },
					timeoutMs: null,
					actionClass: "unknown",
					toolActionClasses: {},
					digest: "session-only",
					trust: { status: "trusted", actionClass: "unknown" },
				};
				const state: ServerState = {
					declaration,
					client: null,
					connection: null,
					tools: [],
					truncated: false,
					registered: [],
					unregistrable: [],
					refused: new Map(),
					failure: null,
					catalog: null,
				};
				all.set(id, state);
				added.push(state);
			}
			await Promise.all(added.map((state) => discover(state)));
		},
		async detachClientServers() {
			if (states === null) return;
			const all = states;
			const clients = [...all.values()].filter((state) => state.declaration.scope === "client");
			await Promise.all(clients.map(closeClient));
			await Promise.all(clients.map((state) => state.connection?.ready));
			for (const state of clients) {
				for (const name of state.registered) registry.unregister?.(name);
				all.delete(state.declaration.id);
			}
		},
		async list(invokeOptions) {
			if (invokeOptions?.signal?.aborted) throw new McpError("aborted", "MCP discovery aborted");
			const all = [...resolveStates().values()];
			const results = await Promise.allSettled(all.map((state) => discover(state, invokeOptions?.signal)));
			for (const result of results) {
				if (result.status === "rejected") throw result.reason;
			}
			return { servers: all.map(listingFor), diagnostics: [...diagnostics] };
		},
		catalog() {
			const all = [...resolveStates().values()];
			const servers = all.map(listingFor);
			return {
				servers,
				entries: all.flatMap(entriesFor),
				diagnostics: [...diagnostics],
				missing: servers.filter((server) => server.catalog === "missing").map((server) => server.id),
			};
		},
		metadata(name) {
			const owner = ownerOf(name);
			if (owner === null) return { metadata: null, reason: `no declared MCP server owns ${name}` };
			const { declaration } = owner;
			const toolName = name.slice(`mcp_${declaration.id}__`.length);

			if (declaration.trust.status !== "trusted") {
				const remedy = mcpTrustRemedy(declaration.id);
				return {
					metadata: null,
					reason: `mcp server ${declaration.id} is ${declaration.trust.status} (${declaration.trust.reason}); it is never launched until trusted: run ${remedy.remedy} (${remedy.interactiveRemedy} in an interactive session)`,
				};
			}
			const registered = registry.get(name as DynamicToolName);
			if (registered !== undefined && owner.registered.includes(registered.name as DynamicToolName)) {
				return {
					metadata: {
						name: registered.name,
						serverId: declaration.id,
						description: registered.description,
						parameters: registered.parameters as Record<string, unknown>,
						actionClass: registered.baseActionClass as McpTrustActionClass,
						provenance: "live",
						truncated: owner.truncated,
					},
				};
			}
			if (owner.failure !== null) {
				return { metadata: null, reason: `mcp server ${declaration.id} failed: ${owner.failure}` };
			}
			// A connected server's own listing is the session's answer; its
			// catalog file describes the same connection and adds nothing.
			if (owner.client !== null) {
				const offered = owner.tools.find((entry) => entry.name === toolName);
				return {
					metadata: null,
					reason:
						offered === undefined
							? `mcp server ${declaration.id} offers no tool named ${toolName}`
							: `mcp server ${declaration.id} offers ${toolName}, but ${name} is not carried as a capability name; another declared server owns that name`,
				};
			}
			const catalog = cachedCatalog(owner);
			if (catalog === null) {
				return {
					metadata: null,
					reason: `no recorded catalog for mcp server ${declaration.id}; list its tools with ${catalogRemedy(declaration.id)}`,
				};
			}
			const tool = catalog.tools.find((entry) => entry.name === toolName);
			if (tool === undefined) {
				return {
					metadata: null,
					reason: `mcp server ${declaration.id} records no tool named ${toolName}${catalog.truncated ? `, and its catalog is incomplete: list it again with ${catalogRemedy(declaration.id)}` : ""}`,
				};
			}
			return {
				metadata: {
					name,
					serverId: declaration.id,
					description: describeTool(declaration, tool),
					parameters: tool.inputSchema,
					actionClass: actionClassFor(declaration, tool),
					provenance: "cached",
					truncated: catalog.truncated,
				},
			};
		},
		async refresh(id, invokeOptions) {
			if (invokeOptions?.signal?.aborted) throw new McpError("aborted", "MCP discovery aborted");
			const state = resolveStates().get(id);
			if (state === undefined) return { listing: null, reason: `no MCP server named '${id}' is declared` };
			const trust = state.declaration.trust;
			if (trust.status !== "trusted") {
				const remedy = mcpTrustRemedy(id);
				return {
					listing: listingFor(state),
					reason: `mcp server ${id} is ${trust.status} (${trust.reason}); it is never launched until trusted: run ${remedy.remedy} (${remedy.interactiveRemedy} in an interactive session)`,
				};
			}
			const refusal = readOnlyLaunchRefusal(state.declaration, invokeOptions?.readOnly);
			if (refusal !== null) return { listing: listingFor(state), reason: refusal };
			await discover(state, invokeOptions?.signal);
			return {
				listing: listingFor(state),
				...(state.failure !== null ? { reason: `mcp server ${id} failed: ${state.failure}` } : {}),
			};
		},
		declaredIds() {
			return [...resolveStates().keys()];
		},
		async ensure(name, invokeOptions) {
			if (invokeOptions?.signal?.aborted) throw new McpError("aborted", "MCP discovery aborted");
			const owner = ownerOf(name);
			if (owner === null) return { spec: null, reason: `no declared MCP server owns ${name}` };
			const trust = owner.declaration.trust;
			if (trust.status !== "trusted") {
				const remedy = mcpTrustRemedy(owner.declaration.id);
				return {
					spec: null,
					reason: `mcp server ${owner.declaration.id} is ${trust.status} (${trust.reason}); it is never launched until trusted: run ${remedy.remedy} (${remedy.interactiveRemedy} in an interactive session)`,
				};
			}
			const refusal = readOnlyLaunchRefusal(
				owner.declaration,
				invokeOptions?.readOnly,
				name.slice(`mcp_${owner.declaration.id}__`.length),
			);
			if (refusal !== null) return { spec: null, reason: refusal };
			await discover(owner, invokeOptions?.signal);
			const spec = registry.get(name as DynamicToolName);
			if (spec !== undefined && owner.registered.includes(spec.name as DynamicToolName)) return { spec };
			return {
				spec: null,
				reason:
					owner.failure !== null
						? `mcp server ${owner.declaration.id} failed: ${owner.failure}`
						: `mcp server ${owner.declaration.id} offers no tool named ${name.slice(`mcp_${owner.declaration.id}__`.length)}`,
			};
		},
		authorityNote(name) {
			const owner = ownerOf(name);
			if (owner === null) return null;
			const { declaration } = owner;
			if (declaration.scope === "client") {
				return `Local stdio MCP server ${declaration.id}, supplied by the ACP client for this session. Calls use the unknown action class, ask at default autonomy, and run at yolo. The server closes with the session.`;
			}
			return `Local stdio MCP server ${declaration.id} (${declaration.scope} scope, declared in ${declaration.path}), trusted with action class ${declaration.trust.actionClass}: ${
				declaration.trust.actionClass === "unknown"
					? "every call asks for approval and read-only denies it"
					: declaration.trust.actionClass === "execute"
						? "calls are admitted like an unrecognized shell command"
						: "calls run as reads at every autonomy level"
			}; ${launchConfinement()}.`;
		},
		ownerIdOf(name) {
			return ownerOf(name)?.declaration.id ?? null;
		},
		discoveryNote(name) {
			const state = ownerOf(name);
			if (state === null) return null;
			const toolName = name.slice(`mcp_${state.declaration.id}__`.length);
			const tool =
				state.tools.find((entry) => entry.name === toolName) ??
				cachedCatalog(state)?.tools.find((entry) => entry.name === toolName);
			const hint = tool === undefined ? undefined : serverHintOf(tool);
			const refused = state.refused.get(toolName);
			return {
				...(hint !== undefined ? { serverHint: hint } : {}),
				...(refused !== undefined
					? { unavailable: `refused by MCP server ${state.declaration.id} policy (${refused}) this session` }
					: {}),
			};
		},
		transportOf(name) {
			const declaration = ownerOf(name)?.declaration;
			if (declaration === undefined) return null;
			return mcpTransportIdentity(declaration.id, declaration.command, declaration.args, declaration.cwd, declaration.env);
		},
		connectedIds(options) {
			return [...(states?.values() ?? [])]
				.filter((state) => state.client !== null && (!options?.readyOnly || state.client.state().status === "ready"))
				.map((state) => state.declaration.id);
		},
		teardownReports() {
			return [...teardowns];
		},
		close() {
			if (closePromise !== null) return closePromise;
			closed = true;
			closePromise = (async () => {
				const all = [...(states?.values() ?? [])];
				await Promise.all(all.map(closeClient));
				await Promise.all(all.map((state) => state.connection?.ready));
				const report: McpCloseReport = { incomplete: [] };
				for (const { id, outcome } of teardowns) {
					if (!outcome.complete) report.incomplete.push({ id, pgid: outcome.pgid, boundMs: outcome.boundMs });
				}
				if (exitHookInstalled) {
					process.removeListener("exit", killLaunchedOnExit);
					exitHookInstalled = false;
				}
				return report;
			})();
			return closePromise;
		},
	};
}
