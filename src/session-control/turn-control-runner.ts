import type { ClioSettings } from "../core/config.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { dispatchOwnerOf, dispatchOwnership } from "../domains/dispatch/ownership.js";
import type { TurnControlRecord, TurnFacts } from "../domains/turn-control/index.js";
import { decide, decisionHash, factsDigest, renderCollectedBlock } from "../domains/turn-control/index.js";
import type { MonitorToolDeps } from "../tools/monitor.js";
import { collectDetachedBatch } from "../tools/monitor-collect.js";
import type { ToolInvokeOptions } from "../tools/registry.js";

export interface TurnControlInput {
	userTurnId: string;
	signal: AbortSignal;
}
export interface TurnControlRunner {
	run(input: TurnControlInput): Promise<{ block: string | null; record: TurnControlRecord }>;
}
export interface TurnControlRunnerDeps {
	getSettings(): Readonly<ClioSettings>;
	dispatch: DispatchContract | undefined;
	getInvokeOptions?: () => ToolInvokeOptions;
	monitorDeps?: MonitorToolDeps;
	getTurnConstraints(): TurnConstraints | undefined;
	finishedDetachedBatchIds(): ReadonlyArray<string>;
	emitNotice(text: string): void;
}

/** Collect detached batches that finished between turns. It is the one thing the harness does before an answer. */
export function createTurnControlRunner(deps: TurnControlRunnerDeps): TurnControlRunner {
	return {
		async run(input) {
			const started = performance.now();
			const facts: TurnFacts = {
				explicitConstraints: deps.getTurnConstraints() !== undefined,
				finishedDetachedBatchIds: deps.finishedDetachedBatchIds(),
			};
			const decision = decide(facts, deps.getSettings().turnControl);
			const record: TurnControlRecord = {
				version: 1,
				turnId: input.userTurnId,
				factsDigest: factsDigest(facts),
				decision,
				decisionHash: decisionHash(decision),
				executed: null,
			};
			if (input.signal.aborted) return { block: null, record: { ...record, executed: { refused: "canceled" } } };
			if (decision.kind !== "collect") return { block: null, record };
			try {
				const monitorDeps = deps.monitorDeps ?? (deps.dispatch ? { dispatch: deps.dispatch } : null);
				if (monitorDeps === null) throw new Error("detached collection is unavailable");
				const ownership = dispatchOwnership(dispatchOwnerOf(monitorDeps.dispatch, deps.getInvokeOptions?.().sessionId));
				const rendered: string[] = [];
				const runIds: string[] = [];
				let collectedCount = 0;
				const failures: string[] = [];
				for (const batchId of decision.batchIds) {
					if (input.signal.aborted) throw new Error("canceled");
					try {
						const outcome = await collectDetachedBatch(monitorDeps, batchId, ownership);
						if (outcome.kind !== "ok") throw new Error(outcome.message);
						if (outcome.details?.complete !== true || outcome.details.collected !== true)
							throw new Error(`batch ${batchId} is not durably collected`);
						rendered.push(outcome.output);
						collectedCount += 1;
						if (Array.isArray(outcome.details.runs))
							for (const run of outcome.details.runs) {
								if (run !== null && typeof run === "object" && typeof run.runId === "string") runIds.push(run.runId);
							}
					} catch (error) {
						// S9: a later failure must not discard results from an already marked batch.
						failures.push(`batch ${batchId}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				if (input.signal.aborted) throw new Error("canceled");
				if (collectedCount === 0) throw new Error(failures.join("; "));
				const block = renderCollectedBlock(
					[...rendered, ...failures.map((failure) => `Collection unavailable for ${failure}`)].join("\n\n"),
				);
				deps.emitNotice(`[Collected] ${collectedCount} batch(es)`);
				return {
					block,
					record: { ...record, executed: { runIds, blockChars: block.length, durationMs: performance.now() - started } },
				};
			} catch (error) {
				const message = input.signal.aborted ? "canceled" : error instanceof Error ? error.message : String(error);
				if (!input.signal.aborted) deps.emitNotice(`[Collected] unavailable: ${message}`);
				return { block: null, record: { ...record, executed: { refused: message } } };
			}
		},
	};
}
