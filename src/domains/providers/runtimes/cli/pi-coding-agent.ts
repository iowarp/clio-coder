import { initialHealth } from "../../health.js";
import type { RuntimeAdapter } from "../../runtime-contract.js";
import { CLI_CAPABILITIES } from "../capability-manifest.js";
import { resolveBinaryWithEnv } from "./resolve-binary.js";

const ADAPTER_ID = "pi-coding-agent";

export const piCodingAgentCliAdapter: RuntimeAdapter = {
	// CLI-only adapter id; lives outside the ProviderId enum.
	id: ADAPTER_ID as unknown as RuntimeAdapter["id"],
	tier: "cli",
	canSatisfy() {
		const cap = CLI_CAPABILITIES.find((c) => c.id === ADAPTER_ID);
		if (!cap) return { ok: false, reason: `no capability entry for ${ADAPTER_ID}` };
		const bin = resolveBinaryWithEnv(cap.binary, cap.envCheck);
		if (!bin) return { ok: false, reason: `binary not found: ${cap.binary}` };
		return { ok: true, reason: `found at ${bin}` };
	},
	initialHealth() {
		return initialHealth(ADAPTER_ID);
	},
	async probe() {
		const verdict = this.canSatisfy({ modelId: "", credentialsPresent: new Set<string>() });
		return verdict.ok ? { ok: true } : { ok: false, error: verdict.reason };
	},
};
