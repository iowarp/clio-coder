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
import { scaleWatchdog } from "./load.js";

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
	/** Outer tab area in cells, from which every pane rect is derived. */
	area?: { width: number; height: number };
}

/**
 * One node of a tab's split tree. The fixture keeps a real tree per tab so the
 * geometry answers (`pane.layout`, `layout.export`, `layout_updated` pushes)
 * are consistent with the splits a test performed, ratios included, the way a
 * real server's are.
 */
export type FakeLayoutNode =
	| { type: "pane"; paneId: string }
	| { type: "split"; direction: "right" | "down"; ratio: number; first: FakeLayoutNode; second: FakeLayoutNode };

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
	/** Push an arbitrary event envelope, for kinds the convenience pushers do not cover. */
	pushRawEvent(kind: string, data: Record<string, unknown>): void;
	/** Push a `layout_updated` carrying the tab's current geometry, as a user resize would. */
	pushLayoutUpdated(tabId: string): void;
	/** The split tree the fixture holds for a tab, or null when the tab is unknown. */
	layoutTree(tabId: string): FakeLayoutNode | null;
	/** Overwrite one split's ratio directly, as a user drag would, without an event. */
	setSplitRatio(tabId: string, path: ReadonlyArray<boolean>, ratio: number): boolean;
	/** Whether a pane is currently zoomed. */
	zoomedPane(tabId: string): string | null;
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
	const area = options.area ?? { width: 200, height: 50 };
	/** Per-tab split tree; every geometry answer derives from it. */
	const tabTrees = new Map<string, FakeLayoutNode>();
	/** Zoomed pane per tab, at most one, the way the real server keeps it. */
	const zoomedByTab = new Map<string, string>();

	// Boot panes sharing a tab become a chain of even right-splits, which is
	// what a user opening them by hand would have.
	for (const pane of panes) {
		const existing = tabTrees.get(pane.tabId);
		const leaf: FakeLayoutNode = { type: "pane", paneId: pane.paneId };
		tabTrees.set(
			pane.tabId,
			existing ? { type: "split", direction: "right", ratio: 0.5, first: existing, second: leaf } : leaf,
		);
	}

	/** Replaces the leaf for `paneId` with `replacement`; returns whether it was found. */
	const replaceLeaf = (node: FakeLayoutNode, paneId: string, replacement: FakeLayoutNode): FakeLayoutNode | null => {
		if (node.type === "pane") return node.paneId === paneId ? replacement : null;
		const first = replaceLeaf(node.first, paneId, replacement);
		if (first) return { ...node, first };
		const second = replaceLeaf(node.second, paneId, replacement);
		if (second) return { ...node, second };
		return null;
	};

	/** Removes the leaf for `paneId`, collapsing its parent split to the sibling. */
	const removeLeaf = (node: FakeLayoutNode, paneId: string): FakeLayoutNode | null | "gone" => {
		if (node.type === "pane") return node.paneId === paneId ? "gone" : null;
		const first = removeLeaf(node.first, paneId);
		if (first === "gone") return node.second;
		if (first) return { ...node, first };
		const second = removeLeaf(node.second, paneId);
		if (second === "gone") return node.first;
		if (second) return { ...node, second };
		return null;
	};

	interface FakeRect {
		x: number;
		y: number;
		width: number;
		height: number;
	}

	/** Walks a tab tree computing integer cell rects, pre-order, the way the wire reports them. */
	const computeGeometry = (
		node: FakeLayoutNode,
		rect: FakeRect,
		out: {
			panes: { pane_id: string; focused: boolean; rect: FakeRect }[];
			splits: { id: string; direction: string; ratio: number; rect: FakeRect }[];
		},
		path: string,
	): void => {
		if (node.type === "pane") {
			out.panes.push({ pane_id: node.paneId, focused: node.paneId === focusedPaneId, rect });
			return;
		}
		out.splits.push({ id: `split_${path || "root"}`, direction: node.direction, ratio: node.ratio, rect });
		if (node.direction === "right") {
			const firstWidth = Math.round(rect.width * node.ratio);
			computeGeometry(node.first, { ...rect, width: firstWidth }, out, `${path}0`);
			computeGeometry(node.second, { ...rect, x: rect.x + firstWidth, width: rect.width - firstWidth }, out, `${path}1`);
		} else {
			const firstHeight = Math.round(rect.height * node.ratio);
			computeGeometry(node.first, { ...rect, height: firstHeight }, out, `${path}0`);
			computeGeometry(
				node.second,
				{ ...rect, y: rect.y + firstHeight, height: rect.height - firstHeight },
				out,
				`${path}1`,
			);
		}
	};

	const layoutSnapshotFor = (tabId: string): Record<string, unknown> | null => {
		const tree = tabTrees.get(tabId);
		if (!tree) return null;
		const workspaceId = panes.find((pane) => pane.tabId === tabId)?.workspaceId ?? "w1";
		const out: {
			panes: { pane_id: string; focused: boolean; rect: FakeRect }[];
			splits: { id: string; direction: string; ratio: number; rect: FakeRect }[];
		} = { panes: [], splits: [] };
		computeGeometry(tree, { x: 0, y: 0, width: area.width, height: area.height }, out, "");
		return {
			workspace_id: workspaceId,
			tab_id: tabId,
			zoomed: zoomedByTab.has(tabId),
			area: { x: 0, y: 0, width: area.width, height: area.height },
			focused_pane_id: focusedPaneId ?? "",
			panes: out.panes,
			splits: out.splits,
		};
	};

	const exportNode = (node: FakeLayoutNode): Record<string, unknown> => {
		if (node.type === "pane") return { type: "pane", pane_id: node.paneId, cwd: "/tmp" };
		return {
			type: "split",
			direction: node.direction,
			ratio: node.ratio,
			first: exportNode(node.first),
			second: exportNode(node.second),
		};
	};

	const splitAtPath = (tabId: string, path: ReadonlyArray<boolean>): FakeLayoutNode | null => {
		let node = tabTrees.get(tabId) ?? null;
		if (node?.type !== "split") return null;
		for (const step of path) {
			const next: FakeLayoutNode = step ? node.second : node.first;
			if (next.type !== "split") return null;
			node = next;
		}
		return node;
	};

	let server!: FakeHerdrServer;

	/** Pushes the tab's current geometry to subscribers, as the real server does after layout changes. */
	const emitLayoutUpdated = (tabId: string): void => {
		const layout = layoutSnapshotFor(tabId);
		if (!layout) return;
		server?.pushRawEvent("layout_updated", { type: "layout_updated", layout });
	};

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
				const direction = params.direction === "down" ? "down" : "right";
				// Wire semantics: ratio is the share the existing pane keeps.
				const ratio = typeof params.ratio === "number" ? params.ratio : 0.5;
				const tree = tabTrees.get(target.tabId);
				if (tree) {
					const replaced = replaceLeaf(tree, target.paneId, {
						type: "split",
						direction,
						ratio,
						first: { type: "pane", paneId: target.paneId },
						second: { type: "pane", paneId: created.paneId },
					});
					if (replaced) tabTrees.set(target.tabId, replaced);
				} else {
					tabTrees.set(target.tabId, { type: "pane", paneId: created.paneId });
				}
				emitLayoutUpdated(target.tabId);
				return { result: { type: "pane_info", pane: paneInfo(created) } };
			}
			case "pane.close": {
				const index = panes.findIndex((entry) => entry.paneId === params.pane_id);
				if (index < 0) return { error: { code: "pane_not_found", message: "pane not found" } };
				const [closed] = panes.splice(index, 1);
				if (closed) {
					const tree = tabTrees.get(closed.tabId);
					const pruned = tree ? removeLeaf(tree, closed.paneId) : null;
					if (pruned === "gone") tabTrees.delete(closed.tabId);
					else if (pruned) tabTrees.set(closed.tabId, pruned);
					if (zoomedByTab.get(closed.tabId) === closed.paneId) zoomedByTab.delete(closed.tabId);
					emitLayoutUpdated(closed.tabId);
				}
				return { result: { type: "ok" } };
			}
			case "pane.focus": {
				if (protocol < 21) return { error: { code: "invalid_request", message: "unknown method pane.focus" } };
				const pane = panes.find((entry) => entry.paneId === params.pane_id);
				if (!pane) return { error: { code: "pane_not_found", message: "pane not found" } };
				// The real server switches the focused tab along with the pane.
				focusedPaneId = pane.paneId;
				focusedTabId = pane.tabId;
				return { result: { type: "pane_info", pane: paneInfo(pane, true, paneTokens.get(pane.paneId) ?? {}) } };
			}
			case "pane.zoom": {
				if (protocol < 17) return { error: { code: "invalid_request", message: "unknown method pane.zoom" } };
				const pane = panes.find((entry) => entry.paneId === params.pane_id);
				if (!pane) return { error: { code: "pane_not_found", message: "pane not found" } };
				const mode = typeof params.mode === "string" ? params.mode : "toggle";
				const wasZoomed = zoomedByTab.get(pane.tabId) === pane.paneId;
				const zoomOn = mode === "on" || (mode === "toggle" && !wasZoomed);
				const changed = zoomOn !== wasZoomed;
				// Zooming an unfocused pane steals focus, verified on 0.8.2.
				const focusChanged = zoomOn && focusedPaneId !== pane.paneId;
				if (zoomOn) {
					zoomedByTab.set(pane.tabId, pane.paneId);
					focusedPaneId = pane.paneId;
				} else {
					zoomedByTab.delete(pane.tabId);
				}
				return {
					result: {
						type: "pane_zoom",
						zoom: { changed, focus_changed: focusChanged, focused_pane_id: focusedPaneId },
					},
				};
			}
			case "layout.export": {
				if (protocol < 21) return { error: { code: "invalid_request", message: "unknown method layout.export" } };
				const byPane = typeof params.pane_id === "string" ? panes.find((p) => p.paneId === params.pane_id) : null;
				const tabId = byPane?.tabId ?? (typeof params.tab_id === "string" ? params.tab_id : (focusedTabId ?? "w1:t1"));
				const tree = tabTrees.get(tabId);
				if (!tree) return { error: { code: "tab_not_found", message: "tab not found" } };
				const workspaceId = panes.find((pane) => pane.tabId === tabId)?.workspaceId ?? "w1";
				return {
					result: {
						type: "layout_export",
						layout: {
							workspace_id: workspaceId,
							tab_id: tabId,
							zoomed: zoomedByTab.has(tabId),
							focused_pane_id: focusedPaneId ?? "",
							root: exportNode(tree),
						},
					},
				};
			}
			case "layout.set_split_ratio": {
				if (protocol < 21) {
					return { error: { code: "invalid_request", message: "unknown method layout.set_split_ratio" } };
				}
				const byPane = typeof params.pane_id === "string" ? panes.find((p) => p.paneId === params.pane_id) : null;
				const tabId = byPane?.tabId ?? (typeof params.tab_id === "string" ? params.tab_id : (focusedTabId ?? "w1:t1"));
				const path = Array.isArray(params.path) ? params.path.map((step) => step === true) : [];
				const split = splitAtPath(tabId, path);
				if (split?.type !== "split") {
					return { error: { code: "split_not_found", message: "no split at path" } };
				}
				if (typeof params.ratio === "number") split.ratio = params.ratio;
				emitLayoutUpdated(tabId);
				const tree = tabTrees.get(tabId);
				const workspaceId = panes.find((pane) => pane.tabId === tabId)?.workspaceId ?? "w1";
				return {
					result: {
						type: "layout_split_ratio_set",
						layout: {
							workspace_id: workspaceId,
							tab_id: tabId,
							zoomed: zoomedByTab.has(tabId),
							focused_pane_id: focusedPaneId ?? "",
							root: tree ? exportNode(tree) : { type: "pane", pane_id: null },
						},
					},
				};
			}
			case "pane.rename": {
				if (protocol < 17) return { error: { code: "invalid_request", message: "unknown method pane.rename" } };
				const pane = panes.find((entry) => entry.paneId === params.pane_id);
				if (!pane) return { error: { code: "pane_not_found", message: "pane not found" } };
				return { result: { type: "ok" } };
			}
			case "pane.layout": {
				const pane = panes.find((entry) => entry.paneId === params.pane_id) ?? panes[0];
				if (!pane) return { error: { code: "pane_layout_unavailable", message: "pane layout unavailable" } };
				const layout = layoutSnapshotFor(pane.tabId);
				if (!layout) return { error: { code: "pane_layout_unavailable", message: "pane layout unavailable" } };
				return { result: { type: "pane_layout", layout } };
			}
			case "tab.create": {
				nextTab += 1;
				const tabId = `w1:t${nextTab}`;
				nextPane += 1;
				const root: FakeHerdrPane = { paneId: `w1:p${nextPane}`, tabId, workspaceId: "w1" };
				panes.push(root);
				tabTrees.set(tabId, { type: "pane", paneId: root.paneId });
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
				focusedPaneId = panes.find((pane) => pane.tabId === tabId)?.paneId ?? focusedPaneId;
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
				tabTrees.set(tabId, { type: "pane", paneId: root.paneId });
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
					tabTrees.set(tabId, { type: "pane", paneId: root.paneId });
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
			if (index < 0) return;
			const [removed] = panes.splice(index, 1);
			if (removed) {
				const tree = tabTrees.get(removed.tabId);
				const pruned = tree ? removeLeaf(tree, removed.paneId) : null;
				if (pruned === "gone") tabTrees.delete(removed.tabId);
				else if (pruned) tabTrees.set(removed.tabId, pruned);
			}
		},
		pushEvent(kind, pane): void {
			server.pushRawEvent(kind, { type: kind, pane_id: pane.paneId, workspace_id: pane.workspaceId });
		},
		pushRawEvent(kind: string, data: Record<string, unknown>): void {
			for (const connection of connections.values()) {
				if (!connection.subscribed) continue;
				write(connection, { event: kind, data });
			}
		},
		pushLayoutUpdated(tabId: string): void {
			emitLayoutUpdated(tabId);
		},
		layoutTree(tabId: string): FakeLayoutNode | null {
			return tabTrees.get(tabId) ?? null;
		},
		setSplitRatio(tabId: string, path: ReadonlyArray<boolean>, ratio: number): boolean {
			const split = splitAtPath(tabId, path);
			if (split?.type !== "split") return false;
			split.ratio = ratio;
			return true;
		},
		zoomedPane(tabId: string): string | null {
			return zoomedByTab.get(tabId) ?? null;
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

/**
 * Polls `predicate` until it holds or the budget runs out. The budget is a
 * watchdog against a wait that never ends, not a claim that the condition
 * arrives quickly, so it is widened by the shard load the run carries.
 */
export async function waitForCondition(predicate: () => boolean, message: string, budgetMs = 4_000): Promise<void> {
	const timeoutMs = scaleWatchdog(budgetMs);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${message}`);
}
