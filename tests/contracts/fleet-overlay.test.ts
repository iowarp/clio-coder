import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { DispatchSnapshot } from "../../src/domains/dispatch/contract.js";
import { formatFleetOverlayBodyLines } from "../../src/interactive/fleet-overlay.js";
import { parseSlashCommand } from "../../src/interactive/slash-commands.js";

function snapshot(overrides: Partial<DispatchSnapshot> = {}): DispatchSnapshot {
	return {
		generatedAt: "2026-06-10T00:00:00.000Z",
		running: [],
		retrying: [],
		totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
		...overrides,
	};
}

describe("fleet overlay", () => {
	it("renders running rows, retry rows, and totals from a dispatch snapshot", () => {
		const lines = formatFleetOverlayBodyLines(
			snapshot({
				running: [
					{
						runId: "run-abcdef123456",
						agentId: "coder",
						runtimeKind: "http",
						outcomePhase: "running",
						heartbeat: "alive",
						lineage: { parentRunId: null, rootRunId: "run-abcdef123456", attempt: 0, depth: 0 },
						startedAt: "2026-06-10T00:00:00.000Z",
						elapsedMs: 12_000,
						tokens: { input: 100, output: 42, total: 142 },
						costUsd: 0.0012,
					},
				],
				retrying: [
					{
						runId: "run-retry123456",
						agentId: "verifier",
						attempt: 1,
						dueAt: "2026-06-10T00:00:05.000Z",
						reason: "stalled: no worker activity",
					},
				],
				totals: { inputTokens: 100, outputTokens: 42, totalTokens: 142, costUsd: 0.0012, runtimeSeconds: 12 },
			}),
		);

		const body = lines.join("\n");
		ok(body.includes("running (1)"));
		ok(body.includes("retrying (1)"));
		ok(body.includes("coder"));
		ok(body.includes("verifier"));
		ok(body.includes("total=142"));
		ok(body.includes("cost=$0.0012"));
	});

	it("states the cross-process limitation when no in-process rows exist", () => {
		const body = formatFleetOverlayBodyLines(snapshot()).join("\n");
		ok(body.includes("running (0)"));
		ok(body.includes("retrying (0)"));
		ok(body.includes("Cross-process live retry state is not attached to the TUI"));
	});

	it("parses /fleet as the fleet overlay command", () => {
		strictEqual(parseSlashCommand("/fleet").kind, "fleet");
	});
});
