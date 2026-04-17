/**
 * Claude Agent SDK runtime adapter (tier=sdk).
 *
 * The SDK package is optional; presence is verified inside the subprocess
 * worker at run time. canSatisfy only reflects credential availability — the
 * orchestrator still needs ANTHROPIC_API_KEY before attempting a dispatch.
 *
 * The `claude-sdk` id is NOT in the ProviderId enum (the catalog models
 * providers, not runtimes). The cast mirrors how CLI adapters register
 * themselves outside the enum.
 */

import { initialHealth } from "../health.js";
import { type RuntimeAdapter, configOnlyLiveProbe } from "../runtime-contract.js";

const ADAPTER_ID = "claude-sdk";

export const claudeSdkAdapter: RuntimeAdapter = {
	id: ADAPTER_ID as unknown as RuntimeAdapter["id"],
	tier: "sdk",
	canSatisfy({ credentialsPresent }) {
		if (!credentialsPresent.has("ANTHROPIC_API_KEY")) {
			return { ok: false, reason: "ANTHROPIC_API_KEY not set" };
		}
		return { ok: true, reason: "credentials present (package checked at run time)" };
	},
	initialHealth() {
		return initialHealth(ADAPTER_ID);
	},
	async probe(opts) {
		const creds = opts?.credentialsPresent ?? new Set<string>();
		const verdict = this.canSatisfy({ modelId: "claude-sonnet-4-6", credentialsPresent: creds });
		return verdict.ok ? { ok: true } : { ok: false, error: verdict.reason };
	},
	async probeLive(opts) {
		const creds = opts?.credentialsPresent ?? new Set<string>();
		const verdict = this.canSatisfy({ modelId: "claude-sonnet-4-6", credentialsPresent: creds });
		return configOnlyLiveProbe(ADAPTER_ID, verdict);
	},
};
