import type { ClioSettings } from "../../core/config.js";
import { AGENT_ROLE_TOOLS_REQUIRED_REASON, supportsAgentRoleTools } from "./capabilities.js";
import type { ProvidersContract } from "./contract.js";
import { probeCapabilitiesForModel, resolveModelCapabilities } from "./model-capabilities.js";

/**
 * Warn about a configured agent-role model the provider reports cannot call
 * tools. Selection already refuses these, so reaching here means the config
 * predates the check or was hand-edited; a run would otherwise fail later at
 * dispatch admission with a message that names a missing tool rather than the
 * model that cannot use any.
 */
export function agentRoleToolWarnings(providers: ProvidersContract, settings: Readonly<ClioSettings>): string[] {
	const roles: ReadonlyArray<{ label: string; target: string | null; model: string | null }> = [
		{ label: "orchestrator", target: settings.chat.target, model: settings.chat.model },
		{ label: "workers.default", target: settings.fleet.default.target, model: settings.fleet.default.model },
	];
	const warnings: string[] = [];
	for (const role of roles) {
		const targetId = role.target?.trim();
		const wireModelId = role.model?.trim();
		if (!targetId || !wireModelId) continue;
		try {
			const status = providers.list().find((entry) => entry.target.id === targetId);
			if (!status) continue;
			const capabilities = resolveModelCapabilities(status, wireModelId, providers.knowledgeBase);
			if (supportsAgentRoleTools(capabilities)) continue;
			// A target that was never probed has reported nothing about this model:
			// the flag is only the runtime's conservative floor. Dispatch admission
			// probes the route itself before it refuses a worker.
			const declared =
				status.target.capabilities?.tools ??
				providers.knowledgeBase?.lookup(wireModelId, status.runtime?.id ?? status.target.runtime)?.entry.capabilities
					?.tools;
			if (
				declared === undefined &&
				status.health.lastCheckAt === null &&
				probeCapabilitiesForModel(status, wireModelId) === null
			)
				continue;
			warnings.push(
				`${role.label} model '${wireModelId}' on target '${targetId}' ${AGENT_ROLE_TOOLS_REQUIRED_REASON}. ` +
					`Pick another model, or state the correction in a model-catalog.d entry if the provider's flag is wrong.`,
			);
		} catch {
			// An unresolvable capability is not evidence of a missing one.
		}
	}
	return warnings;
}
