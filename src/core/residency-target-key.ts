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
	// A base url the canonical form refuses, such as one written without a
	// scheme, still gets a key: callers store this in `ResidencyAdapter.targetKey`,
	// which is a `string`, and dispatch capacity has no key for that target
	// either, so there is nothing to agree with and nothing to gain by dropping
	// the lock the reconciler serializes on.
	return canonicalEndpointUrl(baseUrl) ?? baseUrl;
}
