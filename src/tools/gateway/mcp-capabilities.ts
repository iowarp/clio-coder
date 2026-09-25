import type { TSchema } from "typebox";
import { type DynamicToolName, mcpToolName } from "../../core/tool-names.js";
import {
	canonicalProjectRoot,
	createMcpStdioClient,
	type McpCatalogIdentity,
	type McpClient,
	type McpClientOptions,
	McpError,
	type McpServerCatalog,
	type McpServerSpec,
	type McpTeardownOutcome,
	type McpToolCallResult,
	type McpToolDescriptor,
	type McpToolListing,
	type McpTrustActionClass,
	type ResolvedMcpServer,
	readMcpServerCatalog,
	resolveMcpServers,
	writeMcpServerCatalog,
} from "../../domains/gateway/mcp/index.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import type { ImageContent } from "../../engine/types.js";
import type { ToolRegistry, ToolResult, ToolSpec } from "../registry.js";

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

/**
 * Local stdio MCP servers as gateway capabilities. The source reads the
 * declared servers once per session, launches a server only when it is
 * trusted and only when the first find, describe, or call needs it, registers
 * each of its tools in the registry as `mcp_<id>__<tool>` (placement gateway,
 * action class from the trust record), and closes every client it opened at
 * session end. Launching a server does not sandbox it; the trust record is the
 * operator's explicit acceptance of that.
 */

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
	/** Launch one declared trusted server, register its tools, and publish its catalog. */
	refresh(id: string, options?: { signal?: AbortSignal }): Promise<McpRefreshResult>;
	/** Ids of every declared server, trusted or not, for validating a scoped discovery request. */
	declaredIds(): string[];
	/** Make `name`'s server available (launching it when trusted) and return its registered spec. */
	ensure(name: string, options?: { signal?: AbortSignal }): Promise<McpEnsureResult>;
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

interface ServerState {
	declaration: GatewayMcpServer;
	client: McpClient | null;
	connecting: Promise<void> | null;
	closing: Promise<McpTeardownOutcome> | null;
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
}

/** The one call that fills a missing catalog, named so the model does not guess at a broader one. */
function catalogRemedy(id: string): string {
	return `gateway(op="find", server="${id}", refresh=true)`;
}

interface NamedTool {
	name: string;
	description: string;
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
	return `${objectiveOf(tool)}\nLocal MCP server ${declaration.id} (${declaration.scope} scope), trusted with action class ${declaration.trust.actionClass}; launching it does not sandbox it.`;
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

	const closeClient = (state: ServerState): Promise<McpTeardownOutcome> | undefined => {
		if (state.closing !== null) return state.closing;
		const client = state.client;
		if (client === null) return undefined;
		state.closing = client.close().then((outcome) => {
			teardowns.push({ id: state.declaration.id, outcome });
			state.client = null;
			if (!outcome.complete) {
				process.stderr.write(
					`[gateway] mcp server ${state.declaration.id}: process group ${outcome.pgid} survived SIGKILL for ${outcome.boundMs}ms; recorded, not signalled again\n`,
				);
			}
			return outcome;
		});
		return state.closing;
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
					declaration,
					client: null,
					connecting: null,
					closing: null,
					tools: [],
					truncated: false,
					registered: [],
					unregistrable: [],
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
		if (state.declaration.scope === "client") return;
		writeMcpServerCatalog(catalogIdentity(state.declaration), listing);
		// Drop the memo of whatever the file said before this listing replaced it.
		state.catalog = undefined;
	};

	const makeSpec = (state: ServerState, tool: McpToolDescriptor, name: DynamicToolName): ToolSpec => {
		const { declaration } = state;
		const trustClass: McpTrustActionClass = declaration.trust.actionClass;
		const timeoutMs = declaration.timeoutMs ?? options.requestTimeoutMs;
		const spec: ToolSpec = {
			name,
			description: describeTool(declaration, tool),
			parameters: tool.inputSchema as TSchema,
			baseActionClass: trustClass,
			executionMode: "sequential",
			placement: "gateway",
			sourceInfo: { path: declaration.path, scope: "domain" },
			metadata: {
				objective: objectiveOf(tool),
				uiLabel: `${declaration.id}/${tool.name}`,
				retrySafety: "unknown",
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
				const client = state.client;
				if (client === null || client.state().status !== "ready") {
					return {
						kind: "error",
						message: `${name}: mcp server ${declaration.id} is not connected${state.failure ? ` (${state.failure})` : ""}; a server that exited stays closed for this session`,
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
					if (result.isError) return { kind: "error", message: `${name}: ${result.text || "tool error"}`, details };
					const images = imageBlocks(result);
					return { kind: "ok", output: result.text, details, ...(images.length > 0 ? { images } : {}) };
				} catch (error) {
					if (error instanceof McpError && (error.code === "closed" || error.code === "spawn")) {
						state.failure = errorMessage(error);
					}
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

	const connect = async (state: ServerState): Promise<void> => {
		if (state.connecting !== null) return state.connecting;
		if (closed || state.client !== null || state.failure !== null) return;
		if (state.declaration.trust.status !== "trusted") return;
		state.connecting = (async () => {
			const { declaration } = state;
			let client: McpClient | null = null;
			try {
				client = clientFactory(
					{
						id: declaration.id,
						command: declaration.command,
						args: declaration.args,
						cwd: declaration.cwd,
						env: declaration.env,
					},
					{
						workspaceRoot: declaration.cwdRoot,
						...(declaration.timeoutMs !== null
							? { requestTimeoutMs: declaration.timeoutMs }
							: options.requestTimeoutMs !== undefined
								? { requestTimeoutMs: options.requestTimeoutMs }
								: {}),
					},
				);
				state.client = client;
				installExitHook();
				await client.initialize();
				const listing = await client.listTools();
				state.tools = listing.tools;
				state.truncated = listing.truncated;
				// An abort that landed while the listing was in flight already set
				// the failure and closed the client. Publishing here would persist
				// a catalog from discovery that did not complete.
				if (state.failure === null) publishCatalog(state, listing);
				for (const tool of listing.tools) {
					const name = mcpToolName(declaration.id, tool.name);
					if (name === null || ownerOf(name) !== state || registry.get(name) !== undefined) {
						state.unregistrable.push(tool.name);
						continue;
					}
					registry.register(makeSpec(state, tool, name));
					state.registered.push(name);
				}
			} catch (error) {
				state.failure = errorMessage(error);
				await closeClient(state);
			} finally {
				state.connecting = null;
			}
		})();
		return state.connecting;
	};

	// Discovery owns the pending handshake and pagination. Cancellation closes
	// that shared connection; other waiters observe its failed state as well.
	const discover = async (state: ServerState, signal?: AbortSignal): Promise<void> => {
		const aborted = () => new McpError("aborted", "MCP discovery aborted");
		if (signal?.aborted) throw aborted();
		let cleanup: Promise<McpTeardownOutcome> | undefined;
		const onAbort = (): void => {
			state.failure = errorMessage(aborted());
			cleanup = closeClient(state);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await connect(state);
			await cleanup;
			if (signal?.aborted) throw aborted();
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

	const ownerOf = (name: string): ServerState | null => {
		// IDs and tool names may contain __. Reserve each composed name for
		// the longest declared server prefix, including untrusted declarations,
		// so discovery order cannot change either routing or authority.
		let owner: ServerState | null = null;
		for (const state of resolveStates().values()) {
			if (
				name.startsWith(`mcp_${state.declaration.id}__`) &&
				(owner === null || state.declaration.id.length > owner.declaration.id.length)
			) {
				owner = state;
			}
		}
		return owner;
	};

	/**
	 * Every capability a server's metadata records, live or cached. A cached
	 * name goes through the same ownership rule a live one does, so a tool whose
	 * composed name belongs to a longer-named server is dropped here exactly as
	 * `connect()` drops it, and cache load order can never decide routing.
	 */
	const entriesFor = (state: ServerState): McpCatalogEntry[] => {
		const { declaration } = state;
		const actionClass = declaration.trust.actionClass;
		if (declaration.trust.status !== "trusted" || state.failure !== null) return [];
		if (state.client !== null) {
			return state.registered.flatMap((name) => {
				const spec = registry.get(name);
				return spec === undefined ? [] : [{ name, description: spec.description, actionClass }];
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
			entries.push({ name, description: describeTool(declaration, tool), actionClass });
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
				const slug = server.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
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
					digest: "session-only",
					trust: { status: "trusted", actionClass: "unknown" },
				};
				const state: ServerState = {
					declaration, client: null, connecting: null, closing: null, tools: [], truncated: false,
					registered: [], unregistrable: [], failure: null, catalog: null,
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
			await Promise.all(clients.map((state) => state.connecting));
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
			const actionClass = declaration.trust.actionClass;
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
						actionClass,
						provenance: "live",
						truncated: owner.truncated,
					},
				};
			}
			if (owner.failure !== null) {
				return { metadata: null, reason: `mcp server ${declaration.id} failed: ${owner.failure}` };
			}
			const toolName = name.slice(`mcp_${declaration.id}__`.length);
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
					actionClass,
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
			// A server that already failed this session stays failed. Refresh is a
			// scoped discovery request, not a reconnect policy.
			if (state.failure !== null) {
				return { listing: listingFor(state), reason: `mcp server ${id} failed: ${state.failure}` };
			}
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
			}. Launching the server does not sandbox it.`;
		},
		ownerIdOf(name) {
			return ownerOf(name)?.declaration.id ?? null;
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
				await Promise.all(all.map((state) => state.connecting));
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
