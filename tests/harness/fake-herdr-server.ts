/**
 * A newline-delimited-JSON Unix-socket server that answers the herdr wire
 * surface Clio's mux domain speaks.
 *
 * The response shapes here are transcribed from `herdr api schema --json`
 * (protocol 17, herdr 0.7.5): the `ResponseResult` variant names, the required
 * fields on `PaneInfo` / `TabInfo` / `WorkspaceInfo` / `SessionSnapshot`, and
 * the `{"event":"pane_closed","data":{...}}` envelope lifecycle subscriptions
 * push. Encoding them here is deliberate. When the pinned herdr version moves
 * and a shape changes, these fixtures fail in CI rather than in a live session.
 *
 * Handlers are scriptable per method so a test can inject an error code, hang a
 * request to exercise the timeout path, or drop connections mid-stream.
 */

import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeHerdrRequest {
	connectionId: number;
	id: string;
	method: string;
	params: Record<string, unknown>;
}

/**
 * What a handler does with a request. `hang` writes nothing, which is how the
 * per-request timeout is exercised without a sleeping server.
 */
export type FakeHerdrOutcome =
	| { result: Record<string, unknown> }
	| { error: { code: string; message: string } }
	| { hang: true };

export type FakeHerdrHandler = (request: FakeHerdrRequest, server: FakeHerdrServer) => FakeHerdrOutcome;

export interface FakeHerdrPane {
	paneId: string;
	tabId: string;
	workspaceId: string;
}

export interface FakeHerdrServerOptions {
	version?: string;
	protocol?: number;
	/** Pane ids present at boot, in order. The first is Clio's own pane. */
	panes?: ReadonlyArray<FakeHerdrPane>;
}

export interface FakeHerdrServer {
	readonly socketPath: string;
	readonly requests: ReadonlyArray<FakeHerdrRequest>;
	requestsFor(method: string): ReadonlyArray<FakeHerdrRequest>;
	setHandler(method: string, handler: FakeHerdrHandler | null): void;
	/** Panes the server currently believes exist. */
	panes(): ReadonlyArray<FakeHerdrPane>;
	addPane(pane: FakeHerdrPane): void;
	removePane(paneId: string): void;
	/** Push one lifecycle event to every open subscription connection. */
	pushEvent(kind: "pane_closed" | "pane_exited", pane: { paneId: string; workspaceId: string }): void;
	/** Number of connections that completed an `events.subscribe`. */
	subscriptionCount(): number;
	connectionCount(): number;
	/** Destroy every open connection, as a `kill -9` on the server would. */
	dropConnections(): void;
	stop(): Promise<void>;
}

interface Connection {
	id: number;
	socket: net.Socket;
	subscribed: boolean;
}

const DEFAULT_PANES: ReadonlyArray<FakeHerdrPane> = [{ paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" }];

function paneInfo(pane: FakeHerdrPane, focused = false): Record<string, unknown> {
	return {
		pane_id: pane.paneId,
		terminal_id: `term_${pane.paneId.replace(":", "_")}`,
		workspace_id: pane.workspaceId,
		tab_id: pane.tabId,
		focused,
		agent_status: "unknown",
		revision: 1,
		label: null,
		title: null,
		cwd: "/tmp",
		agent: null,
		tokens: {},
		state_labels: {},
	};
}

function tabInfo(tabId: string, workspaceId: string, label: string, paneCount: number): Record<string, unknown> {
	return {
		tab_id: tabId,
		workspace_id: workspaceId,
		number: Number.parseInt(tabId.split(":t")[1] ?? "1", 10),
		label,
		focused: false,
		pane_count: paneCount,
		agent_status: "unknown",
	};
}

export async function startFakeHerdrServer(options: FakeHerdrServerOptions = {}): Promise<FakeHerdrServer> {
	const version = options.version ?? "0.7.5";
	const protocol = options.protocol ?? 17;
	const dir = mkdtempSync(join(tmpdir(), "clio-mux-"));
	const socketPath = join(dir, "h.sock");

	const requests: FakeHerdrRequest[] = [];
	const connections = new Map<number, Connection>();
	const handlers = new Map<string, FakeHerdrHandler>();
	const panes: FakeHerdrPane[] = [...(options.panes ?? DEFAULT_PANES)];
	const tabLabels = new Map<string, string>([["w1:t1", "shell"]]);
	let nextConnectionId = 0;
	let nextTab = 1;
	let nextPane = panes.length;

	let server!: FakeHerdrServer;

	const tabsInPlay = (): Record<string, unknown>[] => {
		const ids = [...new Set(panes.map((pane) => pane.tabId))];
		for (const id of tabLabels.keys()) if (!ids.includes(id)) ids.push(id);
		return ids.map((tabId) =>
			tabInfo(tabId, "w1", tabLabels.get(tabId) ?? "shell", panes.filter((pane) => pane.tabId === tabId).length),
		);
	};

	const snapshot = (): Record<string, unknown> => ({
		version,
		protocol,
		focused_workspace_id: "w1",
		focused_tab_id: "w1:t1",
		focused_pane_id: panes[0]?.paneId ?? null,
		workspaces: [
			{
				workspace_id: "w1",
				number: 1,
				label: "main",
				focused: true,
				pane_count: panes.length,
				tab_count: tabsInPlay().length,
				active_tab_id: "w1:t1",
				agent_status: "unknown",
				tokens: {},
			},
		],
		tabs: tabsInPlay(),
		panes: panes.map((pane, index) => paneInfo(pane, index === 0)),
		layouts: [],
		agents: [],
	});

	const defaultHandler = (request: FakeHerdrRequest): FakeHerdrOutcome => {
		const { method, params } = request;
		switch (method) {
			case "ping":
				return { result: { type: "pong", protocol, version, capabilities: { live_handoff: false } } };
			case "session.snapshot":
				return { result: { type: "session_snapshot", snapshot: snapshot() } };
			case "pane.current": {
				const pane = panes[0];
				if (!pane) return { error: { code: "pane_not_found", message: "pane not found" } };
				return { result: { type: "pane_current", pane: paneInfo(pane, true) } };
			}
			case "pane.list":
				return { result: { type: "pane_list", panes: panes.map((pane) => paneInfo(pane)) } };
			case "pane.get": {
				const pane = panes.find((entry) => entry.paneId === params.pane_id);
				if (!pane) return { error: { code: "pane_not_found", message: "pane not found" } };
				return { result: { type: "pane_info", pane: paneInfo(pane) } };
			}
			case "pane.split": {
				const targetId = typeof params.target_pane_id === "string" ? params.target_pane_id : panes[0]?.paneId;
				const target = panes.find((entry) => entry.paneId === targetId);
				if (!target) return { error: { code: "pane_not_found", message: "pane not found" } };
				nextPane += 1;
				const created: FakeHerdrPane = {
					paneId: `w1:p${nextPane}`,
					tabId: target.tabId,
					workspaceId: target.workspaceId,
				};
				panes.push(created);
				return { result: { type: "pane_info", pane: paneInfo(created) } };
			}
			case "pane.close": {
				const index = panes.findIndex((entry) => entry.paneId === params.pane_id);
				if (index < 0) return { error: { code: "pane_not_found", message: "pane not found" } };
				panes.splice(index, 1);
				return { result: { type: "ok" } };
			}
			case "pane.layout": {
				const pane = panes.find((entry) => entry.paneId === params.pane_id) ?? panes[0];
				if (!pane) return { error: { code: "pane_layout_unavailable", message: "pane layout unavailable" } };
				const area = { x: 0, y: 0, width: 200, height: 50 };
				return {
					result: {
						type: "pane_layout",
						layout: {
							workspace_id: pane.workspaceId,
							tab_id: pane.tabId,
							zoomed: false,
							area,
							focused_pane_id: pane.paneId,
							panes: panes
								.filter((entry) => entry.tabId === pane.tabId)
								.map((entry) => ({ pane_id: entry.paneId, focused: entry.paneId === pane.paneId, rect: area })),
							splits: [],
						},
					},
				};
			}
			case "tab.create": {
				nextTab += 1;
				const tabId = `w1:t${nextTab}`;
				nextPane += 1;
				const root: FakeHerdrPane = { paneId: `w1:p${nextPane}`, tabId, workspaceId: "w1" };
				panes.push(root);
				tabLabels.set(tabId, typeof params.label === "string" ? params.label : "shell");
				return {
					result: {
						type: "tab_created",
						tab: tabInfo(tabId, "w1", tabLabels.get(tabId) ?? "shell", 1),
						root_pane: paneInfo(root),
					},
				};
			}
			case "tab.list":
				return { result: { type: "tab_list", tabs: tabsInPlay() } };
			case "tab.focus": {
				const tabId = typeof params.tab_id === "string" ? params.tab_id : "";
				if (!tabLabels.has(tabId)) return { error: { code: "tab_not_found", message: "tab not found" } };
				return {
					result: {
						type: "tab_info",
						tab: tabInfo(tabId, "w1", tabLabels.get(tabId) ?? "shell", panes.filter((p) => p.tabId === tabId).length),
					},
				};
			}
			case "pane.send_text":
			case "pane.report_agent":
			case "pane.report_metadata":
				return { result: { type: "ok" } };
			case "events.subscribe":
				return { result: { type: "subscription_started" } };
			default:
				return { error: { code: "invalid_request", message: `unknown method ${method}` } };
		}
	};

	const write = (connection: Connection, payload: Record<string, unknown>): void => {
		if (connection.socket.destroyed) return;
		connection.socket.write(`${JSON.stringify(payload)}\n`);
	};

	const onLine = (connection: Connection, line: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== "object") return;
		const message = parsed as Record<string, unknown>;
		const id = typeof message.id === "string" ? message.id : "";
		const method = typeof message.method === "string" ? message.method : "";
		const rawParams = message.params;
		const request: FakeHerdrRequest = {
			connectionId: connection.id,
			id,
			method,
			params: rawParams && typeof rawParams === "object" ? (rawParams as Record<string, unknown>) : {},
		};
		requests.push(request);
		const outcome = (handlers.get(method) ?? defaultHandler)(request, server);
		if ("hang" in outcome) return;
		if ("error" in outcome) {
			write(connection, { id, error: outcome.error });
			return;
		}
		write(connection, { id, result: outcome.result });
		if (method === "events.subscribe") connection.subscribed = true;
	};

	const listener = net.createServer((socket) => {
		nextConnectionId += 1;
		const connection: Connection = { id: nextConnectionId, socket, subscribed: false };
		connections.set(connection.id, connection);
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length > 0) onLine(connection, line);
				newline = buffer.indexOf("\n");
			}
		});
		socket.on("error", () => connections.delete(connection.id));
		socket.on("close", () => connections.delete(connection.id));
	});

	await new Promise<void>((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(socketPath, () => {
			listener.removeListener("error", reject);
			resolve();
		});
	});

	server = {
		socketPath,
		requests,
		requestsFor(method: string): ReadonlyArray<FakeHerdrRequest> {
			return requests.filter((request) => request.method === method);
		},
		setHandler(method: string, handler: FakeHerdrHandler | null): void {
			if (handler) handlers.set(method, handler);
			else handlers.delete(method);
		},
		panes(): ReadonlyArray<FakeHerdrPane> {
			return [...panes];
		},
		addPane(pane: FakeHerdrPane): void {
			panes.push(pane);
		},
		removePane(paneId: string): void {
			const index = panes.findIndex((entry) => entry.paneId === paneId);
			if (index >= 0) panes.splice(index, 1);
		},
		pushEvent(kind, pane): void {
			for (const connection of connections.values()) {
				if (!connection.subscribed) continue;
				write(connection, {
					event: kind,
					data: { type: kind, pane_id: pane.paneId, workspace_id: pane.workspaceId },
				});
			}
		},
		subscriptionCount(): number {
			let count = 0;
			for (const connection of connections.values()) if (connection.subscribed) count += 1;
			return count;
		},
		connectionCount(): number {
			return connections.size;
		},
		dropConnections(): void {
			for (const connection of [...connections.values()]) {
				connections.delete(connection.id);
				connection.socket.destroy();
			}
		},
		async stop(): Promise<void> {
			server.dropConnections();
			await new Promise<void>((resolve) => listener.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		},
	};

	return server;
}

/** Polls `predicate` until it holds or the budget runs out. */
export async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${message}`);
}
