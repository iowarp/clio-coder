/**
 * Newline-delimited JSON client for a herdr server's Unix domain socket.
 *
 * Two connection kinds, because the server treats them differently:
 *
 *   1. One connection per request. herdr's `handle_connection` reads exactly one
 *      request line, writes the response, and closes
 *      (`src/api/server.rs:172`, verified against herdr 0.7.5 / protocol 17), so
 *      a second request written to the same socket dies with EPIPE. Spec 4.3
 *      describes a persistent request/response connection with a pending map;
 *      that is not what the pinned binary does. Each call still gets a monotonic
 *      id and still checks the echoed id, which catches a server answering
 *      something other than what was asked. A call with no response inside its
 *      budget rejects with {@link MuxRequestTimeout}.
 *   2. One dedicated connection per `events.subscribe` stream. This is one of
 *      the two methods that keep a connection open (the other is
 *      `pane.graphics.stream`): herdr acknowledges once and then pushes event
 *      lines forever.
 *
 * Connect failures back off with a capped exponential delay, so a dead socket
 * is not hammered once per call. After a subscription reconnect the client
 * refetches `session.snapshot` and hands it to the resync handler: herdr's
 * documented pattern is snapshot once and then trust events, and events missed
 * while the socket was down are simply gone.
 *
 * The interactive app never shells out to the `herdr` CLI. CLI wrappers exist
 * for humans, doctor, and scripts.
 *
 * This is the only module in the tree that reads herdr wire shapes. Every
 * public method returns the Clio types from `types.ts`, and unknown fields on a
 * response are ignored, which is herdr's stated forward-compatibility rule.
 */

import * as net from "node:net";
import {
	MuxError,
	type MuxEvent,
	type MuxEventKind,
	type MuxLayoutNode,
	type MuxLayoutTree,
	type MuxLog,
	type MuxNotificationSound,
	type MuxPane,
	type MuxRect,
	type MuxReportableAgentState,
	MuxRequestTimeout,
	type MuxServerInfo,
	type MuxSnapshot,
	type MuxTab,
	type MuxTabGeometry,
	type MuxWorktree,
	type MuxWorktreeSource,
	muxErrorKind,
} from "./types.js";

/** Default per-request budget from spec 4.3. */
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
/** Connect budget. Detection uses a tighter one; see `detect.ts`. */
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_BACKOFF = { initialDelayMs: 250, maxDelayMs: 5_000, factor: 2 } as const;
/**
 * A single response line larger than this means the peer is not a herdr server
 * (or is wedged), so the connection is dropped rather than buffered forever.
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface MuxBackoffOptions {
	initialDelayMs: number;
	maxDelayMs: number;
	factor: number;
}

export interface MuxClientOptions {
	socketPath: string;
	requestTimeoutMs?: number;
	connectTimeoutMs?: number;
	backoff?: MuxBackoffOptions;
	log?: MuxLog;
}

export interface MuxSubscription {
	close(): void;
}

export interface MuxSplitRequest {
	direction: "right" | "down";
	targetPaneId?: string;
	workspaceId?: string;
	cwd?: string;
	env?: Readonly<Record<string, string>>;
	focus?: boolean;
	ratio?: number;
}

export interface MuxReportAgentRequest {
	paneId: string;
	source: string;
	agent: string;
	state: MuxReportableAgentState;
	message?: string;
}

export interface MuxReportMetadataRequest {
	paneId: string;
	source: string;
	agent?: string;
	title?: string;
	displayAgent?: string;
	tokens?: Readonly<Record<string, string | null>>;
	stateLabels?: Readonly<Record<string, string>>;
	ttlMs?: number;
}

export interface MuxSubscribeOptions {
	/** Called after a dropped stream reconnects, with a freshly taken snapshot. */
	onResync?: (snapshot: MuxSnapshot) => void;
}

export interface MuxNotificationRequest {
	title: string;
	body?: string;
	sound?: MuxNotificationSound;
}

/**
 * What the server did with a toast. `shown: false` is a normal answer: the
 * operator's own herdr config can disable toasts, rate-limit them, or have no
 * foreground client to paint one, and none of those is a Clio failure.
 */
export interface MuxNotificationResult {
	shown: boolean;
	reason: string;
}

export interface MuxWorktreeListRequest {
	workspaceId?: string;
	cwd?: string;
}

export interface MuxWorktreeCreateRequest extends MuxWorktreeListRequest {
	branch?: string;
	base?: string;
	path?: string;
	label?: string;
	focus?: boolean;
}

export interface MuxWorktreeOpenRequest extends MuxWorktreeListRequest {
	branch?: string;
	path?: string;
	label?: string;
	focus?: boolean;
}

export interface MuxWorktreeListResult {
	source: MuxWorktreeSource;
	worktrees: ReadonlyArray<MuxWorktree>;
}

export interface MuxWorktreeCreatedResult {
	workspaceId: string;
	tab: MuxTab;
	rootPane: MuxPane;
	worktree: MuxWorktree;
}

export interface MuxWorktreeOpenedResult extends MuxWorktreeCreatedResult {
	alreadyOpen: boolean;
}

export interface MuxWorktreeRemovedResult {
	workspaceId: string;
	path: string;
	forced: boolean;
}

/**
 * The domain-facing surface. Phase 1 covers exactly the wire methods spec 4.3
 * lists for this phase, plus `pane.send_text`, `pane.report_agent`,
 * `pane.report_metadata` (see the notes on those methods below).
 */
export interface MuxClient {
	readonly socketPath: string;
	/** Whether the most recent request reached the server. Requests are one per connection. */
	connected(): boolean;
	/** Protocol/version recorded from the most recent successful ping or snapshot. */
	server(): MuxServerInfo | null;
	/** Most recent `session.snapshot`, including the post-reconnect refetch. */
	cachedSnapshot(): MuxSnapshot | null;

	ping(options?: { timeoutMs?: number }): Promise<MuxServerInfo>;
	snapshot(): Promise<MuxSnapshot>;
	paneCurrent(callerPaneId?: string): Promise<MuxPane>;
	paneList(workspaceId?: string): Promise<ReadonlyArray<MuxPane>>;
	paneSplit(request: MuxSplitRequest): Promise<MuxPane>;
	/** Set the pane's operator-facing label. Available on herdr protocol 17. */
	paneRename(paneId: string, label: string): Promise<void>;
	paneClose(paneId: string): Promise<void>;
	/**
	 * Cell-precise geometry of the tab holding `paneId` (the server's focused
	 * pane when omitted): outer area, pane rects, and live split ratios.
	 */
	paneLayout(paneId?: string): Promise<MuxTabGeometry>;
	/**
	 * Focus a pane. This switches the focused tab as well as the pane (verified
	 * on 0.8.2), so it is only ever driven by an explicit "show me" request,
	 * never by background bookkeeping.
	 */
	paneFocus(paneId: string): Promise<void>;
	/** Zoom a pane. Zooming an unfocused pane steals focus; same rule as paneFocus. */
	paneZoom(paneId: string, mode: "on" | "off" | "toggle"): Promise<{ changed: boolean; focusChanged: boolean }>;
	/** Portable layout tree for a tab, or the tab holding `paneId`. */
	layoutExport(request?: { tabId?: string; paneId?: string }): Promise<MuxLayoutTree>;
	/**
	 * Set one split's ratio, addressed by a boolean path from the root split
	 * (`false` descends first, `true` second; `[]` is the root). Returns the
	 * updated tree.
	 */
	layoutSetSplitRatio(request: {
		tabId?: string;
		paneId?: string;
		path: ReadonlyArray<boolean>;
		ratio: number;
	}): Promise<MuxLayoutTree>;
	worktreeList(request?: MuxWorktreeListRequest): Promise<MuxWorktreeListResult>;
	worktreeCreate(request: MuxWorktreeCreateRequest): Promise<MuxWorktreeCreatedResult>;
	worktreeOpen(request: MuxWorktreeOpenRequest): Promise<MuxWorktreeOpenedResult>;
	worktreeRemove(workspaceId: string, options?: { force?: boolean }): Promise<MuxWorktreeRemovedResult>;
	/**
	 * Deliver a command line into a pane's shell. herdr has no argv parameter on
	 * `pane.split`, so this is the only way an argv utility pane can run what it
	 * was asked to run.
	 */
	paneSendText(paneId: string, text: string): Promise<void>;
	/** Takes agent authority over a pane. Only ever called on Clio-owned panes and Clio's own pane. */
	paneReportAgent(request: MuxReportAgentRequest): Promise<void>;
	paneReportMetadata(request: MuxReportMetadataRequest): Promise<void>;
	/**
	 * Ask the foreground client to paint a toast. Protocol-gated; see
	 * `protocol.ts`. The server answers whether it painted one and why not.
	 */
	notificationShow(request: MuxNotificationRequest): Promise<MuxNotificationResult>;
	subscribe(
		kinds: ReadonlyArray<MuxEventKind>,
		handler: (event: MuxEvent) => void,
		options?: MuxSubscribeOptions,
	): Promise<MuxSubscription>;

	close(): Promise<void>;
}

/** Opens one socket, or rejects with a typed transport error. */
function connectSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ path: socketPath });
		socket.setNoDelay(true);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new MuxError("transport", `mux socket connect to ${socketPath} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();
		const settle = (error: Error | null): void => {
			clearTimeout(timer);
			socket.removeListener("connect", onConnect);
			socket.removeListener("error", onError);
			if (error) {
				socket.destroy();
				reject(new MuxError("transport", `mux socket connect to ${socketPath} failed: ${error.message}`));
				return;
			}
			resolve(socket);
		};
		const onConnect = (): void => settle(null);
		const onError = (error: Error): void => settle(error);
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
}

/**
 * Splits an incoming byte stream into JSON lines.
 *
 * `onOverflow` fires when one line exceeds the sanity cap, which the caller
 * treats as a dead connection rather than growing the buffer without bound.
 */
function readJsonLines(
	socket: net.Socket,
	onValue: (value: Record<string, unknown>) => void,
	onOverflow: () => void,
): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		if (buffer.length > MAX_LINE_BYTES) {
			buffer = "";
			onOverflow();
			return;
		}
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line.length > 0) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					parsed = null;
				}
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					onValue(parsed as Record<string, unknown>);
				}
			}
			newline = buffer.indexOf("\n");
		}
	});
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function requireString(source: Record<string, unknown>, key: string, context: string): string {
	const value = source[key];
	if (typeof value !== "string") {
		throw new MuxError("protocol", `mux ${context} response is missing string field ${key}`);
	}
	return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | null {
	const value = source[key];
	return typeof value === "string" ? value : null;
}

function stringMap(value: unknown): Record<string, string> {
	const source = asRecord(value);
	if (!source) return {};
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(source)) {
		if (typeof entry === "string") out[key] = entry;
	}
	return out;
}

const AGENT_STATES = new Set(["idle", "working", "blocked", "done", "unknown"]);

function readAgentState(value: unknown): MuxPane["agentState"] {
	return typeof value === "string" && AGENT_STATES.has(value) ? (value as MuxPane["agentState"]) : "unknown";
}

function readPane(value: unknown): MuxPane {
	const source = asRecord(value);
	if (!source) throw new MuxError("protocol", "mux pane response is not an object");
	const revision = source.revision;
	return {
		paneId: requireString(source, "pane_id", "pane"),
		tabId: requireString(source, "tab_id", "pane"),
		workspaceId: requireString(source, "workspace_id", "pane"),
		focused: source.focused === true,
		agentState: readAgentState(source.agent_status),
		revision: typeof revision === "number" ? revision : 0,
		label: optionalString(source, "label"),
		title: optionalString(source, "title"),
		cwd: optionalString(source, "cwd"),
		agent: optionalString(source, "agent"),
		tokens: stringMap(source.tokens),
	};
}

function readTab(value: unknown): MuxTab {
	const source = asRecord(value);
	if (!source) throw new MuxError("protocol", "mux tab response is not an object");
	const number = source.number;
	const paneCount = source.pane_count;
	return {
		tabId: requireString(source, "tab_id", "tab"),
		workspaceId: requireString(source, "workspace_id", "tab"),
		number: typeof number === "number" ? number : 0,
		label: optionalString(source, "label") ?? "",
		focused: source.focused === true,
		paneCount: typeof paneCount === "number" ? paneCount : 0,
		agentState: readAgentState(source.agent_status),
	};
}

function readWorktree(value: unknown): MuxWorktree {
	const source = asRecord(value);
	if (!source) throw new MuxError("protocol", "mux worktree response is not an object");
	return {
		path: requireString(source, "path", "worktree"),
		branch: optionalString(source, "branch"),
		isBare: source.is_bare === true,
		isDetached: source.is_detached === true,
		isPrunable: source.is_prunable === true,
		isLinkedWorktree: source.is_linked_worktree === true,
		openWorkspaceId: optionalString(source, "open_workspace_id"),
		label: optionalString(source, "label") ?? "",
	};
}

function readWorktreeSource(value: unknown): MuxWorktreeSource {
	const source = asRecord(value);
	if (!source) throw new MuxError("protocol", "mux worktree source response is not an object");
	return {
		repoKey: requireString(source, "repo_key", "worktree source"),
		repoName: requireString(source, "repo_name", "worktree source"),
		repoRoot: requireString(source, "repo_root", "worktree source"),
		sourceCheckoutPath: requireString(source, "source_checkout_path", "worktree source"),
		sourceWorkspaceId: optionalString(source, "source_workspace_id"),
	};
}

function readArray(source: Record<string, unknown>, key: string): unknown[] {
	const value = source[key];
	return Array.isArray(value) ? value : [];
}

function readServerInfo(source: Record<string, unknown>): MuxServerInfo {
	const protocol = source.protocol;
	return {
		version: optionalString(source, "version") ?? "",
		protocol: typeof protocol === "number" ? protocol : 0,
	};
}

function readSnapshot(value: unknown): MuxSnapshot {
	const source = asRecord(value);
	if (!source) throw new MuxError("protocol", "mux snapshot response is not an object");
	return {
		server: readServerInfo(source),
		focusedPaneId: optionalString(source, "focused_pane_id"),
		focusedTabId: optionalString(source, "focused_tab_id"),
		focusedWorkspaceId: optionalString(source, "focused_workspace_id"),
		panes: readArray(source, "panes").map(readPane),
		tabs: readArray(source, "tabs").map(readTab),
	};
}

function requireNumber(source: Record<string, unknown>, key: string, context: string): number {
	const value = source[key];
	if (typeof value !== "number") {
		throw new MuxError("protocol", `mux ${context} response is missing number field ${key}`);
	}
	return value;
}

function readRect(value: unknown, context: string): MuxRect {
	const source = asRecord(value);
	if (!source) throw new MuxError("protocol", `mux ${context} rect is not an object`);
	return {
		x: requireNumber(source, "x", context),
		y: requireNumber(source, "y", context),
		width: requireNumber(source, "width", context),
		height: requireNumber(source, "height", context),
	};
}

function readSplitDirection(value: unknown, context: string): "right" | "down" {
	if (value === "right" || value === "down") return value;
	throw new MuxError("protocol", `mux ${context} split direction is not right/down`);
}

/** Parses a `PaneLayoutSnapshot`: the shape `pane.layout` and `layout_updated` both carry. */
function readTabGeometry(value: unknown): MuxTabGeometry {
	const source = asRecord(value);
	if (!source) throw new MuxError("protocol", "mux layout snapshot is not an object");
	return {
		workspaceId: requireString(source, "workspace_id", "layout"),
		tabId: requireString(source, "tab_id", "layout"),
		zoomed: source.zoomed === true,
		area: readRect(source.area, "layout"),
		focusedPaneId: optionalString(source, "focused_pane_id"),
		panes: readArray(source, "panes").map((entry) => {
			const pane = asRecord(entry);
			if (!pane) throw new MuxError("protocol", "mux layout pane entry is not an object");
			return {
				paneId: requireString(pane, "pane_id", "layout pane"),
				focused: pane.focused === true,
				rect: readRect(pane.rect, "layout pane"),
			};
		}),
		splits: readArray(source, "splits").map((entry) => {
			const split = asRecord(entry);
			if (!split) throw new MuxError("protocol", "mux layout split entry is not an object");
			return {
				direction: readSplitDirection(split.direction, "layout"),
				ratio: requireNumber(split, "ratio", "layout split"),
				rect: readRect(split.rect, "layout split"),
			};
		}),
	};
}

function readLayoutNode(value: unknown): MuxLayoutNode {
	const source = asRecord(value);
	if (!source) throw new MuxError("protocol", "mux layout node is not an object");
	if (source.type === "pane") {
		return { type: "pane", paneId: optionalString(source, "pane_id"), label: optionalString(source, "label") };
	}
	if (source.type === "split") {
		return {
			type: "split",
			direction: readSplitDirection(source.direction, "layout tree"),
			ratio: requireNumber(source, "ratio", "layout tree split"),
			first: readLayoutNode(source.first),
			second: readLayoutNode(source.second),
		};
	}
	throw new MuxError("protocol", "mux layout node has an unknown type");
}

function readLayoutTree(value: unknown): MuxLayoutTree {
	const source = asRecord(value);
	if (!source) throw new MuxError("protocol", "mux layout tree is not an object");
	return {
		workspaceId: requireString(source, "workspace_id", "layout tree"),
		tabId: requireString(source, "tab_id", "layout tree"),
		zoomed: source.zoomed === true,
		focusedPaneId: optionalString(source, "focused_pane_id"),
		root: readLayoutNode(source.root),
	};
}

/** herdr names lifecycle event kinds with underscores on the wire and dots in subscriptions. */
const PANE_LEAVE_KIND_BY_WIRE: Readonly<Record<string, "pane.closed" | "pane.exited">> = {
	pane_closed: "pane.closed",
	pane_exited: "pane.exited",
};

function readEvent(line: Record<string, unknown>): MuxEvent | null {
	const wireKind = line.event;
	if (typeof wireKind !== "string") return null;
	const data = asRecord(line.data);
	if (!data) return null;
	const leaveKind = PANE_LEAVE_KIND_BY_WIRE[wireKind];
	if (leaveKind) {
		const paneId = data.pane_id;
		const workspaceId = data.workspace_id;
		if (typeof paneId !== "string" || typeof workspaceId !== "string") return null;
		return { kind: leaveKind, paneId, workspaceId };
	}
	if (wireKind === "pane_moved") {
		// The move rewrites the pane id; the payload carries the new pane record
		// plus the id it replaced, and consumers continue from the new one.
		const pane = asRecord(data.pane);
		const previousPaneId = data.previous_pane_id;
		if (!pane || typeof previousPaneId !== "string") return null;
		const paneId = pane.pane_id;
		const tabId = pane.tab_id;
		const workspaceId = pane.workspace_id;
		if (typeof paneId !== "string" || typeof tabId !== "string" || typeof workspaceId !== "string") return null;
		return { kind: "pane.moved", paneId, previousPaneId, tabId, workspaceId };
	}
	if (wireKind === "layout_updated") {
		// The push already carries the full tab geometry, so a consumer never
		// has to answer a layout event with a layout request.
		try {
			return { kind: "layout.updated", geometry: readTabGeometry(data.layout) };
		} catch {
			return null;
		}
	}
	return null;
}

/** Drops undefined entries so an optional field is absent rather than `null` on the wire. */
function params(entries: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entries)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

export function createMuxClient(options: MuxClientOptions): MuxClient {
	const socketPath = options.socketPath;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const backoff = options.backoff ?? DEFAULT_BACKOFF;
	const log = options.log ?? ((): void => undefined);

	let disposed = false;
	let nextId = 0;
	let reachable = false;
	let serverInfo: MuxServerInfo | null = null;
	let snapshotCache: MuxSnapshot | null = null;

	/** Consecutive failed connect attempts. */
	let connectFailures = 0;
	/** Wall clock before which a new connect is refused. */
	let retryAt = 0;

	const delayFor = (failures: number): number =>
		Math.min(backoff.maxDelayMs, backoff.initialDelayMs * backoff.factor ** Math.max(0, failures - 1));

	/**
	 * One request, one connection.
	 *
	 * The id counter and the response-id check survive from the pending-map
	 * design because they still catch a server answering something other than
	 * what was asked, but there is no pending map: a connection carries exactly
	 * one outstanding call and is destroyed as soon as it settles.
	 */
	const call = async (method: string, callParams: Record<string, unknown>, timeoutMs?: number): Promise<unknown> => {
		if (disposed) throw new MuxError("transport", "mux client is closed");
		const waitMs = retryAt - Date.now();
		if (waitMs > 0) {
			throw new MuxError("transport", `mux socket ${socketPath} is in backoff for another ${waitMs}ms`);
		}
		let socket: net.Socket;
		try {
			socket = await connectSocket(socketPath, connectTimeoutMs);
		} catch (error) {
			connectFailures += 1;
			retryAt = Date.now() + delayFor(connectFailures);
			reachable = false;
			throw error;
		}
		connectFailures = 0;
		retryAt = 0;
		nextId += 1;
		const id = `clio-${nextId}`;
		const budget = timeoutMs ?? requestTimeoutMs;
		try {
			const result = await new Promise<unknown>((resolve, reject) => {
				let settled = false;
				const finish = (settle: () => void): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					socket.destroy();
					settle();
				};
				const timer = setTimeout(() => finish(() => reject(new MuxRequestTimeout(method, budget))), budget);
				timer.unref?.();
				readJsonLines(
					socket,
					(line) => {
						const responseId = line.id;
						if (typeof responseId !== "string") return;
						const error = asRecord(line.error);
						// herdr answers a request it could not even parse with an empty id,
						// so an empty-id error line on this connection is still ours.
						if (responseId !== id && !(responseId === "" && error)) return;
						if (error) {
							const code = typeof error.code === "string" ? error.code : "unknown";
							const message = typeof error.message === "string" ? error.message : code;
							finish(() => reject(new MuxError(muxErrorKind(code), message, { wireCode: code, method })));
							return;
						}
						finish(() => resolve(line.result));
					},
					() => finish(() => reject(new MuxError("protocol", `mux ${method} response line was oversized`, { method }))),
				);
				socket.on("error", (error: Error) =>
					finish(() => reject(new MuxError("transport", `mux request ${method} failed: ${error.message}`, { method }))),
				);
				socket.on("close", () =>
					finish(() => reject(new MuxError("transport", `mux request ${method} lost its connection`, { method }))),
				);
				socket.write(`${JSON.stringify({ id, method, params: callParams })}\n`, (error) => {
					if (!error) return;
					finish(() =>
						reject(new MuxError("transport", `mux request ${method} failed to write: ${error.message}`, { method })),
					);
				});
			});
			reachable = true;
			return result;
		} catch (error) {
			if (error instanceof MuxError && error.kind === "transport") reachable = false;
			throw error;
		}
	};

	const callObject = async (
		method: string,
		callParams: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<Record<string, unknown>> => {
		const result = asRecord(await call(method, callParams, timeoutMs));
		if (!result) throw new MuxError("protocol", `mux ${method} returned a non-object result`, { method });
		return result;
	};

	const snapshot = async (): Promise<MuxSnapshot> => {
		const result = await callObject("session.snapshot", {});
		const parsed = readSnapshot(result.snapshot);
		snapshotCache = parsed;
		serverInfo = parsed.server;
		return parsed;
	};

	const subscribe = async (
		kinds: ReadonlyArray<MuxEventKind>,
		handler: (event: MuxEvent) => void,
		subscribeOptions: MuxSubscribeOptions = {},
	): Promise<MuxSubscription> => {
		let closed = false;
		let socket: net.Socket | null = null;
		let retryTimer: NodeJS.Timeout | null = null;
		let failures = 0;

		const scheduleReopen = (): void => {
			if (closed || disposed) return;
			failures += 1;
			const delay = delayFor(failures);
			retryTimer = setTimeout(() => {
				retryTimer = null;
				void open(true);
			}, delay);
			retryTimer.unref?.();
		};

		const open = async (isReconnect: boolean): Promise<void> => {
			if (closed || disposed) return;
			let stream: net.Socket;
			try {
				stream = await connectSocket(socketPath, connectTimeoutMs);
			} catch (error) {
				log("debug", `mux event stream connect failed: ${error instanceof Error ? error.message : String(error)}`);
				scheduleReopen();
				return;
			}
			if (closed || disposed) {
				stream.destroy();
				return;
			}
			socket = stream;
			let acknowledged = false;
			readJsonLines(
				stream,
				(line) => {
					if (!acknowledged && typeof line.id === "string") {
						acknowledged = true;
						failures = 0;
						if (isReconnect) {
							// Events dropped while the socket was down are gone. Take a
							// fresh snapshot and let the caller rebuild from it.
							void snapshot().then(
								(fresh) => subscribeOptions.onResync?.(fresh),
								(error) =>
									log("debug", `mux snapshot re-bootstrap failed: ${error instanceof Error ? error.message : String(error)}`),
							);
						}
						return;
					}
					const event = readEvent(line);
					if (event) handler(event);
				},
				() => stream.destroy(),
			);
			const onGone = (): void => {
				if (socket !== stream) return;
				socket = null;
				stream.destroy();
				scheduleReopen();
			};
			stream.on("error", onGone);
			stream.on("close", onGone);
			stream.write(
				`${JSON.stringify({
					id: `clio-sub-${kinds.join("+")}`,
					method: "events.subscribe",
					params: { subscriptions: kinds.map((kind) => ({ type: kind })) },
				})}\n`,
			);
		};

		await open(false);

		return {
			close(): void {
				closed = true;
				if (retryTimer) clearTimeout(retryTimer);
				retryTimer = null;
				socket?.destroy();
				socket = null;
			},
		};
	};

	return {
		socketPath,
		connected(): boolean {
			return reachable;
		},
		server(): MuxServerInfo | null {
			return serverInfo;
		},
		cachedSnapshot(): MuxSnapshot | null {
			return snapshotCache;
		},
		async ping(pingOptions = {}): Promise<MuxServerInfo> {
			const result = await callObject("ping", {}, pingOptions.timeoutMs);
			const info = readServerInfo(result);
			serverInfo = info;
			return info;
		},
		snapshot,
		async paneCurrent(callerPaneId?: string): Promise<MuxPane> {
			const result = await callObject("pane.current", params({ caller_pane_id: callerPaneId }));
			return readPane(result.pane);
		},
		async paneList(workspaceId?: string): Promise<ReadonlyArray<MuxPane>> {
			const result = await callObject("pane.list", params({ workspace_id: workspaceId }));
			return readArray(result, "panes").map(readPane);
		},
		async paneSplit(request: MuxSplitRequest): Promise<MuxPane> {
			const result = await callObject(
				"pane.split",
				params({
					direction: request.direction,
					target_pane_id: request.targetPaneId,
					workspace_id: request.workspaceId,
					cwd: request.cwd,
					env: request.env,
					focus: request.focus ?? false,
					ratio: request.ratio,
				}),
			);
			return readPane(result.pane);
		},
		async paneRename(paneId: string, label: string): Promise<void> {
			await call("pane.rename", { pane_id: paneId, label });
		},
		async paneClose(paneId: string): Promise<void> {
			await call("pane.close", { pane_id: paneId });
		},
		async paneLayout(paneId?: string): Promise<MuxTabGeometry> {
			const result = await callObject("pane.layout", params({ pane_id: paneId }));
			return readTabGeometry(result.layout);
		},
		async paneFocus(paneId: string): Promise<void> {
			await call("pane.focus", { pane_id: paneId });
		},
		async paneZoom(paneId: string, mode: "on" | "off" | "toggle"): Promise<{ changed: boolean; focusChanged: boolean }> {
			const result = await callObject("pane.zoom", { pane_id: paneId, mode });
			const zoom = asRecord(result.zoom);
			if (!zoom) throw new MuxError("protocol", "mux pane.zoom returned no zoom result");
			return { changed: zoom.changed === true, focusChanged: zoom.focus_changed === true };
		},
		async layoutExport(request = {}): Promise<MuxLayoutTree> {
			const result = await callObject("layout.export", params({ tab_id: request.tabId, pane_id: request.paneId }));
			return readLayoutTree(result.layout);
		},
		async layoutSetSplitRatio(request): Promise<MuxLayoutTree> {
			const result = await callObject(
				"layout.set_split_ratio",
				params({ tab_id: request.tabId, pane_id: request.paneId, path: [...request.path], ratio: request.ratio }),
			);
			return readLayoutTree(result.layout);
		},
		async worktreeList(request = {}): Promise<MuxWorktreeListResult> {
			const result = await callObject("worktree.list", params({ workspace_id: request.workspaceId, cwd: request.cwd }));
			return { source: readWorktreeSource(result.source), worktrees: readArray(result, "worktrees").map(readWorktree) };
		},
		async worktreeCreate(request: MuxWorktreeCreateRequest): Promise<MuxWorktreeCreatedResult> {
			const result = await callObject(
				"worktree.create",
				params({
					workspace_id: request.workspaceId,
					cwd: request.cwd,
					branch: request.branch,
					base: request.base,
					path: request.path,
					label: request.label,
					focus: request.focus ?? false,
				}),
			);
			const workspace = asRecord(result.workspace);
			if (!workspace) throw new MuxError("protocol", "mux worktree.create returned no workspace");
			return {
				workspaceId: requireString(workspace, "workspace_id", "workspace"),
				tab: readTab(result.tab),
				rootPane: readPane(result.root_pane),
				worktree: readWorktree(result.worktree),
			};
		},
		async worktreeOpen(request: MuxWorktreeOpenRequest): Promise<MuxWorktreeOpenedResult> {
			const result = await callObject(
				"worktree.open",
				params({
					workspace_id: request.workspaceId,
					cwd: request.cwd,
					branch: request.branch,
					path: request.path,
					label: request.label,
					focus: request.focus ?? false,
				}),
			);
			const workspace = asRecord(result.workspace);
			if (!workspace) throw new MuxError("protocol", "mux worktree.open returned no workspace");
			return {
				workspaceId: requireString(workspace, "workspace_id", "workspace"),
				tab: readTab(result.tab),
				rootPane: readPane(result.root_pane),
				worktree: readWorktree(result.worktree),
				alreadyOpen: result.already_open === true,
			};
		},
		async worktreeRemove(workspaceId: string, removeOptions = {}): Promise<MuxWorktreeRemovedResult> {
			const result = await callObject("worktree.remove", {
				workspace_id: workspaceId,
				force: removeOptions.force ?? false,
			});
			return {
				workspaceId: requireString(result, "workspace_id", "worktree.remove"),
				path: requireString(result, "path", "worktree.remove"),
				forced: result.forced === true,
			};
		},
		async paneSendText(paneId: string, text: string): Promise<void> {
			await call("pane.send_text", { pane_id: paneId, text });
		},
		async paneReportAgent(request: MuxReportAgentRequest): Promise<void> {
			await call(
				"pane.report_agent",
				params({
					pane_id: request.paneId,
					source: request.source,
					agent: request.agent,
					state: request.state,
					message: request.message,
				}),
			);
		},
		async paneReportMetadata(request: MuxReportMetadataRequest): Promise<void> {
			await call(
				"pane.report_metadata",
				params({
					pane_id: request.paneId,
					source: request.source,
					agent: request.agent,
					title: request.title,
					display_agent: request.displayAgent,
					tokens: request.tokens,
					state_labels: request.stateLabels,
					ttl_ms: request.ttlMs,
				}),
			);
		},
		async notificationShow(request: MuxNotificationRequest): Promise<MuxNotificationResult> {
			const result = await callObject(
				"notification.show",
				params({ title: request.title, body: request.body, sound: request.sound }),
			);
			// `reason` is required on the wire, but a server that grows a new one
			// must not turn a painted toast into a protocol error, so an unreadable
			// reason degrades to the shown flag alone.
			return {
				shown: result.shown === true,
				reason: optionalString(result, "reason") ?? (result.shown === true ? "shown" : "unknown"),
			};
		},
		subscribe,
		async close(): Promise<void> {
			disposed = true;
			reachable = false;
		},
	};
}
