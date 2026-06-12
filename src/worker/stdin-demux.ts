import { parseWorkerSpec, type WorkerSpec } from "./spec-contract.js";

export interface WorkerStdinDemux {
	feed(chunk: string): void;
	eof(): void;
	readSpec(): Promise<WorkerSpec>;
	/**
	 * Register the handler for post-spec steer lines
	 * (`{"type":"steer","text":"..."}`). Steers that arrive before
	 * registration are buffered in order and flushed to the handler.
	 * Single handler; a second registration replaces the first.
	 */
	onSteer(handler: (text: string) => void): void;
	/** Post-spec lines that were not valid steer messages. */
	droppedLineCount(): number;
}

export function createWorkerStdinDemux(): WorkerStdinDemux {
	let buffer = "";
	let specResolve: ((spec: WorkerSpec) => void) | null = null;
	let specReject: ((err: Error) => void) | null = null;
	let specValue: WorkerSpec | null = null;
	let specError: Error | null = null;
	let specReceived = false;
	let closed = false;
	let steerHandler: ((text: string) => void) | null = null;
	const pendingSteers: string[] = [];
	let droppedLines = 0;

	function resolveSpec(spec: WorkerSpec): void {
		specValue = spec;
		specResolve?.(spec);
	}

	function rejectSpec(err: Error): void {
		specError = err;
		specReject?.(err);
	}

	function deliverSteer(text: string): void {
		if (steerHandler) {
			steerHandler(text);
			return;
		}
		pendingSteers.push(text);
	}

	function processPostSpecLine(line: string): void {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			droppedLines += 1;
			return;
		}
		if (
			typeof value === "object" &&
			value !== null &&
			(value as { type?: unknown }).type === "steer" &&
			typeof (value as { text?: unknown }).text === "string" &&
			(value as { text: string }).text.trim().length > 0
		) {
			deliverSteer((value as { text: string }).text);
			return;
		}
		droppedLines += 1;
	}

	function processLine(line: string): void {
		if (line.length === 0) return;
		if (!specReceived) {
			specReceived = true;
			try {
				resolveSpec(parseWorkerSpec(JSON.parse(line)));
			} catch (err) {
				rejectSpec(err instanceof Error ? err : new Error(String(err)));
			}
			return;
		}
		processPostSpecLine(line);
	}

	return {
		feed(chunk: string): void {
			if (closed) return;
			buffer += chunk;
			let idx = buffer.indexOf("\n");
			while (idx >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				processLine(line);
				idx = buffer.indexOf("\n");
			}
		},
		eof(): void {
			if (closed) return;
			closed = true;
			if (buffer.length > 0) {
				processLine(buffer);
				buffer = "";
			}
			if (!specReceived) rejectSpec(new Error("worker stdin closed before spec received"));
		},
		readSpec(): Promise<WorkerSpec> {
			if (specValue) return Promise.resolve(specValue);
			if (specError) return Promise.reject(specError);
			if (closed && !specReceived) return Promise.reject(new Error("worker stdin closed before spec received"));
			return new Promise((resolve, reject) => {
				specResolve = resolve;
				specReject = reject;
			});
		},
		onSteer(handler: (text: string) => void): void {
			steerHandler = handler;
			while (pendingSteers.length > 0) {
				const text = pendingSteers.shift();
				if (text !== undefined) handler(text);
			}
		},
		droppedLineCount(): number {
			return droppedLines;
		},
	};
}
