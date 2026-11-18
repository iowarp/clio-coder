import type { Fact } from "../core/telemetry/fact.js";
import { sumFacts } from "../core/telemetry/pricing.js";
import type { RunSettled } from "../core/telemetry/schemas.js";
import { clioStateDir } from "../core/xdg.js";
import type { DispatchContract } from "../domains/dispatch/index.js";
import type { SessionContract } from "../domains/session/contract.js";
import { readSettledRun } from "../domains/telemetry/run-record.js";
import type { TurnTokens } from "../domains/turn-control/index.js";

type ReceiptDispatch = Pick<DispatchContract, "getRun">;

const WORKER_RECEIPT_SEAL_WAIT_MS = 2000;
const WORKER_RECEIPT_SEAL_POLL_MS = 25;
/** How long the detached watcher keeps looking for a receipt the settle wait gave up on. */
const WORKER_RECEIPT_LATE_WATCH_MS = 30_000;
const WORKER_RECEIPT_LATE_POLL_MS = 250;
/** Session ledger entry that amends a cancelled turn's outcome with worker tokens that sealed after it. */
const TURN_OUTCOME_TOKENS_CUSTOM_TYPE = "turnOutcomeTokens";

export function noOutcomeUsage(): TurnTokens {
	return { input: sumFacts([]), output: sumFacts([]), cacheRead: sumFacts([]), total: sumFacts([]) };
}

/** A worker run's settled record once its journal holds run.settled; null while it has not settled (#434). */
function readWorkerSettlement(
	runId: string,
	dispatch: ReceiptDispatch | undefined,
): Pick<RunSettled, "usage" | "totalTokens"> | null {
	try {
		if (!dispatch?.getRun(runId)) return null;
		return readSettledRun(clioStateDir(), runId)?.settled ?? null;
	} catch {
		// A run that has not settled yet reads as absent; the caller marks it partial.
		return null;
	}
}

/**
 * Follows receipts the settle wait gave up on. Detached and unref'd: it must not
 * hold the process open, and a process that exits first loses the amend, which
 * is only a better count of tokens the outcome already reported as partial.
 * `onDone` runs once: with the elapsed milliseconds when every watched run has
 * sealed, or null when the cap passed first, and the runs still open stay
 * partial. Returns a stop function for dispose.
 */
function watchLateWorkerRunResults(input: {
	missing: ReadonlyArray<string>;
	dispatch: ReceiptDispatch | undefined;
	onDone: (sealedAfterMs: number | null) => void;
}): () => void {
	const pending = new Set(input.missing);
	const started = performance.now();
	const timer = setInterval(() => {
		for (const runId of [...pending]) if (readWorkerSettlement(runId, input.dispatch) !== null) pending.delete(runId);
		const elapsed = performance.now() - started;
		if (pending.size > 0 && elapsed < WORKER_RECEIPT_LATE_WATCH_MS) return;
		clearInterval(timer);
		try {
			input.onDone(pending.size === 0 ? Math.round(elapsed) : null);
		} catch {
			// Measurement must not surface as an error from a timer.
		}
	}, WORKER_RECEIPT_LATE_POLL_MS);
	timer.unref();
	return () => clearInterval(timer);
}

export function createWorkerReceipts(dispatch: ReceiptDispatch | undefined, session: SessionContract | undefined) {
	const watchers = new Set<() => void>();
	/** The workers' tokens, each run one contribution; a run that has not settled counts as unknown, never zero (#434). */
	const usage = (runIds: ReadonlyArray<string>): TurnTokens => {
		const notSettled: Fact<number> = { kind: "unknown", reason: "not-observed" };
		const runs = [...new Set(runIds)].map((runId) => readWorkerSettlement(runId, dispatch));
		const read = (pick: (settled: Pick<RunSettled, "usage" | "totalTokens">) => Fact<number>) =>
			sumFacts(runs.map((settled) => (settled === null ? notSettled : pick(settled))));
		return {
			input: read((settled) => settled.usage.input),
			output: read((settled) => settled.usage.output),
			cacheRead: read((settled) => settled.usage.cacheRead),
			total: read((settled) => settled.totalTokens),
		};
	};
	return {
		/**
		 * A cancelled turn records its outcome as soon as the abort lands, while an
		 * aborted worker seals its receipt a few tens of milliseconds later. The ledger
		 * knows a run from admission, so only runs it knows are worth waiting for; the
		 * wait is bounded. Resolves to the runs still unsealed, whose tokens the outcome
		 * then reports as partial.
		 */
		async awaitSeal(runIds: ReadonlyArray<string>): Promise<string[]> {
			if (!dispatch) return [];
			const pending = new Set(
				runIds.filter((runId) => dispatch.getRun(runId) !== null && readWorkerSettlement(runId, dispatch) === null),
			);
			const deadline = Date.now() + WORKER_RECEIPT_SEAL_WAIT_MS;
			while (pending.size > 0 && Date.now() < deadline) {
				await new Promise<void>((resolve) => setTimeout(resolve, WORKER_RECEIPT_SEAL_POLL_MS));
				for (const runId of [...pending]) if (readWorkerSettlement(runId, dispatch) !== null) pending.delete(runId);
			}
			return [...pending];
		},
		usage,
		/**
		 * A cancelled turn's outcome was written with worker receipts still unsealed. When
		 * they seal, a `turnOutcomeTokens` entry amends the ledger, keyed by turn id. The
		 * entry needs the session that owns the turn, so after /new or /resume nothing is written.
		 */
		amendLate(input: {
			turnId: string;
			parentTurnId: string | null;
			runIds: ReadonlyArray<string>;
			missing: ReadonlyArray<string>;
		}): void {
			if (input.missing.length === 0 || !dispatch) return;
			const sessionId = session?.current()?.id ?? null;
			const stop = watchLateWorkerRunResults({
				missing: input.missing,
				dispatch,
				onDone: (afterMs) => {
					watchers.delete(stop);
					if (afterMs === null) return;
					const workers = usage(input.runIds);
					if (sessionId !== null && session?.current()?.id === sessionId) {
						try {
							session.appendEntry({
								kind: "custom",
								customType: TURN_OUTCOME_TOKENS_CUSTOM_TYPE,
								parentTurnId: input.parentTurnId,
								display: false,
								data: { turnId: input.turnId, workers, sealedAfterMs: afterMs },
							});
						} catch {
							// The ledger closed under the watcher, so the late count is lost with it.
						}
					}
				},
			});
			watchers.add(stop);
		},
		dispose(): void {
			for (const stop of watchers) stop();
			watchers.clear();
		},
	};
}
