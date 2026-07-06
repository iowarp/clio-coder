/**
 * Runtime-agnostic resident-model shapes shared by the VRAM-aware reconciler
 * (residency.ts) and the per-runtime adapters. The reconciler decides load and
 * evict; this module only describes what a runtime reports as resident and how
 * the keep target is matched against divergent id fields.
 */

/**
 * One model currently resident (loaded) on a local runtime, with its footprint
 * when the runtime reports it. `sizeVramBytes` is the GPU-resident portion;
 * `sizeBytes` the total weight footprint. A `sizeBytes` larger than
 * `sizeVramBytes` means the model is split onto CPU.
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
	/**
	 * Runtime-reported tags for the resident model (the llama.cpp router's
	 * per-model `tags` array). The reconciler treats `pinned:true` and
	 * `role:scout` as operator pins that are never evicted.
	 */
	tags?: string[];
}

/**
 * A resident entry is the keep target when its canonical id or any alias
 * matches. Matching on aliases too means a runtime that reports divergent id
 * fields (Ollama's `model` vs `name`) never has the freshly selected model
 * evicted out from under the chat loop.
 */
export function residentMatchesKeep(entry: ResidentModelInfo, keepModelId: string): boolean {
	return entry.modelId === keepModelId || (entry.aliasIds?.includes(keepModelId) ?? false);
}
