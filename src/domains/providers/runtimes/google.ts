import { getProviderSpec } from "../catalog.js";
import { initialHealth } from "../health.js";
import type { RuntimeAdapter, RuntimeProbeResult } from "../runtime-contract.js";

const DEFAULT_PROBE_MODEL = "gemini-2.5-pro";

export const googleAdapter: RuntimeAdapter = {
	id: "google",
	tier: "sdk",
	canSatisfy({ modelId, credentialsPresent }) {
		const spec = getProviderSpec("google");
		const hasModel = spec.models.some((m) => m.id === modelId);
		if (!hasModel) return { ok: false, reason: `model ${modelId} not in google catalog` };
		if (!credentialsPresent.has("GOOGLE_API_KEY")) {
			return { ok: false, reason: "missing GOOGLE_API_KEY" };
		}
		return { ok: true, reason: "ready" };
	},
	initialHealth() {
		return initialHealth("google");
	},
	async probe(opts): Promise<RuntimeProbeResult> {
		const creds = opts?.credentialsPresent ?? new Set<string>();
		const verdict = this.canSatisfy({ modelId: DEFAULT_PROBE_MODEL, credentialsPresent: creds });
		return verdict.ok ? { ok: true } : { ok: false, error: verdict.reason };
	},
	async probeLive(): Promise<RuntimeProbeResult> {
		return { ok: false, error: "live probe not implemented for google; config-only" };
	},
};
