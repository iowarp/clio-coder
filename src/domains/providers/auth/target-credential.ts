import type { TargetDescriptor } from "../types/target-descriptor.js";
import { envKeyCopyRef, type RuntimeAuthMetadata, targetCredentialKey, targetRequiresAuth } from "./storage.js";

/** What removing a target does to the credential it read. */
export type TargetCredentialPlan =
	| { action: "remove"; key: string }
	| { action: "keep"; key: string; owner: { runtime: string } | { targets: ReadonlyArray<string> } };

function credentialKeyOf(target: TargetDescriptor, runtimes: ReadonlyArray<RuntimeAuthMetadata>): string | null {
	const runtime = runtimes.find((entry) => entry.id === target.runtime);
	if (runtime) return targetRequiresAuth(target, runtime) ? targetCredentialKey(target, runtime) : null;
	return target.auth?.oauthProfile?.trim() || target.auth?.apiKeyRef?.trim() || null;
}

function ownKeyPlan(
	removed: TargetDescriptor,
	remaining: ReadonlyArray<TargetDescriptor>,
	runtimes: ReadonlyArray<RuntimeAuthMetadata>,
): TargetCredentialPlan | null {
	const key = credentialKeyOf(removed, runtimes);
	if (key === null) return null;
	const runtime = runtimes.find((entry) => (entry.oauthProviderId ?? entry.id) === key || entry.id === key);
	if (runtime) return { action: "keep", key, owner: { runtime: runtime.id } };
	const targets = remaining
		.filter((target) => target.id !== removed.id && credentialKeyOf(target, runtimes) === key)
		.map((target) => target.id);
	if (targets.length > 0) return { action: "keep", key, owner: { targets } };
	return { action: "remove", key };
}

function keyVariableOf(target: TargetDescriptor): string | null {
	return target.auth?.apiKeyEnvVar?.trim() || null;
}

/** The desktop app's stored copy of the key variable the target names (`env:<VAR>`), while no other target names it. */
function envCopyPlan(
	removed: TargetDescriptor,
	remaining: ReadonlyArray<TargetDescriptor>,
): TargetCredentialPlan | null {
	const variable = keyVariableOf(removed);
	if (variable === null) return null;
	const key = envKeyCopyRef(variable);
	const targets = remaining
		.filter((target) => target.id !== removed.id && keyVariableOf(target) === variable)
		.map((target) => target.id);
	if (targets.length > 0) return { action: "keep", key, owner: { targets } };
	return { action: "remove", key };
}

/**
 * The credentials a removed target owned go with it: the entry under its own
 * key ref or profile, and the stored copy of the key variable it names. A
 * runtime's own entry, or one another target still reads, stays, so removing
 * one target never signs out the runtime or a sibling.
 */
export function planTargetCredentialRemoval(
	removed: TargetDescriptor,
	remaining: ReadonlyArray<TargetDescriptor>,
	runtimes: ReadonlyArray<RuntimeAuthMetadata>,
): TargetCredentialPlan[] {
	return [ownKeyPlan(removed, remaining, runtimes), envCopyPlan(removed, remaining)].filter(
		(plan): plan is TargetCredentialPlan => plan !== null,
	);
}

export interface TargetCredentialStore {
	isStored(key: string): boolean;
	remove(key: string): void;
	/** Why the last write did not land, or null. */
	damageReason(): string | null;
}

/**
 * Carry out the plans and say what happened to each stored credential, or null
 * when nothing was stored under any key, so the removal line names only real keys.
 */
export function applyTargetCredentialPlan(
	plans: ReadonlyArray<TargetCredentialPlan>,
	store: TargetCredentialStore,
): string | null {
	const lines = plans.map((plan) => applyOne(plan, store)).filter((line): line is string => line !== null);
	return lines.length > 0 ? lines.join("; ") : null;
}

function applyOne(plan: TargetCredentialPlan, store: TargetCredentialStore): string | null {
	if (!store.isStored(plan.key)) return null;
	if (plan.action === "keep") {
		const owner =
			"runtime" in plan.owner
				? `it is the ${plan.owner.runtime} runtime's own key`
				: `${plan.owner.targets.join(", ")} still ${plan.owner.targets.length === 1 ? "uses" : "use"} it`;
		return `kept the stored key ${plan.key}: ${owner}`;
	}
	store.remove(plan.key);
	const damage = store.damageReason();
	if (damage !== null || store.isStored(plan.key)) {
		return `could not remove the stored key ${plan.key}${damage ? `: ${damage}` : ""}`;
	}
	return `removed its stored key ${plan.key}`;
}
