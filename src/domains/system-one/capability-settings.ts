import type { ClioSettings } from "../../core/config.js";

/** FW-1: reuse an explicitly configured side model through the normal calibrated decision engine. */
export function capabilitySettings(settings: Readonly<ClioSettings>): Readonly<ClioSettings> {
	if (settings.systemOne.sites.relevance !== undefined) return settings;
	const { target, model } = settings.context.memory;
	if (!settings.context.memory.enabled || !target || !model) return settings;
	// Skill routing must never pay a second pass through the foreground model.
	if (target === settings.chat.target && model === settings.chat.model) return settings;
	const engine = "clio-capability-side-model";
	if (settings.systemOne.engines[engine] !== undefined) return settings;
	return {
		...settings,
		systemOne: {
			...settings.systemOne,
			engines: { ...settings.systemOne.engines, [engine]: { kind: "llm", target, model, mode: "auto" } },
			sites: { ...settings.systemOne.sites, relevance: { engine, timeoutMs: 800 } },
		},
	};
}
