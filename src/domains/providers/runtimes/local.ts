import { initialHealth } from "../health.js";
import type { RuntimeAdapter, RuntimeProbeResult } from "../runtime-contract.js";

export const localAdapter: RuntimeAdapter = {
	id: "local",
	tier: "native",
	canSatisfy() {
		return { ok: true, reason: "local runtime" };
	},
	initialHealth() {
		return initialHealth("local");
	},
	async probe(): Promise<RuntimeProbeResult> {
		return { ok: true };
	},
};
