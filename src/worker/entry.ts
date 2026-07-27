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
import { setProtectedModelsProvider, setResidencyNoticeSink } from "../engine/apis/residency.js";
import { startWorkerRun, type WorkerRunInput, workerProviderSupportsTools } from "../engine/worker-runtime.js";
import { attestedToolSignature } from "../engine/worker-tools.js";
import { emitControlFrame } from "./control-lane.js";
import { projectWorkerEventForStdout } from "./event-projection.js";
import { startWorkerHeartbeat } from "./heartbeat.js";
import { drainStdout, emitEvent } from "./ndjson.js";
import { endpointIdentityHash, WORKER_PROTOCOL_VERSION, workerSpecDigest } from "./protocol.js";
import { observeHostIdentity, observeWorkerResourceFacts } from "./resource-facts.js";
import { resolveWorkerRuntime } from "./runtime-registry.js";
import { validateRehydratedWorkerRuntime, type WorkerSpec } from "./spec-contract.js";
import { createWorkerStdinDemux } from "./stdin-demux.js";

/** Bound between channel-close abort and forced exit for a hung run. */
const CHANNEL_CLOSE_EXIT_GRACE_MS = 5000;

/**
 * The process group an abort must escalate against. A remote launch exports
 * the group leader the login shell established, because `exec` preserves it
 * across the shell replacement. A local launch is spawned detached, which
 * makes this process its own group leader. Windows has no process groups and
 * reports null rather than an id the orchestrator cannot signal.
 */
/**
 * Operator-configured labels for this node. They ride the transport
 * environment rather than the WorkerSpec because the node, not the request,
 * is what they describe: the same spec dispatched to two nodes must attest two
 * different label sets.
 */
function configuredNodeLabels(): string[] {
	return (process.env.CLIO_WORKER_LABELS ?? "")
		.split(",")
		.map((label) => label.trim())
		.filter((label) => label.length > 0);
}

function announcedProcessGroupId(): number | null {
	const declared = Number.parseInt(process.env.CLIO_WORKER_PGID ?? "", 10);
	if (Number.isSafeInteger(declared) && declared > 0) return declared;
	return process.platform === "win32" ? null : process.pid;
}

/**
 * Attest this process, this node, and the route identity it resolved, on the
 * control lane, before any model call. The orchestrator compares every field
 * against the plan it approved and kills a drifting peer instead of running it.
 */
function announceWorker(spec: WorkerSpec, input: WorkerRunInput): void {
	emitControlFrame({
		kind: "announce",
		attestation: {
			protocolVersion: WORKER_PROTOCOL_VERSION,
			specVersion: spec.specVersion,
			pid: process.pid,
			processGroupId: announcedProcessGroupId(),
			host: observeHostIdentity(),
			settingsFingerprint: spec.settingsFingerprint,
			specDigest: workerSpecDigest(spec),
			runtimeId: spec.runtimeId,
			targetId: spec.target.id,
			endpointIdentityHash: endpointIdentityHash(spec.target.url),
			wireModelId: spec.wireModelId,
			toolSignature: attestedToolSignature({
				allowedTools: spec.allowedTools,
				toolsSupported: workerProviderSupportsTools(input),
				...(spec.toolProfile !== undefined ? { toolProfile: spec.toolProfile } : {}),
				agentId: spec.agentId,
				task: spec.task,
			}),
			resources: observeWorkerResourceFacts(configuredNodeLabels()),
		},
	});
}

async function main(): Promise<number> {
	// A worker has no TUI, so residency notices go to stderr (the parent
	// captures it for diagnostics) instead of the shared bus, keeping headless
	// reconciliation parity with the interactive path.
	setResidencyNoticeSink((notice) => {
		process.stderr.write(`[worker] residency ${notice.kind}: ${notice.message}\n`);
		if (notice.kind === "will-not-fit") {
			emitEvent({ type: "clio_run_outcome", payload: { outcomeCode: "vram_capacity_fit_failure" } });
		}
	});
	const demux = createWorkerStdinDemux();
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => demux.feed(chunk));
	process.stdin.on("end", () => demux.eof());
	process.stdin.on("error", () => demux.eof());
	process.stdin.resume();

	const spec = await demux.readSpec();
	// The worker has no settings view of its own; the dispatcher copied the
	// operator's configured model ids onto the spec so this process protects
	// the same residents as the orchestrator.
	setProtectedModelsProvider(() => spec.protectedModels ?? []);
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
		budget: spec.budget,
		...(spec.noSkills !== undefined ? { noSkills: spec.noSkills } : {}),
		...(spec.skillPaths !== undefined ? { skillPaths: [...spec.skillPaths] } : {}),
		...(spec.agentSkills !== undefined ? { agentSkills: [...spec.agentSkills] } : {}),
		...(spec.trustProjectCompatRoots !== undefined ? { trustProjectCompatRoots: spec.trustProjectCompatRoots } : {}),
		...(spec.onPermission !== undefined ? { onPermission: spec.onPermission } : {}),
		...(spec.escalation !== undefined ? { escalation: spec.escalation } : {}),
		...(spec.toolProfile !== undefined ? { toolProfile: spec.toolProfile } : {}),
		...(spec.autonomy !== undefined ? { autonomy: spec.autonomy } : {}),
		...(spec.writeRoots !== undefined ? { writeRoots: [...spec.writeRoots] } : {}),
		...(spec.protectedArtifactState !== undefined
			? {
					protectedArtifactState: {
						version: spec.protectedArtifactState.version,
						artifacts: structuredClone(spec.protectedArtifactState.artifacts),
					},
				}
			: {}),
		...(spec.responseSchema !== undefined ? { responseSchema: spec.responseSchema } : {}),
	};
	if (spec.modelCapabilities) input.modelCapabilities = spec.modelCapabilities;
	if (spec.sessionId) input.sessionId = spec.sessionId;
	if (spec.apiKey) input.apiKey = spec.apiKey;
	if (spec.thinkingLevel) input.thinkingLevel = spec.thinkingLevel;
	if (spec.runtimeResolution) input.runtimeResolution = spec.runtimeResolution;
	if (spec.middlewareSnapshot) input.middlewareSnapshot = spec.middlewareSnapshot;
	// Attest after the runtime is rehydrated and the run input is fully
	// resolved, so the announced identity describes the run that is about to
	// start, and strictly before startWorkerRun reaches a model.
	announceWorker(spec, input);
	// Slim streaming events before NDJSON serialization: pi's message_update
	// carries the full cumulative message twice (top-level + assistantMessageEvent
	// .partial), which reserializes quadratically on stdout. No worker-stdout
	// consumer reads those cumulative snapshots (see event-projection.ts).
	const handle = startWorkerRun(input, (event) => emitEvent(projectWorkerEventForStdout(event)));
	// Steer lines arriving on stdin after the spec queue onto the agent's
	// steering queue; the demux buffers any that landed before this point.
	// The acknowledgement rides the control lane, so a saturated stdout queue
	// cannot delay it past the orchestrator's steering bound.
	let steerSequence = 0;
	demux.onSteer((text) => {
		steerSequence += 1;
		emitControlFrame({ kind: "steer_ack", sequence: steerSequence });
		handle.steer(text);
	});
	// Permission-decision lines resolve a parked escalation. Unknown or
	// duplicate requestIds return false and are dropped without crashing the
	// worker; runtimes without an escalation loop simply have no handler.
	demux.onPermissionDecision(({ requestId, decision }) => {
		const resolved = handle.resolvePermission?.(requestId, decision) ?? false;
		if (!resolved) {
			process.stderr.write(`[worker] dropped permission_decision for unknown request '${requestId}'\n`);
		}
	});
	// Parent monitor: the control channel closing after the spec means the
	// dispatcher is gone (orchestrator exit, SSH channel drop). Abort the run
	// and bound the exit so no worker is ever stranded on a remote node. The
	// timer is unref'd: it cannot keep an otherwise-finished process alive,
	// but it fires if a hung run is still holding the event loop.
	demux.onChannelClose(() => {
		process.stderr.write("[worker] control channel closed; aborting run\n");
		emitControlFrame({ kind: "cancel_ack", at: Date.now() });
		handle.abort();
		const forceExit = setTimeout(() => process.exit(1), CHANNEL_CLOSE_EXIT_GRACE_MS);
		forceExit.unref?.();
	});
	const onSignal = () => {
		emitControlFrame({ kind: "cancel_ack", at: Date.now() });
		handle.abort();
	};
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
