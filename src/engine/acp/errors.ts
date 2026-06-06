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
