/**
 * Newline-delimited JSON client for a herdr server's Unix domain socket.
 *
 * Two connection kinds, because the server treats them differently:
 *
 *   1. One persistent request/response connection. Every call gets a monotonic
 *      id, lands in a pending map, and is settled by the response line carrying
 *      that id. A call with no response inside its budget rejects with
 *      {@link MuxRequestTimeout}.
 *   2. One dedicated connection per `events.subscribe` stream. herdr holds a
 *      subscription connection open, acknowledges once, and then pushes event
 *      lines on it forever, so it cannot share the request connection.
 *
 * Both reconnect with capped exponential backoff. After a subscription
 * reconnect the client refetches `session.snapshot` and hands it to the resync
 * handler: herdr's documented pattern is snapshot once and then trust events,
 * and events missed while the socket was down are simply gone.
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
	type MuxLog,
	type MuxPane,
	type MuxReportableAgentState,
	MuxRequestTimeout,
	type MuxServerInfo,
	type MuxSnapshot,
	type MuxTab,
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

export interface MuxTabCreateRequest {
	workspaceId?: string;
	label?: string;
	cwd?: string;
	env?: Readonly<Record<string, string>>;
	focus?: boolean;
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

/**
 * The domain-facing surface. Phase 1 covers exactly the wire methods spec 4.3
 * lists for this phase, plus `pane.send_text`, `pane.report_agent`,
 * `pane.report_metadata` (see the notes on those methods below).
 */
export interface MuxClient {
	readonly socketPath: string;
	/** True while the request connection is up. */
	connected(): boolean;
	/** Protocol/version recorded from the most recent successful ping or snapshot. */
	server(): MuxServerInfo | null;
	/** Most recent `session.snapshot`, including the post-reconnect refetch. */
	cachedSnapshot(): MuxSnapshot | null;

	ping(options?: { timeoutMs?: number }): Promise<MuxServerInfo>;
	snapshot(): Promise<MuxSnapshot>;
	paneCurrent(callerPaneId?: string): Promise<MuxPane>;
	paneList(workspaceId?: string): Promise<ReadonlyArray<MuxPane>>;
	paneGet(paneId: string): Promise<MuxPane>;
	paneSplit(request: MuxSplitRequest): Promise<MuxPane>;
	paneClose(paneId: string): Promise<void>;
	/** Pane ids sharing a tab with `paneId`, read off the tab's layout snapshot. */
	paneLayout(paneId?: string): Promise<ReadonlyArray<string>>;
	tabCreate(request: MuxTabCreateRequest): Promise<{ tab: MuxTab; rootPane: MuxPane }>;
	tabList(workspaceId?: string): Promise<ReadonlyArray<MuxTab>>;
	tabFocus(tabId: string): Promise<MuxTab>;
	/**
	 * Deliver a command line into a pane's shell. herdr has no argv parameter on
	 * `pane.split`, so this is the only way an argv utility pane can run what it
	 * was asked to run.
	 */
	paneSendText(paneId: string, text: string): Promise<void>;
	/** Takes agent authority over a pane. Only ever called on Clio-owned panes and Clio's own pane. */
	paneReportAgent(request: MuxReportAgentRequest): Promise<void>;
	paneReportMetadata(request: MuxReportMetadataRequest): Promise<void>;

	subscribe(
		kinds: ReadonlyArray<MuxEventKind>,
		handler: (event: MuxEvent) => void,
		options?: MuxSubscribeOptions,
	): Promise<MuxSubscription>;

	close(): Promise<void>;
}

interface PendingCall {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	timer: NodeJS.Timeout;
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

/** herdr names lifecycle event kinds with underscores on the wire and dots in subscriptions. */
const EVENT_KIND_BY_WIRE: Readonly<Record<string, MuxEventKind>> = {
	pane_closed: "pane.closed",
	pane_exited: "pane.exited",
};

function readEvent(line: Record<string, unknown>): MuxEvent | null {
	const wireKind = line.event;
	if (typeof wireKind !== "string") return null;
	const kind = EVENT_KIND_BY_WIRE[wireKind];
	if (!kind) return null;
	const data = asRecord(line.data);
	if (!data) return null;
	const paneId = data.pane_id;
	const workspaceId = data.workspace_id;
	if (typeof paneId !== "string" || typeof workspaceId !== "string") return null;
	return { kind, paneId, workspaceId };
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
	let requestSocket: net.Socket | null = null;
	let connecting: Promise<net.Socket> | null = null;
	let nextId = 0;
	const pending = new Map<string, PendingCall>();
	let serverInfo: MuxServerInfo | null = null;
	let snapshotCache: MuxSnapshot | null = null;

	/** Consecutive failed connect attempts on the request channel. */
	let requestFailures = 0;
	/** Wall clock before which a new request-channel connect is refused. */
	let requestRetryAt = 0;

	const delayFor = (failures: number): number =>
		Math.min(backoff.maxDelayMs, backoff.initialDelayMs * backoff.factor ** Math.max(0, failures - 1));

	const failPending = (error: MuxError): void => {
		for (const call of pending.values()) {
			clearTimeout(call.timer);
			call.reject(error);
		}
		pending.clear();
	};

	const dropRequestSocket = (reason: string): void => {
		const socket = requestSocket;
		requestSocket = null;
		if (socket) socket.destroy();
		failPending(new MuxError("transport", `mux request connection lost: ${reason}`));
	};

	const handleResponseLine = (line: Record<string, unknown>): void => {
		const id = line.id;
		if (typeof id !== "string") return;
		const call = pending.get(id);
		if (!call) return;
		pending.delete(id);
		clearTimeout(call.timer);
		const error = asRecord(line.error);
		if (error) {
			const code = typeof error.code === "string" ? error.code : "unknown";
			const message = typeof error.message === "string" ? error.message : code;
			call.reject(new MuxError(muxErrorKind(code), message, { wireCode: code, method: call.method }));
			return;
		}
		call.resolve(line.result);
	};

	const ensureRequestSocket = async (): Promise<net.Socket> => {
		if (disposed) throw new MuxError("transport", "mux client is closed");
		if (requestSocket && !requestSocket.destroyed) return requestSocket;
		if (connecting) return connecting;
		const waitMs = requestRetryAt - Date.now();
		if (waitMs > 0) {
			throw new MuxError("transport", `mux socket ${socketPath} is in backoff for another ${waitMs}ms`);
		}
		connecting = (async () => {
			try {
				const socket = await connectSocket(socketPath, connectTimeoutMs);
				readJsonLines(socket, handleResponseLine, () => dropRequestSocket("oversized response line"));
				socket.on("error", (error: Error) => dropRequestSocket(error.message));
				socket.on("close", () => {
					if (requestSocket === socket) dropRequestSocket("closed by peer");
				});
				requestSocket = socket;
				requestFailures = 0;
				requestRetryAt = 0;
				return socket;
			} catch (error) {
				requestFailures += 1;
				requestRetryAt = Date.now() + delayFor(requestFailures);
				throw error;
			} finally {
				connecting = null;
			}
		})();
		return connecting;
	};

	const call = async (method: string, callParams: Record<string, unknown>, timeoutMs?: number): Promise<unknown> => {
		const socket = await ensureRequestSocket();
		nextId += 1;
		const id = `clio-${nextId}`;
		const budget = timeoutMs ?? requestTimeoutMs;
		return await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new MuxRequestTimeout(method, budget));
			}, budget);
			timer.unref?.();
			pending.set(id, { method, resolve, reject, timer });
			socket.write(`${JSON.stringify({ id, method, params: callParams })}\n`, (error) => {
				if (!error) return;
				const inflight = pending.get(id);
				if (!inflight) return;
				pending.delete(id);
				clearTimeout(inflight.timer);
				reject(new MuxError("transport", `mux request ${method} failed to write: ${error.message}`, { method }));
			});
		});
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
			return requestSocket !== null && !requestSocket.destroyed;
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
		async paneGet(paneId: string): Promise<MuxPane> {
			const result = await callObject("pane.get", { pane_id: paneId });
			return readPane(result.pane);
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
		async paneClose(paneId: string): Promise<void> {
			await call("pane.close", { pane_id: paneId });
		},
		async paneLayout(paneId?: string): Promise<ReadonlyArray<string>> {
			const result = await callObject("pane.layout", params({ pane_id: paneId }));
			const layout = asRecord(result.layout);
			if (!layout) throw new MuxError("protocol", "mux pane.layout returned no layout");
			const ids: string[] = [];
			for (const entry of readArray(layout, "panes")) {
				const pane = asRecord(entry);
				const id = pane ? pane.pane_id : undefined;
				if (typeof id === "string") ids.push(id);
			}
			return ids;
		},
		async tabCreate(request: MuxTabCreateRequest): Promise<{ tab: MuxTab; rootPane: MuxPane }> {
			const result = await callObject(
				"tab.create",
				params({
					workspace_id: request.workspaceId,
					label: request.label,
					cwd: request.cwd,
					env: request.env,
					focus: request.focus ?? false,
				}),
			);
			return { tab: readTab(result.tab), rootPane: readPane(result.root_pane) };
		},
		async tabList(workspaceId?: string): Promise<ReadonlyArray<MuxTab>> {
			const result = await callObject("tab.list", params({ workspace_id: workspaceId }));
			return readArray(result, "tabs").map(readTab);
		},
		async tabFocus(tabId: string): Promise<MuxTab> {
			const result = await callObject("tab.focus", { tab_id: tabId });
			return readTab(result.tab);
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
		subscribe,
		async close(): Promise<void> {
			disposed = true;
			dropRequestSocket("client closed");
		},
	};
}
