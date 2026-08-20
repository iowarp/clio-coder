export class AcpError extends Error {
	readonly code: string;
	readonly data?: unknown;

	constructor(code: string, message: string, data?: unknown) {
		super(message);
		this.name = "AcpError";
		this.code = code;
		this.data = data;
	}
}

export class AcpProtocolError extends AcpError {
	constructor(message: string, data?: unknown) {
		super("acp_protocol_error", message, data);
		this.name = "AcpProtocolError";
	}
}

export class AcpTimeoutError extends AcpError {
	constructor(message: string, data?: unknown) {
		super("acp_timeout", message, data);
		this.name = "AcpTimeoutError";
	}
}

export class AcpProcessError extends AcpError {
	constructor(message: string, data?: unknown) {
		super("acp_process_error", message, data);
		this.name = "AcpProcessError";
	}
}

/**
 * Upper bound on any `error.message` this process puts on the wire. A JSON-RPC
 * message is operator-facing prose, not a payload: an unbounded one lets a
 * provider response, a file body, or a stack walk cross the protocol boundary.
 */
export const ACP_MAX_ERROR_MESSAGE_CHARS = 256;

/**
 * The `error.message` a failed prompt turn always carries. A provider or engine
 * failure body is text this process never authored: it can name an absolute
 * path, a URL with credentials, or a token, and stdout is the one channel the
 * client parses. The client branches on `data._meta`'s `turn_failed` code; the
 * original prose goes to the diagnostics sink (stderr) instead.
 */
export const ACP_TURN_FAILED_MESSAGE = "the prompt turn failed";

/**
 * The `error.message` an unclassified handler failure always carries, for the
 * same reason as {@link ACP_TURN_FAILED_MESSAGE}: the thrower did not choose
 * this text, so nothing bounds what it might disclose.
 */
export const ACP_INTERNAL_ERROR_MESSAGE = "internal error";

/**
 * The `error.message` an unregistered method always carries. The method name is
 * peer-controlled text, and a bounded copy of peer text is still peer text on a
 * channel where every message is authored by this process. The client already
 * knows which method it called, so echoing it back buys nothing and the frame
 * says only that the method is not served; `data._meta` carries
 * `method_not_found`.
 */
export const ACP_METHOD_NOT_FOUND_MESSAGE = "method not found";

/** `_meta` key carrying Clio's machine-readable error detail (CONTRACT C001 §0). */
export const ACP_ERROR_META_KEY = "clio-coder/error";

/** Version of the `clio-coder/error` payload shape. */
export const ACP_ERROR_META_VERSION = 1;

/**
 * Machine-readable failure detail. `code` is a closed-set string the client
 * branches on; `reason` and `supported` are the two optional refinements the
 * profile defines (admission reason, supported protocol versions).
 */
export interface AcpErrorDetail {
	code: string;
	reason?: string;
	supported?: number[];
}

/**
 * A failure whose JSON-RPC code and machine-readable detail the thrower chooses.
 * The transport serializes it verbatim; anything else it catches becomes an
 * `internal_error` with a bounded message and no stack.
 */
export class AcpRequestError extends Error {
	constructor(
		readonly rpcCode: number,
		message: string,
		readonly detail: AcpErrorDetail,
	) {
		super(message);
		this.name = "AcpRequestError";
	}
}

/**
 * The only thing that ever travels in a JSON-RPC `error.data` from this server:
 * one namespaced, versioned object. A strict ACP client that ignores `_meta`
 * still sees a conformant error, and nothing else can ride along.
 */
export function acpErrorData(detail: AcpErrorDetail): { _meta: Record<string, unknown> } {
	return {
		_meta: {
			[ACP_ERROR_META_KEY]: {
				version: ACP_ERROR_META_VERSION,
				code: detail.code,
				...(detail.reason !== undefined ? { reason: detail.reason } : {}),
				...(detail.supported !== undefined ? { supported: [...detail.supported] } : {}),
			},
		},
	};
}

/**
 * One bounded single-line message from any thrown value. Newlines are what turn
 * a message into a stack dump, so every run of whitespace collapses to one
 * space before the length bound applies.
 */
export function acpErrorMessage(value: unknown): string {
	const raw = value instanceof Error ? value.message : String(value);
	const collapsed = raw.replace(/\s+/g, " ").trim();
	if (collapsed.length <= ACP_MAX_ERROR_MESSAGE_CHARS) return collapsed;
	return `${collapsed.slice(0, ACP_MAX_ERROR_MESSAGE_CHARS - 1)}…`;
}
