/**
 * Rebuild the running usage totals from a session's own ledger.
 *
 * The `/usage` overlay and the footer both render one process-lifetime
 * accumulator, and only `startNewSession` ever reset it. Resuming did not, so a
 * resumed session showed the *previous* session's numbers under the resumed
 * session's id: one process, two sessions, byte-identical totals relabelled.
 * That is misattribution rather than an undercount, and a process that resumed
 * and sent nothing reported zero for a session holding tens of thousands of
 * tokens on disk.
 *
 * The fold itself is `ledgerUsageCalls` in the session domain, which owns the
 * ledger and serves `clio-coder usage report` from the same function. This module is
 * only the sink wiring between that fold and the observability projection.
 */

import {
	addResponseModelIdObservationCount,
	emptyResponseModelIdObservationCounts,
	type ResponseModelIdObservationCounts,
} from "../../core/response-model-id.js";
import type { CostEntryLabel } from "../observability/cost.js";
import type { CostProvenance } from "../providers/types/cost-provenance.js";
import type { SessionEntry } from "./entries.js";
import { filterEntriesToActivePath } from "./tree/active-path.js";
import { ledgerUsageCalls, type SessionUsageDefaults } from "./usage.js";

/** The slice of ObservabilityContract a reseed needs. */
export interface SessionUsageSink {
	resetSession(sessionId?: string | null): void;
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
	): void;
}

/**
 * Clear the running totals and replay the supplied session's recorded calls
 * into them. Safe to call with an empty ledger: the totals reset to zero, which
 * is the honest answer for a session that has spent nothing.
 *
 * `activeLeafTurnId` scopes the fold to one branch, through the same
 * `filterEntriesToActivePath` the transcript replays through. current.jsonl is
 * append-only, so after a `/tree` switch the abandoned sibling turns are still
 * in the file: the transcript stopped showing them and `/usage` and the footer Σ
 * kept counting them, which put a session total on screen for turns the reader
 * had just been told were not on this branch. Omitted, the fold follows the
 * newest message's ancestry, the same fallback an offline read of the transcript
 * takes; a ledger with no branch in it folds whole either way.
 */
export function reseedSessionUsageFromLedger(
	sink: SessionUsageSink,
	entries: ReadonlyArray<SessionEntry>,
	defaults: SessionUsageDefaults = {},
	activeLeafTurnId?: string | null,
): void {
	sink.resetSession(defaults.sessionId);
	const scoped = filterEntriesToActivePath(entries, activeLeafTurnId ?? undefined);
	for (const call of ledgerUsageCalls(scoped, defaults)) {
		const responseModelIdObservationCounts = emptyResponseModelIdObservationCounts();
		addResponseModelIdObservationCount(
			responseModelIdObservationCounts,
			call.responseModelIdObservation,
			call.apiCalls ?? 1,
		);
		sink.recordTokens(
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
		);
	}
}
