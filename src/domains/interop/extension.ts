import { readSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { acceptInteropAgents, declineInteropAgents, interopProposals } from "./consent.js";
import type { InteropContract } from "./contract.js";
import { detectInteropAgents } from "./detect.js";
import { INTEROP_AGENT_KINDS } from "./registry.js";
import { readInteropReport } from "./state.js";
import type { InteropReport } from "./types.js";

const EMPTY_REPORT: InteropReport = { version: 1, detectedAt: new Date(0).toISOString(), agents: [] };

export function createInteropBundle(_context: DomainContext): DomainBundle<InteropContract> {
	let detected: InteropReport | null = null;
	const extension: DomainExtension = {
		start() {
			return undefined;
		},
	};
	const contract: InteropContract = {
		kinds() {
			return INTEROP_AGENT_KINDS;
		},
		async detect(input = {}) {
			detected = await detectInteropAgents(input, detected?.agents);
			return detected;
		},
		lastReport() {
			return detected ?? readInteropReport();
		},
		proposals(report) {
			return interopProposals(report, readSettings());
		},
		accept(ids) {
			return acceptInteropAgents(ids, detected ?? readInteropReport() ?? EMPTY_REPORT);
		},
		decline(ids) {
			return declineInteropAgents(ids, detected ?? readInteropReport() ?? EMPTY_REPORT);
		},
	};
	return { extension, contract };
}
