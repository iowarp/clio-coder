import type { DomainContract } from "../../core/domain-loader.js";
import type {
	InteropAgentId,
	InteropAgentKind,
	InteropDecisionResult,
	InteropDetectInput,
	InteropProposal,
	InteropReport,
} from "./types.js";

export interface InteropContract extends DomainContract {
	/** The static agent table. No I/O. */
	kinds(): ReadonlyArray<InteropAgentKind>;
	detect(input?: InteropDetectInput): Promise<InteropReport>;
	/** The newest report this process produced, else the recorded one. Never probes. */
	lastReport(): InteropReport | null;
	proposals(report: InteropReport): ReadonlyArray<InteropProposal>;
	accept(ids: ReadonlyArray<InteropAgentId>): InteropDecisionResult;
	decline(ids: ReadonlyArray<InteropAgentId>): InteropDecisionResult;
	/** One boot line for undecided agents whose facts have not been announced yet. */
	bootHint(report: InteropReport): string | null;
}
