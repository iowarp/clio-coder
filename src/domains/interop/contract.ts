import type { DomainContract } from "../../core/domain-loader.js";
import type { InteropAgentKind, InteropDetectInput, InteropReport } from "./types.js";

export interface InteropContract extends DomainContract {
	/** The static agent table. No I/O. */
	kinds(): ReadonlyArray<InteropAgentKind>;
	detect(input?: InteropDetectInput): Promise<InteropReport>;
	/** The newest report this process produced, else the recorded one. Never probes. */
	lastReport(): InteropReport | null;
}
