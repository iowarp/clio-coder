import { getProviderSpec } from "../catalog.js";
import { initialHealth } from "../health.js";
import { type RuntimeAdapter, type RuntimeProbeResult, configOnlyLiveProbe } from "../runtime-contract.js";

const DEFAULT_PROBE_MODEL = "anthropic.claude-sonnet-4-6";

export const bedrockAdapter: RuntimeAdapter = {
	id: "amazon-bedrock",
	tier: "sdk",
	canSatisfy({ modelId }) {
		// AWS SDK handles credentials via its own env/config chain, so credential
		// presence is assumed true here.
		const spec = getProviderSpec("amazon-bedrock");
		const hasModel = spec.models.some((m) => m.id === modelId);
		if (!hasModel) return { ok: false, reason: `model ${modelId} not in bedrock catalog` };
		return { ok: true, reason: "ready" };
	},
	initialHealth() {
		return initialHealth("amazon-bedrock");
	},
	async probe(): Promise<RuntimeProbeResult> {
		const verdict = this.canSatisfy({ modelId: DEFAULT_PROBE_MODEL, credentialsPresent: new Set<string>() });
		return verdict.ok ? { ok: true } : { ok: false, error: verdict.reason };
	},
	async probeLive(): Promise<RuntimeProbeResult> {
		const verdict = this.canSatisfy({ modelId: DEFAULT_PROBE_MODEL, credentialsPresent: new Set<string>() });
		return configOnlyLiveProbe("amazon-bedrock", verdict);
	},
};
