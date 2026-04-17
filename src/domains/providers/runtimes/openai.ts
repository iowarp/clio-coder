import { getProviderSpec } from "../catalog.js";
import { initialHealth } from "../health.js";
import type { RuntimeAdapter, RuntimeProbeResult } from "../runtime-contract.js";

const DEFAULT_PROBE_MODEL = "gpt-5";

export const openaiAdapter: RuntimeAdapter = {
	id: "openai",
	tier: "sdk",
	canSatisfy({ modelId, credentialsPresent }) {
		const spec = getProviderSpec("openai");
		const hasModel = spec.models.some((m) => m.id === modelId);
		if (!hasModel) return { ok: false, reason: `model ${modelId} not in openai catalog` };
		if (!credentialsPresent.has("OPENAI_API_KEY")) {
			return { ok: false, reason: "missing OPENAI_API_KEY" };
		}
		return { ok: true, reason: "ready" };
	},
	initialHealth() {
		return initialHealth("openai");
	},
	async probe(opts): Promise<RuntimeProbeResult> {
		const creds = opts?.credentialsPresent ?? new Set<string>();
		const verdict = this.canSatisfy({ modelId: DEFAULT_PROBE_MODEL, credentialsPresent: creds });
		return verdict.ok ? { ok: true } : { ok: false, error: verdict.reason };
	},
	async probeLive(): Promise<RuntimeProbeResult> {
		return { ok: false, error: "live probe not implemented for openai; config-only" };
	},
};
