/**
 * The `fleet view --watch` surface: the selection-file reader and the pure
 * watch renderer the workers-view pane paints. Both are pure, so the test
 * asserts the strings an operator reads without a PTY.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	it("names the searched ledger and separates queued from wrong-ledger cases", () => {
		const ledgerRoot = "/isolated/state/whose/full/path/must/survive/a/narrow/watch/pane";
		const rendered = renderWatchView("run-queued", null, 40, ledgerRoot);
		const lines = rendered.join("\n");
		ok(rendered.join("").includes(ledgerRoot), rendered.join("\n"));
		match(rendered.join(""), /run run-queued is not in the run ledger under \/isolated\/state/);
		match(lines, /queued, it has not started yet/);
		match(lines, /already started or finished, it was not found in this ledger/);
	});

	it("reads the exact resolved layout passed on argv even when the child environment points elsewhere", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-fleet-watch-layout-"));
		dirs.push(root);
		const layout = {
			config: join(root, "resolved", "config"),
			data: join(root, "resolved", "data"),
			state: join(root, "resolved", "state"),
			cache: join(root, "resolved", "cache"),
		};
		mkdirSync(layout.state, { recursive: true });
		const runId = "run-layout";
		writeFileSync(
			join(layout.state, "runs.json"),
			`${JSON.stringify([
				{
					id: runId,
					agentId: "layout-tester",
					task: "prove resolved layout",
					targetId: "target-1",
					wireModelId: "model-1",
					status: "running",
					outcome: null,
					outcomeDetail: null,
					startedAt: "2026-08-31T10:00:00.000Z",
					endedAt: null,
					receiptPath: null,
				},
			])}\n`,
			"utf8",
		);
		const selection = join(root, "watch-selection");
		writeFileSync(selection, `${runId}\n`, "utf8");
		const wrongHome = join(root, "wrong-home");
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				join(process.cwd(), "src/cli/index.ts"),
				"fleet",
				"view",
				"--config-dir",
				layout.config,
				"--data-dir",
				layout.data,
				"--state-dir",
				layout.state,
				"--cache-dir",
				layout.cache,
				"--watch",
				selection,
			],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: {
					...process.env,
					CLIO_CODER_HOME: wrongHome,
					CLIO_CODER_CONFIG_DIR: join(wrongHome, "config"),
					CLIO_CODER_DATA_DIR: join(wrongHome, "data"),
					CLIO_CODER_STATE_DIR: join(wrongHome, "state"),
					CLIO_CODER_CACHE_DIR: join(wrongHome, "cache"),
				},
			},
		);
		strictEqual(result.status, 0, result.stderr);
		match(result.stdout, /run run-layout {2}layout-tester/);
		ok(!result.stdout.includes("not in the run ledger"), result.stdout);
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
