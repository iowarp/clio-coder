/**
 * Worker subprocess entry point.
 *
 * Reads a WorkerSpec JSON document from stdin, re-hydrates the runtime
 * descriptor from the runtime registry (EndpointDescriptor is pure data;
 * RuntimeDescriptor carries functions and cannot cross the stdin boundary),
 * builds a WorkerRunInput, and dispatches to `startWorkerRun` from the engine
 * boundary. Emits NDJSON events on stdout.
 */

import type { ToolName } from "../core/tool-names.js";
import type { MiddlewareSnapshot } from "../domains/middleware/index.js";
import type { CapabilityFlags, EndpointDescriptor } from "../domains/providers/index.js";
import { startWorkerRun, type WorkerRunInput } from "../engine/worker-runtime.js";
import type { SelfDevMode } from "../selfdev/mode.js";
import { startWorkerHeartbeat } from "./heartbeat.js";
import { emitEvent } from "./ndjson.js";
import { resolveWorkerRuntime } from "./runtime-registry.js";

type WorkerMode = NonNullable<WorkerRunInput["mode"]>;

interface WorkerSpec {
	systemPrompt: string;
	task: string;
	endpoint: EndpointDescriptor;
	runtimeId: string;
	wireModelId: string;
	modelCapabilities?: Partial<CapabilityFlags>;
	sessionId?: string;
	apiKey?: string;
	thinkingLevel?: WorkerRunInput["thinkingLevel"];
	allowedTools?: ReadonlyArray<string>;
	mode?: string;
	middlewareSnapshot?: MiddlewareSnapshot;
	selfDev?: SelfDevMode;
}

async function main(): Promise<number> {
	const spec = await readSpecFromStdin();
	const stopHeartbeat = startWorkerHeartbeat();
	const mode = (spec.mode ?? "default") as WorkerMode;

	const runtime = await resolveWorkerRuntime(spec.runtimeId);
	if (!runtime) {
		process.stderr.write(`[worker] runtime '${spec.runtimeId}' not registered\n`);
		stopHeartbeat();
		return 2;
	}

	const input: WorkerRunInput = {
		systemPrompt: spec.systemPrompt,
		task: spec.task,
		endpoint: spec.endpoint,
		runtime,
		wireModelId: spec.wireModelId,
		mode,
	};
	if (spec.modelCapabilities) input.modelCapabilities = spec.modelCapabilities;
	if (spec.sessionId) input.sessionId = spec.sessionId;
	if (spec.apiKey) input.apiKey = spec.apiKey;
	if (spec.thinkingLevel) input.thinkingLevel = spec.thinkingLevel;
	if (spec.middlewareSnapshot) input.middlewareSnapshot = spec.middlewareSnapshot;
	if (spec.selfDev) input.selfDev = spec.selfDev;
	if (spec.allowedTools !== undefined) {
		input.allowedTools = spec.allowedTools as ReadonlyArray<ToolName>;
	} else {
		process.stderr.write("[worker] warning: spec missing allowedTools; falling back to mode matrix\n");
	}

	const handle = startWorkerRun(input, emitEvent);
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
		process.stdin.resume();
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
