import assert from "node:assert/strict";
import { test } from "node:test";
import { usageCacheEvidence } from "../client/pages/usage-insights-model.js";
import type { UsageReport } from "../contracts/reports.js";

const report = (facts: UsageReport["facts"]): UsageReport => ({
	schema: "experimental",
	workspaceId: "0".repeat(32),
	windowDays: 30,
	from: "2026-10-01",
	to: "2026-10-30",
	facts,
	opportunities: [],
});

const quantity = (display: string, measured: number, unknownCount = 0) => ({
	fact: {
		measured,
		estimated: 0,
		unknownCount,
		absentCount: 0,
		coverage: { measured: 1, estimated: 0, unknown: unknownCount },
	},
	display,
	ref: "repo:all-30d#calls",
});

test("prompt-cache evidence reads each session's cache report displays", () => {
	const cache = usageCacheEvidence(
		report([
			{
				name: "telemetry-cache",
				values: {
					sessionId: "s1",
					report: {
						kind: "cache",
						sessionId: "s1",
						verdicts: { hot: 4, partial: 1, cold: 1, small: 0, unknown: 0 },
						uncachedPrefill: quantity("1,200", 1200),
						rePrefilled: quantity("~800", 800),
						breaks: [{}, {}],
					},
				},
			},
		]),
	);
	assert.deepEqual(cache.rows, [
		{
			key: "s1",
			session: "s1",
			uncached: "1,200",
			reprocessed: "~800",
			breaks: "2",
			verdicts: "hot: 4 · partial: 1 · cold: 1 · small: 0 · unknown: 0",
		},
	]);
});
