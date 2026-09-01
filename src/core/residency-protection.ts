/**
 * Wire model ids the operator's configuration references, each tagged with the
 * role it serves. The residency layer (src/engine/apis/residency.ts) protects
 * these from eviction by any other Clio stream: a scout worker must never
 * unload the orchestrator's coder, and no profile may evict another profile's
 * model. The orchestrator derives the set from its live effective settings;
 * dispatch copies it onto each WorkerSpec so worker subprocesses protect the
 * same models.
 *
 * The role travels with the id because an eviction message that names only a
 * model id reads as an anonymous collision. A resident serving `memory` is the
 * proactive-memory plane; unloading it silently stops task memory rather than
 * freeing a spare model, and the operator has to be told which plane they are
 * about to lose.
 */

import type { ClioSettings } from "./config.js";

/**
 * Which plane of the operator's configuration references a model:
 *   - `chat`: the orchestrator model, the one the interactive session talks to.
 *   - `memory`: the background plane for proactive task memory.
 *   - `worker`: the worker default or one of the worker profiles.
 *   - `target-default`: a target's `defaultModel`, the fallback any session picks up.
 */
export type ResidencyRole = "chat" | "memory" | "worker" | "target-default";

/** One configured model id and the role its configuration entry serves. */
export interface ProtectedModelRef {
	modelId: string;
	role: ResidencyRole;
}

/**
 * Configured model ids with their roles. The first role that claims an id wins,
 * ordered chat > memory > worker > target-default, so a model serving both the
 * chat plane and a target default is reported by the more specific role.
 */
export function protectedResidencyModels(settings: ClioSettings): ProtectedModelRef[] {
	const byId = new Map<string, ResidencyRole>();
	const add = (id: string | null | undefined, role: ResidencyRole): void => {
		const trimmed = id?.trim();
		if (!trimmed || byId.has(trimmed)) return;
		byId.set(trimmed, role);
	};
	add(settings.chat.model, "chat");
	add(settings.context.memory.model, "memory");
	add(settings.fleet.default.model, "worker");
	for (const profile of Object.values(settings.fleet.profiles ?? {})) add(profile.model, "worker");
	for (const target of settings.targets) add(target.defaultModel, "target-default");
	return [...byId].map(([modelId, role]) => ({ modelId, role }));
}

export function protectedResidencyModelIds(settings: ClioSettings): string[] {
	return protectedResidencyModels(settings).map((ref) => ref.modelId);
}
