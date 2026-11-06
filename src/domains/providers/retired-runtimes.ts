/**
 * Runtime ids 0.7.0 stopped resolving (82842896d), each mapped to the runtime
 * that replaced it. Nothing aliases them: a target that still names one stays
 * unregistered, and these helpers only make the refusal name the fix.
 */
const RETIRED_RUNTIME_IDS: Readonly<Record<string, string>> = {
	"lmstudio-native": "lmstudio",
	"ollama-native": "ollama",
};

/** The runtime that replaced a retired id, or null for any other id. */
export function retiredRuntimeReplacement(runtimeId: string): string | null {
	return Object.hasOwn(RETIRED_RUNTIME_IDS, runtimeId) ? (RETIRED_RUNTIME_IDS[runtimeId] ?? null) : null;
}

/** Problem text for a target whose runtime id resolves to nothing. */
export function runtimeNotRegistered(runtimeId: string): string {
	const replacement = retiredRuntimeReplacement(runtimeId);
	if (replacement === null) return `runtime '${runtimeId}' is not registered`;
	return `runtime '${runtimeId}' was removed in 0.7.0; set \`runtime: ${replacement}\` on this target in settings.yaml`;
}
