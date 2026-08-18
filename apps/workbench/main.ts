import { extname, join } from "node:path";
import {
	type ClioLauncher,
	createLocalClioLauncher,
	EngineCoordinator,
	EngineError,
	type EngineEvent,
	type EnginePhase,
	type EngineProject,
	type EngineSink,
} from "./engine.ts";
import { ProjectStore, ProjectStoreError, type ProjectSummary, type ProjectTreeNode } from "./project-store.ts";
import {
	type ClientCommand,
	encodeServerEvent,
	MAX_CLIENT_FRAME_BYTES,
	parseClientCommand,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	type ServerEvent,
	type ServerEventKind,
	type ServerEventPayloadByKind,
	validateServerEvent,
	type WireProjectWorkspace,
	type WireTreeNode,
} from "./src/protocol.ts";

const APP_NAME = "Clio Workbench" as const;
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 4173;
const DEFAULT_EVENT_DELAY_MS = 145;
const INVALID_CLIENT_FRAME_CLOSE_REASON = "Invalid Workbench client protocol frame";
const SLOW_CLIENT_CLOSE_REASON = "Workbench client fell behind";
const BOOTSTRAP_BLOCKING_PHASES: ReadonlySet<EnginePhase> = new Set([
	"probing",
	"starting",
	"connected",
	"running",
	"awaiting-approval",
	"cancelling",
]);
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

export function wouldExceedWebSocketHighWaterMark(bufferedAmount: number, encodedFrameBytes: number): boolean {
	if (
		!Number.isSafeInteger(bufferedAmount) || bufferedAmount < 0 ||
		!Number.isSafeInteger(encodedFrameBytes) || encodedFrameBytes < 0
	) return true;
	return bufferedAmount > MAX_WEBSOCKET_OUTBOUND_BYTES - encodedFrameBytes;
}

interface RuntimeCliOptions {
	dataDir: string;
	port: number;
	smokeMs?: number;
}

export interface WorkbenchServerOptions {
	dataDir: string;
	hostname?: string;
	port?: number;
	eventDelayMs?: number;
	quiet?: boolean;
	mode?: "browser" | "desktop";
	distRoot?: URL;
	clioLauncher?: ClioLauncher;
	engineCoordinator?: EngineCoordinator;
}

export interface RunningWorkbenchServer {
	readonly server: Deno.HttpServer<Deno.NetAddr>;
	readonly url: string;
	readonly token: string;
	readonly mode: "browser" | "desktop";
	readonly workspaceInstanceId: string;
	readonly store: ProjectStore;
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
	let dataDir = ".workbench-data";
	let port = DEFAULT_PORT;
	let smokeMs: number | undefined;
	for (const argument of args) {
		if (argument.startsWith("--data-dir=")) dataDir = argument.slice("--data-dir=".length);
		else if (argument.startsWith("--port=")) {
			port = parsePositiveInteger(argument.slice("--port=".length), "port", 65_535);
		} else if (argument.startsWith("--smoke-ms=")) {
			smokeMs = parsePositiveInteger(argument.slice("--smoke-ms=".length), "smoke-ms", 120_000);
		} else throw new Error(`Unknown Workbench argument: ${argument}`);
	}
	if (dataDir.length === 0) throw new Error("data-dir cannot be empty.");
	return { dataDir, port, ...(smokeMs === undefined ? {} : { smokeMs }) };
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

class BootstrapBusyError extends Error {
	constructor() {
		super("Workbench is settling an active engine operation before bootstrap.");
		this.name = "BootstrapBusyError";
	}
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

function displayPathFor(project: ProjectSummary): string {
	if (project.identity.kind === "local-sandbox") {
		return `sandbox://${project.identity.sandboxId}/${project.identity.relativeRoot.join("/")}`;
	}
	if (project.identity.kind === "wsl") return `WSL ${project.identity.distro} project`;
	return `${project.identity.platform} native project`;
}

function projectIdentityToWire(project: ProjectSummary): WireProjectWorkspace["project"]["identity"] {
	return project.identity.kind === "wsl"
		? { kind: "wsl", displayPath: displayPathFor(project), distro: project.identity.distro }
		: { kind: project.identity.kind, displayPath: displayPathFor(project) };
}

function initialTimeline(projectId: string): WireProjectWorkspace["timeline"] {
	if (projectId !== "project-atlas-0001") return [];
	return [
		{
			id: "history-atlas-request",
			kind: "request",
			title: "Establish the convergence-study baseline",
			summary: "A preserved scaffold note demonstrating project-keyed session history.",
			status: "complete",
			timeLabel: "earlier",
		},
		{
			id: "history-atlas-outcome",
			kind: "outcome",
			title: "Baseline recorded",
			summary: "Presentation fixture only — no real check, edit, or Clio turn is claimed.",
			status: "complete",
			timeLabel: "earlier",
		},
	];
}

/**
 * Selects the product launcher for the host platform. Native Windows launch is
 * deliberately unavailable: `wslAcpLaunch` remains a typed integration seam,
 * not a product path or a claim that descendants of `wsl.exe` are owned.
 */
export function defaultClioLauncher(platform = Deno.build.os): ClioLauncher {
	if (platform !== "windows") return createLocalClioLauncher();
	return {
		probe() {
			return Promise.reject(
				new EngineError(
					"not-ready",
					"Native Windows Clio launch is unavailable until a WSL project mapping is configured.",
				),
			);
		},
		launch() {
			throw new EngineError("not-ready", "Native Windows Clio launch requires an explicit WSL configuration.");
		},
	};
}

class WorkbenchRuntime {
	readonly workspaceInstanceId = `workspace-${crypto.randomUUID()}`;
	readonly token = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`;
	readonly #store: ProjectStore;
	readonly #mode: "browser" | "desktop";
	readonly #quiet: boolean;
	readonly #distRoot: URL;
	readonly #engine: EngineCoordinator;
	readonly #sockets = new Set<SocketSession>();
	#origin = "";
	#activeTurn: Readonly<{ owner: SocketSession; projectId: string; turnId: string }> | null = null;
	#commandQueue: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(
		store: ProjectStore,
		options:
			& Required<Pick<WorkbenchServerOptions, "eventDelayMs" | "quiet" | "mode" | "distRoot">>
			& Pick<WorkbenchServerOptions, "clioLauncher" | "engineCoordinator">,
	) {
		this.#store = store;
		this.#quiet = options.quiet;
		this.#mode = options.mode;
		this.#distRoot = normalizeStaticRoot(options.distRoot);
		if (options.clioLauncher !== undefined && options.engineCoordinator !== undefined) {
			throw new Error("Configure either a Clio launcher or an engine coordinator, not both.");
		}
		this.#engine = options.engineCoordinator ?? new EngineCoordinator({
			launcher: options.clioLauncher ?? defaultClioLauncher(),
			eventDelayMs: options.eventDelayMs,
		});
	}

	setOrigin(origin: string): void {
		this.#origin = origin;
	}

	bootstrap(): Promise<Record<string, unknown>> {
		return this.#serialize(() => this.#buildBootstrap());
	}

	async #buildBootstrap(): Promise<Record<string, unknown>> {
		if (
			this.#store.listProjects().some((project) =>
				BOOTSTRAP_BLOCKING_PHASES.has(this.#engine.snapshot(project.id).phase)
			)
		) throw new BootstrapBusyError();
		const projects = await Promise.all(this.#store.listProjects().map((project) => this.workspace(project.id)));
		const selectedProjectId = projects[0]?.project.id;
		if (!selectedProjectId) throw new Error("The controlled sandbox has no seeded project.");
		return {
			protocolVersion: PROTOCOL_VERSION,
			appName: APP_NAME,
			workspaceInstanceId: this.workspaceInstanceId,
			localToken: this.token,
			mode: this.#mode,
			selectedProjectId,
			projects,
			registerableSandboxFolders: await this.#registerableFolders(),
			sandboxLabel: "Controlled local scaffold sandbox",
			securityNote:
				"Segment-array paths, bounded trees, blocked symlinks, no-clobber creates, and one-use delete challenges protect this sandbox. Production project access still needs handle-relative native/WSL helpers to close external TOCTOU races.",
		};
	}

	async workspace(projectId: string): Promise<WireProjectWorkspace> {
		const project = this.#store.getProject(projectId);
		const tree = await this.#store.getTree({ projectId, maxDepth: 5, maxNodes: 200 });
		const hasHistory = project.id === "project-atlas-0001";
		return {
			project: {
				id: project.id,
				displayName: project.displayName,
				identity: projectIdentityToWire(project),
				lastOpenedAt: project.lastOpenedAt,
			},
			tree: (tree.root.children ?? []).map(treeNodeToWire),
			treeTruncated: tree.truncated,
			sessions: hasHistory
				? [
					{
						id: "session-atlas-baseline",
						label: "Convergence baseline",
						preview: "Presentation fixture — no persisted Clio transcript",
						updatedAt: project.lastOpenedAt,
						status: "complete",
					},
				]
				: [],
			selectedSessionId: hasHistory ? "session-atlas-baseline" : null,
			timeline: initialTimeline(project.id),
			engine: this.#engine.snapshot(project.id),
			pendingPermission: null,
			deleteChallenge: null,
			agents: [],
			changes: [],
			evidence: [],
			engineGeneration: null,
			activeTurnId: null,
			lastSequence: 0,
		};
	}

	async handleRequest(request: Request): Promise<Response> {
		if (!this.#origin || new URL(request.url).origin !== this.#origin) {
			return textResponse("Misdirected localhost request", 421);
		}
		const url = new URL(request.url);
		if (url.pathname === "/api/bootstrap") {
			if (request.method !== "GET") return textResponse("Method not allowed", 405);
			try {
				return jsonResponse(await this.bootstrap());
			} catch (error) {
				if (error instanceof BootstrapBusyError) return jsonResponse({ error: "engine-busy" }, 409);
				throw error;
			}
		}
		if (url.pathname === "/api/events") return this.#upgrade(request, url);
		if (url.pathname.startsWith("/api/")) return jsonResponse({ error: "not-found" }, 404);
		return await this.#serveStatic(request, url);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#commandQueue.catch(() => undefined);
		await this.#engine.close();
		for (const session of this.#sockets) session.close(1001, "Workbench is shutting down");
		this.#sockets.clear();
	}

	handleCommand(session: SocketSession, command: ClientCommand): Promise<void> {
		return this.#serialize(() => this.#dispatchCommand(session, command));
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const queued = this.#commandQueue.then(operation);
		this.#commandQueue = queued.then(() => undefined, () => undefined);
		return queued;
	}

	async #dispatchCommand(session: SocketSession, command: ClientCommand): Promise<void> {
		try {
			if (this.#closed || session.closed) throw new EngineError("not-ready", "The local client is closed.");
			switch (command.kind) {
				case "project.create": {
					const project = await this.#store.createProject(command.payload);
					session.send("project.created", { projectId: project.id }, { workspace: await this.workspace(project.id) });
					break;
				}
				case "project.register": {
					const project = await this.#store.registerProject(command.payload);
					session.send("project.registered", { projectId: project.id }, {
						workspace: await this.workspace(project.id),
					});
					break;
				}
				case "project.select":
					this.#store.getProject(command.payload.projectId);
					if (this.#activeTurn !== null) {
						throw new EngineError("conflict", "Cancel the active turn before switching projects.");
					}
					session.send("project.selected", { projectId: command.payload.projectId }, {});
					break;
				case "fs.refresh":
					await this.#sendTree(session, command.payload.projectId, "project.snapshot");
					break;
				case "fs.create-file":
					await this.#store.createFile(command.payload);
					await this.#sendTree(session, command.payload.projectId, "fs.changed");
					break;
				case "fs.create-folder":
					await this.#store.createFolder(command.payload);
					await this.#sendTree(session, command.payload.projectId, "fs.changed");
					break;
				case "fs.move":
					await this.#store.moveEntry(command.payload);
					await this.#sendTree(session, command.payload.projectId, "fs.changed");
					break;
				case "fs.delete.prepare": {
					const challenge = await this.#store.prepareDelete(command.payload);
					session.send(
						"fs.delete.challenge",
						{ projectId: challenge.projectId },
						{
							confirmationId: challenge.confirmationId,
							target: { segments: challenge.target },
							displayPath: challenge.displayPath,
							targetKind: challenge.targetKind,
							expiresAt: challenge.expiresAt,
						},
					);
					break;
				}
				case "fs.delete.confirm":
					await this.#store.confirmDelete(command.payload);
					await this.#sendTree(session, command.payload.projectId, "fs.changed");
					break;
				case "engine.select": {
					const project = await this.#engineProject(command.payload.projectId);
					if (session.closed) throw new EngineError("not-ready", "The local client is closed.");
					this.#engine.select(session, project, command.payload.kind);
					break;
				}
				case "engine.probe": {
					const project = await this.#engineProject(command.payload.projectId);
					if (session.closed) throw new EngineError("not-ready", "The local client is closed.");
					await this.#engine.probe(session, project);
					break;
				}
				case "turn.start": {
					const project = await this.#engineProject(command.payload.projectId);
					if (session.closed) throw new EngineError("not-ready", "The local client is closed.");
					const snapshot = this.#engine.snapshot(project.projectId);
					if (snapshot.kind === "clio-acp" && command.payload.fakeScenario !== undefined) {
						throw new EngineError("invalid", "A fake scenario is valid only for the fake engine.");
					}
					const context = await this.#engine.start({
						owner: session,
						project,
						prompt: command.payload.prompt,
						...(command.payload.fakeScenario === undefined ? {} : { fakeScenario: command.payload.fakeScenario }),
					});
					if (session.closed) {
						await this.#engine.disconnect(session);
						break;
					}
					if (BOOTSTRAP_BLOCKING_PHASES.has(this.#engine.snapshot(context.projectId).phase)) {
						this.#activeTurn ??= {
							owner: session,
							projectId: context.projectId,
							turnId: context.turnId,
						};
					}
					break;
				}
				case "turn.cancel":
					await this.#engine.cancel({
						owner: session,
						projectId: command.payload.projectId,
						turnId: command.payload.turnId,
					});
					break;
				case "permission.resolve":
					await this.#engine.resolvePermission({
						owner: session,
						projectId: command.payload.projectId,
						turnId: command.payload.turnId,
						permissionId: command.payload.permissionId,
						decision: command.payload.decision === "allow-once" ? "allow_once" : "reject_once",
					});
					break;
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

	onSocketClosed(session: SocketSession): void {
		this.#sockets.delete(session);
		if (this.#closed) return;
		void this.#serialize(() => this.#engine.disconnect(session)).catch((error) => {
			if (!this.#quiet) console.error("Workbench engine disconnect cleanup failed", error);
		});
	}

	emitEngineEvent(session: SocketSession, event: EngineEvent): void {
		if (event.type === "engine.state") {
			session.send("engine.state", { projectId: event.projectId }, { snapshot: event.snapshot });
			return;
		}
		const context = {
			projectId: event.context.projectId,
			engineGeneration: event.context.generation,
			sessionId: event.context.sessionId,
			turnId: event.context.turnId,
		};
		switch (event.type) {
			case "turn.started":
				this.#activeTurn = { owner: session, projectId: event.context.projectId, turnId: event.context.turnId };
				session.send("turn.started", context, {
					promptSummary: event.promptSummary,
					...(event.scenario === undefined ? {} : { fakeScenario: event.scenario }),
					source: event.source,
				});
				break;
			case "turn.text":
			case "turn.thought":
				session.send(event.type, context, { text: event.text, source: event.source });
				break;
			case "turn.agent":
				session.send("turn.agent", context, {
					agentId: event.agentId,
					name: event.name,
					task: event.task,
					status: event.status,
					summary: event.summary,
					source: event.source,
				});
				break;
			case "turn.tool":
				session.send("turn.tool", context, {
					toolCallId: event.toolCallId,
					title: event.title,
					kind: event.kind,
					status: event.status,
					summary: event.summary,
					locations: event.locations.map((segments) => ({ segments })),
					source: event.source,
				});
				break;
			case "turn.change":
				session.send("turn.change", context, {
					path: { segments: event.path },
					summary: event.summary,
					source: event.source,
				});
				break;
			case "turn.permission.requested":
				session.send("turn.permission.requested", context, {
					permissionId: event.permissionId,
					toolCallId: event.toolCallId,
					title: event.title,
					kind: event.kind,
					locations: event.locations.map((segments) => ({ segments })),
					expiresAt: event.expiresAt,
					source: event.source,
				});
				break;
			case "turn.permission.resolved":
				session.send("turn.permission.resolved", context, {
					permissionId: event.permissionId,
					decision: event.decision === "allow_once"
						? "allow-once"
						: event.decision === "reject_once"
						? "reject"
						: event.decision,
					source: event.source,
				});
				break;
			case "turn.evidence":
				session.send("turn.evidence", context, {
					label: event.label,
					detail: event.detail,
					status: event.status,
					source: event.source,
				});
				break;
			case "turn.terminal":
				session.send("turn.terminal", context, {
					outcome: event.outcome,
					code: event.code,
					summary: event.summary,
					...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
					...(event.usage === undefined ? {} : { usage: event.usage }),
					source: event.source,
				});
				if (
					this.#activeTurn?.owner === session && this.#activeTurn.projectId === event.context.projectId &&
					this.#activeTurn.turnId === event.context.turnId
				) this.#activeTurn = null;
				break;
		}
	}

	async refreshProject(session: SocketSession, projectId: string): Promise<void> {
		if (!session.closed) await this.#sendTree(session, projectId, "project.snapshot");
	}

	async #engineProject(projectId: string): Promise<EngineProject> {
		const project = this.#store.getProject(projectId);
		const trustedRoot = await this.#store.resolveTrustedRoot(projectId);
		return { projectId: project.id, trustedRoot, displayName: project.displayName };
	}

	#registerableFolders(): string[] {
		const registered = new Set(
			this.#store.listProjects().flatMap((project) =>
				project.identity.kind === "local-sandbox" && project.identity.relativeRoot.length === 1
					? [project.identity.relativeRoot[0] as string]
					: []
			),
		);
		return ["cryosphere-notes"].filter((folder) => !registered.has(folder));
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
		socket.addEventListener("open", () => session.send("connection.ready", {}, {}));
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

	async #sendTree(session: SocketSession, projectId: string, kind: "project.snapshot" | "fs.changed"): Promise<void> {
		const tree = await this.#store.getTree({ projectId, maxDepth: 5, maxNodes: 200 });
		session.send(
			kind,
			{ projectId },
			{ tree: (tree.root.children ?? []).map(treeNodeToWire), treeTruncated: tree.truncated },
		);
	}

	#commandError(
		error: unknown,
	): { code: "invalid" | "conflict" | "not-found" | "not-ready" | "internal"; message: string } {
		if (error instanceof ProjectStoreError) {
			const code = error.code === "already_exists" || error.code === "project_overlap"
				? "conflict"
				: error.code === "not_found" || error.code === "project_not_found"
				? "not-found"
				: "invalid";
			return { code, message: error.message };
		}
		if (error instanceof EngineError) return { code: error.code, message: error.message };
		if (!this.#quiet) console.error("Workbench command failed", error);
		return { code: "internal", message: "The local command could not be completed." };
	}
}

class SocketSession implements EngineSink {
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

	emit(event: EngineEvent): void {
		this.#runtime.emitEngineEvent(this, event);
	}

	async refreshProject(projectId: string): Promise<void> {
		await this.#runtime.refreshProject(this, projectId);
	}

	send<K extends ServerEventKind>(
		kind: K,
		context: { projectId?: string; engineGeneration?: string; sessionId?: string; turnId?: string },
		payload: ServerEventPayloadByKind[K],
	): void {
		if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return;
		const sequence = this.#sequence + 1;
		const terminal = kind === "turn.terminal" || kind === "protocol.error";
		const event = validateServerEvent({
			protocolVersion: PROTOCOL_VERSION,
			workspaceInstanceId: this.#runtime.workspaceInstanceId,
			sequence,
			eventId: `event-${String(sequence).padStart(6, "0")}`,
			kind,
			...context,
			terminal,
			payload,
		}) as ServerEvent;
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

async function ensureSeedEntry(operation: () => Promise<unknown>): Promise<void> {
	try {
		await operation();
	} catch (error) {
		if (!(error instanceof ProjectStoreError && error.code === "already_exists")) throw error;
	}
}

async function createProjectStore(dataDir: string): Promise<ProjectStore> {
	const sandboxRoot = join(dataDir, "projects");
	const store = await ProjectStore.open({
		sandboxRoot,
		sandboxId: "scaffold-v1",
		seeds: [
			{
				id: "project-atlas-0001",
				displayName: "Atlas Field Study",
				relativeRoot: ["atlas-field-study"],
				createIfMissing: true,
			},
			{
				id: "project-spectra-0002",
				displayName: "Spectra Lab",
				relativeRoot: ["spectra-lab"],
				createIfMissing: true,
			},
		],
	});

	await ensureSeedEntry(() => store.createFile({ projectId: "project-atlas-0001", parent: [], name: "README.md" }));
	await ensureSeedEntry(() => store.createFolder({ projectId: "project-atlas-0001", parent: [], name: "analysis" }));
	await ensureSeedEntry(() =>
		store.createFile({ projectId: "project-atlas-0001", parent: ["analysis"], name: "convergence-notes.md" })
	);
	await ensureSeedEntry(() => store.createFolder({ projectId: "project-atlas-0001", parent: [], name: "data" }));
	await ensureSeedEntry(() =>
		store.createFile({ projectId: "project-atlas-0001", parent: ["data"], name: "mesh-study.csv" })
	);
	await ensureSeedEntry(() =>
		store.createFile({ projectId: "project-spectra-0002", parent: [], name: "experiment.toml" })
	);
	await ensureSeedEntry(() => store.createFolder({ projectId: "project-spectra-0002", parent: [], name: "notebooks" }));
	await ensureSeedEntry(() =>
		store.createFile({ projectId: "project-spectra-0002", parent: ["notebooks"], name: "line-fit.md" })
	);
	await Deno.mkdir(join(sandboxRoot, "cryosphere-notes"), { recursive: true });
	return store;
}

export async function startWorkbenchServer(options: WorkbenchServerOptions): Promise<RunningWorkbenchServer> {
	const hostname = options.hostname ?? DEFAULT_HOSTNAME;
	if (hostname !== DEFAULT_HOSTNAME) throw new Error("Workbench may bind only to 127.0.0.1.");
	const port = options.port ?? DEFAULT_PORT;
	const desktopAddress = options.mode === undefined ? Deno.env.get("DENO_SERVE_ADDRESS") : undefined;
	const mode = options.mode ?? (desktopAddress ? "desktop" : "browser");
	const store = await createProjectStore(options.dataDir);
	const runtime = new WorkbenchRuntime(store, {
		eventDelayMs: options.eventDelayMs ?? DEFAULT_EVENT_DELAY_MS,
		quiet: options.quiet ?? false,
		mode,
		distRoot: options.distRoot ?? new URL("./dist/", import.meta.url),
		...(options.clioLauncher === undefined ? {} : { clioLauncher: options.clioLauncher }),
		...(options.engineCoordinator === undefined ? {} : { engineCoordinator: options.engineCoordinator }),
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
		store,
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
	const running = await startWorkbenchServer({ dataDir: options.dataDir, port: options.port });
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
