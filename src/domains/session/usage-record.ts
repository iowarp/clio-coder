import type { ResponseModelIdObservationCounts } from "../../core/response-model-id.js";
import {
	addResponseModelIdObservationCount,
	emptyResponseModelIdObservationCounts,
} from "../../core/response-model-id.js";
import type { CostAggregate, CostEntryLabel } from "../observability/cost.js";
import type { CostProvenance } from "../providers/types/cost-provenance.js";
import type { LedgerUsageCall } from "./usage.js";

/** The slice of ObservabilityContract a reseed needs. */
export interface SessionUsageSink {
	recordRunTokens?(runId: string, ...args: Parameters<SessionUsageSink["recordTokens"]>): void;
	resetSession(sessionId?: string | null): void;
	recordNeverSentCalls?(count: number): void;
	recordTokens(
		providerId: string,
		attributedModelId: string,
		tokens: number,
		costUsd?: number,
		breakdown?: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			cacheWrite1h?: number;
			reasoningTokens: number;
			totalTokens: number;
			apiCalls?: number;
			missingTokenCalls?: number;
		},
		costProvenance?: CostProvenance,
		modelIdFacts?: {
			requestedModelIds: ReadonlyArray<string>;
			responseModelIdObservationCounts: Readonly<ResponseModelIdObservationCounts>;
		},
		label?: CostEntryLabel,
		costSummary?: CostAggregate,
		replayed?: boolean,
	): void;
}

/** Both live and replayed calls use the same sink wiring (#434). */
export function recordUsageCall(
	sink: Pick<SessionUsageSink, "recordTokens" | "recordRunTokens">,
	call: LedgerUsageCall,
	replayed = false,
): void {
	const responseModelIdObservationCounts = emptyResponseModelIdObservationCounts();
	addResponseModelIdObservationCount(
		responseModelIdObservationCounts,
		call.responseModelIdObservation,
		call.apiCalls ?? 1,
	);
	const record =
		call.runId && sink.recordRunTokens ? sink.recordRunTokens.bind(sink, call.runId) : sink.recordTokens.bind(sink);
	record(
		call.providerId,
		call.attributedModelId,
		call.totalTokens,
		call.costUsd,
		{
			input: call.input,
			output: call.output,
			cacheRead: call.cacheRead,
			cacheWrite: call.cacheWrite,
			...(call.cacheWrite1h === undefined ? {} : { cacheWrite1h: call.cacheWrite1h }),
			reasoningTokens: call.reasoningTokens,
			totalTokens: call.totalTokens,
			apiCalls: call.apiCalls ?? 1,
			...(call.missingTokenCalls ? { missingTokenCalls: call.missingTokenCalls } : {}),
		},
		call.costProvenance,
		{
			requestedModelIds: [call.requestedModelId],
			responseModelIdObservationCounts,
		},
		call.label,
		call.costSummary,
		replayed,
	);
}
