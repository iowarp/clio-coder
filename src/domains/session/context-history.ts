import { clioStateDir } from "../../core/xdg.js";
import { readSessionContextSnapshots } from "../telemetry/index.js";
import type { ContextSnapshot } from "./context-accounting.js";
import type { SessionMeta } from "./contract.js";

function getContextSnapshots(meta: SessionMeta): ContextSnapshot[] {
	return readSessionContextSnapshots(clioStateDir(), meta.id);
}

export function getLatestContextSnapshot(meta: SessionMeta): ContextSnapshot | null {
	const list = getContextSnapshots(meta);
	return list.at(-1) ?? null;
}

/**
 * The window a previous process measured this session's prompts against, when
 * the backend itself reported it as the one it had open (issue #227).
 *
 * A resumed session re-resolves its target before discovery has reported a
 * loaded window, so the first turn budgets against the probed server-wide
 * figure, which on a multi-slot backend is a multiple of what the model is
 * actually serving. The snapshot ledger already recorded the number the
 * backend named, so the resume carries it forward instead of re-probing.
 * Scoped to the same target and model: a different selection has no claim on
 * that measurement, and a live loaded window always outranks this one, so a
 * model reloaded at a new size corrects on the next resolution.
 */
export function lastLoadedContextWindow(meta: SessionMeta, providerId: string, modelId: string): number | null {
	const snapshots = getContextSnapshots(meta);
	for (let i = snapshots.length - 1; i >= 0; i -= 1) {
		const snapshot = snapshots[i];
		if (snapshot?.contextWindowSource !== "loaded") continue;
		if (snapshot.providerId !== providerId || snapshot.modelId !== modelId) continue;
		const window = snapshot.effectiveContextWindow;
		if (typeof window === "number" && Number.isFinite(window) && window > 0) return window;
	}
	return null;
}
