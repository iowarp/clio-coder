import { buildBwrapInvocation, DEFAULT_BWRAP_PATH } from "./bwrap.js";
import { buildSeatbeltInvocation, SEATBELT_EXECUTABLE } from "./seatbelt.js";
import type { SandboxBackend, SandboxInvocation, SandboxInvocationSpec } from "./types.js";

/** Pure: the sandboxed argv for one command on the named backend. */
export function buildSandboxInvocation(
	spec: SandboxInvocationSpec,
	backend: SandboxBackend = "bwrap",
	executable?: string,
): SandboxInvocation {
	return backend === "bwrap"
		? buildBwrapInvocation(spec, executable ?? DEFAULT_BWRAP_PATH)
		: buildSeatbeltInvocation(spec, executable ?? SEATBELT_EXECUTABLE);
}
