/**
 * The `fleet view --watch` surface: the selection-file reader and the pure
 * watch renderer the workers-view pane paints. Both are pure, so the test
 * asserts the strings an operator reads without a PTY.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type RunViewModel, readWatchSelection, renderWatchView } from "../../src/cli/fleet-view.js";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function selectionFile(content?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "clio-fleet-watch-"));
	dirs.push(dir);
	const path = join(dir, "watch-selection");
	if (content !== undefined) writeFileSync(path, content, "utf8");
	return path;
}

describe("fleet view --watch selection reader", () => {
	it("reads the first line as the run id and tolerates every degenerate state", () => {
		strictEqual(readWatchSelection(selectionFile("run-abc123\n")), "run-abc123");
		strictEqual(readWatchSelection(selectionFile("run-abc123\ntrailing garbage\n")), "run-abc123");
		strictEqual(readWatchSelection(selectionFile("  run-abc123  \n")), "run-abc123");
		// Missing, empty, and absurd content all read as "no selection".
		strictEqual(readWatchSelection(join(tmpdir(), "does-not-exist-anywhere")), null);
		strictEqual(readWatchSelection(selectionFile("")), null);
		strictEqual(readWatchSelection(selectionFile("\n")), null);
		strictEqual(readWatchSelection(selectionFile(`${"x".repeat(4096)}\n`)), null);
	});
});

describe("fleet view --watch renderer", () => {
	it("names the workers view when nothing is selected yet", () => {
		const lines = renderWatchView(null, null).join("\n");
		match(lines, /no worker selected/);
		match(lines, /Alt\+W/);
	});

	it("holds a placeholder for a selected run the ledger has not seen", () => {
		const lines = renderWatchView("run-queued", null).join("\n");
		match(lines, /run run-queued is not in the run ledger yet/);
		match(lines, /appears here the moment it starts/);
	});

	it("renders the selected run through the same pure run view as --follow", () => {
		const model: RunViewModel = {
			runId: "run-1",
			agentId: "tester",
			model: "qwen3-coder",
			target: "t1",
			node: "local",
			phase: "running",
			startedAt: "2026-08-31T10:00:00.000Z",
			elapsedMs: 65_000,
			task: "run the suite",
			transcript: [{ at: "2026-08-31T10:00:01.000Z", label: "run opened (tester)", detail: undefined }],
			transcriptTruncated: false,
			journalPresent: true,
			journalPath: "/state/runs/run-1/events.ndjson",
			evidence: "receipt pending; the run has not finalized",
			receiptPath: null,
			outcome: null,
			outcomeDetail: null,
			terminal: false,
		};
		const lines = renderWatchView("run-1", model, 100);
		ok(lines[0]?.startsWith("run run-1"), lines[0]);
		deepStrictEqual(
			lines.filter((line) => line.includes("outcome")).length,
			1,
			"the watch surface is the run view, not a summary of it",
		);
	});
});
