import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { InteropContract } from "./contract.js";
import { detectInteropAgents } from "./detect.js";
import { INTEROP_AGENT_KINDS } from "./registry.js";
import { readInteropReport } from "./state.js";
import type { InteropReport } from "./types.js";

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
			const previous = detected ?? readInteropReport();
			detected = await detectInteropAgents(input, previous?.agents ?? []);
			return detected;
		},
		lastReport() {
			return detected ?? readInteropReport();
		},
	};
	return { extension, contract };
}
