import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { AcpProcessError, AcpProtocolError, AcpTimeoutError } from "./errors.js";
import type { AcpJsonRpcFailure, AcpJsonRpcMessage, AcpJsonRpcSuccess } from "./types.js";

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
	request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
	notify(method: string, params?: unknown): void;
	onNotification(method: string, handler: NotificationHandler): () => void;
	onRequest(method: string, handler: RequestHandler): () => void;
	onStderr(handler: StderrHandler): () => void;
	close(): void;
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
}

export interface StdioServerTransportOptions {
	input?: Readable;
	output?: Writable;
	write?: (chunk: string) => void;
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

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): AcpJsonRpcFailure {
	return {
		jsonrpc: "2.0",
		id,
		error: data === undefined ? { code, message } : { code, message, data },
	};
}

class StdioJsonRpcTransport implements AcpJsonRpcTransport {
	readonly child: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private buffer = "";
	private isClosed = false;
	private readonly pending = new Map<string | number, PendingRequest>();
	private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
	private readonly requestHandlers = new Map<string, RequestHandler>();
	private readonly stderrHandlers = new Set<StderrHandler>();

	constructor(command: string, args: string[], options: StdioTransportOptions = {}) {
		this.child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
		this.child.stderr.on("data", (chunk: string) => {
			for (const handler of this.stderrHandlers) handler(chunk);
		});
		this.child.on("error", (err) => {
			this.failAll(new AcpProcessError(`ACP process error: ${errorMessage(err)}`));
		});
		this.child.on("exit", (code, signal) => {
			this.isClosed = true;
			if (this.pending.size === 0) return;
			const reason = new AcpProcessError(
				`ACP process exited before replying (code=${code ?? "null"}, signal=${signal ?? "null"})`,
			);
			this.failAll(reason);
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
		const id = this.nextId++;
		const message = { jsonrpc: "2.0" as const, id, method, params };
		const promise = new Promise<T>((resolve, reject) => {
			const pending: PendingRequest = {
				method,
				resolve: (value) => resolve(value as T),
				reject,
			};
			if (timeoutMs !== undefined && timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new AcpTimeoutError(`ACP request timed out after ${timeoutMs}ms: ${method}`));
				}, timeoutMs);
				pending.timer.unref?.();
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
		if (this.isClosed) return;
		this.isClosed = true;
		this.failAll(new AcpProcessError("ACP transport closed"));
		try {
			this.child.stdin.end();
		} catch {
			// ignore
		}
		if (this.child.exitCode === null && this.child.signalCode === null) {
			this.child.kill("SIGTERM");
		}
	}

	private write(message: AcpJsonRpcMessage): void {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
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
			this.write({
				jsonrpc: "2.0",
				id,
				error: { code: -32000, message: errorMessage(err), data: err instanceof Error ? err.stack : undefined },
			});
		}
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
	private isClosed = false;
	private readonly pending = new Map<string | number, PendingRequest>();
	private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
	private readonly requestHandlers = new Map<string, RequestHandler>();
	private readonly closeHandlers = new Set<CloseHandler>();
	private readonly input: Readable;
	private readonly output: Writable;
	private readonly writeOverride?: (chunk: string) => void;

	constructor(options: StdioServerTransportOptions = {}) {
		this.input = options.input ?? process.stdin;
		this.output = options.output ?? process.stdout;
		if (options.write !== undefined) this.writeOverride = options.write;
		this.input.setEncoding("utf8");
		this.input.on("data", (chunk: string) => this.consume(chunk));
		this.input.on("end", () => this.markClosed(new AcpProcessError("ACP input closed")));
		this.input.on("error", (err) => this.markClosed(new AcpProcessError(`ACP input error: ${errorMessage(err)}`)));
		this.output.on?.("error", (err) => this.markClosed(new AcpProcessError(`ACP output error: ${errorMessage(err)}`)));
	}

	get closed(): boolean {
		return this.isClosed;
	}

	request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
		if (this.closed) throw new AcpProcessError(`ACP transport is closed; cannot request ${method}`);
		const id = this.nextId++;
		const message = { jsonrpc: "2.0" as const, id, method, params };
		const promise = new Promise<T>((resolve, reject) => {
			const pending: PendingRequest = {
				method,
				resolve: (value) => resolve(value as T),
				reject,
			};
			if (timeoutMs !== undefined && timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new AcpTimeoutError(`ACP request timed out after ${timeoutMs}ms: ${method}`));
				}, timeoutMs);
				pending.timer.unref?.();
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
		this.output.write(line);
	}

	private consume(chunk: string): void {
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
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			this.write(jsonRpcError(null, -32700, `parse error: ${errorMessage(err)}`));
			return;
		}
		if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
			this.write(jsonRpcError(null, -32600, "invalid JSON-RPC message", parsed));
			return;
		}
		if (isSuccess(parsed) || isFailure(parsed)) {
			this.handleResponse(parsed);
			return;
		}
		const method = typeof parsed.method === "string" ? parsed.method : "";
		const id = "id" in parsed ? (parsed.id as string | number | null) : undefined;
		if (!method) {
			if (id !== undefined) this.write(jsonRpcError(id, -32600, "request/notification missing method", parsed));
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
		if (id === null) return;
		const handler = this.requestHandlers.get(method);
		if (!handler) {
			this.write(jsonRpcError(id, -32601, `method not found: ${method}`));
			return;
		}
		try {
			const result = await handler(params);
			this.write({ jsonrpc: "2.0", id, result });
		} catch (err) {
			this.write(jsonRpcError(id, -32000, errorMessage(err), err instanceof Error ? err.stack : undefined));
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
