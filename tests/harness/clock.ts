/**
 * A frozen, steppable clock for tests.
 *
 * Three separate commits fixed three instances of the same wall-clock race by
 * hand, each adding its own `now: () => 1000`. This is the shared seam: pass
 * `clock.now` wherever a factory takes an injectable clock, and step it
 * explicitly when the test needs time to pass. No fake timers, no patching of
 * globals; `setTimeout` and `performance.now()` are untouched.
 */

/** A readable, obviously synthetic instant. Nothing depends on the exact value. */
export const TEST_CLOCK_START_MS = Date.parse("2026-01-01T00:00:00.000Z");

export interface TestClock {
	/** Bound, so it can be passed straight through as an injected `now`. */
	now: () => number;
	/** Jump to an absolute epoch-millis instant. */
	set(ms: number): void;
	/** Step forward (or back, with a negative) and return the new instant. */
	advance(ms: number): number;
}

export function createTestClock(start: Date | number | string = TEST_CLOCK_START_MS): TestClock {
	let current = typeof start === "number" ? start : new Date(start).getTime();
	return {
		now: () => current,
		set(ms) {
			current = ms;
		},
		advance(ms) {
			current += ms;
			return current;
		},
	};
}

/**
 * Runs under a pinned zone, so an assertion about what an operator sees does
 * not depend on the runner's TZ. The other half of the same seam: `TestClock`
 * pins *when* a test runs, this pins *where*. Every render surface that turns a
 * stored UTC instant into operator-local text is asserted through it in at
 * least three zones, which is what catches a UTC string rendered as if it were
 * local (issue #46).
 */
export function withTimeZone<T>(zone: string, run: () => T): T {
	const previous = process.env.TZ;
	process.env.TZ = zone;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
}

/**
 * The same, for a surface that formats behind an await. The sync form would
 * restore the zone when the callback returned its promise, i.e. before the
 * formatting ran.
 */
export async function withTimeZoneAsync<T>(zone: string, run: () => Promise<T>): Promise<T> {
	const previous = process.env.TZ;
	process.env.TZ = zone;
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
}
