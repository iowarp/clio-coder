/**
 * Accounting for one proactive-memory step.
 *
 * A background memory step is a priced model call that never enters the
 * session: it appends nothing to the session JSONL, exactly as a `/btw` side
 * question does not. Until this existed the spend was recorded nowhere at all.
 * The operator's own telemetry ledger held 60 model steps, 137,205 tokens, and
 * 1,666 seconds of model time across 14 days while `/cost` showed no row for
 * any of it and `clio-coder usage report` could not see it either (#229).
 *
 * The two writes are the same pair the side-question path makes: the
 * in-process cost tracker under the `background-memory` label, which is what
 * `/cost` folds, and one durable row in the out-of-turn usage store, which is
 * what an archive reader folds after the process is gone.
 */

import { uncachedPrefillTokens } from "../../core/cache-telemetry.js";
import type { CostProvenance } from "../providers/index.js";
import type { CostEntryLabel, UsageBreakdown } from "./cost.js";
import { appendOutOfTurnUsageRow, type OutOfTurnUsageRow } from "./out-of-turn-usage.js";

/** Provider-reported spend for one memory step, as the calling client observed it. */
export interface BackgroundMemoryStepUsage {
	targetId: string;
	attributedModelId: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	costUsd: number;
	costProvenance: CostProvenance;
	durationMs: number;
	backend: {
		promptTokens: number;
		cachedTokens: number | null;
		promptMs: number;
		source: string;
	} | null;
}

/** The subset of the observability contract this accounting needs. */
export interface BackgroundMemoryUsageSink {
	recordTokens(
		providerId: string,
		attributedModelId: string,
		tokens: number,
		costUsd?: number,
		breakdown?: Partial<UsageBreakdown>,
		costProvenance?: CostProvenance,
		modelIdFacts?: unknown,
		label?: CostEntryLabel,
	): void;
}

export interface RecordBackgroundMemoryStepInput {
	usage: BackgroundMemoryStepUsage;
	stateDir: string;
	sessionId: string | null;
	/** The cwd hash the session ledger is filed under, so `usage report --repo` selects it. */
	repoIdentity: string | null;
	observability?: BackgroundMemoryUsageSink | undefined;
	now?: Date;
	/** Test seam; production appends to the out-of-turn store under the state dir. */
	appendRow?: (stateDir: string, row: OutOfTurnUsageRow) => void;
}

/** Build the durable row for one memory step without writing it. */
export function backgroundMemoryUsageRow(
	usage: BackgroundMemoryStepUsage,
	options: { sessionId: string | null; repoIdentity: string | null; now?: Date },
): OutOfTurnUsageRow {
	return {
		label: "background-memory",
		sessionId: options.sessionId,
		repoIdentity: options.repoIdentity,
		timestamp: (options.now ?? new Date()).toISOString(),
		target: usage.targetId,
		attributedModelId: usage.attributedModelId,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			reasoning: usage.reasoning,
			totalTokens: usage.totalTokens,
			costUsd: usage.costUsd,
			costProvenance: usage.costProvenance,
		},
		timing: { durationMs: usage.durationMs },
		...(usage.backend === null
			? {}
			: {
					promptCache: {
						promptTokens: usage.backend.promptTokens,
						cachedTokens: usage.backend.cachedTokens,
						uncachedPrefillTokens: uncachedPrefillTokens({
							promptTokens: usage.backend.promptTokens,
							cachedTokens: usage.backend.cachedTokens,
							predictedTokens: 0,
							promptMs: usage.backend.promptMs,
							predictedMs: 0,
							source: "llamacpp-timings",
						}),
						promptMs: usage.backend.promptMs,
						source: usage.backend.source,
					},
				}),
	};
}

/** Record one memory step in the session's cost totals and in the durable store. */
export function recordBackgroundMemoryStep(input: RecordBackgroundMemoryStepInput): OutOfTurnUsageRow {
	input.observability?.recordTokens(
		input.usage.targetId,
		input.usage.attributedModelId,
		input.usage.totalTokens,
		input.usage.costUsd,
		{
			input: input.usage.input,
			output: input.usage.output,
			cacheRead: input.usage.cacheRead,
			cacheWrite: input.usage.cacheWrite,
			reasoningTokens: input.usage.reasoning,
			totalTokens: input.usage.totalTokens,
			apiCalls: 1,
		},
		input.usage.costProvenance,
		undefined,
		"background-memory",
	);
	const row = backgroundMemoryUsageRow(input.usage, {
		sessionId: input.sessionId,
		repoIdentity: input.repoIdentity,
		...(input.now === undefined ? {} : { now: input.now }),
	});
	(input.appendRow ?? appendOutOfTurnUsageRow)(input.stateDir, row);
	return row;
}
