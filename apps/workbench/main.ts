import { extname } from "node:path";
import { type ClioCatalogInspector, ClioCliCatalogInspector } from "./clio-catalog-inspector.ts";
import { ClioCliConfigInspector, ClioConfigInspectError, type ClioConfigInspector } from "./clio-config-inspector.ts";
import { ClioCliUsageInspector, ClioUsageInspectError, type ClioUsageInspector } from "./clio-usage-inspector.ts";
import { ClioCliRoutingInspector, type ClioRoutingInspector } from "./clio-routing-inspector.ts";
import {
	type ClioLauncher,
	ClioProjectHost,
	createLocalClioLauncher,
	HostError,
	type HostEvent,
	type HostSink,
} from "./clio-host.ts";
import type { AcpClientTiming } from "./acp-client.ts";
import { ProjectStore, ProjectStoreError, type ProjectSummary, type ProjectTreeNode } from "./project-store.ts";
import {
	type ClientCommand,
	type ClientCommandOf,
	type CommandErrorCode,
	encodeServerEvent,
	MAX_CLIENT_FRAME_BYTES,
	parseClientCommand,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	type ServerEvent,
	type ServerEventKind,
	type ServerEventPayloadByKind,
	validateServerEvent,
	type WireCatalogInspection,
	type WireConfigInspection,
	type WireDeleteChallenge,
	type WireProjectSummary,
	type WireProjectWorkspace,
	type WireRoutingInspection,
	type WireTreeNode,
	type WireUsageInspection,
} from "./src/protocol.ts";
import { applyTurnEvent, emptyTurnProjection, type TurnEventInput, type TurnProjection } from "./src/timeline.ts";
import { type RecentProject, WorkbenchState, WorkbenchStateError } from "./workbench-state.ts";

const APP_NAME = "Clio Workbench" as const;
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 4173;
/** How long the host waits after the last browser goes away before it stops a live turn. */
export const DEFAULT_DISCONNECT_GRACE_MS = 10_000;
const INVALID_CLIENT_FRAME_CLOSE_REASON = "Invalid Workbench client protocol frame";
const SLOW_CLIENT_CLOSE_REASON = "Workbench client fell behind";
const TREE_DEPTH = 5;
const TREE_NODES = 200;
export const MAX_WEBSOCKET_OUTBOUND_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data:",
	"font-src 'self'",
	"connect-src 'self' ws: wss:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"content-security-policy": CSP,
	"cross-origin-opener-policy": "same-origin",
	"cross-origin-resource-policy": "same-origin",
	"permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
};

const MIME_TYPES: Readonly<Record<string, string>> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

export const SECURITY_NOTE =
	"Workbench enforces the project boundary in its own code against the canonical root you opened; Deno's file grants are broad at launch, so that boundary is not a sandbox.";

export function wouldExceedWebSocketHighWaterMark(bufferedAmount: number, encodedFrameBytes: number): boolean {
	if (
		!Number.isSafeInteger(bufferedAmount) || bufferedAmount < 0 ||
		!Number.isSafeInteger(encodedFrameBytes) || encodedFrameBytes < 0
	) return true;
	return bufferedAmount > MAX_WEBSOCKET_OUTBOUND_BYTES - encodedFrameBytes;
}

interface RuntimeCliOptions {
	port: number;
	smokeMs?: number;
}

export interface WorkbenchServerOptions {
	hostname?: string;
	port?: number;
	quiet?: boolean;
	mode?: "browser" | "desktop";
	distRoot?: URL;
	clioLauncher?: ClioLauncher;
	/** Overrides the fixed read-only Clio configuration adapter (tests). */
	configInspector?: ClioConfigInspector;
	/** Overrides the fixed read-only Clio resource-catalog adapter (tests). */
	catalogInspector?: ClioCatalogInspector;
	/** Overrides the fixed project-scoped Clio usage adapter (tests). */
	usageInspector?: ClioUsageInspector;
	/** Overrides the fixed offline model and worker-routing adapter (tests). */
	routingInspector?: ClioRoutingInspector;
	/** Overrides the Workbench state directory (tests). */
	stateDir?: string;
	/** Overrides `$HOME` for the guards and browser (tests). */
	homePath?: string;
	disconnectGraceMs?: number;
	permissionEscalateMs?: number;
	permissionBudgetMs?: number;
	promptTimeoutMs?: number;
	acpTiming?: AcpClientTiming;
}

export interface RunningWorkbenchServer {
	readonly server: Deno.HttpServer<Deno.NetAddr>;
	readonly url: string;
	readonly token: string;
	readonly mode: "browser" | "desktop";
	readonly workspaceInstanceId: string;
	readonly stateDir: string;
	close(): Promise<void>;
}

function parsePositiveInteger(value: string, label: string, maximum: number): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
		throw new Error(`${label} must be an integer from 0 through ${maximum}.`);
	}
	return parsed;
}

function parseCliOptions(args: readonly string[]): RuntimeCliOptions {
	let port = DEFAULT_PORT;
	let smokeMs: number | undefined;
	for (const argument of args) {
		if (argument.startsWith("--port=")) {
			port = parsePositiveInteger(argument.slice("--port=".length), "port", 65_535);
		} else if (argument.startsWith("--smoke-ms=")) {
			smokeMs = parsePositiveInteger(argument.slice("--smoke-ms=".length), "smoke-ms", 120_000);
		} else throw new Error(`Unknown Workbench argument: ${argument}`);
	}
	return { port, ...(smokeMs === undefined ? {} : { smokeMs }) };
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			...STATIC_SECURITY_HEADERS,
			"cache-control": "no-store",
			"content-type": "application/json; charset=utf-8",
		},
	});
}

function textResponse(value: string, status: number): Response {
	return new Response(value, {
		status,
		headers: {
			...STATIC_SECURITY_HEADERS,
			"cache-control": "no-store",
			"content-type": "text/plain; charset=utf-8",
		},
	});
}

function normalizeStaticRoot(value: URL): URL {
	const root = new URL(value.href);
	if (root.protocol !== "file:") throw new Error("Workbench distRoot must be a local file URL.");
	root.search = "";
	root.hash = "";
	if (!root.pathname.endsWith("/")) root.pathname = `${root.pathname}/`;
	return root;
}

function resolveStaticAsset(root: URL, relativePath: string): URL | null {
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(relativePath)) return null;
	let candidate: URL;
	try {
		candidate = new URL(relativePath, root);
	} catch {
		return null;
	}
	if (candidate.protocol !== "file:" || !candidate.href.startsWith(root.href)) return null;
	return candidate;
}

function treeNodeToWire(node: ProjectTreeNode): WireTreeNode {
	return {
		name: node.name,
		path: { segments: [...node.path] },
		kind: node.kind,
		operable: node.operable,
		...(node.size === undefined ? {} : { size: node.size }),
		...(node.modifiedAt === undefined ? {} : { modifiedAt: node.modifiedAt }),
		...(node.nodeVersion === undefined ? {} : { nodeVersion: node.nodeVersion }),
		...(node.children === undefined ? {} : { children: node.children.map(treeNodeToWire) }),
	};
}

/**
 * Selects the product launcher for the host platform. Native Windows launch is
 * deliberately unavailable: `wslAcpLaunch` remains a typed integration seam,
 * not a product path or a claim that descendants of `wsl.exe` are owned.
 */
export function defaultClioLauncher(platform = Deno.build.os): ClioLauncher {
	if (platform !== "windows") return createLocalClioLauncher();
	return {
		launch() {
			throw new HostError("not-ready", "Native Windows Clio launch requires an explicit WSL configuration.");
		},
	};
}

interface OpenProject {
	readonly project: ProjectSummary;
	readonly host: ClioProjectHost;
	projection: TurnProjection;
	tree: readonly WireTreeNode[];
	treeTruncated: boolean;
	deleteChallenge: WireDeleteChallenge | null;
	configInspection: WireConfigInspection | null;
	catalogInspection: WireCatalogInspection | null;
	usageInspection: WireUsageInspection | null;
	routingInspection: WireRoutingInspection | null;
}

type EventContext = { projectId?: string; processGeneration?: string; sessionId?: string; turnId?: string };

class WorkbenchRuntime implements HostSink {
	readonly workspaceInstanceId = `workspace-${crypto.randomUUID()}`;
	readonly token = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`;
	readonly #store: ProjectStore;
	readonly #state: WorkbenchState;
	readonly #launcher: ClioLauncher;
	readonly #configInspector: ClioConfigInspector;
	readonly #catalogInspector: ClioCatalogInspector;
	readonly #usageInspector: ClioUsageInspector;
	readonly #routingInspector: ClioRoutingInspector;
	readonly #mode: "browser" | "desktop";
	readonly #quiet: boolean;
	readonly #distRoot: URL;
	readonly #disconnectGraceMs: number;
	readonly #hostOptions: Pick<
		WorkbenchServerOptions,
		"permissionEscalateMs" | "permissionBudgetMs" | "promptTimeoutMs" | "acpTiming"
	>;
	readonly #sockets = new Set<SocketSession>();
	#open: OpenProject | null = null;
	#origin = "";
	#commandQueue: Promise<void> = Promise.resolve();
	#readCommandQueue: Promise<void> = Promise.resolve();
	#graceTimer: ReturnType<typeof setTimeout> | null = null;
	#closed = false;

	constructor(
		store: ProjectStore,
		state: WorkbenchState,
		options:
			& Required<Pick<WorkbenchServerOptions, "quiet" | "mode" | "distRoot" | "disconnectGraceMs">>
			& Pick<
				WorkbenchServerOptions,
				| "clioLauncher"
				| "configInspector"
				| "catalogInspector"
				| "usageInspector"
				| "routingInspector"
				| "permissionEscalateMs"
				| "permissionBudgetMs"
				| "promptTimeoutMs"
				| "acpTiming"
			>,
	) {
		this.#store = store;
		this.#state = state;
		this.#quiet = options.quiet;
		this.#mode = options.mode;
		this.#distRoot = normalizeStaticRoot(options.distRoot);
		this.#launcher = options.clioLauncher ?? defaultClioLauncher();
		this.#configInspector = options.configInspector ?? new ClioCliConfigInspector({
			log: options.quiet ? () => undefined : (message) => console.error(message),
		});
		this.#catalogInspector = options.catalogInspector ?? new ClioCliCatalogInspector({
			log: options.quiet ? () => undefined : (message) => console.error(message),
		});
		this.#usageInspector = options.usageInspector ?? new ClioCliUsageInspector({
			log: options.quiet ? () => undefined : (message) => console.error(message),
		});
		this.#routingInspector = options.routingInspector ?? new ClioCliRoutingInspector({
			log: options.quiet ? () => undefined : (message) => console.error(message),
		});
		this.#disconnectGraceMs = options.disconnectGraceMs;
		this.#hostOptions = {
			...(options.permissionEscalateMs === undefined ? {} : { permissionEscalateMs: options.permissionEscalateMs }),
			...(options.permissionBudgetMs === undefined ? {} : { permissionBudgetMs: options.permissionBudgetMs }),
			...(options.promptTimeoutMs === undefined ? {} : { promptTimeoutMs: options.promptTimeoutMs }),
			...(options.acpTiming === undefined ? {} : { acpTiming: options.acpTiming }),
		};
	}

	setOrigin(origin: string): void {
		this.#origin = origin;
	}

	get stateDir(): string {
		return this.#state.stateDir;
	}

	// ---------------------------------------------------------------- bootstrap

	async bootstrap(): Promise<Record<string, unknown>> {
		const open = this.#open;
		return {
			protocolVersion: PROTOCOL_VERSION,
			appName: APP_NAME,
			workspaceInstanceId: this.workspaceInstanceId,
			localToken: this.token,
			mode: this.#mode,
			openProjectId: open?.project.id ?? null,
			workspace: open === null ? null : this.#workspaceDto(open),
			recent: await this.#recentDtos(),
			homePath: this.#state.homePath,
			stateDirNote:
				`Workbench keeps only its recent-project list under ${this.#state.stateDir}; bounded configuration, catalog, project usage, and offline routing inspections ask Clio for typed data, redact it on the host, and never change Clio configuration.`,
			securityNote: SECURITY_NOTE,
		};
	}

	async #recentDtos(): Promise<WireProjectSummary[]> {
		const recent = this.#state.recent();
		return await Promise.all(recent.map(async (project) => await this.#recentDto(project)));
	}

	async #recentDto(project: RecentProject): Promise<WireProjectSummary> {
		const available = this.#open?.project.id === project.id ? true : await this.#state.available(project.canonicalPath);
		return {
			id: project.id,
			displayName: project.displayName,
			rootPath: project.canonicalPath,
			lastOpenedAt: project.lastOpenedAt,
			available,
		};
	}

	#projectSummary(open: OpenProject): WireProjectSummary {
		const recent = this.#state.recentById(open.project.id);
		return {
			id: open.project.id,
			displayName: open.project.displayName,
			rootPath: open.project.identity.canonicalPath,
			lastOpenedAt: recent?.lastOpenedAt ?? open.project.lastOpenedAt,
			available: true,
		};
	}

	#workspaceDto(open: OpenProject): WireProjectWorkspace {
		const sessions = open.host.sessions;
		return {
			project: this.#projectSummary(open),
			tree: open.tree,
			treeTruncated: open.treeTruncated,
			sessions: sessions.sessions,
			sessionsTruncated: sessions.truncated,
			clio: open.host.snapshot(),
			timeline: open.projection.timeline,
			timelineTruncated: open.projection.timelineTruncated,
			activeTurn: open.projection.activeTurn,
			pendingPermission: open.projection.pendingPermission,
			deleteChallenge: open.deleteChallenge,
			settings: open.host.settings,
			configInspection: open.configInspection,
			catalogInspection: open.catalogInspection,
			usageInspection: open.usageInspection,
			routingInspection: open.routingInspection,
			targets: open.host.targets,
			targetsTruncated: open.host.targetsTruncated,
			processGeneration: open.host.generation,
			lastSequence: 0,
		};
	}

	// ---------------------------------------------------------------- http

	async handleRequest(request: Request): Promise<Response> {
		if (!this.#origin || new URL(request.url).origin !== this.#origin) {
			return textResponse("Misdirected localhost request", 421);
		}
		const url = new URL(request.url);
		if (url.pathname === "/api/bootstrap") {
			if (request.method !== "GET") return textResponse("Method not allowed", 405);
			return jsonResponse(await this.bootstrap());
		}
		if (url.pathname === "/api/events") return this.#upgrade(request, url);
		if (url.pathname.startsWith("/api/")) return jsonResponse({ error: "not-found" }, 404);
		return await this.#serveStatic(request, url);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearGrace();
		await Promise.all([
			this.#commandQueue.catch(() => undefined),
			this.#readCommandQueue.catch(() => undefined),
		]);
		const open = this.#open;
		this.#open = null;
		if (open !== null) {
			try {
				await open.host.close();
			} catch (error) {
				if (!this.#quiet) console.error("Workbench could not close the Clio host cleanly", error);
			}
			this.#store.unregister(open.project.id);
		}
		for (const session of this.#sockets) session.close(1001, "Workbench is shutting down");
		this.#sockets.clear();
	}

	// ---------------------------------------------------------------- HostSink

	emit(event: HostEvent): void {
		const open = this.#open;
		if (open === null) return;
		switch (event.type) {
			case "clio.state":
				if (event.projectId !== open.project.id) return;
				this.#broadcast("clio.state", { projectId: event.projectId }, { snapshot: event.snapshot });
				return;
			case "session.list":
				if (event.projectId !== open.project.id) return;
				this.#broadcast("session.list", { projectId: event.projectId }, {
					sessions: event.sessions,
					truncated: event.truncated,
				});
				return;
			case "settings.state":
				if (event.projectId !== open.project.id) return;
				this.#broadcast("settings.state", { projectId: event.projectId }, { settings: event.settings });
				return;
			case "targets.state":
				if (event.projectId !== open.project.id) return;
				this.#broadcast("targets.state", { projectId: event.projectId }, {
					targets: event.targets,
					truncated: event.truncated,
				});
				return;
			case "targets.probed":
				if (event.projectId !== open.project.id) return;
				this.#broadcast("targets.probed", { projectId: event.projectId }, {
					targetId: event.targetId,
					health: event.health,
				});
				return;
			default: {
				if (event.context.projectId !== open.project.id) return;
				const context: EventContext = {
					projectId: event.context.projectId,
					processGeneration: event.context.generation,
					sessionId: event.context.sessionId,
					turnId: event.context.turnId,
				};
				const input = { kind: event.type, turnId: event.context.turnId, payload: event.payload } as TurnEventInput;
				open.projection = applyTurnEvent(open.projection, input, new Date().toISOString());
				this.#broadcast(event.type, context, event.payload as ServerEventPayloadByKind[typeof event.type]);
			}
		}
	}

	async refreshProject(projectId: string): Promise<void> {
		const open = this.#open;
		if (open === null || open.project.id !== projectId) return;
		await this.#refreshTree(open, "project.snapshot");
	}

	// ---------------------------------------------------------------- commands

	handleCommand(session: SocketSession, command: ClientCommand): Promise<void> {
		// Read-only CLI adapters have their own serialized lane. They may run
		// alongside the owned ACP child, but can never delay Stop, permission,
		// project, or session controls on the primary lane.
		if (command.kind === "config.inspect") {
			return this.#serializeRead(() => this.#dispatchConfigInspect(session, command));
		}
		if (command.kind === "catalog.inspect") {
			return this.#serializeRead(() => this.#dispatchCatalogInspect(session, command));
		}
		if (command.kind === "usage.inspect") {
			return this.#serializeRead(() => this.#dispatchUsageInspect(session, command));
		}
		if (command.kind === "routing.inspect") {
			return this.#serializeRead(() => this.#dispatchRoutingInspect(session, command));
		}
		return this.#serialize(() => this.#dispatchCommand(session, command));
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const queued = this.#commandQueue.then(operation, operation);
		this.#commandQueue = queued.then(() => undefined, () => undefined);
		return queued;
	}

	#serializeRead<T>(operation: () => Promise<T>): Promise<T> {
		const queued = this.#readCommandQueue.then(operation, operation);
		this.#readCommandQueue = queued.then(() => undefined, () => undefined);
		return queued;
	}

	async #dispatchConfigInspect(
		session: SocketSession,
		command: ClientCommandOf<"config.inspect">,
	): Promise<void> {
		try {
			if (this.#closed || session.closed) throw new HostError("not-ready", "The local client is closed.");
			const open = this.#requireOpen(command.payload.projectId);
			const inspection = await this.#configInspector.inspect(open.project.identity.canonicalPath);
			// Project switching and inspection are intentionally concurrent. A late
			// result belongs only to the exact OpenProject instance that requested it.
			if (this.#closed || this.#open !== open) return;
			open.configInspection = inspection;
			this.#broadcast("config.state", { projectId: open.project.id }, { inspection });
		} catch (error) {
			const mapped = this.#commandError(error);
			session.send(
				"command.error",
				{ projectId: command.payload.projectId },
				{ ...mapped, requestId: command.requestId },
			);
		}
	}

	async #dispatchCatalogInspect(
		session: SocketSession,
		command: ClientCommandOf<"catalog.inspect">,
	): Promise<void> {
		try {
			if (this.#closed || session.closed) throw new HostError("not-ready", "The local client is closed.");
			const open = this.#requireOpen(command.payload.projectId);
			const inspection = await this.#catalogInspector.inspect(open.project.identity.canonicalPath);
			// As with config inspection, a project switch invalidates a late result.
			if (this.#closed || this.#open !== open) return;
			open.catalogInspection = inspection;
			this.#broadcast("catalog.state", { projectId: open.project.id }, { inspection });
		} catch (error) {
			const mapped = this.#commandError(error);
			session.send(
				"command.error",
				{ projectId: command.payload.projectId },
				{ ...mapped, requestId: command.requestId },
			);
		}
	}

	async #dispatchUsageInspect(
		session: SocketSession,
		command: ClientCommandOf<"usage.inspect">,
	): Promise<void> {
		try {
			if (this.#closed || session.closed) throw new HostError("not-ready", "The local client is closed.");
			const open = this.#requireOpen(command.payload.projectId);
			const inspection = await this.#usageInspector.inspect(open.project.identity.canonicalPath);
			// Read adapters may outlive a project switch; late results are discarded
			// instead of being attached to whichever project is open now.
			if (this.#closed || this.#open !== open) return;
			open.usageInspection = inspection;
			this.#broadcast("usage.state", { projectId: open.project.id }, { inspection });
		} catch (error) {
			const mapped = this.#commandError(error);
			session.send(
				"command.error",
				{ projectId: command.payload.projectId },
				{ ...mapped, requestId: command.requestId },
			);
		}
	}

	async #dispatchRoutingInspect(
		session: SocketSession,
		command: ClientCommandOf<"routing.inspect">,
	): Promise<void> {
		try {
			if (this.#closed || session.closed) throw new HostError("not-ready", "The local client is closed.");
			const open = this.#requireOpen(command.payload.projectId);
			const inspection = await this.#routingInspector.inspect(open.project.identity.canonicalPath);
			// The routing listing is a cached project snapshot. A late result cannot
			// attach to a project selected while the read was in flight.
			if (this.#closed || this.#open !== open) return;
			open.routingInspection = inspection;
			this.#broadcast("routing.state", { projectId: open.project.id }, { inspection });
		} catch (error) {
			const mapped = this.#commandError(error);
			session.send(
				"command.error",
				{ projectId: command.payload.projectId },
				{ ...mapped, requestId: command.requestId },
			);
		}
	}

	#requireOpen(projectId: string): OpenProject {
		const open = this.#open;
		if (open === null || open.project.id !== projectId) {
			throw new HostError("not-found", "That project is not open.");
		}
		return open;
	}

	async #dispatchCommand(session: SocketSession, command: ClientCommand): Promise<void> {
		try {
			if (this.#closed || session.closed) throw new HostError("not-ready", "The local client is closed.");
			switch (command.kind) {
				case "project.browse": {
					const listing = await this.#state.browse(command.payload.path);
					session.send("project.browse.listing", {}, listing);
					break;
				}
				case "project.open":
					await this.#openPath(command.payload.path, null);
					break;
				case "project.select": {
					const recent = this.#state.recentById(command.payload.projectId);
					if (recent === null) throw new HostError("not-found", "That project is not in the recent list.");
					if (this.#open?.project.id === recent.id) {
						this.#broadcast("project.opened", { projectId: recent.id }, { workspace: this.#workspaceDto(this.#open) });
						break;
					}
					await this.#openPath(recent.canonicalPath, recent);
					break;
				}
				case "project.forget": {
					const projectId = command.payload.projectId;
					if (this.#open?.project.id === projectId) {
						if (this.#open.host.hasActivePrompt) {
							throw new HostError(
								"conflict",
								"Clio is still working in this project. Cancel the turn before forgetting it.",
							);
						}
						await this.#closeOpen();
					}
					if (!(await this.#state.forget(projectId))) {
						throw new HostError("not-found", "That project is not in the recent list.");
					}
					this.#broadcast("project.forgotten", { projectId }, {});
					break;
				}
				case "fs.refresh": {
					const open = this.#requireOpen(command.payload.projectId);
					await this.#refreshTree(open, "project.snapshot");
					break;
				}
				case "fs.create-file": {
					const open = this.#requireOpen(command.payload.projectId);
					await this.#store.createFile(command.payload);
					await this.#refreshTree(open, "fs.changed");
					break;
				}
				case "fs.create-folder": {
					const open = this.#requireOpen(command.payload.projectId);
					await this.#store.createFolder(command.payload);
					await this.#refreshTree(open, "fs.changed");
					break;
				}
				case "fs.move": {
					const open = this.#requireOpen(command.payload.projectId);
					await this.#store.moveEntry(command.payload);
					await this.#refreshTree(open, "fs.changed");
					break;
				}
				case "fs.delete.prepare": {
					const open = this.#requireOpen(command.payload.projectId);
					const challenge = await this.#store.prepareDelete(command.payload);
					const wire: WireDeleteChallenge = {
						confirmationId: challenge.confirmationId,
						target: { segments: challenge.target },
						displayPath: challenge.displayPath,
						targetKind: challenge.targetKind,
						expiresAt: challenge.expiresAt,
					};
					open.deleteChallenge = wire;
					this.#broadcast("fs.delete.challenge", { projectId: open.project.id }, wire);
					break;
				}
				case "fs.delete.confirm": {
					const open = this.#requireOpen(command.payload.projectId);
					await this.#store.confirmDelete(command.payload);
					open.deleteChallenge = null;
					await this.#refreshTree(open, "fs.changed");
					break;
				}
				case "session.new": {
					const open = this.#requireOpen(command.payload.projectId);
					this.#resetProjection(open);
					await open.host.newSession();
					break;
				}
				case "session.load": {
					const open = this.#requireOpen(command.payload.projectId);
					this.#resetProjection(open);
					await open.host.loadSession(command.payload.sessionId);
					break;
				}
				case "session.close": {
					const open = this.#requireOpen(command.payload.projectId);
					await open.host.closeSession();
					this.#resetProjection(open);
					break;
				}
				case "session.list": {
					const open = this.#requireOpen(command.payload.projectId);
					await open.host.listSessions();
					break;
				}
				case "session.label": {
					const open = this.#requireOpen(command.payload.projectId);
					await open.host.labelSession(command.payload.sessionId, command.payload.label);
					break;
				}
				case "session.delete": {
					const open = this.#requireOpen(command.payload.projectId);
					await open.host.deleteSession(command.payload.sessionId);
					break;
				}
				case "turn.start": {
					const open = this.#requireOpen(command.payload.projectId);
					if (open.host.boundSessionPublicId === null && !open.host.hasActivePrompt) {
						this.#resetProjection(open);
						await open.host.newSession();
					}
					await open.host.startTurn(command.payload.prompt);
					break;
				}
				case "turn.cancel": {
					const open = this.#requireOpen(command.payload.projectId);
					await open.host.cancelTurn(command.payload.turnId, "operator");
					break;
				}
				case "permission.resolve": {
					const open = this.#requireOpen(command.payload.projectId);
					await open.host.resolvePermission(
						command.payload.turnId,
						command.payload.permissionId,
						command.payload.decision === "allow-once" ? "allow_once" : "reject_once",
					);
					break;
				}
				case "settings.get": {
					const open = this.#requireOpen(command.payload.projectId);
					await open.host.getSettings();
					break;
				}
				case "settings.patch": {
					const open = this.#requireOpen(command.payload.projectId);
					await open.host.patchSettings(command.payload.patch);
					break;
				}
				case "targets.list": {
					const open = this.#requireOpen(command.payload.projectId);
					await open.host.listTargets();
					break;
				}
				case "targets.probe": {
					const open = this.#requireOpen(command.payload.projectId);
					await open.host.probeTarget(command.payload.targetId);
					break;
				}
				case "autonomy.set": {
					const open = this.#requireOpen(command.payload.projectId);
					await open.host.setAutonomy(command.payload.level);
					break;
				}
			}
		} catch (error) {
			const projectId = "projectId" in command.payload && typeof command.payload.projectId === "string"
				? command.payload.projectId
				: undefined;
			const mapped = this.#commandError(error);
			session.send(
				"command.error",
				projectId === undefined ? {} : { projectId },
				{ ...mapped, requestId: command.requestId },
			);
		}
	}

	#resetProjection(open: OpenProject): void {
		open.projection = emptyTurnProjection;
	}

	/** Opens a real directory as the one open project, replacing whatever was open. */
	async #openPath(typedPath: string, recent: RecentProject | null): Promise<void> {
		if (this.#open?.host.hasActivePrompt) {
			throw new HostError(
				"conflict",
				"Clio is still working in the open project. Cancel the turn or wait before opening another project.",
			);
		}
		const resolved = await this.#state.resolveOpenable(typedPath);
		if (this.#open !== null && this.#open.project.identity.canonicalPath === resolved.canonicalPath) {
			this.#broadcast("project.opened", { projectId: this.#open.project.id }, {
				workspace: this.#workspaceDto(this.#open),
			});
			return;
		}
		await this.#closeOpen();
		const known = recent ?? this.#state.recentByPath(resolved.canonicalPath);
		const project = await this.#store.registerRoot({
			canonicalPath: resolved.canonicalPath,
			displayName: resolved.displayName,
			id: known?.id ?? `project-${crypto.randomUUID()}`,
		});
		await this.#state.remember({
			id: project.id,
			canonicalPath: resolved.canonicalPath,
			displayName: resolved.displayName,
		});
		const host = new ClioProjectHost({
			launcher: this.#launcher,
			project: { projectId: project.id, trustedRoot: resolved.canonicalPath, displayName: resolved.displayName },
			sink: this,
			...this.#hostOptions,
		});
		const open: OpenProject = {
			project,
			host,
			projection: emptyTurnProjection,
			tree: [],
			treeTruncated: false,
			deleteChallenge: null,
			configInspection: null,
			catalogInspection: null,
			usageInspection: null,
			routingInspection: null,
		};
		this.#open = open;
		try {
			const tree = await this.#store.getTree({ projectId: project.id, maxDepth: TREE_DEPTH, maxNodes: TREE_NODES });
			open.tree = (tree.root.children ?? []).map(treeNodeToWire);
			open.treeTruncated = tree.truncated;
		} catch {
			// The tree is presentation only; a later refresh may succeed.
		}
		try {
			await host.open();
			await host.primeSettings();
		} catch {
			// The host records the failure in its snapshot; the project is open regardless.
		}
		if (this.#open !== open) return;
		this.#broadcast("project.opened", { projectId: project.id }, { workspace: this.#workspaceDto(open) });
	}

	async #closeOpen(): Promise<void> {
		const open = this.#open;
		if (open === null) return;
		this.#open = null;
		this.#clearGrace();
		try {
			await open.host.close();
		} finally {
			this.#store.unregister(open.project.id);
		}
	}

	async #refreshTree(open: OpenProject, kind: "project.snapshot" | "fs.changed"): Promise<void> {
		const tree = await this.#store.getTree({ projectId: open.project.id, maxDepth: TREE_DEPTH, maxNodes: TREE_NODES });
		if (this.#open !== open) return;
		open.tree = (tree.root.children ?? []).map(treeNodeToWire);
		open.treeTruncated = tree.truncated;
		if (kind === "fs.changed") open.deleteChallenge = null;
		this.#broadcast(kind, { projectId: open.project.id }, { tree: open.tree, treeTruncated: open.treeTruncated });
	}

	#broadcast<K extends ServerEventKind>(kind: K, context: EventContext, payload: ServerEventPayloadByKind[K]): void {
		for (const socket of this.#sockets) socket.send(kind, context, payload);
	}

	// ---------------------------------------------------------------- sockets

	socketOpened(session: SocketSession): void {
		this.#clearGrace();
		session.send("connection.ready", {}, {});
		const open = this.#open;
		if (open !== null) {
			// The bootstrap the browser fetched may predate events on this socket; a
			// full snapshot on the same ordered stream closes that gap.
			session.send("project.opened", { projectId: open.project.id }, { workspace: this.#workspaceDto(open) });
		}
	}

	onSocketClosed(session: SocketSession): void {
		this.#sockets.delete(session);
		if (this.#closed || this.#sockets.size > 0) return;
		const open = this.#open;
		if (open === null || !open.host.hasActivePrompt) return;
		this.#clearGrace();
		this.#graceTimer = setTimeout(() => {
			this.#graceTimer = null;
			if (this.#closed || this.#sockets.size > 0 || this.#open !== open) return;
			void open.host.abandon().catch((error) => {
				if (!this.#quiet) console.error("Workbench could not stop the abandoned turn", error);
			});
		}, this.#disconnectGraceMs);
	}

	#clearGrace(): void {
		if (this.#graceTimer !== null) {
			clearTimeout(this.#graceTimer);
			this.#graceTimer = null;
		}
	}

	#upgrade(request: Request, url: URL): Response {
		if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return textResponse("WebSocket upgrade required", 426);
		}
		if (request.headers.get("origin") !== this.#origin || url.searchParams.get("token") !== this.token) {
			return textResponse("Local control channel authorization failed", 403);
		}
		// Deno sends a WebSocket ping and waits this many seconds for its pong;
		// browser clients answer automatically, so this health bound does not
		// shorten an otherwise idle permission deadline.
		const { socket, response } = Deno.upgradeWebSocket(request, { idleTimeout: 30 });
		const session = new SocketSession(this, socket);
		this.#sockets.add(session);
		socket.addEventListener("open", () => void this.#serialize(() => Promise.resolve(this.socketOpened(session))));
		return response;
	}

	async #serveStatic(request: Request, url: URL): Promise<Response> {
		if (request.method !== "GET" && request.method !== "HEAD") return textResponse("Method not allowed", 405);
		let pathname: string;
		try {
			pathname = decodeURIComponent(url.pathname);
		} catch {
			return textResponse("Invalid URL encoding", 400);
		}
		if (pathname.includes("\\") || pathname.split("/").some((segment) => segment === "..")) {
			return textResponse("Invalid asset path", 400);
		}
		const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
		let assetUrl = resolveStaticAsset(this.#distRoot, relativePath);
		if (assetUrl === null) return textResponse("Invalid asset path", 400);
		let bytes: Uint8Array;
		try {
			bytes = await Deno.readFile(assetUrl);
		} catch (error) {
			const acceptsHtml = request.headers.get("accept")?.includes("text/html") === true;
			if (!(error instanceof Deno.errors.NotFound) || !acceptsHtml || extname(relativePath) !== "") {
				return textResponse("Asset not found", 404);
			}
			assetUrl = resolveStaticAsset(this.#distRoot, "index.html");
			if (assetUrl === null) return textResponse("Invalid asset path", 400);
			try {
				bytes = await Deno.readFile(assetUrl);
			} catch {
				return textResponse("Workbench UI has not been built. Run deno task build.", 503);
			}
		}
		const headers = new Headers(STATIC_SECURITY_HEADERS);
		headers.set("content-type", MIME_TYPES[extname(assetUrl.pathname)] ?? "application/octet-stream");
		headers.set("cache-control", assetUrl.pathname.includes("/assets/") ? "public, max-age=3600" : "no-cache");
		return new Response(request.method === "HEAD" ? null : Uint8Array.from(bytes).buffer, { headers });
	}

	#commandError(error: unknown): { code: CommandErrorCode; message: string } {
		if (error instanceof ProjectStoreError) {
			const code: CommandErrorCode = error.code === "already_exists"
				? "conflict"
				: error.code === "not_found" || error.code === "project_not_found"
				? "not-found"
				: error.code === "root_changed" || error.code === "permission_denied"
				? "refused"
				: "invalid";
			return { code, message: error.message };
		}
		if (error instanceof WorkbenchStateError) return { code: error.code, message: error.message };
		if (error instanceof HostError) return { code: error.code, message: error.message };
		if (error instanceof ClioConfigInspectError) return { code: error.code, message: error.message };
		if (error instanceof ClioUsageInspectError) return { code: error.code, message: error.message };
		if (!this.#quiet) console.error("Workbench command failed", error);
		return { code: "internal", message: "The local command could not be completed." };
	}
}

class SocketSession {
	readonly #runtime: WorkbenchRuntime;
	readonly #socket: WebSocket;
	#sequence = 0;
	#closed = false;
	#notifiedClosed = false;

	constructor(runtime: WorkbenchRuntime, socket: WebSocket) {
		this.#runtime = runtime;
		this.#socket = socket;
		socket.addEventListener("message", (event) => this.#onMessage(event));
		socket.addEventListener("close", () => this.#markClosed());
		socket.addEventListener("error", () => this.#markClosed());
	}

	get closed(): boolean {
		return this.#closed;
	}

	send<K extends ServerEventKind>(kind: K, context: EventContext, payload: ServerEventPayloadByKind[K]): void {
		if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return;
		const sequence = this.#sequence + 1;
		const terminal = kind === "turn.terminal" || kind === "protocol.error";
		let event: ServerEvent;
		try {
			event = validateServerEvent({
				protocolVersion: PROTOCOL_VERSION,
				workspaceInstanceId: this.#runtime.workspaceInstanceId,
				sequence,
				eventId: `event-${String(sequence).padStart(6, "0")}`,
				kind,
				...context,
				terminal,
				payload,
			}) as ServerEvent;
		} catch (error) {
			// A DTO the host cannot validate never reaches the renderer; the socket
			// stays open and the failure is loud on stderr.
			console.error(`Workbench refused to send an invalid ${kind} event`, error);
			return;
		}
		const frame = encodeServerEvent(event);
		if (wouldExceedWebSocketHighWaterMark(this.#socket.bufferedAmount, encoder.encode(frame).byteLength)) {
			this.close(1008, SLOW_CLIENT_CLOSE_REASON);
			return;
		}
		try {
			this.#socket.send(frame);
			this.#sequence = sequence;
		} catch {
			this.close(1011, "Workbench could not send the server event");
		}
	}

	close(code: number, reason: string): void {
		if (this.#closed) return;
		this.#markClosed();
		try {
			this.#socket.close(code, reason);
		} catch {
			// The socket may already be closing as part of a browser shutdown.
		}
	}

	#markClosed(): void {
		this.#closed = true;
		if (this.#notifiedClosed) return;
		this.#notifiedClosed = true;
		this.#runtime.onSocketClosed(this);
	}

	#onMessage(event: MessageEvent): void {
		if (typeof event.data !== "string") {
			this.close(1003, "Workbench accepts text protocol frames only");
			return;
		}
		if (encoder.encode(event.data).byteLength > MAX_CLIENT_FRAME_BYTES) {
			this.close(1009, "Workbench client frame exceeded 16 KiB");
			return;
		}
		let command: ClientCommand;
		try {
			command = parseClientCommand(event.data);
		} catch (error) {
			const code = error instanceof ProtocolValidationError && error.code === "unsupported-version"
				? "unsupported-version"
				: "invalid-frame";
			const message = error instanceof Error ? error.message.slice(0, 240) : "The client frame was invalid.";
			this.send("protocol.error", {}, { code, message });
			this.close(
				error instanceof ProtocolValidationError && error.code === "frame-too-large" ? 1009 : 1002,
				INVALID_CLIENT_FRAME_CLOSE_REASON,
			);
			return;
		}
		void this.#runtime.handleCommand(this, command);
	}
}

export async function startWorkbenchServer(options: WorkbenchServerOptions = {}): Promise<RunningWorkbenchServer> {
	const hostname = options.hostname ?? DEFAULT_HOSTNAME;
	if (hostname !== DEFAULT_HOSTNAME) throw new Error("Workbench may bind only to 127.0.0.1.");
	const port = options.port ?? DEFAULT_PORT;
	const desktopAddress = options.mode === undefined ? Deno.env.get("DENO_SERVE_ADDRESS") : undefined;
	const mode = options.mode ?? (desktopAddress ? "desktop" : "browser");
	const state = await WorkbenchState.open({
		...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
		...(options.homePath === undefined ? {} : { homePath: options.homePath }),
		...(options.quiet ? { log: () => undefined } : {}),
	});
	const store = new ProjectStore();
	const runtime = new WorkbenchRuntime(store, state, {
		quiet: options.quiet ?? false,
		mode,
		distRoot: options.distRoot ?? new URL("./dist/", import.meta.url),
		disconnectGraceMs: options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS,
		...(options.clioLauncher === undefined ? {} : { clioLauncher: options.clioLauncher }),
		...(options.configInspector === undefined ? {} : { configInspector: options.configInspector }),
		...(options.catalogInspector === undefined ? {} : { catalogInspector: options.catalogInspector }),
		...(options.usageInspector === undefined ? {} : { usageInspector: options.usageInspector }),
		...(options.routingInspector === undefined ? {} : { routingInspector: options.routingInspector }),
		...(options.permissionEscalateMs === undefined ? {} : { permissionEscalateMs: options.permissionEscalateMs }),
		...(options.permissionBudgetMs === undefined ? {} : { permissionBudgetMs: options.permissionBudgetMs }),
		...(options.promptTimeoutMs === undefined ? {} : { promptTimeoutMs: options.promptTimeoutMs }),
		...(options.acpTiming === undefined ? {} : { acpTiming: options.acpTiming }),
	});

	let origin = "";
	const server = Deno.serve(
		{
			hostname,
			port,
			onListen(address) {
				const displayHostname = address.hostname.includes(":") ? `[${address.hostname}]` : address.hostname;
				origin = `http://${displayHostname}:${address.port}`;
				runtime.setOrigin(origin);
				if (!options.quiet) console.log(`${APP_NAME} ${mode} URL: ${origin}`);
			},
		},
		(request) => runtime.handleRequest(request),
	);
	if (!origin) {
		const address = server.addr;
		origin = `http://${address.hostname}:${address.port}`;
		runtime.setOrigin(origin);
	}

	let closed = false;
	return {
		server,
		url: origin,
		token: runtime.token,
		mode,
		workspaceInstanceId: runtime.workspaceInstanceId,
		stateDir: runtime.stateDir,
		async close() {
			if (closed) return;
			closed = true;
			await runtime.close();
			await server.shutdown();
		},
	};
}

async function runMain(): Promise<void> {
	const options = parseCliOptions(Deno.args);
	const running = await startWorkbenchServer({ port: options.port });
	if (options.smokeMs !== undefined) {
		setTimeout(async () => {
			await running.close();
			Deno.exit(0);
		}, options.smokeMs);
	}
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		try {
			Deno.addSignalListener(signal, async () => {
				await running.close();
				Deno.exit(0);
			});
		} catch {
			// Desktop targets do not expose every POSIX signal.
		}
	}
	await running.server.finished;
}

if (import.meta.main) await runMain();
