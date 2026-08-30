import { canonicalEndpointUrl } from "./endpoint-key.js";

/** Runtime families whose model residency Clio can actively mutate. */
export type ResidencyRuntimeId = "llamacpp" | "lmstudio" | "ollama-native";

const RESIDENCY_RUNTIME_IDS: ReadonlySet<string> = new Set<ResidencyRuntimeId>([
	"llamacpp",
	"lmstudio",
	"ollama-native",
]);

export function residencyTargetKey(runtimeId: ResidencyRuntimeId, baseUrl: string): string;
export function residencyTargetKey(runtimeId: string, baseUrl: string | null | undefined): string | null;
/** Stable key for one residency-managed server endpoint: its canonical URL. */
export function residencyTargetKey(runtimeId: string, baseUrl: string | null | undefined): string | null {
	if (!RESIDENCY_RUNTIME_IDS.has(runtimeId) || typeof baseUrl !== "string") return null;
	// The key is the canonical endpoint itself, without a runtime prefix, so the
	// residency lock and dispatch capacity name one server the same way (#250).
	return canonicalEndpointUrl(baseUrl);
}
