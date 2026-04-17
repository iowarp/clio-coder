/**
 * Worker subprocess entry point.
 *
 * Reads a WorkerSpec JSON document from stdin, dispatches to
 * `startWorkerRun` from the engine boundary, emits NDJSON events to stdout,
 * and exits with the run's exit code. This file imports ONLY from
 * src/engine/** (the pi-mono boundary) and src/worker/** (sibling helpers);
 * it must never import pi-mono or any domain directly.
 */

import { startWorkerRun } from "../engine/worker-runtime.js";
import { startWorkerHeartbeat } from "./heartbeat.js";
import { emitEvent } from "./ndjson.js";

interface WorkerSpec {
	systemPrompt: string;
	task: string;
	providerId: string;
	modelId: string;
	sessionId?: string;
	apiKey?: string;
}

async function main(): Promise<number> {
	const spec = await readSpecFromStdin();
	const stopHeartbeat = startWorkerHeartbeat();
	const handle = startWorkerRun(spec, emitEvent);
	const onSignal = () => handle.abort();
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		const result = await handle.promise;
		return result.exitCode;
	} finally {
		stopHeartbeat();
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

async function readSpecFromStdin(): Promise<WorkerSpec> {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			try {
				resolve(JSON.parse(data) as WorkerSpec);
			} catch (err) {
				reject(err);
			}
		});
		process.stdin.on("error", reject);
	});
}

main().then(
	(code) => process.exit(code),
	(err) => {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[worker] fatal: ${msg}\n`);
		process.exit(2);
	},
);
