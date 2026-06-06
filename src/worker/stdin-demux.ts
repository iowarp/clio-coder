import { parseWorkerSpec, type WorkerSpec } from "./spec-contract.js";

export interface WorkerStdinDemux {
	feed(chunk: string): void;
	eof(): void;
	readSpec(): Promise<WorkerSpec>;
}

export function createWorkerStdinDemux(): WorkerStdinDemux {
	let buffer = "";
	let specResolve: ((spec: WorkerSpec) => void) | null = null;
	let specReject: ((err: Error) => void) | null = null;
	let specValue: WorkerSpec | null = null;
	let specError: Error | null = null;
	let specReceived = false;
	let closed = false;

	function resolveSpec(spec: WorkerSpec): void {
		specValue = spec;
		specResolve?.(spec);
	}

	function rejectSpec(err: Error): void {
		specError = err;
		specReject?.(err);
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
	};
}
