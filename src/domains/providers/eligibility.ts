import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";

/**
 * Target eligibility covers runtimes Clio can drive from at least one target
 * surface. HTTP runtimes remain the only orchestrator/print runtimes; the
 * Claude Code subscription runtimes are worker-dispatch targets with their own
 * worker runners.
 */
export function isTargetEligibleRuntime(runtime: RuntimeDescriptor): boolean {
	return (
		runtime.kind === "http" ||
		runtime.id === "claude-sdk" ||
		runtime.id === "claude-code" ||
		runtime.id === "antigravity-code"
	);
}

export function isOrchestratorEligibleRuntime(runtime: RuntimeDescriptor): boolean {
	return runtime.kind === "http";
}

export function isDispatchEligibleRuntime(runtime: RuntimeDescriptor): boolean {
	return isTargetEligibleRuntime(runtime);
}
