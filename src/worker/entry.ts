#!/usr/bin/env node
/**
 * Worker subprocess entry point.
 *
 * Reads a WorkerSpec JSON document from stdin, re-hydrates the runtime
 * descriptor from the runtime registry (TargetDescriptor is pure data;
 * RuntimeDescriptor carries functions and cannot cross the stdin boundary),
 * builds a WorkerRunInput, and dispatches to `startWorkerRun` from the engine
 * boundary. Emits NDJSON events on stdout.
 */

import { disposeLmStudioClients } from "../engine/apis/lmstudio-native.js";
import { setResidencyNoticeSink } from "../engine/apis/residency.js";
import { startWorkerRun, type WorkerRunInput } from "../engine/worker-runtime.js";
import { projectWorkerEventForStdout } from "./event-projection.js";
import { startWorkerHeartbeat } from "./heartbeat.js";
import { drainStdout, emitEvent } from "./ndjson.js";
import { resolveWorkerRuntime } from "./runtime-registry.js";
import { validateRehydratedWorkerRuntime } from "./spec-contract.js";
import { createWorkerStdinDemux } from "./stdin-demux.js";

async function main(): Promise<number> {
	// A worker has no TUI, so residency notices go to stderr (the parent
	// captures it for diagnostics) instead of the shared bus, keeping headless
	// reconciliation parity with the interactive path.
	setResidencyNoticeSink((notice) => {
		process.stderr.write(`[worker] residency ${notice.kind}: ${notice.message}\n`);
	});
	const demux = createWorkerStdinDemux();
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => demux.feed(chunk));
	process.stdin.on("end", () => demux.eof());
	process.stdin.on("error", () => demux.eof());
	process.stdin.resume();

	const spec = await demux.readSpec();
	const stopHeartbeat = startWorkerHeartbeat();

	const runtime = await resolveWorkerRuntime(spec.runtimeId);
	if (!runtime) {
		process.stderr.write(`[worker] runtime '${spec.runtimeId}' not registered\n`);
		stopHeartbeat();
		return 2;
	}
	try {
		validateRehydratedWorkerRuntime(spec, runtime);
	} catch (err) {
		process.stderr.write(`[worker] ${err instanceof Error ? err.message : String(err)}\n`);
		stopHeartbeat();
		return 2;
	}

	const input: WorkerRunInput = {
		systemPrompt: spec.systemPrompt,
		dynamicPromptMessages: spec.dynamicPromptMessages ?? [],
		agentId: spec.agentId,
		task: spec.task,
		target: spec.target,
		runtime,
		wireModelId: spec.wireModelId,
		allowedTools: spec.allowedTools,
		...(spec.noSkills !== undefined ? { noSkills: spec.noSkills } : {}),
		...(spec.skillPaths !== undefined ? { skillPaths: [...spec.skillPaths] } : {}),
		...(spec.agentSkills !== undefined ? { agentSkills: [...spec.agentSkills] } : {}),
		...(spec.trustProjectCompatRoots !== undefined ? { trustProjectCompatRoots: spec.trustProjectCompatRoots } : {}),
		...(spec.onPermission !== undefined ? { onPermission: spec.onPermission } : {}),
		...(spec.escalation !== undefined ? { escalation: spec.escalation } : {}),
		...(spec.toolProfile !== undefined ? { toolProfile: spec.toolProfile } : {}),
		...(spec.autonomy !== undefined ? { autonomy: spec.autonomy } : {}),
		...(spec.writeRoots !== undefined ? { writeRoots: [...spec.writeRoots] } : {}),
	};
	if (spec.modelCapabilities) input.modelCapabilities = spec.modelCapabilities;
	if (spec.sessionId) input.sessionId = spec.sessionId;
	if (spec.apiKey) input.apiKey = spec.apiKey;
	if (spec.thinkingLevel) input.thinkingLevel = spec.thinkingLevel;
	if (spec.runtimeResolution) input.runtimeResolution = spec.runtimeResolution;
	if (spec.middlewareSnapshot) input.middlewareSnapshot = spec.middlewareSnapshot;
	// Slim streaming events before NDJSON serialization: pi's message_update
	// carries the full cumulative message twice (top-level + assistantMessageEvent
	// .partial), which reserializes quadratically on stdout. No worker-stdout
	// consumer reads those cumulative snapshots (see event-projection.ts).
	const handle = startWorkerRun(input, (event) => emitEvent(projectWorkerEventForStdout(event)));
	// Steer lines arriving on stdin after the spec queue onto the agent's
	// steering queue; the demux buffers any that landed before this point.
	demux.onSteer((text) => handle.steer(text));
	// Permission-decision lines resolve a parked escalation. Unknown or
	// duplicate requestIds return false and are dropped without crashing the
	// worker; runtimes without an escalation loop simply have no handler.
	demux.onPermissionDecision(({ requestId, decision }) => {
		const resolved = handle.resolvePermission?.(requestId, decision) ?? false;
		if (!resolved) {
			process.stderr.write(`[worker] dropped permission_decision for unknown request '${requestId}'\n`);
		}
	});
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
		const dropped = demux.droppedLineCount();
		if (dropped > 0) {
			process.stderr.write(`[worker] dropped ${dropped} unrecognized stdin line(s) after the spec\n`);
		}
		// Best-effort dispose of any LMStudioClient instances cached by the
		// engine so we close their WebSocket sessions cleanly before the worker
		// process exits.
		await disposeLmStudioClients();
	}
}

main().then(
	async (code) => {
		await drainStdout();
		process.exit(code);
	},
	async (err) => {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[worker] fatal: ${msg}\n`);
		await drainStdout();
		process.exit(2);
	},
);
