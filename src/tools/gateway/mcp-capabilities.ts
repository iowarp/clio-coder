import type { TSchema } from "typebox";
import { type DynamicToolName, mcpToolName } from "../../core/tool-names.js";
import {
	createMcpStdioClient,
	type McpClient,
	type McpClientOptions,
	McpError,
	type McpServerSpec,
	type McpTeardownOutcome,
	type McpToolCallResult,
	type McpToolDescriptor,
	type McpTrustActionClass,
	type ResolvedMcpServer,
	resolveMcpServers,
} from "../../domains/gateway/mcp/index.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import type { ImageContent } from "../../engine/types.js";
import type { ToolRegistry, ToolResult, ToolSpec } from "../registry.js";

/**
 * Local stdio MCP servers as gateway capabilities. The source reads the
 * declared servers once per session, launches a server only when it is
 * trusted and only when the first find, describe, or call needs it, registers
 * each of its tools in the registry as `mcp_<id>__<tool>` (placement gateway,
 * action class from the trust record), and closes every client it opened at
 * session end. Launching a server does not sandbox it; the trust record is the
 * operator's explicit acceptance of that.
 */

/** What the gateway's find listing says about one declared server. */
export interface McpServerListing {
	id: string;
	scope: ResolvedMcpServer["scope"];
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
}

export interface McpListing {
	servers: McpServerListing[];
	/** Config and trust-file problems, verbatim. */
	diagnostics: string[];
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
	/** Launch every trusted server not yet launched, register its tools, and describe every declared server. */
	list(options?: { signal?: AbortSignal }): Promise<McpListing>;
	/** Make `name`'s server available (launching it when trusted) and return its registered spec. */
	ensure(name: string, options?: { signal?: AbortSignal }): Promise<McpEnsureResult>;
	/** One sentence of provenance and authority for describe, or null for a name this source does not own. */
	authorityNote(name: string): string | null;
	/** Ids of the servers launched this session and still open. */
	connectedIds(): string[];
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
	declaration: ResolvedMcpServer;
	client: McpClient | null;
	connecting: Promise<void> | null;
	closing: Promise<McpTeardownOutcome> | null;
	tools: McpToolDescriptor[];
	truncated: boolean;
	registered: DynamicToolName[];
	unregistrable: string[];
	failure: string | null;
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
				},
			]),
		);
		return states;
	};

	const makeSpec = (state: ServerState, tool: McpToolDescriptor, name: DynamicToolName): ToolSpec => {
		const { declaration } = state;
		const trustClass: McpTrustActionClass = declaration.trust.actionClass;
		const timeoutMs = declaration.timeoutMs ?? options.requestTimeoutMs;
		const spec: ToolSpec = {
			name,
			description: `${tool.description.trim().length > 0 ? tool.description.trim() : `MCP tool ${tool.name}`}\nLocal MCP server ${declaration.id} (${declaration.scope} scope), trusted with action class ${trustClass}; launching it does not sandbox it.`,
			parameters: tool.inputSchema as TSchema,
			baseActionClass: trustClass,
			executionMode: "sequential",
			placement: "gateway",
			sourceInfo: { path: declaration.path, scope: "domain" },
			metadata: {
				objective: tool.description.trim().length > 0 ? tool.description.trim() : `MCP tool ${tool.name}`,
				uiLabel: `${declaration.id}/${tool.name}`,
				retrySafety: "unknown",
				resultSizePolicy: { kind: "bounded", maxBytes: 600_000 },
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
				tools: [...state.registered],
				...(state.truncated ? { truncated: true } : {}),
				...(state.unregistrable.length > 0 ? { unregistrable: [...state.unregistrable] } : {}),
			};
		}
		return { ...base, status: "trusted" };
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

	return {
		async list(invokeOptions) {
			if (invokeOptions?.signal?.aborted) throw new McpError("aborted", "MCP discovery aborted");
			const all = [...resolveStates().values()];
			const results = await Promise.allSettled(all.map((state) => discover(state, invokeOptions?.signal)));
			for (const result of results) {
				if (result.status === "rejected") throw result.reason;
			}
			return { servers: all.map(listingFor), diagnostics: [...diagnostics] };
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
			return `Local stdio MCP server ${declaration.id} (${declaration.scope} scope, declared in ${declaration.path}), trusted with action class ${declaration.trust.actionClass}: ${
				declaration.trust.actionClass === "unknown"
					? "every call asks for approval and read-only denies it"
					: declaration.trust.actionClass === "execute"
						? "calls are admitted like an unrecognized shell command"
						: "calls run as reads at every autonomy level"
			}. Launching the server does not sandbox it.`;
		},
		connectedIds() {
			return [...(states?.values() ?? [])].filter((state) => state.client !== null).map((state) => state.declaration.id);
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
