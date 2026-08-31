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
 * The connection model is transcribed too, and it is the part that matters
 * most. herdr's `handle_connection` (`src/api/server.rs:172`) reads exactly one
 * request line per connection and closes after writing the response;
 * `events.subscribe` and `pane.graphics.stream` are the only methods that keep
 * the socket open. An earlier version of this fixture kept reading lines, which
 * made a client that reused a connection pass in CI and fail with EPIPE against
 * a real server on its second call. The fixture now closes like the real one.
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

export interface FakeHerdrWorktree {
	path: string;
	branch: string | null;
	workspaceId: string | null;
}

export interface FakeHerdrServerOptions {
	version?: string;
	protocol?: number;
	/** Pane ids present at boot, in order. The first is Clio's own pane. */
	panes?: ReadonlyArray<FakeHerdrPane>;
	/**
	 * What `notification.show` reports back. `false` models an operator whose own
	 * herdr config disabled toasts, which the wire calls a normal answer.
	 */
	toastsShown?: boolean;
}

/** One toast the fixture was asked to paint. */
export interface FakeHerdrNotification {
	title: string;
	body: string | null;
	sound: string | null;
}

export interface FakeHerdrServer {
	readonly socketPath: string;
	readonly requests: ReadonlyArray<FakeHerdrRequest>;
	requestsFor(method: string): ReadonlyArray<FakeHerdrRequest>;
	setHandler(method: string, handler: FakeHerdrHandler | null): void;
	/** Panes the server currently believes exist. */
	panes(): ReadonlyArray<FakeHerdrPane>;
	/** Worktrees the server currently believes exist. */
	worktrees(): ReadonlyArray<FakeHerdrWorktree>;
	/** Toasts requested through `notification.show`, oldest first. */
	notifications(): ReadonlyArray<FakeHerdrNotification>;
	/** Metadata tokens the server retained for a pane, as `pane.get` would report them. */
	tokensFor(paneId: string): Readonly<Record<string, string>>;
	/** Set the tokens a pane carries, as a previous session's panes would. */
	setTokens(paneId: string, tokens: Readonly<Record<string, string>>): void;
	/** Whether a pane holds agent authority, which is what `agent.focus` resolves through. */
	hasAgentAuthority(paneId: string): boolean;
	/** The pane `agent.focus` most recently focused, or null. */
	focusedPane(): string | null;
	/** The tab currently focused by either focus method, or null. */
	focusedTab(): string | null;
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

function paneInfo(
	pane: FakeHerdrPane,
	focused = false,
	tokens: Readonly<Record<string, string>> = {},
	agent: string | null = null,
): Record<string, unknown> {
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
		agent,
		tokens,
		state_labels: {},
	};
}

function tabInfo(
	tabId: string,
	workspaceId: string,
	label: string,
	paneCount: number,
	focused = false,
): Record<string, unknown> {
	return {
		tab_id: tabId,
		workspace_id: workspaceId,
		number: Number.parseInt(tabId.split(":t")[1] ?? "1", 10),
		label,
		focused,
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
	const paneTokens = new Map<string, Record<string, string>>();
	const agentPanes = new Set<string>();
	const worktrees: FakeHerdrWorktree[] = [];
	const notifications: FakeHerdrNotification[] = [];
	const toastsShown = options.toastsShown ?? true;
	let focusedPaneId: string | null = panes[0]?.paneId ?? null;
	let focusedTabId: string | null = panes[0]?.tabId ?? null;
	let nextConnectionId = 0;
	let nextTab = 1;
	let nextPane = panes.length;
	let nextWorkspace = 1;

	let server!: FakeHerdrServer;

	const tabsInPlay = (): Record<string, unknown>[] => {
		const ids = [...new Set(panes.map((pane) => pane.tabId))];
		for (const id of tabLabels.keys()) if (!ids.includes(id)) ids.push(id);
		return ids.map((tabId) => {
			const workspaceId = panes.find((pane) => pane.tabId === tabId)?.workspaceId ?? "w1";
			return tabInfo(
				tabId,
				workspaceId,
				tabLabels.get(tabId) ?? "shell",
				panes.filter((pane) => pane.tabId === tabId).length,
				tabId === focusedTabId,
			);
		});
	};

	const worktreeInfo = (entry: FakeHerdrWorktree): Record<string, unknown> => ({
		path: entry.path,
		branch: entry.branch,
		is_bare: false,
		is_detached: entry.branch === null,
		is_prunable: false,
		is_linked_worktree: true,
		open_workspace_id: entry.workspaceId,
		label: entry.branch ?? "detached",
	});

	const workspaceInfo = (workspaceId: string, tabId: string): Record<string, unknown> => ({
		workspace_id: workspaceId,
		number: Number.parseInt(workspaceId.slice(1), 10),
		label: workspaceId,
		focused: workspaceId === panes.find((pane) => pane.paneId === focusedPaneId)?.workspaceId,
		pane_count: panes.filter((pane) => pane.workspaceId === workspaceId).length,
		tab_count: 1,
		active_tab_id: tabId,
		agent_status: "unknown",
		tokens: {},
	});

	const snapshot = (): Record<string, unknown> => ({
		version,
		protocol,
		focused_workspace_id: "w1",
		focused_tab_id: focusedTabId,
		focused_pane_id: focusedPaneId,
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
		panes: panes.map((pane) => paneInfo(pane, pane.paneId === focusedPaneId, paneTokens.get(pane.paneId) ?? {})),
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
				return { result: { type: "pane_current", pane: paneInfo(pane, true, paneTokens.get(pane.paneId) ?? {}) } };
			}
			case "pane.list":
				return {
					result: {
						type: "pane_list",
						panes: panes.map((pane) => paneInfo(pane, false, paneTokens.get(pane.paneId) ?? {})),
					},
				};
			case "pane.get": {
				const pane = panes.find((entry) => entry.paneId === params.pane_id);
				if (!pane) return { error: { code: "pane_not_found", message: "pane not found" } };
				return { result: { type: "pane_info", pane: paneInfo(pane, false, paneTokens.get(pane.paneId) ?? {}) } };
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
				focusedTabId = tabId;
				const workspaceId = panes.find((pane) => pane.tabId === tabId)?.workspaceId ?? "w1";
				return {
					result: {
						type: "tab_info",
						tab: tabInfo(
							tabId,
							workspaceId,
							tabLabels.get(tabId) ?? "shell",
							panes.filter((pane) => pane.tabId === tabId).length,
							true,
						),
					},
				};
			}
			case "worktree.list": {
				if (protocol < 10) return { error: { code: "invalid_request", message: "unknown method worktree.list" } };
				return {
					result: {
						type: "worktree_list",
						source: {
							repo_key: "fake-repo",
							repo_name: "fake",
							repo_root: "/repo",
							source_checkout_path: "/repo",
							source_workspace_id: "w1",
						},
						worktrees: worktrees.map(worktreeInfo),
					},
				};
			}
			case "worktree.create": {
				if (protocol < 10) return { error: { code: "invalid_request", message: "unknown method worktree.create" } };
				const path = typeof params.path === "string" ? params.path : `/repo/.worktrees/${worktrees.length + 1}`;
				const branch = typeof params.branch === "string" ? params.branch : null;
				if (worktrees.some((entry) => entry.path === path || (branch !== null && entry.branch === branch))) {
					return { error: { code: "worktree_exists", message: "worktree already exists" } };
				}
				nextWorkspace += 1;
				const workspaceId = `w${nextWorkspace}`;
				const tabId = `${workspaceId}:t1`;
				const root: FakeHerdrPane = { paneId: `${workspaceId}:p1`, tabId, workspaceId };
				const entry: FakeHerdrWorktree = { path, branch, workspaceId };
				panes.push(root);
				worktrees.push(entry);
				tabLabels.set(tabId, typeof params.label === "string" ? params.label : (branch ?? "worktree"));
				return {
					result: {
						type: "worktree_created",
						workspace: workspaceInfo(workspaceId, tabId),
						tab: tabInfo(tabId, workspaceId, tabLabels.get(tabId) ?? "worktree", 1),
						root_pane: paneInfo(root),
						worktree: worktreeInfo(entry),
					},
				};
			}
			case "worktree.open": {
				if (protocol < 10) return { error: { code: "invalid_request", message: "unknown method worktree.open" } };
				const path = typeof params.path === "string" ? params.path : null;
				const branch = typeof params.branch === "string" ? params.branch : null;
				const entry = worktrees.find(
					(candidate) => (path !== null && candidate.path === path) || (branch !== null && candidate.branch === branch),
				);
				if (!entry) return { error: { code: "worktree_not_found", message: "worktree not found" } };
				const alreadyOpen = entry.workspaceId !== null;
				if (entry.workspaceId === null) {
					nextWorkspace += 1;
					entry.workspaceId = `w${nextWorkspace}`;
				}
				const workspaceId = entry.workspaceId;
				const tabId = `${workspaceId}:t1`;
				let root = panes.find((pane) => pane.workspaceId === workspaceId);
				if (!root) {
					root = { paneId: `${workspaceId}:p1`, tabId, workspaceId };
					panes.push(root);
				}
				tabLabels.set(tabId, typeof params.label === "string" ? params.label : (entry.branch ?? "worktree"));
				return {
					result: {
						type: "worktree_opened",
						workspace: workspaceInfo(workspaceId, tabId),
						tab: tabInfo(tabId, workspaceId, tabLabels.get(tabId) ?? "worktree", 1),
						root_pane: paneInfo(root),
						worktree: worktreeInfo(entry),
						already_open: alreadyOpen,
					},
				};
			}
			case "worktree.remove": {
				if (protocol < 10) return { error: { code: "invalid_request", message: "unknown method worktree.remove" } };
				const workspaceId = typeof params.workspace_id === "string" ? params.workspace_id : "";
				const index = worktrees.findIndex((entry) => entry.workspaceId === workspaceId);
				if (index < 0) return { error: { code: "worktree_not_found", message: "worktree not found" } };
				const [removed] = worktrees.splice(index, 1);
				if (!removed) return { error: { code: "worktree_not_found", message: "worktree not found" } };
				for (let paneIndex = panes.length - 1; paneIndex >= 0; paneIndex -= 1) {
					if (panes[paneIndex]?.workspaceId === workspaceId) panes.splice(paneIndex, 1);
				}
				return {
					result: {
						type: "worktree_removed",
						workspace_id: workspaceId,
						path: removed.path,
						forced: params.force === true,
					},
				};
			}
			case "pane.send_text":
				return { result: { type: "ok" } };
			case "pane.report_agent": {
				const pane = panes.find((entry) => entry.paneId === params.pane_id);
				if (!pane) return { error: { code: "pane_not_found", message: "pane not found" } };
				// Agent authority is what makes `agent.focus` resolve for a pane id,
				// so the fixture records it rather than answering a bare ok: the focus
				// ladder's fallback rung is only reachable when it is absent.
				agentPanes.add(pane.paneId);
				return { result: { type: "ok" } };
			}
			case "pane.report_metadata": {
				const pane = panes.find((entry) => entry.paneId === params.pane_id);
				if (!pane) return { error: { code: "pane_not_found", message: "pane not found" } };
				const tokens = paneTokens.get(pane.paneId) ?? {};
				const incoming = params.tokens;
				if (incoming && typeof incoming === "object") {
					for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
						// herdr clears a token whose value is null rather than setting it,
						// which the phase 1 manual gate observed against a live server.
						if (value === null) delete tokens[key];
						else if (typeof value === "string") tokens[key] = value;
					}
				}
				paneTokens.set(pane.paneId, tokens);
				return { result: { type: "ok" } };
			}
			// Both of the following are protocol-gated in `src/domains/mux/protocol.ts`.
			// A server configured below the floor answers the way an older herdr
			// does, so a test can exercise the fallback rungs without a second binary.
			case "notification.show": {
				if (protocol < 17) return { error: { code: "invalid_request", message: "unknown method notification.show" } };
				const title = typeof params.title === "string" ? params.title : "";
				notifications.push({
					title,
					body: typeof params.body === "string" ? params.body : null,
					sound: typeof params.sound === "string" ? params.sound : null,
				});
				return { result: { type: "notification_show", shown: toastsShown, reason: toastsShown ? "shown" : "disabled" } };
			}
			case "agent.focus": {
				if (protocol < 17) return { error: { code: "invalid_request", message: "unknown method agent.focus" } };
				const target = typeof params.target === "string" ? params.target : "";
				const pane = panes.find((entry) => entry.paneId === target);
				// herdr resolves an agent target by pane id only when that pane holds
				// agent authority, and by agent name otherwise.
				if (!pane || !agentPanes.has(pane.paneId)) {
					return { error: { code: "agent_not_found", message: `agent target not found: ${target}` } };
				}
				focusedPaneId = pane.paneId;
				focusedTabId = pane.tabId;
				return {
					result: {
						type: "agent_info",
						agent: { target: pane.paneId, pane_id: pane.paneId, name: "clio", status: "working" },
					},
				};
			}
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

	/**
	 * Closes the connection the way herdr does once a non-streaming request is
	 * answered. `end` rather than `destroy` so the response line is flushed first.
	 */
	const closeAfterResponse = (connection: Connection): void => {
		connection.socket.end();
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
		// A hung request leaves the connection open with no response, which is what
		// a wedged server looks like until its own write timeout fires.
		if ("hang" in outcome) return;
		if ("error" in outcome) {
			write(connection, { id, error: outcome.error });
			closeAfterResponse(connection);
			return;
		}
		write(connection, { id, result: outcome.result });
		if (method === "events.subscribe") {
			connection.subscribed = true;
			return;
		}
		closeAfterResponse(connection);
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
		worktrees(): ReadonlyArray<FakeHerdrWorktree> {
			return worktrees.map((entry) => ({ ...entry }));
		},
		addPane(pane: FakeHerdrPane): void {
			panes.push(pane);
		},
		notifications(): ReadonlyArray<FakeHerdrNotification> {
			return [...notifications];
		},
		tokensFor(paneId: string): Readonly<Record<string, string>> {
			return { ...(paneTokens.get(paneId) ?? {}) };
		},
		setTokens(paneId: string, tokens: Readonly<Record<string, string>>): void {
			paneTokens.set(paneId, { ...tokens });
		},
		hasAgentAuthority(paneId: string): boolean {
			return agentPanes.has(paneId);
		},
		focusedPane(): string | null {
			return focusedPaneId;
		},
		focusedTab(): string | null {
			return focusedTabId;
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
