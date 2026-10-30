import type { PreimageData, PreimageKind } from "./schemas.js";

/**
 * The session-scoped home of background research traces. Memory and compaction code runs outside any call, so it
 * reaches the owning session's journal through the one sink its composition root registers (#434).
 */
export interface ResearchTraceSink {
	/** Answered from memory without allocating, so emitters can skip building a trace standard mode refuses. */
	admits(kind: PreimageKind): boolean;
	/** Ownership of `data` and `preimage` transfers to the sink. */
	record<K extends PreimageKind>(kind: K, data: PreimageData<K>, preimage: unknown): void;
}

let registered: ResearchTraceSink | null = null;

export function registerResearchTraceSink(sink: ResearchTraceSink): () => void {
	registered = sink;
	return () => {
		if (registered === sink) registered = null;
	};
}

/** Ask before building a trace's facts: a refused kind must cost nothing on background paths (#434, §14). */
export function researchTraceAdmits(kind: PreimageKind): boolean {
	return registered?.admits(kind) ?? false;
}

export function recordResearchTrace<K extends PreimageKind>(kind: K, data: PreimageData<K>, preimage: unknown): void {
	try {
		registered?.record(kind, data, preimage);
	} catch {
		// A research trace never decides whether the memory step or compaction it describes succeeds (#434).
	}
}
