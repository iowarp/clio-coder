/**
 * One local MCP server over stdio: spawn, initialize, list and call tools,
 * close. The client owns exactly one child process and never restarts it; a
 * server that dies stays dead until the gateway decides to create a new
 * client. Every request carries its own timeout, every failure is a typed
 * McpError, and nothing the server prints reaches this process's stdout or
 * stderr. Launching a server here is not sandboxing it: the child gets the
 * allowlisted tool environment and a workspace-contained cwd, nothing more.
 *
 * Both directions are bounded. The framer caps inbound lines; an outbound
 * cap bounds the bytes waiting on a server that stopped reading its stdin,
 * and crossing it is a fatal `overload` that closes the client. Teardown
 * covers the server's whole process group, not only the child it spawned,
 * escalates to SIGKILL for any member that outlives the grace period, and
 * begins the moment the leader is seen to exit, whether or not close() has
 * been called.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildSafeToolEnv, resolveSafeCwd } from "../../../core/safe-exec.js";
import { clampTimerDelayMs, sleep } from "../../../core/timers.js";
import {
	createLineFramer,
	DEFAULT_MAX_LINE_BYTES,
	encodeJsonRpcMessage,
	JSON_RPC_METHOD_NOT_FOUND,
	type JsonRpcId,
	type JsonRpcMessage,
	MCP_PROTOCOL_VERSION,
	McpError,
} from "./protocol.js";

export const MCP_CLIENT_NAME = "clio-coder";
export const DEFAULT_MCP_CLIENT_VERSION = "0.4.9";
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_STDERR_TAIL_BYTES = 16 * 1024;
export const DEFAULT_RESULT_TEXT_BYTES = 1024 * 1024;
export const DEFAULT_KILL_GRACE_MS = 3_000;
/** Bytes accepted for the server's stdin but not yet flushed before the client fails with `overload`. */
export const DEFAULT_MAX_OUTBOUND_BYTES = 4 * 1024 * 1024;
/** Tools accepted from one server before pagination stops. */
export const MCP_TOOL_LIST_CAP = 500;
/** Pages followed before a cursor that never ends is abandoned. */
const MCP_TOOL_LIST_PAGE_CAP = 100;
/** Smallest outbound cap a caller may configure; initialize alone needs a few hundred bytes. */
const MIN_OUTBOUND_BYTES = 4096;
/** How long a teardown waits for a SIGKILLed group to disappear before it gives up and says so. */
export const DEFAULT_TEARDOWN_BOUND_MS = 2_000;

export interface McpServerSpec {
	id: string;
	command: string;
	args?: ReadonlyArray<string>;
	cwd?: string;
	env?: Readonly<Record<string, string>>;
}

export interface McpClientOptions {
	/** Containment root for the server's cwd; a cwd outside it, by path or by symlink, is refused before spawn. */
	workspaceRoot: string;
	clientVersion?: string;
	initializeTimeoutMs?: number;
	requestTimeoutMs?: number;
	stderrTailBytes?: number;
	maxLineBytes?: number;
	/** Cap on the plain-text rendering of one tool result. */
	maxResultTextBytes?: number;
	/** Cap on bytes queued for a server that is not reading its stdin; crossing it fails the client. */
	maxOutboundBytes?: number;
	/** Delay between SIGTERM and SIGKILL on close. */
	killGraceMs?: number;
	/** Wait for the group to disappear after SIGKILL before the teardown is reported incomplete. */
	teardownBoundMs?: number;
	/** Aborting this signal closes the client. */
	signal?: AbortSignal;
}

export type McpClientStatus = "idle" | "starting" | "ready" | "closed" | "failed";

/**
 * How the process-group teardown ended. `complete: false` means members of
 * the group were still present when the post-SIGKILL bound passed; the id was
 * released all the same (see GroupPhase), so `pgid` is for the operator's
 * report, never for another signal.
 */
export type McpTeardownOutcome =
	| { complete: true }
	| { complete: false; reason: "group-survived-sigkill"; pgid: number; boundMs: number };

export type McpClientState = ({ status: Exclude<McpClientStatus, "failed"> } | { status: "failed"; reason: string }) & {
	/** Group members were still present when the post-SIGKILL bound passed; the client stopped waiting for them. */
	cleanupIncomplete: boolean;
	/** The teardown's outcome, null until one has run. Kept alongside an earlier fatal error, never in place of it. */
	teardown: McpTeardownOutcome | null;
};

export interface McpServerInfo {
	protocolVersion: string;
	serverInfo: { name: string; version: string } | null;
	capabilities: Record<string, unknown>;
	instructions: string | null;
}

export interface McpToolDescriptor {
	name: string;
	title: string | null;
	description: string;
	inputSchema: Record<string, unknown>;
	/** Server-declared hints; advisory only, never a safety input. */
	annotations: Record<string, unknown> | null;
}

export interface McpToolListing {
	tools: McpToolDescriptor[];
	/** True when the server offered more tools than the cap admits. */
	truncated: boolean;
}

export type McpContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; data: string }
	| { type: "audio"; mimeType: string; data: string }
	| { type: "resource"; uri: string; text?: string; mimeType?: string }
	| { type: "other"; raw: unknown };

export interface McpToolCallResult {
	content: McpContentBlock[];
	isError: boolean;
	structuredContent?: unknown;
	/** Bounded plain rendering of the content blocks. */
	text: string;
	textTruncated: boolean;
}

export interface McpCallToolOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface McpClient {
	readonly id: string;
	readonly pid: number | undefined;
	initialize(): Promise<McpServerInfo>;
	listTools(): Promise<McpToolListing>;
	callTool(name: string, args: Record<string, unknown>, options?: McpCallToolOptions): Promise<McpToolCallResult>;
	/** Resolves with the teardown outcome; an incomplete teardown is flagged there and in state(), not thrown. */
	close(): Promise<McpTeardownOutcome>;
	/** Synchronous exit backstop. Signals only a currently owned group; use close() for awaited teardown. */
	killOwnedOnExit(): void;
	state(): McpClientState;
	serverInfo(): McpServerInfo | null;
	/** Set by `notifications/tools/list_changed`; cleared by acknowledgeToolsChanged. */
	toolsChanged(): boolean;
	acknowledgeToolsChanged(): void;
	notificationCount(): number;
	/** Bounded tail of everything the server wrote to stderr. */
	stderrTail(): string;
}

interface PendingRequest {
	method: string;
	resolve(value: unknown): void;
	reject(error: McpError): void;
}

type OutboundMessage = Parameters<typeof encodeJsonRpcMessage>[0];

interface OutboundEntry {
	payload: Buffer;
	/** The request this line carries, so a request that settles unsent can be withdrawn. */
	requestId: number | null;
	onError: ((error: Error) => void) | undefined;
}

type EnqueueOutcome = { kind: "queued" } | { kind: "oversized"; bytes: number } | { kind: "overloaded" };

/**
 * Lifecycle of the server's process group as this client tracks it. The
 * leader's pid doubles as the group id because the child is spawned detached.
 * The kernel keeps a group id reserved only while some member of that group
 * exists; once the last member is reaped, the number can be handed to an
 * unrelated process, and a signal-0 probe would then report a stranger as
 * alive. Two rules keep this client from ever signalling a stranger:
 *
 *   1. Cleanup starts the moment the leader is seen to exit, not when close()
 *      happens to be called. At that instant the group is still ours or is
 *      already empty, so an arbitrarily late close() never gets to signal a
 *      number that has had time to change hands.
 *   2. Once the group has been observed gone (ESRCH), or cleanup has run to
 *      its bound, the id is `released` and is never probed or signalled
 *      again, whatever a later probe would say. A group that survives SIGKILL
 *      for the confirm window is unreaped zombies or something we cannot end
 *      either way; keeping the number is worth nothing and risks a stranger.
 *
 * The residual exposure is a reuse of the number between two 10 ms polls of
 * one active cleanup, the same window every group-signalling spawner in this
 * codebase accepts. Direct-child signals go through Node's own handle, which
 * knows whether that pid has been reaped, so they carry no such risk.
 */
type GroupPhase = "unspawned" | "live" | "cleaning" | "released";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Cut a string at a UTF-8 byte boundary at or below `maxBytes`. */
function cutUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const bytes = Buffer.from(text, "utf8");
	let cut = Math.max(0, maxBytes);
	while (cut > 0) {
		const byte = bytes[cut];
		if (byte === undefined || (byte & 0xc0) !== 0x80) break;
		cut -= 1;
	}
	return bytes.subarray(0, cut).toString("utf8");
}

/**
 * The canonical directory the server starts in, or why there is none. The cwd
 * must stay inside the workspace root lexically and after every symbolic link
 * is followed, and it must exist as a directory. Checked once at creation for
 * early feedback and again at spawn, which is the boundary that matters.
 */
function containedCwd(spec: McpServerSpec, workspaceRoot: string): string | Error {
	let lexical: string;
	try {
		lexical = resolveSafeCwd(spec.cwd, workspaceRoot);
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	let realRoot: string;
	let real: string;
	try {
		realRoot = realpathSync(path.resolve(workspaceRoot));
		real = realpathSync(lexical);
		if (!statSync(real).isDirectory()) return new Error(`cwd is not a directory: ${lexical}`);
	} catch (error) {
		return new Error(`cwd cannot be resolved: ${lexical} (${errorMessage(error)})`);
	}
	try {
		resolveSafeCwd(real, realRoot);
	} catch {
		return new Error(`cwd escapes workspace root through a symbolic link: ${lexical} -> ${real}`);
	}
	return real;
}

function parseServerInfo(value: unknown): McpServerInfo | McpError {
	if (!isRecord(value)) return new McpError("protocol", "initialize result is not an object");
	if (typeof value.protocolVersion !== "string" || value.protocolVersion.length === 0) {
		return new McpError("protocol", "initialize result lacks a protocolVersion string");
	}
	const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
	let serverInfo: McpServerInfo["serverInfo"] = null;
	if (isRecord(value.serverInfo)) {
		serverInfo = {
			name: typeof value.serverInfo.name === "string" ? value.serverInfo.name : "",
			version: typeof value.serverInfo.version === "string" ? value.serverInfo.version : "",
		};
	}
	return {
		protocolVersion: value.protocolVersion,
		serverInfo,
		capabilities,
		instructions: typeof value.instructions === "string" ? value.instructions : null,
	};
}

function parseToolDescriptor(value: unknown): McpToolDescriptor | McpError {
	if (!isRecord(value)) return new McpError("protocol", "tools/list entry is not an object");
	if (typeof value.name !== "string" || value.name.length === 0) {
		return new McpError("protocol", "tools/list entry lacks a name");
	}
	const inputSchema = isRecord(value.inputSchema) ? value.inputSchema : { type: "object" };
	return {
		name: value.name,
		title: typeof value.title === "string" ? value.title : null,
		description: typeof value.description === "string" ? value.description : "",
		inputSchema,
		annotations: isRecord(value.annotations) ? value.annotations : null,
	};
}

function normalizeContentBlock(value: unknown): McpContentBlock {
	if (!isRecord(value) || typeof value.type !== "string") return { type: "other", raw: value };
	switch (value.type) {
		case "text":
			return typeof value.text === "string" ? { type: "text", text: value.text } : { type: "other", raw: value };
		case "image":
		case "audio":
			if (typeof value.data === "string" && typeof value.mimeType === "string") {
				return { type: value.type, mimeType: value.mimeType, data: value.data };
			}
			return { type: "other", raw: value };
		case "resource": {
			const resource = value.resource;
			if (!isRecord(resource) || typeof resource.uri !== "string") return { type: "other", raw: value };
			return {
				type: "resource",
				uri: resource.uri,
				...(typeof resource.text === "string" ? { text: resource.text } : {}),
				...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
			};
		}
		case "resource_link":
			if (typeof value.uri !== "string") return { type: "other", raw: value };
			return {
				type: "resource",
				uri: value.uri,
				...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
			};
		default:
			return { type: "other", raw: value };
	}
}

function renderContentBlock(block: McpContentBlock): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "image":
		case "audio":
			return `[${block.type} ${block.mimeType}, ${Buffer.byteLength(block.data, "base64")} bytes]`;
		case "resource":
			return block.text === undefined ? `[resource ${block.uri}]` : `[resource ${block.uri}]\n${block.text}`;
		case "other": {
			const type = isRecord(block.raw) && typeof block.raw.type === "string" ? block.raw.type : "unknown";
			return `[unsupported content type ${type}]`;
		}
	}
}

/** Render every block as plain text and bound the whole rendering. */
export function renderMcpContent(
	blocks: ReadonlyArray<McpContentBlock>,
	maxBytes: number = DEFAULT_RESULT_TEXT_BYTES,
): { text: string; truncated: boolean } {
	const joined = blocks.map(renderContentBlock).join("\n");
	if (Buffer.byteLength(joined, "utf8") <= maxBytes) return { text: joined, truncated: false };
	const marker = `\n[mcp result text truncated at ${maxBytes} bytes]`;
	const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	return { text: `${cutUtf8(joined, budget)}${marker}`, truncated: true };
}

function parseToolCallResult(value: unknown, maxTextBytes: number): McpToolCallResult | McpError {
	if (!isRecord(value)) return new McpError("protocol", "tools/call result is not an object");
	const rawContent = Array.isArray(value.content) ? value.content : [];
	const content = rawContent.map(normalizeContentBlock);
	const rendered = renderMcpContent(content, maxTextBytes);
	const result: McpToolCallResult = {
		content,
		isError: value.isError === true,
		text: rendered.text,
		textTruncated: rendered.truncated,
	};
	if (value.structuredContent !== undefined) result.structuredContent = value.structuredContent;
	return result;
}

export function createMcpStdioClient(spec: McpServerSpec, options: McpClientOptions): McpClient {
	const initialCwd = containedCwd(spec, options.workspaceRoot);
	if (initialCwd instanceof Error) throw new McpError("spawn", `mcp server ${spec.id}: ${initialCwd.message}`);
	const initializeTimeoutMs = clampTimerDelayMs(options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS);
	const requestTimeoutMs = clampTimerDelayMs(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
	const stderrTailBytes = Math.max(0, options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES);
	const maxResultTextBytes = Math.max(64, options.maxResultTextBytes ?? DEFAULT_RESULT_TEXT_BYTES);
	const maxOutboundBytes = Math.max(MIN_OUTBOUND_BYTES, options.maxOutboundBytes ?? DEFAULT_MAX_OUTBOUND_BYTES);
	const killGraceMs = clampTimerDelayMs(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
	const teardownBoundMs = clampTimerDelayMs(options.teardownBoundMs ?? DEFAULT_TEARDOWN_BOUND_MS);
	const clientVersion = options.clientVersion ?? DEFAULT_MCP_CLIENT_VERSION;
	const framer = createLineFramer(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);

	let status: McpClientStatus = "idle";
	let failure: McpError | null = null;
	let child: ChildProcess | null = null;
	let spawned: Promise<boolean> | null = null;
	let exited: Promise<void> | null = null;
	let leaderExited = false;
	let groupPhase: GroupPhase = "unspawned";
	let groupCleanup: Promise<McpTeardownOutcome> | null = null;
	let teardown: McpTeardownOutcome | null = null;
	let closing = false;
	let initializePromise: Promise<McpServerInfo> | null = null;
	let closePromise: Promise<McpTeardownOutcome> | null = null;
	let info: McpServerInfo | null = null;
	let nextId = 1;
	const pending = new Map<number, PendingRequest>();
	const outbound: OutboundEntry[] = [];
	let outboundQueuedBytes = 0;
	let awaitingDrain = false;
	let notifications = 0;
	let toolsChangedFlag = false;
	let stderrTailBuffer = Buffer.alloc(0);

	const isAlive = (): boolean => child !== null && child.exitCode === null && child.signalCode === null;

	/** The error every later request gets once the client cannot serve it. */
	const closedError = (): McpError => failure ?? new McpError("closed", `mcp server ${spec.id} is closed`);

	const rejectAllPending = (error: McpError): void => {
		for (const entry of [...pending.values()]) entry.reject(error);
	};

	/** Record the first fatal error; later ones never overwrite the cause a caller sees. */
	const fail = (error: McpError): void => {
		if (status === "closed" || status === "failed") return;
		status = "failed";
		failure = error;
		rejectAllPending(error);
	};

	/** The group id may be signalled only while the group is known to be ours (see GroupPhase). */
	const groupOwned = (): boolean => groupPhase === "live" || groupPhase === "cleaning";

	const signalGroup = (signalName: NodeJS.Signals): void => {
		const pid = child?.pid;
		if (pid !== undefined && process.platform !== "win32" && groupOwned()) {
			try {
				process.kill(-pid, signalName);
				return;
			} catch (error) {
				// ESRCH: the group is gone, and the number is no longer ours to touch.
				if ((error as NodeJS.ErrnoException).code === "ESRCH") groupPhase = "released";
			}
		}
		// Node's handle knows whether this pid was reaped, so the direct child is always safe to address.
		try {
			child?.kill(signalName);
		} catch {
			// Already exited.
		}
	};

	/** True while any member of the server's process group exists, whether or not the leader does. */
	const groupAlive = (): boolean => {
		const pid = child?.pid;
		if (pid === undefined || !groupOwned()) return false;
		if (process.platform !== "win32") {
			try {
				process.kill(-pid, 0);
				return true;
			} catch (error) {
				// ESRCH means every member is gone; the number is released for good.
				// EPERM means a member exists that this process may not signal;
				// anything else is treated as alive so cleanup never reports a
				// teardown it did not observe.
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
				groupPhase = "released";
				return false;
			}
		}
		return isAlive();
	};

	const terminationObserved = (): boolean => leaderExited && !groupAlive();

	/** Poll until the leader has been reaped and its group is empty, or the bound elapses. */
	const waitForTermination = async (timeoutMs: number): Promise<boolean> => {
		const deadline = performance.now() + timeoutMs;
		while (!terminationObserved()) {
			const remaining = deadline - performance.now();
			if (remaining <= 0) return terminationObserved();
			const nap = sleep(Math.min(10, remaining));
			await (leaderExited || exited === null ? nap : Promise.race([exited, nap]));
		}
		return true;
	};

	const destroyStdio = (): void => {
		for (const stream of [child?.stdin, child?.stdout, child?.stderr]) stream?.destroy();
	};

	/**
	 * Tear the group down once: SIGTERM, the grace period, SIGKILL for whatever
	 * is left, a bounded wait for it to disappear, then release the id for
	 * good. Runs from close() and from the leader's exit, whichever comes first;
	 * the second caller shares the first run. When something survives even
	 * SIGKILL the outcome says so, with the group id, and our pipe ends are
	 * dropped so the survivor cannot pin this process's event loop; otherwise
	 * the pipes drain naturally and the stderr tail stays whole. The outcome is
	 * flagged rather than thrown: a caller's shutdown loop cannot do anything
	 * about a survivor except report it, and the flag carries what to report.
	 */
	const cleanupGroup = (): Promise<McpTeardownOutcome> => {
		if (groupCleanup !== null) return groupCleanup;
		groupCleanup = (async () => {
			let terminated = true;
			const pgid = child?.pid;
			if (groupPhase === "live" && pgid !== undefined) {
				groupPhase = "cleaning";
				if (groupAlive()) signalGroup("SIGTERM");
				terminated = await waitForTermination(killGraceMs);
				if (!terminated) {
					if (groupAlive()) signalGroup("SIGKILL");
					terminated = await waitForTermination(teardownBoundMs);
				}
			} else {
				await (exited ?? Promise.resolve());
			}
			groupPhase = "released";
			const outcome: McpTeardownOutcome =
				terminated || pgid === undefined
					? { complete: true }
					: { complete: false, reason: "group-survived-sigkill", pgid, boundMs: killGraceMs + teardownBoundMs };
			teardown = outcome;
			if (!outcome.complete) destroyStdio();
			return outcome;
		})();
		return groupCleanup;
	};

	/** Bytes accepted for the server but not yet flushed: this queue plus the stream's own buffer. */
	const pendingOutboundBytes = (): number => outboundQueuedBytes + (child?.stdin?.writableLength ?? 0);

	const flushOutbound = (): void => {
		while (!awaitingDrain) {
			const entry = outbound.shift();
			if (entry === undefined) return;
			outboundQueuedBytes -= entry.payload.length;
			const stdin = child?.stdin;
			if (!stdin || stdin.destroyed || !stdin.writable) {
				entry.onError?.(new Error("server stdin is not writable"));
				continue;
			}
			const accepted = stdin.write(entry.payload, (error) => {
				if (error) entry.onError?.(error);
			});
			if (!accepted) {
				awaitingDrain = true;
				stdin.once("drain", () => {
					awaitingDrain = false;
					flushOutbound();
				});
			}
		}
	};

	/**
	 * Queue one line for the server. A line larger than the cap is refused on
	 * its own; a line that would push the unflushed total over the cap means the
	 * server stopped reading, which fails the client and closes it.
	 */
	const enqueueOutbound = (
		message: OutboundMessage,
		requestId: number | null,
		onError?: (error: Error) => void,
	): EnqueueOutcome => {
		const payload = encodeJsonRpcMessage(message);
		if (payload.length > maxOutboundBytes) return { kind: "oversized", bytes: payload.length };
		const queued = pendingOutboundBytes();
		if (queued + payload.length > maxOutboundBytes) {
			fail(
				new McpError(
					"overload",
					`mcp server ${spec.id} stopped reading its stdin: ${queued} bytes are queued for it and the outbound cap is ${maxOutboundBytes} bytes`,
				),
			);
			void close();
			return { kind: "overloaded" };
		}
		outbound.push({ payload, requestId, onError });
		outboundQueuedBytes += payload.length;
		flushOutbound();
		return { kind: "queued" };
	};

	/** Drop a request's line if it is still waiting in the queue. */
	const withdrawOutbound = (requestId: number): void => {
		const index = outbound.findIndex((entry) => entry.requestId === requestId);
		if (index === -1) return;
		const [entry] = outbound.splice(index, 1);
		if (entry !== undefined) outboundQueuedBytes -= entry.payload.length;
	};

	const dispatch = (frame: JsonRpcMessage): void => {
		if (frame.kind === "response") {
			const id = frame.message.id;
			if (typeof id !== "number") return;
			const entry = pending.get(id);
			if (entry === undefined) return;
			if (frame.message.error !== undefined) {
				const error = frame.message.error;
				entry.reject(new McpError("server", `${entry.method}: ${error.message} (code ${error.code})`, error));
				return;
			}
			entry.resolve(frame.message.result);
			return;
		}
		if (frame.kind === "request") {
			const request = frame.message;
			const outcome = enqueueOutbound(
				{
					jsonrpc: "2.0",
					id: request.id as JsonRpcId,
					error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `method not found: ${request.method}` },
				},
				null,
			);
			if (outcome.kind === "oversized") {
				fail(
					new McpError(
						"overload",
						`mcp server ${spec.id} sent a request whose ${outcome.bytes}-byte reply exceeds the ${maxOutboundBytes}-byte outbound cap`,
					),
				);
				void close();
			}
			return;
		}
		notifications += 1;
		if (frame.message.method === "notifications/tools/list_changed") toolsChangedFlag = true;
	};

	const consumeFrames = (frames: ReturnType<typeof framer.push>): void => {
		for (const frame of frames) {
			if (status === "closed" || status === "failed") return;
			if (frame.kind === "message") {
				dispatch(frame.message);
				continue;
			}
			fail(new McpError("protocol", `protocol error from mcp server ${spec.id}: ${frame.error.message}`));
			void close();
			return;
		}
	};

	const spawnChild = (): boolean => {
		const cwd = containedCwd(spec, options.workspaceRoot);
		if (cwd instanceof Error) {
			fail(new McpError("spawn", `mcp server ${spec.id} failed to start: ${cwd.message}`));
			return false;
		}
		let proc: ChildProcess;
		try {
			proc = spawn(spec.command, [...(spec.args ?? [])], {
				cwd,
				env: buildSafeToolEnv({ ...(spec.env ?? {}) }),
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			fail(new McpError("spawn", `mcp server ${spec.id} failed to start: ${errorMessage(error)}`));
			return false;
		}
		child = proc;
		if (proc.pid !== undefined) groupPhase = "live";
		spawned = new Promise<boolean>((resolve) => {
			proc.once("spawn", () => resolve(true));
			proc.once("error", (error) => {
				fail(new McpError("spawn", `mcp server ${spec.id} failed to start: ${error.message}`));
				resolve(false);
			});
		});
		exited = new Promise<void>((resolve) => {
			proc.once("exit", (code, signal) => {
				leaderExited = true;
				if (!closing && status !== "failed") {
					fail(
						new McpError(
							"closed",
							`mcp server ${spec.id} exited with ${signal !== null ? `signal ${signal}` : `code ${code ?? "?"}`} before the client closed it`,
						),
					);
				} else {
					rejectAllPending(closedError());
				}
				resolve();
				// Whatever the leader left in its group is torn down now, while the id is still ours.
				void cleanupGroup();
			});
			proc.once("error", () => {
				if (proc.pid === undefined) {
					leaderExited = true;
					resolve();
				}
			});
		});
		proc.stdin?.on("error", () => {
			// Surfaced through the write callbacks; a bare listener keeps the event from throwing.
		});
		proc.stdout?.on("data", (chunk: Buffer) => consumeFrames(framer.push(chunk)));
		proc.stdout?.on("end", () => consumeFrames(framer.flush()));
		proc.stderr?.on("data", (chunk: Buffer) => {
			if (stderrTailBytes === 0) return;
			const joined = Buffer.concat([stderrTailBuffer, chunk]);
			stderrTailBuffer =
				joined.length > stderrTailBytes ? Buffer.from(joined.subarray(joined.length - stderrTailBytes)) : joined;
		});
		return true;
	};

	const request = (method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> =>
		new Promise<unknown>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new McpError("aborted", `${method} aborted before it was sent`));
				return;
			}
			if (child === null || status === "closed" || status === "failed") {
				reject(closedError());
				return;
			}
			const id = nextId++;
			let timer: ReturnType<typeof setTimeout> | null = null;
			const settle = (finish: () => void): void => {
				if (!pending.has(id)) return;
				pending.delete(id);
				withdrawOutbound(id);
				if (timer !== null) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				finish();
			};
			const onAbort = (): void => settle(() => reject(new McpError("aborted", `${method} aborted`)));
			pending.set(id, {
				method,
				resolve: (value) => settle(() => resolve(value)),
				reject: (error) => settle(() => reject(error)),
			});
			if (timeoutMs > 0) {
				timer = setTimeout(
					() => settle(() => reject(new McpError("timeout", `${method} timed out after ${timeoutMs}ms`))),
					timeoutMs,
				);
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			const outcome = enqueueOutbound(
				{ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
				id,
				(error) => {
					settle(() => reject(failure ?? new McpError("closed", `write to mcp server ${spec.id} failed: ${error.message}`)));
				},
			);
			if (outcome.kind === "oversized") {
				settle(() =>
					reject(
						new McpError(
							"overload",
							`${method} request of ${outcome.bytes} bytes exceeds the ${maxOutboundBytes}-byte outbound cap`,
						),
					),
				);
			}
			// An overloaded queue already failed the client, which rejected this request with the cause.
		});

	const initialize = (): Promise<McpServerInfo> => {
		if (status === "closed" || status === "failed") return Promise.reject(closedError());
		if (initializePromise !== null) return initializePromise;
		initializePromise = (async () => {
			status = "starting";
			if (!spawnChild()) {
				await close();
				throw closedError();
			}
			const started = await (spawned ?? Promise.resolve(false));
			if (!started) {
				await close();
				throw closedError();
			}
			let result: unknown;
			try {
				result = await request(
					"initialize",
					{
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: {},
						clientInfo: { name: MCP_CLIENT_NAME, version: clientVersion },
					},
					initializeTimeoutMs,
				);
			} catch (error) {
				const cause = error instanceof McpError ? error : new McpError("protocol", errorMessage(error));
				fail(new McpError(cause.code, `initialize failed: ${cause.message}`, cause.data));
				await close();
				throw closedError();
			}
			const parsed = parseServerInfo(result);
			if (parsed instanceof McpError) {
				fail(new McpError("protocol", `initialize failed: ${parsed.message}`));
				await close();
				throw closedError();
			}
			info = parsed;
			enqueueOutbound({ jsonrpc: "2.0", method: "notifications/initialized" }, null);
			if (status === "starting") status = "ready";
			return parsed;
		})();
		return initializePromise;
	};

	const ensureReady = async (): Promise<void> => {
		if (status === "ready") return;
		await initialize();
	};

	const listTools = async (): Promise<McpToolListing> => {
		await ensureReady();
		const tools: McpToolDescriptor[] = [];
		let cursor: string | undefined;
		let pages = 0;
		for (;;) {
			pages += 1;
			const result = await request("tools/list", cursor === undefined ? {} : { cursor }, requestTimeoutMs);
			if (!isRecord(result) || !Array.isArray(result.tools)) {
				throw new McpError("protocol", "tools/list result lacks a tools array");
			}
			for (const entry of result.tools) {
				if (tools.length >= MCP_TOOL_LIST_CAP) return { tools, truncated: true };
				const descriptor = parseToolDescriptor(entry);
				if (descriptor instanceof McpError) throw descriptor;
				tools.push(descriptor);
			}
			const next = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
			if (next === undefined) return { tools, truncated: false };
			if (tools.length >= MCP_TOOL_LIST_CAP || pages >= MCP_TOOL_LIST_PAGE_CAP) return { tools, truncated: true };
			cursor = next;
		}
	};

	const callTool = async (
		name: string,
		args: Record<string, unknown>,
		callOptions: McpCallToolOptions = {},
	): Promise<McpToolCallResult> => {
		await ensureReady();
		const timeoutMs = clampTimerDelayMs(callOptions.timeoutMs ?? requestTimeoutMs);
		const result = await request("tools/call", { name, arguments: args }, timeoutMs, callOptions.signal);
		const parsed = parseToolCallResult(result, maxResultTextBytes);
		if (parsed instanceof McpError) throw parsed;
		return parsed;
	};

	/**
	 * End the server: close its stdin, then run (or join) the group teardown.
	 * The leader's exit is not the end of it; a descendant that outlives the
	 * leader is signalled and waited for the same way. Our ends of the pipes
	 * are dropped last, since nobody reads them after close.
	 */
	const close = (): Promise<McpTeardownOutcome> => {
		if (closePromise !== null) return closePromise;
		closePromise = (async () => {
			closing = true;
			if (status !== "failed") status = "closed";
			rejectAllPending(closedError());
			outbound.length = 0;
			outboundQueuedBytes = 0;
			if (child === null) {
				teardown ??= { complete: true };
				return teardown;
			}
			try {
				child.stdin?.end();
			} catch {
				// Nothing to flush on a dead pipe.
			}
			const outcome = await cleanupGroup();
			destroyStdio();
			return outcome;
		})();
		return closePromise;
	};

	if (options.signal !== undefined) {
		if (options.signal.aborted) void close();
		else options.signal.addEventListener("abort", () => void close(), { once: true });
	}

	return {
		id: spec.id,
		get pid() {
			return child?.pid;
		},
		initialize,
		listTools,
		callTool,
		close,
		killOwnedOnExit: () => {
			// ESRCH releases ownership before the asynchronous teardown record settles.
			// Check the live ownership state, never the retained pid or final outcome.
			if (groupOwned()) signalGroup("SIGKILL");
		},
		state: () => {
			const cleanup = { cleanupIncomplete: teardown?.complete === false, teardown };
			return status === "failed"
				? { status, reason: failure?.message ?? `mcp server ${spec.id} failed`, ...cleanup }
				: { status, ...cleanup };
		},
		serverInfo: () => info,
		toolsChanged: () => toolsChangedFlag,
		acknowledgeToolsChanged: () => {
			toolsChangedFlag = false;
		},
		notificationCount: () => notifications,
		stderrTail: () => stderrTailBuffer.toString("utf8"),
	};
}
