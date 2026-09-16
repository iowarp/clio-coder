/**
 * JSON-RPC 2.0 framing for the MCP stdio transport.
 *
 * The transport carries one JSON message per line: UTF-8 text, newline
 * terminated, with no embedded newline. Everything here is pure: the framer
 * accepts byte chunks and yields typed messages or one typed protocol error,
 * and the client decides what to do with either. Invalid UTF-8 is a protocol
 * error rather than a U+FFFD substitution, because a tool result that reached
 * the model with silently replaced bytes would misreport what the server said.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;

export type McpErrorCode = "timeout" | "closed" | "protocol" | "server" | "spawn" | "aborted" | "overload";

/**
 * Every failure the client reports carries one of the codes above. `overload`
 * names an outbound line the client refused to queue: on its own because it
 * exceeds the cap, or fatally because the server stopped reading its stdin.
 */
export class McpError extends Error {
	override readonly name = "McpError";
	readonly code: McpErrorCode;
	readonly data: unknown;

	constructor(code: McpErrorCode, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	result?: unknown;
	error?: JsonRpcErrorObject;
}

export type JsonRpcMessage =
	| { kind: "request"; message: JsonRpcRequest }
	| { kind: "notification"; message: JsonRpcNotification }
	| { kind: "response"; message: JsonRpcResponse };

export type ProtocolFrame = { kind: "message"; message: JsonRpcMessage } | { kind: "error"; error: McpError };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** Classify one decoded JSON value as a request, notification, or response, or name why it is none of them. */
export function classifyJsonRpcMessage(value: unknown): JsonRpcMessage | McpError {
	if (!isRecord(value)) return new McpError("protocol", "message is not a JSON object");
	if (value.jsonrpc !== "2.0") return new McpError("protocol", 'message lacks jsonrpc: "2.0"');
	if (typeof value.method === "string") {
		if (value.id === undefined || value.id === null) {
			const notification: JsonRpcNotification = { jsonrpc: "2.0", method: value.method };
			if (value.params !== undefined) notification.params = value.params;
			return { kind: "notification", message: notification };
		}
		if (!isJsonRpcId(value.id)) return new McpError("protocol", "request id must be a string or a finite number");
		const request: JsonRpcRequest = { jsonrpc: "2.0", id: value.id, method: value.method };
		if (value.params !== undefined) request.params = value.params;
		return { kind: "request", message: request };
	}
	const hasResult = Object.hasOwn(value, "result");
	const hasError = Object.hasOwn(value, "error");
	if (!hasResult && !hasError) return new McpError("protocol", "message has neither method, result, nor error");
	if (hasResult && hasError) return new McpError("protocol", "response carries both result and error");
	if (value.id !== null && !isJsonRpcId(value.id)) {
		return new McpError("protocol", "response id must be a string, a finite number, or null");
	}
	const response: JsonRpcResponse = {
		jsonrpc: "2.0",
		id: value.id === undefined ? null : (value.id as JsonRpcId | null),
	};
	if (hasResult) response.result = value.result;
	if (hasError) {
		const error = value.error;
		if (!isRecord(error) || typeof error.code !== "number" || typeof error.message !== "string") {
			return new McpError("protocol", "response error must carry a numeric code and a message");
		}
		const errorObject: JsonRpcErrorObject = { code: error.code, message: error.message };
		if (error.data !== undefined) errorObject.data = error.data;
		response.error = errorObject;
	}
	return { kind: "response", message: response };
}

/** Decode one complete line (without its terminator) into a message or a protocol error. */
export function parseJsonRpcLine(line: Buffer): JsonRpcMessage | McpError {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(line);
	} catch {
		return new McpError("protocol", "message line is not valid UTF-8");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		return new McpError(
			"protocol",
			`message line is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return classifyJsonRpcMessage(parsed);
}

/** Serialize one outbound message as a newline-terminated line. JSON.stringify escapes every newline inside strings. */
export function encodeJsonRpcMessage(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): Buffer {
	return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

export interface LineFramer {
	/** Accept one chunk and return every frame it completed. After an error frame the framer yields nothing more. */
	push(chunk: Buffer): ProtocolFrame[];
	/** Flush a final unterminated line at end of stream. */
	flush(): ProtocolFrame[];
	/** Bytes held for the line still being assembled. */
	readonly pendingBytes: number;
	/** True once an error frame has been produced. */
	readonly failed: boolean;
}

/**
 * Split a byte stream into newline-delimited messages. A line longer than the
 * cap is refused as soon as its bytes exceed it, before any newline arrives,
 * so an unterminated flood cannot grow the buffer without bound. Blank lines
 * are skipped; a trailing carriage return is tolerated.
 */
export function createLineFramer(maxLineBytes: number = DEFAULT_MAX_LINE_BYTES): LineFramer {
	const pending: Buffer[] = [];
	let pendingBytes = 0;
	let failed = false;

	const fail = (message: string): ProtocolFrame[] => {
		failed = true;
		pending.length = 0;
		pendingBytes = 0;
		return [{ kind: "error", error: new McpError("protocol", message) }];
	};

	const frameLine = (line: Buffer): ProtocolFrame | null => {
		const trimmed = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line;
		if (trimmed.length === 0) return null;
		const decoded = parseJsonRpcLine(trimmed);
		if (decoded instanceof McpError) return { kind: "error", error: decoded };
		return { kind: "message", message: decoded };
	};

	return {
		get pendingBytes() {
			return pendingBytes;
		},
		get failed() {
			return failed;
		},
		push(chunk) {
			if (failed) return [];
			const frames: ProtocolFrame[] = [];
			let start = 0;
			for (;;) {
				const newline = chunk.indexOf(0x0a, start);
				if (newline === -1) break;
				const tail = chunk.subarray(start, newline);
				const lineBytes = pendingBytes + tail.length;
				if (lineBytes > maxLineBytes) return fail(`message line exceeds ${maxLineBytes} bytes`);
				const line = pending.length === 0 ? tail : Buffer.concat([...pending, tail], lineBytes);
				pending.length = 0;
				pendingBytes = 0;
				const frame = frameLine(line);
				if (frame !== null) {
					frames.push(frame);
					if (frame.kind === "error") {
						failed = true;
						return frames;
					}
				}
				start = newline + 1;
			}
			if (start < chunk.length) {
				const rest = chunk.subarray(start);
				if (pendingBytes + rest.length > maxLineBytes) {
					frames.push(...fail(`message line exceeds ${maxLineBytes} bytes`));
					return frames;
				}
				pending.push(Buffer.from(rest));
				pendingBytes += rest.length;
			}
			return frames;
		},
		flush() {
			if (failed || pendingBytes === 0) return [];
			const line = Buffer.concat(pending, pendingBytes);
			pending.length = 0;
			pendingBytes = 0;
			const frame = frameLine(line);
			if (frame === null) return [];
			if (frame.kind === "error") failed = true;
			return [frame];
		},
	};
}
