export type LocalModelFamily =
	| "openai-gpt-oss"
	| "qwen3"
	| "nemotron-3-nano-omni"
	| "nemotron-cascade-2"
	| "gemma-4"
	| "unknown";

export function normalizeModelIdForFamily(modelId: string | null | undefined): string {
	return (modelId ?? "").trim().toLowerCase().replace(/_/g, "-");
}

export function isHarmonyModelId(modelId: string | null | undefined): boolean {
	return normalizeModelIdForFamily(modelId).includes("gpt-oss");
}

export function inferLocalModelFamily(modelId: string | null | undefined): LocalModelFamily {
	const normalized = normalizeModelIdForFamily(modelId);
	if (normalized.length === 0) return "unknown";
	if (normalized.includes("gpt-oss")) return "openai-gpt-oss";
	if (normalized.includes("nemotron-cascade-2") || normalized.includes("nemotron-cascade2")) {
		return "nemotron-cascade-2";
	}
	if (normalized.includes("nemotron-3-nano-omni") || normalized.includes("nemotron-nano-omni")) {
		return "nemotron-3-nano-omni";
	}
	if (normalized.includes("qwen3")) return "qwen3";
	if (normalized.includes("gemma-4") || normalized.includes("gemma4") || normalized.includes("gemopus")) {
		return "gemma-4";
	}
	return "unknown";
}
