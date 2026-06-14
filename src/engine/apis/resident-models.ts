import { ollamaResidentManager } from "./ollama-native.js";

/**
 * One model currently resident (loaded) on a local runtime, with its footprint
 * when the runtime reports it. `sizeVramBytes` is the GPU-resident portion;
 * `sizeBytes` the total weight footprint.
 */
export interface ResidentModelInfo {
	modelId: string;
	/**
	 * Other ids the runtime reports for the same resident model. Ollama's
	 * `/api/ps` returns both `model` and `name`, which can diverge, so the keep
	 * target may match either field. The reconciler keeps a model resident when
	 * the keep target equals `modelId` or any alias; collapsing to one id risks
	 * evicting the model the chat loop just selected.
	 */
	aliasIds?: string[];
	sizeVramBytes?: number;
	sizeBytes?: number;
}

/**
 * Per-runtime resident-model lifecycle. Local runtimes that pin weights in VRAM
 * implement this so the chat loop can reconcile residency through one
 * abstraction instead of branching on the runtime id. `listResident` enumerates
 * what is loaded; `unload` releases one model. Both are best-effort: a slow or
 * unreachable server must never block a model swap.
 */
export interface ResidentModelManager {
	listResident(baseUrl: string, headers?: Record<string, string>): Promise<ResidentModelInfo[]>;
	unload(baseUrl: string, modelId: string, headers?: Record<string, string>): Promise<void>;
}

/**
 * Runtimes whose resident set the chat loop reconciles on model hot-swap.
 * Ollama pins the active model with `keep_alive: -1`, so a prior pinned model
 * lingers in VRAM until something evicts it. LM Studio manages its own resident
 * set in the stream path (see `ensureResidentModel`) and is deliberately not
 * listed here so its lifecycle policy stays where it lives today.
 */
const RESIDENT_MANAGERS: Readonly<Record<string, ResidentModelManager>> = {
	"ollama-native": ollamaResidentManager,
};

export function residentModelManagerFor(runtimeId: string): ResidentModelManager | undefined {
	return RESIDENT_MANAGERS[runtimeId];
}

/**
 * A resident entry is the keep target when its canonical id or any alias
 * matches. Matching on aliases too means a runtime that reports divergent
 * id fields (Ollama's `model` vs `name`) never has the freshly selected model
 * evicted out from under the chat loop.
 */
export function residentMatchesKeep(entry: ResidentModelInfo, keepModelId: string): boolean {
	return entry.modelId === keepModelId || (entry.aliasIds?.includes(keepModelId) ?? false);
}

/**
 * Release every resident model on the target except `keepModelId`. No-op when
 * the runtime does not manage residency or the target has no url. Failures are
 * swallowed so a model swap never stalls on a slow server.
 */
export async function evictOtherResidentModels(
	runtimeId: string,
	baseUrl: string | undefined,
	keepModelId: string,
	headers?: Record<string, string>,
): Promise<void> {
	if (!baseUrl) return;
	const manager = residentModelManagerFor(runtimeId);
	if (!manager) return;
	let resident: ResidentModelInfo[];
	try {
		resident = await manager.listResident(baseUrl, headers);
	} catch {
		return;
	}
	const stale = resident.filter((entry) => !residentMatchesKeep(entry, keepModelId));
	await Promise.all(stale.map((entry) => manager.unload(baseUrl, entry.modelId, headers).catch(() => undefined)));
}
