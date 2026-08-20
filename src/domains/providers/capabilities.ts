import type { CapabilityFlags } from "./types/capability-flags.js";

/**
 * Layer capability sources onto a runtime's defaults, weakest first.
 *
 * A probe is what the server currently reports; a knowledge-base entry is what
 * an operator wrote down about a specific model. The written entry wins for
 * descriptive capabilities because a hand-authored `model-catalog.d` file is
 * the per-model escape hatch for incorrect server metadata. Context and output
 * limits are deployment facts, so a live probe overrides the model's maximums.
 * A target-level override still outranks every source.
 */
export function mergeCapabilities(
	base: CapabilityFlags,
	kb: Partial<CapabilityFlags> | null,
	probe: Partial<CapabilityFlags> | null,
	userOverride: Partial<CapabilityFlags> | null,
): CapabilityFlags {
	const merged: Record<string, unknown> = { ...base };
	applyLayer(merged, probe);
	applyLayer(merged, kb);
	applyDeploymentLimits(merged, probe);
	applyLayer(merged, userOverride);
	return merged as unknown as CapabilityFlags;
}

function applyDeploymentLimits(target: Record<string, unknown>, probe: Partial<CapabilityFlags> | null): void {
	if (!probe) return;
	if (probe.contextWindow !== undefined) target.contextWindow = probe.contextWindow;
	if (probe.maxTokens !== undefined) target.maxTokens = probe.maxTokens;
}

/**
 * Whether a model may drive an agent role (orchestrator, dispatched worker).
 *
 * Clio's whole surface is typed tools. A chat model that reports no tool support
 * cannot read a file or run a command, so pointing an agent role at one produces
 * a run that burns budget and returns nothing usable. Roles that only need text
 * back, such as the background memory policy, do not consult this.
 *
 * The flag is metadata, not a measurement, and servers do get it wrong. An
 * operator who disagrees states so in a `model-catalog.d` entry or a target-level
 * capability override, both of which outrank the probe.
 */
export function supportsAgentRoleTools(capabilities: Pick<CapabilityFlags, "tools">): boolean {
	return capabilities.tools === true;
}

export const AGENT_ROLE_TOOLS_REQUIRED_REASON =
	"reports no tool support; Clio drives every agent role through typed tools";

function applyLayer(target: Record<string, unknown>, layer: Partial<CapabilityFlags> | null): void {
	if (!layer) return;
	for (const key of Object.keys(layer) as Array<keyof CapabilityFlags>) {
		const value = layer[key];
		if (value !== undefined) target[key] = value;
	}
}
