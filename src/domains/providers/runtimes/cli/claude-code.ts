import { initialHealth } from "../../health.js";
import type { RuntimeAdapter } from "../../runtime-contract.js";
import { CLI_CAPABILITIES } from "../capability-manifest.js";
import { resolveBinaryWithEnv } from "./resolve-binary.js";

const ADAPTER_ID = "claude-code";
const FALLBACK_BINARY = "claude";

export const claudeCodeCliAdapter: RuntimeAdapter = {
	// CLI-only adapter id; lives outside the ProviderId enum.
	id: ADAPTER_ID as unknown as RuntimeAdapter["id"],
	tier: "cli",
	canSatisfy() {
		const cap = CLI_CAPABILITIES.find((c) => c.id === ADAPTER_ID);
		if (!cap) return { ok: false, reason: `no capability entry for ${ADAPTER_ID}` };
		const primary = resolveBinaryWithEnv(cap.binary, cap.envCheck);
		if (primary) return { ok: true, reason: `found at ${primary}` };
		const fallback = resolveBinaryWithEnv(FALLBACK_BINARY);
		if (fallback) return { ok: true, reason: `found at ${fallback}` };
		return { ok: false, reason: `binary not found: ${cap.binary} (or ${FALLBACK_BINARY})` };
	},
	initialHealth() {
		return initialHealth(ADAPTER_ID);
	},
	async probe() {
		const verdict = this.canSatisfy({ modelId: "", credentialsPresent: new Set<string>() });
		return verdict.ok ? { ok: true } : { ok: false, error: verdict.reason };
	},
	async probeLive() {
		return { ok: false, error: `live probe not implemented for ${ADAPTER_ID}; config-only` };
	},
};
