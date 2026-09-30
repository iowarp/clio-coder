import type { RuntimeDescriptor, RuntimeEnforcement } from "./types/runtime-descriptor.js";

/**
 * Enforcement a runtime can honor for a worker permit (Codex review F10,
 * "Runtime fidelity"). Admission compares a permit's hard requirements with
 * this and refuses a guarantee the runtime cannot keep instead of accepting it
 * silently.
 */

/** Native pi-agent-core workers: Clio's registry admits every call and can park one. */
const NATIVE_ENFORCEMENT: RuntimeEnforcement = Object.freeze({
	perCallMediation: true,
	toolNarrowing: "exact",
	scopeEnforcement: true,
	grantPauseResume: true,
	cancellation: true,
});

/**
 * A runtime that runs its own tool loop. Its own read-only or sandbox mode is
 * the runtime's authority, not Clio's per-call mediation, so it is never
 * described as equivalent.
 */
export const UNMEDIATED_ENFORCEMENT: RuntimeEnforcement = Object.freeze({
	perCallMediation: false,
	toolNarrowing: "none",
	scopeEnforcement: false,
	grantPauseResume: false,
	cancellation: true,
});

/**
 * The runtime's declared enforcement. An HTTP runtime runs in the native
 * worker whatever its descriptor says; any other runtime that declares
 * nothing (a plugin runtime, for example) is treated as unmediated.
 */
export function runtimeEnforcement(runtime: Pick<RuntimeDescriptor, "kind" | "enforcement">): RuntimeEnforcement {
	if (runtime.kind === "http") return NATIVE_ENFORCEMENT;
	return runtime.enforcement ?? UNMEDIATED_ENFORCEMENT;
}
