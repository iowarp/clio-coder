import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";

/**
 * Single target-eligibility policy shared by orchestrator, print, and dispatch
 * paths. Clio only drives HTTP/native/pi-ai-backed executable adapters; any
 * other runtime kind is rejected before it can be used as a target. Keeping one
 * predicate means configure, targets, the model selector, startup checks, and
 * dispatch admission all agree on what counts as a usable target.
 */
export function isTargetEligibleRuntime(runtime: RuntimeDescriptor): boolean {
	return runtime.kind === "http";
}
