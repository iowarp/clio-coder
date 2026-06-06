import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";

/**
 * Returns true if the runtime is a worker-only runtime (subprocess or sdk kind).
 * Worker-only runtimes can execute as worker targets but are blocked from being
 * used as the orchestrator (chat/TUI) or print targets.
 */
export function isWorkerOnlyRuntime(runtime: RuntimeDescriptor): boolean {
	return runtime.kind === "subprocess" || runtime.kind === "sdk";
}
