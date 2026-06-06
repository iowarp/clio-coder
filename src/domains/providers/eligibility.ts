import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";

export const WORKER_ONLY_RUNTIME_IDS = ["codex-cli", "opencode-cli"] as const;
export type WorkerOnlyRuntimeId = (typeof WORKER_ONLY_RUNTIME_IDS)[number];

const WORKER_ONLY_RUNTIME_ID_SET = new Set<string>(WORKER_ONLY_RUNTIME_IDS);

/**
 * Returns true only for the built-in subprocess runtimes that Clio can execute
 * as worker targets. HTTP/native/pi-ai-backed runtimes are eligible for both
 * orchestrator and worker use; worker-only runtimes are never eligible for the
 * orchestrator or print paths.
 */
export function isWorkerOnlyRuntime(runtime: RuntimeDescriptor): boolean {
	return runtime.kind === "subprocess" && WORKER_ONLY_RUNTIME_ID_SET.has(runtime.id);
}

export function isOrchestratorTargetEligibleRuntime(runtime: RuntimeDescriptor): boolean {
	return runtime.kind === "http";
}

export function isWorkerTargetEligibleRuntime(runtime: RuntimeDescriptor): boolean {
	return runtime.kind === "http" || isWorkerOnlyRuntime(runtime);
}
