import { readSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { acceptInteropAgents, declineInteropAgents, interopBootHint, interopProposals } from "./consent.js";
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
		// A decision is written and read back, so the report an overlay rebuilds
		// from carries it: a declined row leaves the proposal list on the
		// keystroke rather than on the next detection.
		lastReport() {
			return detected ?? readInteropReport();
		},
		proposals(report) {
			return interopProposals(report, readSettings());
		},
		accept(ids) {
			const result = acceptInteropAgents(ids, detected ?? readInteropReport() ?? EMPTY_REPORT);
			detected = readInteropReport() ?? detected;
			return result;
		},
		decline(ids) {
			const result = declineInteropAgents(ids, detected ?? readInteropReport() ?? EMPTY_REPORT);
			detected = readInteropReport() ?? detected;
			return result;
		},
		bootHint(report) {
			return interopBootHint(report, readSettings());
		},
	};
	return { extension, contract };
}
