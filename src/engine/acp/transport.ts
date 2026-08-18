import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import { MAX_TIMER_DELAY_MS } from "../../core/timers.js";
import {
	ACP_INTERNAL_ERROR_MESSAGE,
	ACP_METHOD_NOT_FOUND_MESSAGE,
	AcpProcessError,
	AcpProtocolError,
	AcpRequestError,
	AcpTimeoutError,
	acpErrorData,
	acpErrorMessage,
} from "./errors.js";
import type { AcpJsonRpcFailure, AcpJsonRpcMessage, AcpJsonRpcSuccess } from "./types.js";

/**
 * Largest single stdin line this process will buffer, in UTF-8 bytes. A
 * newline-delimited protocol has no other backstop: without a bound, a peer
 * that never sends a newline grows the pending buffer until the process dies.
 * Past the bound the line is discarded up to the next newline, one error frame
 * is emitted, and the channel stays open and parseable.
 */
export const ACP_MAX_INPUT_LINE_BYTES = 1024 * 1024;

/**
 * Cheap guard before the O(n) byte measurement. UTF-8 never spends more than
 * three bytes on one UTF-16 code unit (a surrogate pair is two units and four
 * bytes), so anything at or under a third of the bound cannot exceed it.
 */
function exceedsInputLineBytes(value: string): boolean {
	if (value.length <= ACP_MAX_INPUT_LINE_BYTES / 3) return false;
	return Buffer.byteLength(value, "utf8") > ACP_MAX_INPUT_LINE_BYTES;
}

type NotificationHandler = (params: unknown) => void;
type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
type StderrHandler = (chunk: string) => void;
type CloseHandler = () => void;

interface PendingRequest {
	resolve(value: unknown): void;
	reject(reason: unknown): void;
	timer?: ReturnType<typeof setTimeout>;
	method: string;
}

export interface AcpJsonRpcTransport {
	readonly closed: boolean;
	readonly pid: number | null;
	/**
	 * Scope owned by this transport's force-termination path. POSIX transports
	 * own a dedicated process group and cover descendants that remain in that
	 * group. Descendants that create a new session/process group are outside the
	 * owned scope. Windows can signal only the direct child.
	 */
	readonly terminationScope: AcpTerminationScope;
	request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
	notify(method: string, params?: unknown): void;
	onNotification(method: string, handler: NotificationHandler): () => void;
	onRequest(method: string, handler: RequestHandler): () => void;
	onStderr(handler: StderrHandler): () => void;
	/** Close the JSON-RPC channel cooperatively by ending stdin. Sends no signal. */
	close(): void;
	/** Observe owned process/stdio closure for a bounded interval without signalling. */
	waitForExit(timeoutMs: number): Promise<boolean>;
	/** End the channel and send one SIGTERM without waiting or escalating. */
	terminate(): void;
	/** SIGTERM, bounded grace, SIGKILL fallback, then a bounded exit observation. */
	forceTerminate(): Promise<AcpForceTerminationResult>;
}

export type AcpTerminationScope = "process-group" | "child";

export interface AcpForceTerminationResult {
	/** True only when the owned process scope and the direct child's stdio handles were observed closed. */
	exited: boolean;
	/** True when the SIGTERM grace expired and SIGKILL was sent. */
	escalated: boolean;
	/** Exact scope the implementation was able to signal. */
	scope: AcpTerminationScope;
}

export interface AcpJsonRpcPeerTransport {
	readonly closed: boolean;
	request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
	notify(method: string, params?: unknown): void;
	onNotification(method: string, handler: NotificationHandler): () => void;
	onRequest(method: string, handler: RequestHandler): () => void;
	onClose(handler: CloseHandler): () => void;
	close(): void;
}

export interface StdioTransportOptions {
	cwd?: string;
	env?: Record<string, string>;
	/** SIGTERM grace before SIGKILL. Defaults to 500ms. */
	terminationGraceMs?: number;
	/** Maximum post-SIGKILL wait for process/handle closure. Defaults to 2s. */
	terminationWaitMs?: number;
}

export interface StdioServerTransportOptions {
	input?: Readable;
	output?: Writable;
	write?: (chunk: string) => void;
	/**
	 * Where the original text of an unclassified handler failure goes. Stdout is
	 * JSON-RPC only, so the detail behind an `internal_error` frame lands on the
	 * unstructured stderr tail (CONTRACT C001 §6). Defaults to dropping it.
	 */
	diagnostics?: (line: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSuccess(value: Record<string, unknown>): value is Record<string, unknown> & AcpJsonRpcSuccess {
	return "id" in value && "result" in value;
}

function isFailure(value: Record<string, unknown>): value is Record<string, unknown> & AcpJsonRpcFailure {
	return "id" in value && isRecord(value.error);
}

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

function errorCode(value: unknown): string | undefined {
	return isRecord(value) && typeof value.code === "string" ? value.code : undefined;
}

function boundedMilliseconds(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * An omitted low-level timeout remains available for lifecycle calls whose
 * owner supplies another bound. An explicit timeout, however, must be a real
 * bound; accepting zero here previously turned valid application settings
 * into requests that could wait forever.
 */
function validateRequestTimeout(method: string, timeoutMs: number | undefined): number | undefined {
	if (timeoutMs === undefined) return undefined;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
		throw new AcpTimeoutError(`ACP request timeout must be between 1 and ${MAX_TIMER_DELAY_MS} ms: ${method}`);
	}
	return timeoutMs;
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): AcpJsonRpcFailure {
	return {
		jsonrpc: "2.0",
		id,
		error: data === undefined ? { code, message } : { code, message, data },
	};
}

/**
 * The one serialization for a request handler that threw. A thrower that knows
 * its failure raises {@link AcpRequestError} and owns the JSON-RPC code, the
 * host-authored message, and the machine-readable detail; anything else is an
 * internal error the client cannot act on beyond retrying, and its message is
 * text no part of this process authored. Bounding that text was not enough:
 * whatever threw can name an absolute path, a URL with credentials, or a token,
 * and a bounded copy of a secret is still the secret. The frame carries fixed
 * host text plus the `internal_error` code, the original goes to `diagnostics`,
 * and neither form ever carries a stack, an echoed frame, or unbounded data.
 */
function handlerErrorFrame(id: string | number, err: unknown, diagnostics?: (line: string) => void): AcpJsonRpcFailure {
	if (err instanceof AcpRequestError) {
		const message = err.detail.code === "internal_error" ? ACP_INTERNAL_ERROR_MESSAGE : acpErrorMessage(err.message);
		return jsonRpcError(id, err.rpcCode, message, acpErrorData(err.detail));
	}
	diagnostics?.(`internal error: ${acpErrorMessage(err)}`);
	return jsonRpcError(id, -32000, ACP_INTERNAL_ERROR_MESSAGE, acpErrorData({ code: "internal_error" }));
}

class StdioJsonRpcTransport implements AcpJsonRpcTransport {
	readonly child: ChildProcessWithoutNullStreams;
	readonly terminationScope: AcpTerminationScope = process.platform === "win32" ? "child" : "process-group";
	private nextId = 1;
	private buffer = "";
	private isClosed = false;
	private inputEnded = false;
	private childHandlesClosed = false;
	private forceTermination: Promise<AcpForceTerminationResult> | null = null;
	private readonly terminationGraceMs: number;
	private readonly terminationWaitMs: number;
	private readonly childClosePromise: Promise<void>;
	private resolveChildClose: (() => void) | null = null;
	private readonly pending = new Map<string | number, PendingRequest>();
	private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
	private readonly requestHandlers = new Map<string, RequestHandler>();
	private readonly stderrHandlers = new Set<StderrHandler>();

	constructor(command: string, args: string[], options: StdioTransportOptions = {}) {
		this.terminationGraceMs = boundedMilliseconds(options.terminationGraceMs, 500);
		this.terminationWaitMs = boundedMilliseconds(options.terminationWaitMs, 2_000);
		this.childClosePromise = new Promise((resolve) => {
			this.resolveChildClose = resolve;
		});
		this.child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			stdio: ["pipe", "pipe", "pipe"],
			// POSIX detached children lead a new session/process group whose id is
			// the child pid. That makes negative-pid signaling safe for this owned
			// group. Windows detached semantics do not provide an equivalent
			// killable tree, so the explicit fallback there is the direct child.
			detached: process.platform !== "win32",
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
		this.child.stderr.on("data", (chunk: string) => {
			for (const handler of this.stderrHandlers) handler(chunk);
		});
		this.child.on("error", (err) => {
			this.closeChannel(new AcpProcessError(`ACP process error: ${errorMessage(err)}`));
		});
		this.child.on("exit", (code, signal) => {
			this.isClosed = true;
			if (this.pending.size === 0) return;
			const reason = new AcpProcessError(
				`ACP process exited before replying (code=${code ?? "null"}, signal=${signal ?? "null"})`,
			);
			this.failAll(reason);
		});
		this.child.on("close", () => {
			this.childHandlesClosed = true;
			this.isClosed = true;
			this.resolveChildClose?.();
			this.resolveChildClose = null;
		});
		// Closing stdin during termination can race a peer exit. Consume the
		// resulting EPIPE instead of letting an unhandled stream error escape.
		this.child.stdin.on("error", (err) => {
			if (!this.isClosed) this.closeChannel(new AcpProcessError(`ACP stdin error: ${errorMessage(err)}`));
		});
	}

	get closed(): boolean {
		return this.isClosed || this.child.exitCode !== null || this.child.signalCode !== null;
	}

	get pid(): number | null {
		return this.child.pid ?? null;
	}

	request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
		if (this.closed) throw new AcpProcessError(`ACP process is closed; cannot request ${method}`);
		const requestTimeoutMs = validateRequestTimeout(method, timeoutMs);
		const id = this.nextId++;
		const message = { jsonrpc: "2.0" as const, id, method, params };
		const promise = new Promise<T>((resolve, reject) => {
			const pending: PendingRequest = {
				method,
				resolve: (value) => resolve(value as T),
				reject,
			};
			if (requestTimeoutMs !== undefined) {
				// The timer must hold the event loop: its firing is the only
				// thing that resolves a request the peer never answers. It is
				// cleared on response and by failAll on close.
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new AcpTimeoutError(`ACP request timed out after ${requestTimeoutMs}ms: ${method}`));
				}, requestTimeoutMs);
			}
			this.pending.set(id, pending);
		});
		this.write(message);
		return promise;
	}

	notify(method: string, params?: unknown): void {
		if (this.closed) return;
		this.write({ jsonrpc: "2.0" as const, method, params });
	}

	onNotification(method: string, handler: NotificationHandler): () => void {
		const handlers = this.notificationHandlers.get(method) ?? new Set<NotificationHandler>();
		handlers.add(handler);
		this.notificationHandlers.set(method, handlers);
		return () => {
			handlers.delete(handler);
		};
	}

	onRequest(method: string, handler: RequestHandler): () => void {
		this.requestHandlers.set(method, handler);
		return () => {
			if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
		};
	}

	onStderr(handler: StderrHandler): () => void {
		this.stderrHandlers.add(handler);
		return () => {
			this.stderrHandlers.delete(handler);
		};
	}

	close(): void {
		this.closeChannel(new AcpProcessError("ACP transport closed"));
	}

	terminate(): void {
		this.closeChannel(new AcpProcessError("ACP transport terminated"));
		this.signalOwnedScope("SIGTERM");
	}

	forceTerminate(): Promise<AcpForceTerminationResult> {
		if (this.forceTermination !== null) return this.forceTermination;
		this.forceTermination = this.runForceTermination();
		return this.forceTermination;
	}

	waitForExit(timeoutMs: number): Promise<boolean> {
		return this.waitForTermination(boundedMilliseconds(timeoutMs, 0));
	}

	private write(message: AcpJsonRpcMessage): void {
		if (this.closed || !this.child.stdin.writable || this.child.stdin.destroyed) return;
		try {
			this.child.stdin.write(`${JSON.stringify(message)}\n`);
		} catch (err) {
			this.closeChannel(new AcpProcessError(`ACP stdin write failed: ${errorMessage(err)}`));
		}
	}

	private consumeStdout(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const idx = this.buffer.indexOf("\n");
			if (idx === -1) break;
			const line = this.buffer.slice(0, idx).trimEnd();
			this.buffer = this.buffer.slice(idx + 1);
			if (line.length === 0) continue;
			this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		const trimmed = line.trimStart();
		if (!trimmed.startsWith("{")) {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (err) {
			this.failAll(new AcpProtocolError(`ACP stdout contained invalid JSON: ${errorMessage(err)}`, { line }));
			return;
		}
		if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
			return;
		}
		if (isSuccess(parsed) || isFailure(parsed)) {
			this.handleResponse(parsed);
			return;
		}
		const method = typeof parsed.method === "string" ? parsed.method : "";
		if (!method) {
			this.failAll(new AcpProtocolError("ACP request/notification missing method", parsed));
			return;
		}
		if ("id" in parsed) {
			void this.handleIncomingRequest(parsed.id as string | number, method, parsed.params);
			return;
		}
		const handlers = this.notificationHandlers.get(method);
		if (!handlers) return;
		for (const handler of handlers) handler(parsed.params);
	}

	private handleResponse(message: AcpJsonRpcSuccess | AcpJsonRpcFailure): void {
		const pending = this.pending.get(message.id ?? "");
		if (!pending) return;
		this.pending.delete(message.id ?? "");
		if (pending.timer) clearTimeout(pending.timer);
		if ("error" in message) {
			pending.reject(new AcpProtocolError(`ACP ${pending.method} failed: ${message.error.message}`, message.error));
			return;
		}
		pending.resolve(message.result);
	}

	private async handleIncomingRequest(id: string | number, method: string, params: unknown): Promise<void> {
		const handler = this.requestHandlers.get(method);
		if (!handler) {
			this.write({
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: `method not found: ${method}` },
			});
			return;
		}
		try {
			const result = await handler(params);
			this.write({ jsonrpc: "2.0", id, result });
		} catch (err) {
			this.write(handlerErrorFrame(id, err));
		}
	}

	private closeChannel(reason: unknown): void {
		if (!this.isClosed) {
			this.isClosed = true;
			this.failAll(reason);
		}
		if (this.inputEnded) return;
		this.inputEnded = true;
		try {
			this.child.stdin.end();
		} catch {
			// The peer may have closed stdin concurrently.
		}
	}

	private directChildAlive(): boolean {
		return !this.childHandlesClosed && this.child.exitCode === null && this.child.signalCode === null;
	}

	private processGroupAlive(): boolean {
		if (this.terminationScope !== "process-group") return this.directChildAlive();
		const pid = this.pid;
		if (pid === null) return this.directChildAlive();
		try {
			process.kill(-pid, 0);
			return true;
		} catch (err) {
			const code = errorCode(err);
			if (code === "ESRCH") return false;
			// EPERM means the scope exists but cannot be signalled. Unknown errors
			// are also treated as alive so force termination never reports success
			// without observing disappearance.
			return true;
		}
	}

	private terminationObserved(): boolean {
		return this.childHandlesClosed && !this.processGroupAlive();
	}

	private signalOwnedScope(signal: NodeJS.Signals): boolean {
		const pid = this.pid;
		if (this.terminationScope === "process-group" && pid !== null) {
			try {
				process.kill(-pid, signal);
				return true;
			} catch {
				// Fall through to direct-child signaling. This cannot cover the
				// group, but it is still safer than abandoning a live leader.
			}
		}
		if (!this.directChildAlive()) return false;
		try {
			return this.child.kill(signal);
		} catch {
			// The child may exit between the liveness check and signal.
			return false;
		}
	}

	private async waitForTermination(timeoutMs: number): Promise<boolean> {
		// Monotonic deadline: a backward wall-clock step used to extend this wait
		// past the bound the caller asked for.
		const deadline = performance.now() + timeoutMs;
		while (!this.terminationObserved()) {
			const remaining = deadline - performance.now();
			if (remaining <= 0) return this.terminationObserved();
			const interval = Math.min(10, remaining);
			if (this.childHandlesClosed) {
				await new Promise<void>((resolve) => setTimeout(resolve, interval));
			} else {
				await Promise.race([this.childClosePromise, new Promise<void>((resolve) => setTimeout(resolve, interval))]);
			}
		}
		return true;
	}

	private async runForceTermination(): Promise<AcpForceTerminationResult> {
		this.closeChannel(new AcpProcessError("ACP transport force-terminated"));
		if (this.terminationObserved()) {
			return { exited: true, escalated: false, scope: this.terminationScope };
		}

		this.signalOwnedScope("SIGTERM");
		if (await this.waitForExit(this.terminationGraceMs)) {
			return { exited: true, escalated: false, scope: this.terminationScope };
		}

		const escalated = this.signalOwnedScope("SIGKILL");
		const exited = await this.waitForExit(this.terminationWaitMs);
		return { exited, escalated, scope: this.terminationScope };
	}

	private failAll(reason: unknown): void {
		for (const [id, pending] of this.pending.entries()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(reason);
			this.pending.delete(id);
		}
	}
}

export function createStdioTransport(
	command: string,
	args: string[] = [],
	options: StdioTransportOptions = {},
): AcpJsonRpcTransport {
	if (command.trim().length === 0) {
		throw new AcpProcessError("ACP stdio command must not be empty");
	}
	return new StdioJsonRpcTransport(command, args, options);
}

class StreamJsonRpcPeerTransport implements AcpJsonRpcPeerTransport {
	private nextId = 1;
	private buffer = "";
	/** True while the bytes of an oversized line are being dropped up to its terminating newline. */
	private discardingLine = false;
	private isClosed = false;
	private readonly pending = new Map<string | number, PendingRequest>();
	private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
	private readonly requestHandlers = new Map<string, RequestHandler>();
	private readonly closeHandlers = new Set<CloseHandler>();
	private readonly input: Readable;
	private readonly output: Writable;
	private readonly writeOverride?: (chunk: string) => void;
	private readonly diagnostics?: (line: string) => void;

	constructor(options: StdioServerTransportOptions = {}) {
		this.input = options.input ?? process.stdin;
		this.output = options.output ?? process.stdout;
		if (options.write !== undefined) this.writeOverride = options.write;
		if (options.diagnostics !== undefined) this.diagnostics = options.diagnostics;
		this.input.setEncoding("utf8");
		this.input.on("data", (chunk: string) => this.consume(chunk));
		// EOF with a nonblank partial frame drops that frame silently. A partial
		// frame has no id, so there is no request to answer, and the channel it
		// would be answered on is the one that just ended.
		this.input.on("end", () => this.markClosed(new AcpProcessError("ACP input closed")));
		this.input.on("error", (err) => this.markClosed(new AcpProcessError(`ACP input error: ${errorMessage(err)}`)));
		this.output.on?.("error", (err) => this.markClosed(new AcpProcessError(`ACP output error: ${errorMessage(err)}`)));
	}

	get closed(): boolean {
		return this.isClosed;
	}

	request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
		if (this.closed) throw new AcpProcessError(`ACP transport is closed; cannot request ${method}`);
		const requestTimeoutMs = validateRequestTimeout(method, timeoutMs);
		const id = this.nextId++;
		const message = { jsonrpc: "2.0" as const, id, method, params };
		const promise = new Promise<T>((resolve, reject) => {
			const pending: PendingRequest = {
				method,
				resolve: (value) => resolve(value as T),
				reject,
			};
			if (requestTimeoutMs !== undefined) {
				// The timer must hold the event loop: its firing is the only
				// thing that resolves a request the peer never answers. It is
				// cleared on response and by failAll on close.
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new AcpTimeoutError(`ACP request timed out after ${requestTimeoutMs}ms: ${method}`));
				}, requestTimeoutMs);
			}
			this.pending.set(id, pending);
		});
		this.write(message);
		return promise;
	}

	notify(method: string, params?: unknown): void {
		if (this.closed) return;
		this.write({ jsonrpc: "2.0", method, params });
	}

	onNotification(method: string, handler: NotificationHandler): () => void {
		const handlers = this.notificationHandlers.get(method) ?? new Set<NotificationHandler>();
		handlers.add(handler);
		this.notificationHandlers.set(method, handlers);
		return () => {
			handlers.delete(handler);
		};
	}

	onRequest(method: string, handler: RequestHandler): () => void {
		this.requestHandlers.set(method, handler);
		return () => {
			if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
		};
	}

	onClose(handler: CloseHandler): () => void {
		this.closeHandlers.add(handler);
		return () => {
			this.closeHandlers.delete(handler);
		};
	}

	close(): void {
		this.markClosed(new AcpProcessError("ACP transport closed"));
	}

	private write(message: AcpJsonRpcMessage): void {
		const line = `${JSON.stringify(message)}\n`;
		if (this.writeOverride) {
			this.writeOverride(line);
			return;
		}
		// A `false` return means the stream buffered rather than flushed. Honoring
		// it means pausing frame production, which changes turn timing, so the
		// decision to keep writing is deferred rather than forgotten (CONTRACT
		// C001 §6 leaves stdout backpressure out of this profile).
		this.output.write(line);
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const idx = this.buffer.indexOf("\n");
			if (idx === -1) break;
			const line = this.buffer.slice(0, idx).trimEnd();
			this.buffer = this.buffer.slice(idx + 1);
			// The tail of a line already reported as oversized. Its newline ends the
			// discard; the bytes before it are dropped without a second report.
			if (this.discardingLine) {
				this.discardingLine = false;
				continue;
			}
			if (line.length === 0) continue;
			// A complete but oversized line, which arrives when the whole line and
			// its newline land in one chunk and the pending-buffer check below never
			// saw it.
			if (exceedsInputLineBytes(line)) {
				this.reportOversizedLine();
				continue;
			}
			this.handleLine(line);
		}
		if (this.discardingLine) {
			this.buffer = "";
			return;
		}
		// No newline yet: bound what is held for a line still being received.
		if (exceedsInputLineBytes(this.buffer)) {
			this.buffer = "";
			this.discardingLine = true;
			this.reportOversizedLine();
		}
	}

	/** One error frame per oversized line. The transport stays open and parseable. */
	private reportOversizedLine(): void {
		this.write(
			jsonRpcError(null, -32600, "input line exceeds the maximum size", acpErrorData({ code: "input_line_too_large" })),
		);
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// The parser's own message quotes the input it choked on, so the frame
			// says only that parsing failed. The client already has the line.
			this.write(jsonRpcError(null, -32700, "parse error", acpErrorData({ code: "parse_error" })));
			return;
		}
		if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
			this.write(jsonRpcError(null, -32600, "invalid JSON-RPC message", acpErrorData({ code: "invalid_request" })));
			return;
		}
		if (isSuccess(parsed) || isFailure(parsed)) {
			this.handleResponse(parsed);
			return;
		}
		const method = typeof parsed.method === "string" ? parsed.method : "";
		const id = "id" in parsed ? (parsed.id as string | number | null) : undefined;
		if (!method) {
			if (id !== undefined) {
				this.write(
					jsonRpcError(id, -32600, "request/notification missing method", acpErrorData({ code: "invalid_request" })),
				);
			}
			return;
		}
		if (id !== undefined) {
			void this.handleRequest(id, method, parsed.params);
			return;
		}
		const handlers = this.notificationHandlers.get(method);
		if (!handlers) return;
		for (const handler of handlers) handler(parsed.params);
	}

	private handleResponse(message: AcpJsonRpcSuccess | AcpJsonRpcFailure): void {
		const pending = this.pending.get(message.id ?? "");
		if (!pending) return;
		this.pending.delete(message.id ?? "");
		if (pending.timer) clearTimeout(pending.timer);
		if ("error" in message) {
			pending.reject(new AcpProtocolError(`ACP ${pending.method} failed: ${message.error.message}`, message.error));
			return;
		}
		pending.resolve(message.result);
	}

	private async handleRequest(id: string | number | null, method: string, params: unknown): Promise<void> {
		// A null id is a request nothing can answer, since a response correlates by
		// id. Saying so beats the silent drop that left the caller waiting out its
		// own timeout with no evidence of what happened.
		if (id === null) {
			this.write(jsonRpcError(null, -32600, "request id must not be null", acpErrorData({ code: "invalid_request_id" })));
			return;
		}
		const handler = this.requestHandlers.get(method);
		if (!handler) {
			// The method name never goes back out. Bounding it was not enough: it is
			// peer-controlled text on a channel where every message is authored by this
			// process, and the client already knows which method it called. The frame
			// carries fixed host text plus the `method_not_found` code.
			this.write(jsonRpcError(id, -32601, ACP_METHOD_NOT_FOUND_MESSAGE, acpErrorData({ code: "method_not_found" })));
			return;
		}
		try {
			const result = await handler(params);
			this.write({ jsonrpc: "2.0", id, result });
		} catch (err) {
			this.write(handlerErrorFrame(id, err, this.diagnostics));
		}
	}

	private markClosed(reason: unknown): void {
		if (this.isClosed) return;
		this.isClosed = true;
		this.failAll(reason);
		for (const handler of this.closeHandlers) handler();
	}

	private failAll(reason: unknown): void {
		for (const [id, pending] of this.pending.entries()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(reason);
			this.pending.delete(id);
		}
	}
}

export function createStdioServerTransport(options: StdioServerTransportOptions = {}): AcpJsonRpcPeerTransport {
	return new StreamJsonRpcPeerTransport(options);
}
