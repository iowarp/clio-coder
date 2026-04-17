import { initialHealth } from "../health.js";
import { type RuntimeAdapter, type RuntimeProbeResult, configOnlyLiveProbe } from "../runtime-contract.js";

const DEFAULT_PROBE_MODEL = "openai/gpt-4.1-mini";

export const openrouterAdapter: RuntimeAdapter = {
	id: "openrouter",
	tier: "sdk",
	canSatisfy({ modelId, credentialsPresent }) {
		// openrouter fronts many providers; accept any non-empty model id.
		if (!modelId || modelId.length === 0) {
			return { ok: false, reason: "openrouter requires an explicit model id" };
		}
		if (!credentialsPresent.has("OPENROUTER_API_KEY")) {
			return { ok: false, reason: "missing OPENROUTER_API_KEY" };
		}
		return { ok: true, reason: "ready" };
	},
	initialHealth() {
		return initialHealth("openrouter");
	},
	async probe(opts): Promise<RuntimeProbeResult> {
		const creds = opts?.credentialsPresent ?? new Set<string>();
		if (!creds.has("OPENROUTER_API_KEY")) {
			return { ok: false, error: "missing OPENROUTER_API_KEY" };
		}
		return { ok: true };
	},
	async probeLive(opts): Promise<RuntimeProbeResult> {
		const creds = opts?.credentialsPresent ?? new Set<string>();
		const verdict = this.canSatisfy({ modelId: DEFAULT_PROBE_MODEL, credentialsPresent: creds });
		return configOnlyLiveProbe("openrouter", verdict);
	},
};
