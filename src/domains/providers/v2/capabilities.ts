import type { CapabilityFlags } from "./types/capability-flags.js";

export function mergeCapabilities(
	base: CapabilityFlags,
	kb: Partial<CapabilityFlags> | null,
	probe: Partial<CapabilityFlags> | null,
	userOverride: Partial<CapabilityFlags> | null,
): CapabilityFlags {
	const merged: Record<string, unknown> = { ...base };
	applyLayer(merged, kb);
	applyLayer(merged, probe);
	applyLayer(merged, userOverride);
	return merged as unknown as CapabilityFlags;
}

function applyLayer(target: Record<string, unknown>, layer: Partial<CapabilityFlags> | null): void {
	if (!layer) return;
	for (const key of Object.keys(layer) as Array<keyof CapabilityFlags>) {
		const value = layer[key];
		if (value !== undefined) target[key] = value;
	}
}
