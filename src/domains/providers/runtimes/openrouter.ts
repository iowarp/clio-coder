import { initialHealth } from "../health.js";
import type { RuntimeAdapter, RuntimeProbeResult } from "../runtime-contract.js";

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
};
