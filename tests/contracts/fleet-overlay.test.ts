import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { DispatchSnapshot } from "../../src/domains/dispatch/contract.js";
import { formatFleetOverlayBodyLines } from "../../src/interactive/fleet-overlay.js";
import { parseSlashCommand } from "../../src/interactive/slash-commands.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const theme = clioTheme();

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
	it("renders running rows, retry rows, and kv totals from a dispatch snapshot", () => {
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

		const body = strip(lines.join("\n"));
		// Section headers now use the list-group recipe.
		ok(body.includes("── running (1)"));
		ok(body.includes("── retrying (1)"));
		ok(body.includes("── totals"));
		ok(body.includes("coder"));
		ok(body.includes("verifier"));
		// Totals render as key-value rows, not a packed `key=value` line.
		ok(/total\s+142/.test(body), `totals should read as a kv row, got: ${body}`);
		ok(/cost\s+\$0\.0012/.test(body), `cost should read as a kv row, got: ${body}`);
		ok(!body.includes("total=142"), "the packed totals line is gone");
	});

	it("renders the generated timestamp as a local clock, never a raw ISO string", () => {
		const body = strip(formatFleetOverlayBodyLines(snapshot()).join("\n"));
		ok(/generated \d{2}:\d{2}:\d{2}\b/.test(body), `generated line should carry a clock, got: ${body}`);
		ok(!body.includes("2026-06-10T00:00:00.000Z"), "the raw ISO string must not survive");
	});

	it("tokens status-ish cells: stale is a warning and failed is an error", () => {
		const lines = formatFleetOverlayBodyLines(
			snapshot({
				running: [
					{
						runId: "run-stale00001",
						agentId: "coder",
						runtimeKind: "http",
						outcomePhase: "failed",
						heartbeat: "stale",
						lineage: { parentRunId: null, rootRunId: "run-stale00001", attempt: 1, depth: 0 },
						startedAt: "2026-06-10T00:00:00.000Z",
						elapsedMs: 4_000,
						tokens: { input: 10, output: 5, total: 15 },
						costUsd: 0,
					},
				],
			}),
		);
		const body = lines.join("\n");
		ok(body.includes(theme.fgSequence("warning")), "a stale heartbeat should paint the warning token");
		ok(body.includes(theme.fgSequence("error")), "a failed phase should paint the error token");
	});

	it("renders costs at or above a cent with two decimals via the shared formatter", () => {
		const body = strip(
			formatFleetOverlayBodyLines(
				snapshot({
					totals: { inputTokens: 100, outputTokens: 42, totalTokens: 142, costUsd: 0.42, runtimeSeconds: 12 },
				}),
			).join("\n"),
		);
		ok(/cost\s+\$0\.42\b/.test(body), `cost should read cents, got: ${body}`);
		ok(!body.includes("$0.4200"), "the shared formatter drops the four-decimal fleet form");
	});

	it("states the cross-process limitation when no in-process rows exist", () => {
		const body = strip(formatFleetOverlayBodyLines(snapshot()).join("\n"));
		ok(body.includes("── running (0)"));
		ok(body.includes("── retrying (0)"));
		ok(body.includes("Cross-process live retry state is not attached to the TUI"));
	});

	it("parses /fleet as the fleet overlay command", () => {
		strictEqual(parseSlashCommand("/fleet").kind, "fleet");
	});
});
