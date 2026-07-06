/**
 * Wire model ids the operator's configuration references. The residency layer
 * (src/engine/apis/residency.ts) protects these from eviction by any other
 * Clio stream: a scout worker must never unload the orchestrator's coder, and
 * no profile may evict another profile's model. The orchestrator derives the
 * set from its live effective settings; dispatch copies it onto each
 * WorkerSpec so worker subprocesses protect the same models.
 */

import type { ClioSettings } from "./config.js";

export function protectedResidencyModelIds(settings: ClioSettings): string[] {
	const ids = new Set<string>();
	const add = (id: string | null | undefined): void => {
		const trimmed = id?.trim();
		if (trimmed) ids.add(trimmed);
	};
	add(settings.orchestrator.model);
	add(settings.workers.default.model);
	for (const profile of Object.values(settings.workers.profiles ?? {})) add(profile.model);
	for (const target of settings.targets) add(target.defaultModel);
	return [...ids];
}
