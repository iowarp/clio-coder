/** Runtime families whose model residency Clio can actively mutate. */
export type ResidencyRuntimeId = "llamacpp" | "lmstudio" | "ollama-native";

const RESIDENCY_RUNTIME_IDS: ReadonlySet<string> = new Set<ResidencyRuntimeId>([
	"llamacpp",
	"lmstudio",
	"ollama-native",
]);

/**
 * Normalize the server endpoint shared by residency accounting and the
 * cross-process mutation lock. OpenAI-compatible model records carry a `/v1`
 * API mount while their load and unload endpoints live at the server root.
 */
function residencyEndpointRoot(baseUrl: string): string {
	let normalized = baseUrl.trim().replace(/\/+$/u, "");
	if (normalized.endsWith("/v1")) normalized = normalized.slice(0, -"/v1".length);
	if (normalized.startsWith("ws://")) normalized = `http://${normalized.slice("ws://".length)}`;
	if (normalized.startsWith("wss://")) normalized = `https://${normalized.slice("wss://".length)}`;
	return normalized;
}

export function residencyTargetKey(runtimeId: ResidencyRuntimeId, baseUrl: string): string;
export function residencyTargetKey(runtimeId: string, baseUrl: string | null | undefined): string | null;
/** Stable key for one residency-managed server endpoint. */
export function residencyTargetKey(runtimeId: string, baseUrl: string | null | undefined): string | null {
	if (!RESIDENCY_RUNTIME_IDS.has(runtimeId) || typeof baseUrl !== "string") return null;
	const endpoint = residencyEndpointRoot(baseUrl);
	if (endpoint.length === 0) return null;
	return `${runtimeId}|${endpoint}`;
}
