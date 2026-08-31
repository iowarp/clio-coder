/**
 * Watchdog budgets, scaled to the load the run actually carries.
 *
 * Most timeouts in this suite are not claims about speed. `runCli`'s 15s, a
 * `waitFor` helper's 8s, a PTY driver's 30s: each one exists to turn a hang
 * into a failure with a stack instead of a suite that never returns. Nothing
 * asserts the budget was nearly used, so the number only has to be larger than
 * the slowest honest completion.
 *
 * `npm test` runs 24 lanes at once on a 24-core box, so "the slowest honest
 * completion" is a different number under `npm test` than under
 * `npm run test:file`. A CLI that boots in 50-70ms unloaded has been measured
 * taking the full 15s budget in a lane while 23 siblings compete for the same
 * cores. Every one of those timeouts was chosen against the unloaded figure,
 * which is why they fail intermittently and never reproduce alone.
 *
 * The fix is to make the budget a function of the contention rather than a
 * constant: `scaleWatchdog` multiplies by how many lanes the runner spawned.
 * A test that runs alone keeps its original number exactly, so nothing about a
 * single-file debugging run changes. A hang still fails, just later.
 *
 * This is only for watchdogs. A budget a test asserts against, "the batch beat
 * serial", "SIGKILL followed the 2s grace", "the park was not charged", is a
 * measurement and must not be scaled: scaling it would weaken the claim rather
 * than protect it. Those files belong in the runner's serial lane, where they
 * are measured on a quiet box.
 */

/** Lanes `scripts/shard-tests.mjs` spawned for this run; 1 when nothing set it. */
export function testLaneCount(): number {
	const parsed = Number.parseInt(process.env.CLIO_TEST_CONCURRENCY ?? "", 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * One step of headroom per this many lanes. Three is what the ceiling below
 * needs to be reachable at this host's 24 lanes; the CLI-spawn timeouts held
 * at every lane count up to about six and started failing above it, so the
 * first step lands where the failures start.
 */
const LANES_PER_STEP = 3;

/**
 * Ceiling on the multiplier. Without one, a 128-lane box would turn a 30s PTY
 * watchdog into an hour of waiting for a genuine hang before the suite reports
 * it.
 *
 * Eight rather than a rounder number, from measurement.
 * `dispatch-background-control`'s conversion case runs in 0.75-1.2s alone and
 * has been observed at 34s and 62s inside a 24-lane run on this host, which
 * does durable-store work under a file lock and so amplifies far past the
 * linear cost of the contention. Its budget is 8s, so covering the 62s
 * observation needs a factor of 8. A smaller ceiling was tried at 4 and left
 * that case failing.
 *
 * The cost is honest and worth stating: at 8, a genuinely hung `runCli` takes
 * two minutes to report instead of fifteen seconds. That is still an order of
 * magnitude below what a suite that never returns costs, and it only applies
 * to a run that is actually sharded.
 */
const MAX_FACTOR = 8;

/** The multiplier `scaleWatchdog` applies; 1 when the file runs on its own. */
export function watchdogFactor(): number {
	return Math.min(MAX_FACTOR, Math.max(1, Math.ceil(testLaneCount() / LANES_PER_STEP)));
}

/** A watchdog budget of `ms`, widened by the shard load this process runs under. */
export function scaleWatchdog(ms: number): number {
	return Math.round(ms * watchdogFactor());
}
