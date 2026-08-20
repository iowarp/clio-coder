/**
 * Rendering contract for issue #95 / findings-session-state.md finding 4: a
 * worker run with no sealed receipt must not collapse into one indistinct
 * state. Replay reads `receipts/<runId>.json` first and falls back to the
 * run's own `runs.json` row (`worker-receipts.ts`'s
 * `readWorkerReceiptFactsForReplay`) so a run still going elsewhere, one the
 * ledger closed as dead/stalled before it could seal a receipt
 * (`closeAbandonedRows`), and one whose evidence is genuinely gone all read
 * differently.
 *
 * Assertions are on distinction (no two states print the same footer, and
 * each names what it actually knows), not on exact glyphs or colors, so a
 * theme change does not break this file but a semantic collapse does.
 *
 * The second case also drives the live subscription's own fold
 * (`createWorkerStream`, the one `interactive-subscriptions.ts` wires up) for
 * a run with no terminal event yet, and checks it renders identically to
 * replay's still-running state: the bug this guards against is exactly two
 * paths disagreeing about what happened, and it would be a regression to fix
 * that by making live and replay disagree in a new way.
 */

import { notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DispatchStartedPayload } from "../../src/core/bus-events.js";
import type { WorkerRunEntry } from "../../src/domains/session/index.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import { readWorkerReceiptFactsForReplay } from "../../src/interactive/worker-receipts.js";
import { workerEntriesFromRunEntries } from "../../src/interactive/worker-replay.js";
import { createWorkerStream, type WorkerEntryState } from "../../src/interactive/worker-stream.js";

/** A scratch `runs.json` with the given rows and no `receipts/` directory at all. */
function scratchLedgerDir(rows: Array<Record<string, unknown>>): string {
	const dir = mkdtempSync(join(tmpdir(), "clio-run-state-render-"));
	writeFileSync(join(dir, "runs.json"), JSON.stringify(rows));
	return dir;
}

function runEntry(overrides: Partial<WorkerRunEntry> = {}): WorkerRunEntry {
	return {
		kind: "workerRun",
		turnId: "t1",
		parentTurnId: null,
		timestamp: "2026-08-17T10:00:00.000Z",
		assignmentId: "a-1",
		runId: "run-1",
		origin: "user",
		agentId: "coder",
		runtime: { kind: "clio", targetId: "node-a", wireModelId: "example-model" },
		...overrides,
	};
}

/** The rendered footer line, ANSI stripped, from the expanded (unfolded) block. */
function footerText(entry: WorkerEntryState): string {
	const lines = renderWorkerEntryLines(entry, 80, { folded: false });
	const last = lines[lines.length - 1] ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping real ANSI SGR codes from rendered output
	return last.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("worker run state render (issue #95)", () => {
	it("replay distinguishes running, ledger-abandoned, and genuinely-missing", () => {
		const dir = scratchLedgerDir([
			{
				id: "run-running",
				status: "running",
				outcome: null,
				outcomeDetail: null,
				startedAt: "2026-08-17T10:00:00.000Z",
				endedAt: null,
				pid: 424242,
			},
			{
				id: "run-abandoned",
				status: "dead",
				outcome: "stalled",
				outcomeDetail: "abandoned: orchestrator exited before the run finalized",
				startedAt: "2026-08-17T09:00:00.000Z",
				endedAt: "2026-08-17T09:05:00.000Z",
				pid: 999999,
			},
			// run-lost intentionally has no row: a genuinely missing receipt.
		]);
		try {
			const entries: WorkerRunEntry[] = [
				runEntry({ assignmentId: "a-running", runId: "run-running" }),
				runEntry({ assignmentId: "a-abandoned", runId: "run-abandoned" }),
				runEntry({ assignmentId: "a-lost", runId: "run-lost" }),
			];
			const states = workerEntriesFromRunEntries(entries, (runId) => readWorkerReceiptFactsForReplay(runId, dir));

			const running = states.get("a-running");
			const abandoned = states.get("a-abandoned");
			const lost = states.get("a-lost");
			ok(running !== undefined, "still-running assignment rendered a block");
			ok(abandoned !== undefined, "abandoned assignment rendered a block");
			ok(lost !== undefined, "genuinely-missing assignment rendered a block");
			if (running === undefined || abandoned === undefined || lost === undefined) return;

			const runningText = footerText(running);
			const abandonedText = footerText(abandoned);
			const lostText = footerText(lost);

			// The bug: all three used to print the identical "receipt unavailable"
			// line. The fix: no two of them may say the same thing.
			notStrictEqual(runningText, abandonedText, "running and abandoned must render differently");
			notStrictEqual(runningText, lostText, "running and genuinely-missing must render differently");
			notStrictEqual(abandonedText, lostText, "abandoned and genuinely-missing must render differently");

			// Each names what it actually knows.
			ok(!runningText.includes("unavailable"), `still-running footer must not claim unavailable: ${runningText}`);
			ok(!runningText.includes("abandoned"), `still-running footer must not claim abandoned: ${runningText}`);
			ok(abandonedText.includes("abandoned"), `abandoned footer must name itself: ${abandonedText}`);
			ok(lostText.includes("unavailable"), `genuinely-missing footer must still say unavailable: ${lostText}`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("live subscription renders a still-running assignment the same way replay does", () => {
		const dir = scratchLedgerDir([
			{
				id: "run-running",
				status: "running",
				outcome: null,
				outcomeDetail: null,
				startedAt: "2026-08-17T10:00:00.000Z",
				endedAt: null,
				pid: 424242,
			},
		]);
		try {
			// Replay side: the run's workerRun entry rebuilt through the real
			// replay reader, exactly as a resumed session would.
			const replayed = workerEntriesFromRunEntries(
				[runEntry({ assignmentId: "a-running", runId: "run-running" })],
				(runId) => readWorkerReceiptFactsForReplay(runId, dir),
			);
			const replayState = replayed.get("a-running");
			ok(replayState !== undefined, "replay produced a block for the still-running assignment");
			if (replayState === undefined) return;

			// Live side: the same fold interactive-subscriptions.ts wires up,
			// given a real DispatchStarted and no terminal event yet, so it is
			// still "pending" in-process the way a run that has not finished
			// anywhere actually is.
			const liveStream = createWorkerStream();
			const startedPayload: DispatchStartedPayload = {
				runId: "run-running",
				agentId: "coder",
				requestOrigin: "user",
				targetId: "node-a",
				wireModelId: "example-model",
				runtimeId: "lmstudio",
				runtimeKind: "http",
				pid: 424242,
				assignmentId: "a-running",
				attempt: 0,
			};
			const created = liveStream.started(startedPayload);
			ok(created !== null, "live started() opened a block");
			const liveState = liveStream.get("a-running");
			ok(liveState !== undefined, "live stream carries the assignment");
			if (liveState === undefined) return;

			// Neither side has a settled receipt for this run. Both must render
			// the running state, and render it identically: the bug this guards
			// against is exactly two paths disagreeing about what happened, so a
			// fix that makes live and replay disagree with each other is not one.
			const replayText = footerText(replayState);
			const liveText = footerText(liveState);
			strictEqual(replayText, liveText, "replay and live must render the same still-running footer");
			ok(liveText.includes("running"), `live still-running footer must say running: ${liveText}`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
