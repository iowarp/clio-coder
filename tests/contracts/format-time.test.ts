import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { clockLocal, dateLocal, relative } from "../../src/interactive/format-time.js";

/** Runs under a pinned zone so an assertion does not depend on the runner's TZ. */
function withTimeZone<T>(zone: string, run: () => T): T {
	const previous = process.env.TZ;
	process.env.TZ = zone;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
}

/** 21:30 on the 14th in Chicago, 08:00 on the 15th in Kolkata: the date differs too. */
const INSTANT = "2026-08-15T02:30:00.000Z";

describe("format-time", () => {
	it("renders the clock in the operator's zone, not UTC", () => {
		strictEqual(
			withTimeZone("America/Chicago", () => clockLocal(INSTANT)),
			"21:30:00",
		);
		strictEqual(
			withTimeZone("Asia/Kolkata", () => clockLocal(INSTANT)),
			"08:00:00",
		);
		strictEqual(
			withTimeZone("UTC", () => clockLocal(INSTANT)),
			"02:30:00",
		);
	});

	it("renders the calendar date in the operator's zone, off-by-one included", () => {
		strictEqual(
			withTimeZone("America/Chicago", () => dateLocal(INSTANT)),
			"2026-08-14",
		);
		strictEqual(
			withTimeZone("Asia/Kolkata", () => dateLocal(INSTANT)),
			"2026-08-15",
		);
		strictEqual(
			withTimeZone("UTC", () => dateLocal(INSTANT)),
			"2026-08-15",
		);
	});

	it("accepts an ISO string, epoch millis, or a Date interchangeably", () => {
		withTimeZone("UTC", () => {
			const millis = Date.parse(INSTANT);
			strictEqual(clockLocal(millis), "02:30:00");
			strictEqual(clockLocal(new Date(millis)), "02:30:00");
			strictEqual(dateLocal(millis), "2026-08-15");
			strictEqual(dateLocal(new Date(millis)), "2026-08-15");
		});
	});

	it("returns the missing marker rather than 'Invalid Date'", () => {
		strictEqual(clockLocal("not a timestamp"), "—");
		strictEqual(dateLocal(Number.NaN), "—");
		strictEqual(relative(new Date(Number.NaN)), "—");
	});

	it("walks the relative ladder and keeps the week branch both copies had diverged on", () => {
		const now = Date.parse(INSTANT);
		const ago = (ms: number): string => relative(now - ms, now);
		strictEqual(ago(0), "just now");
		strictEqual(ago(4_000), "just now");
		strictEqual(ago(-60_000), "just now");
		strictEqual(ago(30_000), "30s ago");
		strictEqual(ago(3 * 60_000), "3m ago");
		strictEqual(ago(5 * 3_600_000), "5h ago");
		strictEqual(ago(30 * 3_600_000), "yesterday");
		strictEqual(ago(3 * 86_400_000), "3d ago");
		strictEqual(ago(10 * 86_400_000), "1w ago");
	});

	it("falls back past 30 days to the local date, not the UTC one", () => {
		const now = Date.parse(INSTANT);
		const old = now - 40 * 86_400_000;
		strictEqual(
			withTimeZone("America/Chicago", () => relative(old, now)),
			"2026-07-05",
		);
		strictEqual(
			withTimeZone("UTC", () => relative(old, now)),
			"2026-07-06",
		);
	});
});
