/**
 * Fold a `clio fleet run --json` summary off a runner's stdout.
 *
 * A bounded loop's whole subject is what the machinery did across attempts, and
 * that is reported on one line at the end of the run. Folding it live rather
 * than reading the stored artifact is what makes the reading trustworthy: the
 * operator-facing stdout keeps only a bounded head and tail, and a run that
 * spent every attempt is exactly the run whose middle does not survive.
 *
 * Absence is never zero here either. A stream that carried no summary, or more
 * than one, measured nothing about a loop and emits no metrics at all, so a
 * threshold on them fails closed instead of reading silence as a bound
 * respected.
 */

export interface EvalFleetLoopSummary {
	/** Verifications that ran. The declared bound is spent when this reaches `maxAttempts`. */
	attempts: number;
	/** Agent repairs that ran. Each is attempt `n` and therefore an execution role of `recovery`. */
	repairs: number;
	/** Whether the loop converged. Diagnostic: a bound spent without a pass is a correct machinery result. */
	resolved: boolean;
	/** The loop's terminal reason, e.g. `resolved` or `loop_bound_exhausted`. */
	reason: string;
	/** Nodes a resolved loop made unnecessary. Declared, never run, and never failures. */
	unneeded: number;
	/** Nodes the scheduler refused to run because something upstream broke. */
	skipped: number;
}

export interface EvalFleetLoopObservation {
	summaryCount: number;
	/** Loops named by the one summary. Several loops in one contract sum into the metrics below. */
	loops: ReadonlyArray<EvalFleetLoopSummary>;
}

export interface EvalFleetLoopFold {
	/** Feed a raw stdout chunk; partial trailing lines are held until completed. */
	push(chunk: string): void;
	observation(): EvalFleetLoopObservation;
}

export const EMPTY_FLEET_LOOP_OBSERVATION: EvalFleetLoopObservation = { summaryCount: 0, loops: [] };

export function createFleetLoopFold(): EvalFleetLoopFold {
	let summaryCount = 0;
	let loops: EvalFleetLoopSummary[] = [];
	let pending = "";

	const consume = (line: string): void => {
		if (line.trim().length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			return;
		}
		if (!isRecord(parsed) || typeof parsed.fleet !== "string" || !Array.isArray(parsed.loops)) return;
		summaryCount += 1;
		const unneeded = Array.isArray(parsed.unneeded) ? parsed.unneeded.length : 0;
		const skipped = Array.isArray(parsed.skipped) ? parsed.skipped.length : 0;
		loops = parsed.loops.flatMap((entry) => {
			const loop = parseLoop(entry, unneeded, skipped);
			return loop === null ? [] : [loop];
		});
	};

	return {
		push(chunk: string): void {
			pending += chunk;
			for (;;) {
				const newline = pending.indexOf("\n");
				if (newline === -1) break;
				consume(pending.slice(0, newline).replace(/\r$/u, ""));
				pending = pending.slice(newline + 1);
			}
		},
		observation(): EvalFleetLoopObservation {
			if (pending.length > 0) {
				consume(pending.replace(/\r$/u, ""));
				pending = "";
			}
			return { summaryCount, loops: loops.map((loop) => ({ ...loop })) };
		},
	};
}

export function addFleetLoopObservations(
	left: EvalFleetLoopObservation,
	right: EvalFleetLoopObservation,
): EvalFleetLoopObservation {
	const summaryCount = left.summaryCount + right.summaryCount;
	return { summaryCount, loops: summaryCount === 1 ? [...left.loops, ...right.loops] : [] };
}

/**
 * Metrics for a bounded loop's own promises.
 *
 * - `loop.attemptsSpent`: verifications that ran. The declared bound is the
 *   ceiling, and exceeding it is the failure this catches.
 * - `loop.repairsSpent`: repairs that ran. A loop spends one fewer repair than
 *   verifications, because the last verification has nothing after it.
 * - `loop.resolved`: whether the loop converged. This is the model's result and
 *   is measured, never gated: a bound spent without a pass is correct
 *   machinery.
 * - `loop.reasonExhausted`: the terminal report was `loop_bound_exhausted`
 *   rather than a false green. A loop that ran out of attempts and reported
 *   success would be the worst failure here.
 * - `loop.unneededNodes` / `loop.skippedNodes`: after a loop resolves its later
 *   nodes are `unneeded`, never `skipped` and never failed. Counting them
 *   apart is how "the loop answered it" stays distinguishable from "something
 *   upstream broke".
 *
 * Emitted only for exactly one summary carrying at least one loop. Anything
 * else observed nothing about a loop.
 */
export function fleetLoopMetricEntries(observation: EvalFleetLoopObservation): Record<string, number | boolean> {
	if (observation.summaryCount !== 1 || observation.loops.length === 0) return {};
	const loops = observation.loops;
	return {
		"loop.count": loops.length,
		"loop.attemptsSpent": sum(loops.map((loop) => loop.attempts)),
		"loop.repairsSpent": sum(loops.map((loop) => loop.repairs)),
		"loop.resolved": loops.every((loop) => loop.resolved),
		"loop.reasonExhausted": loops.every((loop) => loop.resolved || loop.reason === "loop_bound_exhausted"),
		"loop.unneededNodes": loops[0]?.unneeded ?? 0,
		"loop.skippedNodes": loops[0]?.skipped ?? 0,
	};
}

/**
 * Whether the receipts this item sealed agree with the repairs its loops spent.
 *
 * A repair is an attempt, every attempt after the first is `recovery`, and each
 * one seals its own receipt. A loop that reported two repairs beside one
 * recovery receipt either lost a receipt or ran an attempt it did not report,
 * and both are the bound not meaning what it says.
 *
 * Absent when either side is unmeasured, so the check fails closed rather than
 * comparing a number against a silence.
 */
export function fleetLoopReceiptAgreement(
	loopMetrics: Record<string, number | boolean>,
	journalMetrics: Record<string, number | boolean>,
): Record<string, boolean> {
	const repairs = loopMetrics["loop.repairsSpent"];
	const recoveries = journalMetrics["receipt.recoveryCount"];
	if (typeof repairs !== "number" || typeof recoveries !== "number") return {};
	return { "loop.receiptsMatchRepairs": repairs === recoveries };
}

function parseLoop(entry: unknown, unneeded: number, skipped: number): EvalFleetLoopSummary | null {
	if (!isRecord(entry)) return null;
	const { attempts, repairs, resolved, reason } = entry;
	if (!isFiniteInteger(attempts) || attempts < 0) return null;
	if (!isFiniteInteger(repairs) || repairs < 0) return null;
	if (typeof resolved !== "boolean" || typeof reason !== "string" || reason.length === 0) return null;
	return { attempts, repairs, resolved, reason, unneeded, skipped };
}

function sum(values: ReadonlyArray<number>): number {
	return values.reduce((total, value) => total + value, 0);
}

function isFiniteInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
