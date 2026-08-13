/**
 * Rebuild the running usage totals from a session's own ledger.
 *
 * The `/cost` overlay and the footer both render one process-lifetime
 * accumulator, and only `startNewSession` ever reset it. Resuming did not, so a
 * resumed session showed the *previous* session's numbers under the resumed
 * session's id: one process, two sessions, byte-identical totals relabelled.
 * That is misattribution rather than an undercount, and a process that resumed
 * and sent nothing reported zero for a session holding tens of thousands of
 * tokens on disk.
 *
 * The fold itself is `ledgerUsageCalls` in the session domain, which owns the
 * ledger and serves `clio usage report` from the same function. This module is
 * only the sink wiring between that fold and the observability projection.
 */

import { ledgerUsageCalls, type SessionEntry, type SessionUsageDefaults } from "../domains/session/index.js";

/** The slice of ObservabilityContract a reseed needs. */
export interface SessionUsageSink {
	resetSession(): void;
	recordTokens(
		providerId: string,
		modelId: string,
		tokens: number,
		costUsd?: number,
		breakdown?: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			reasoningTokens: number;
			totalTokens: number;
			apiCalls?: number;
		},
		costProvenance?: never,
	): void;
}

/**
 * Clear the running totals and replay the supplied session's recorded calls
 * into them. Safe to call with an empty ledger: the totals reset to zero, which
 * is the honest answer for a session that has spent nothing.
 */
export function reseedSessionUsageFromLedger(
	sink: SessionUsageSink,
	entries: ReadonlyArray<SessionEntry>,
	defaults: SessionUsageDefaults = {},
): void {
	sink.resetSession();
	for (const call of ledgerUsageCalls(entries, defaults)) {
		sink.recordTokens(call.providerId, call.modelId, call.totalTokens, call.costUsd, {
			input: call.input,
			output: call.output,
			cacheRead: call.cacheRead,
			cacheWrite: call.cacheWrite,
			reasoningTokens: call.reasoningTokens,
			totalTokens: call.totalTokens,
			apiCalls: 1,
		});
	}
}
