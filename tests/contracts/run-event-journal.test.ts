/**
 * Run event journal contract.
 *
 * The journal is the only durable copy of a run's display event stream, so the
 * shape a viewer process reads is a contract, not an implementation detail:
 * monotonic seq, a truncation marker the moment display lines start dropping,
 * receipt and lifecycle lines that survive that dropping, a terminal line that
 * is always last, retention bound to the ledger ring, and a sink failure that
 * turns the journal off instead of failing a run.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import {
	createRunEventJournal,
	RUN_EVENT_JOURNAL_ENV_VAR,
	type RunEventJournalLine,
	readRunEventJournal,
	removeRunEventJournals,
	runEventJournalDir,
	runEventJournalEnabled,
	runEventJournalPath,
	runEventJournalRoot,
} from "../../src/domains/dispatch/run-event-journal.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function scratchRoot(dir: string): string {
	const root = join(dir, "journal-root");
	mkdirSync(root, { recursive: true });
	return root;
}

function linesOf(root: string, runId: string): RunEventJournalLine[] {
	return readRunEventJournal(runId, { root }).lines;
}

function rawLines(root: string, runId: string): string[] {
	return readFileSync(runEventJournalPath(runId, root), "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
}

describe("run event journal", () => {
	it("appends one NDJSON line per event with a monotonic seq and a wall-clock at", async () => {
		const isolated = await isolateClioEnv("clio-journal-append-");
		try {
			const root = scratchRoot(isolated.dir);
			const journal = createRunEventJournal({ root });
			journal.open("run-append", "coder");
			journal.append("run-append", { at: "2026-08-30T10:00:00.000Z", type: "message_end", detail: "hello" });
			journal.append("run-append", { at: "2026-08-30T10:00:01.000Z", type: "clio_tool_finish" });
			journal.flush();

			const lines = linesOf(root, "run-append");
			deepStrictEqual(
				lines.map((line) => line.seq),
				[1, 2, 3],
			);
			deepStrictEqual(
				lines.map((line) => line.kind),
				["open", "event", "event"],
			);
			const opened = lines[0];
			ok(opened?.kind === "open");
			strictEqual(opened.agentId, "coder");
			const first = lines[1];
			ok(first?.kind === "event");
			strictEqual(first.type, "message_end");
			strictEqual(first.detail, "hello");
			// `at` is the journal's own wall clock, not the entry's, so a replayed or
			// back-dated entry cannot make the file's timeline go backwards.
			ok(!Number.isNaN(Date.parse(first.at)));
			// One event per line: the raw file has exactly as many lines as parsed.
			strictEqual(rawLines(root, "run-append").length, 3);
		} finally {
			isolated.restore();
		}
	});

	it("bounds a run at the size cap, marks the truncation once, and keeps lifecycle and receipt lines", async () => {
		const isolated = await isolateClioEnv("clio-journal-cap-");
		try {
			const root = scratchRoot(isolated.dir);
			const journal = createRunEventJournal({ root, capBytes: 1024, flushBytes: 64 });
			journal.open("run-cap", "coder");
			for (let i = 0; i < 200; i += 1) {
				journal.append("run-cap", { at: "2026-08-30T10:00:00.000Z", type: "message_end", detail: "x".repeat(60) });
			}
			journal.receipt("run-cap", { outcome: "succeeded", exitCode: 0, digest: "abc123" });
			journal.terminal("run-cap", "succeeded");
			journal.flush();

			const lines = linesOf(root, "run-cap");
			const markers = lines.filter((line) => line.kind === "journal_truncated");
			strictEqual(markers.length, 1, "the truncation marker is written exactly once");
			const events = lines.filter((line) => line.kind === "event");
			ok(events.length > 0, "events before the cap are kept");
			ok(events.length < 200, "events after the cap are dropped");
			// Nothing droppable follows the marker.
			const markerIndex = lines.findIndex((line) => line.kind === "journal_truncated");
			ok(
				lines.slice(markerIndex).every((line) => line.kind !== "event"),
				"no display line is written after dropping begins",
			);

			// The receipt-bearing line and both lifecycle lines survive the cap.
			const receipt = lines.find((line) => line.kind === "receipt");
			ok(receipt?.kind === "receipt");
			strictEqual(receipt.outcome, "succeeded");
			strictEqual(receipt.digest, "abc123");
			ok(lines.some((line) => line.kind === "open"));
			ok(readRunEventJournal("run-cap", { root }).bytes > 1024, "the cap bounds display lines, not the whole file");
		} finally {
			isolated.restore();
		}
	});

	it("makes the terminal line the last write and reports it to a reader", async () => {
		const isolated = await isolateClioEnv("clio-journal-terminal-");
		try {
			const root = scratchRoot(isolated.dir);
			const journal = createRunEventJournal({ root });
			journal.open("run-terminal", "tester");
			journal.append("run-terminal", { at: "2026-08-30T10:00:00.000Z", type: "message_end" });
			journal.terminal("run-terminal", "failed", "worker exited 1");
			// Everything after the terminal line is discarded, whatever its kind.
			journal.append("run-terminal", { at: "2026-08-30T10:00:02.000Z", type: "message_end" });
			journal.receipt("run-terminal", { outcome: "succeeded", exitCode: 0 });
			journal.terminal("run-terminal", "succeeded");
			journal.flush();

			const read = readRunEventJournal("run-terminal", { root });
			const last = read.lines.at(-1);
			ok(last?.kind === "terminal");
			strictEqual(last.outcome, "failed");
			strictEqual(read.terminal?.outcome, "failed");
			strictEqual(read.terminal?.detail, "worker exited 1");
			strictEqual(read.lines.filter((line) => line.kind === "terminal").length, 1);
			strictEqual(read.agentId, "tester");
		} finally {
			isolated.restore();
		}
	});

	it("degrades to journal-off with one notice when the sink cannot be written, and never throws", async () => {
		const isolated = await isolateClioEnv("clio-journal-degrade-");
		try {
			// A regular file where the journal root should be: mkdir under it fails
			// the way a read-only or full filesystem does.
			const root = join(isolated.dir, "not-a-directory");
			writeFileSync(root, "", "utf8");
			const notices: string[] = [];
			const journal = createRunEventJournal({ root, warn: (message) => notices.push(message) });

			journal.open("run-degrade", "coder");
			journal.append("run-degrade", { at: "2026-08-30T10:00:00.000Z", type: "message_end" });
			journal.receipt("run-degrade", { outcome: "succeeded", exitCode: 0 });
			journal.terminal("run-degrade", "succeeded");
			journal.flush();

			strictEqual(journal.degraded(), true);
			strictEqual(notices.length, 1, "one observability notice, not one per event");
			match(notices[0] ?? "", /run event journal disabled/);
			strictEqual(existsSync(runEventJournalPath("run-degrade", root)), false);
		} finally {
			isolated.restore();
		}
	});

	it("writes nothing when the journal is disabled", async () => {
		const isolated = await isolateClioEnv("clio-journal-disabled-");
		try {
			const root = scratchRoot(isolated.dir);
			const journal = createRunEventJournal({ root, isEnabled: () => false });
			journal.open("run-off", "coder");
			journal.append("run-off", { at: "2026-08-30T10:00:00.000Z", type: "message_end" });
			journal.terminal("run-off", "succeeded");
			journal.flush();
			strictEqual(existsSync(runEventJournalDir("run-off", root)), false);
			strictEqual(readRunEventJournal("run-off", { root }).present, false);
		} finally {
			isolated.restore();
		}
	});

	it("resolves enablement as env override over configured settings over on", () => {
		strictEqual(runEventJournalEnabled({}), true);
		strictEqual(runEventJournalEnabled({ [RUN_EVENT_JOURNAL_ENV_VAR]: "0" }), false);
		strictEqual(runEventJournalEnabled({ [RUN_EVENT_JOURNAL_ENV_VAR]: "off" }), false);
		strictEqual(runEventJournalEnabled({ [RUN_EVENT_JOURNAL_ENV_VAR]: "true" }), true);
		// An unparseable override falls through rather than erroring.
		strictEqual(runEventJournalEnabled({ [RUN_EVENT_JOURNAL_ENV_VAR]: "maybe" }), true);
	});

	it("lives under the state root, so `clio-coder reset --state` clears it", async () => {
		const isolated = await isolateClioEnv("clio-journal-reset-");
		try {
			ok(
				runEventJournalRoot().startsWith(`${clioStateDir()}/`),
				`journal root ${runEventJournalRoot()} must sit inside ${clioStateDir()}`,
			);
		} finally {
			isolated.restore();
		}
	});

	it("removes a run's journal when the run leaves the ledger ring", async () => {
		const isolated = await isolateClioEnv("clio-journal-retention-");
		try {
			const ledger = openLedger({ maxRuns: 1 });
			const older = ledger.create({
				agentId: "coder",
				executionRole: "builder",
				task: "older",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "openai",
				runtimeKind: "http",
				sessionId: null,
				cwd: isolated.dir,
			});
			const newer = ledger.create({
				agentId: "coder",
				executionRole: "builder",
				task: "newer",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "openai",
				runtimeKind: "http",
				sessionId: null,
				cwd: isolated.dir,
			});
			// Ring eviction only spends its budget on finished rows.
			for (const run of [older, newer]) {
				ledger.update(run.id, { status: "completed", endedAt: new Date().toISOString(), exitCode: 0 });
			}

			// Journals in the default location, which is what retention prunes.
			const journal = createRunEventJournal({});
			for (const run of [older, newer]) {
				journal.open(run.id, "coder");
				journal.terminal(run.id, "succeeded");
			}
			journal.flush();
			ok(existsSync(runEventJournalDir(older.id)));
			ok(existsSync(runEventJournalDir(newer.id)));

			await ledger.persist();

			strictEqual(openLedger({ maxRuns: 1 }).get(older.id), null, "the older row left the ring");
			strictEqual(existsSync(runEventJournalDir(older.id)), false, "its journal went with it");
			ok(existsSync(runEventJournalDir(newer.id)), "the surviving row keeps its journal");
		} finally {
			isolated.restore();
		}
	});

	it("refuses a run id that would escape the journal root", async () => {
		const isolated = await isolateClioEnv("clio-journal-traversal-");
		try {
			const root = scratchRoot(isolated.dir);
			const journal = createRunEventJournal({ root });
			journal.open("../escape", "coder");
			journal.terminal("../escape", "succeeded");
			journal.flush();
			strictEqual(existsSync(join(isolated.dir, "escape")), false);
			// removeRunEventJournals applies the same rule before it deletes.
			const keeper = join(root, "keep");
			mkdirSync(keeper, { recursive: true });
			removeRunEventJournals(["../keep", "..", "."], root);
			ok(existsSync(keeper));
		} finally {
			isolated.restore();
		}
	});
});
