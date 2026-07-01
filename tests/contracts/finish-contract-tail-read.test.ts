/**
 * WS2 behaviour-equivalence: the finish-contract reads only a bounded tail of the
 * session ledger, not the whole file. This contract pins that the tail-scoped
 * read yields the SAME assessment as the whole-file read for a long session,
 * while parsing a bounded number of lines regardless of session length.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetXdgCache } from "../../src/core/xdg.js";
import { assessFinishContract } from "../../src/domains/safety/finish-contract.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import {
	createSession,
	openSession,
	readSessionFileEntries,
	readSessionFileTailEntries,
	readSessionTailTurns,
} from "../../src/engine/session.js";

const FIXED_TS = "2026-01-01T00:00:00.000Z";
const TAIL = 160; // FINISH_CONTRACT_TAIL_ENTRIES: 2× the 80-entry window cap

function msg(role: string, turnId: string, payload: Record<string, unknown>): Record<string, unknown> {
	return { kind: "message", role, turnId, parentTurnId: null, timestamp: FIXED_TS, payload };
}

/** A non-mutating read call+result pair, used as filler to grow session length. */
function readPair(i: number): Record<string, unknown>[] {
	const id = `read-${i}`;
	return [
		msg("tool_call", `t-read-${i}`, { name: "read", toolCallId: id, args: { path: `f${i}.ts` } }),
		msg("tool_result", `t-read-r-${i}`, { toolName: "read", toolCallId: id, isError: false, result: { kind: "ok" } }),
	];
}

/** A successful write call+result pair — the mutation the contract keys off. */
function writePair(path: string): Record<string, unknown>[] {
	return [
		msg("tool_call", "t-write", { name: "write", toolCallId: "w1", args: { path } }),
		msg("tool_result", "t-write-r", { toolName: "write", toolCallId: "w1", isError: false, result: { kind: "ok" } }),
	];
}

/** A validation-command bash call+result pair. */
function validationPair(): Record<string, unknown>[] {
	return [
		msg("tool_call", "t-val", { name: "bash", toolCallId: "v1", args: { command: "npm run test" } }),
		msg("tool_result", "t-val-r", { toolName: "bash", toolCallId: "v1", isError: false, result: { kind: "ok" } }),
	];
}

const ASSISTANT_TURN_ID = "t-assistant";

interface Scenario {
	name: string;
	assistantText: string;
	fillerCount: number;
	tail: Record<string, unknown>[];
	/** Extra bookkeeping entries appended AFTER the assistant turn. */
	after?: Record<string, unknown>[];
	expectKind: "engage" | "ok";
	expectReason: string;
}

const SCENARIOS: Scenario[] = [
	{
		name: "engages on an unvalidated mutation at the tail of a long session",
		assistantText: "Done. Implemented the change.",
		fillerCount: 400,
		tail: [msg("user", "t-user", { text: "please implement" }), ...writePair("out.ts")],
		expectKind: "engage",
		expectReason: "unvalidated_mutation",
	},
	{
		name: "clears on validation evidence at the tail of a long session",
		assistantText: "Done, tests pass.",
		fillerCount: 400,
		tail: [msg("user", "t-user", { text: "please implement" }), ...writePair("out.ts"), ...validationPair()],
		expectKind: "ok",
		expectReason: "validation_evidence",
	},
	{
		name: "clears on an explicit limitation at the tail of a long session",
		assistantText: "Updated the parser. Tests: not run — blocked by a missing fixture.",
		fillerCount: 400,
		tail: [msg("user", "t-user", { text: "please implement" }), ...writePair("out.ts")],
		expectKind: "ok",
		expectReason: "explicit_limitation",
	},
	{
		name: "stays silent on a read-only turn at the tail of a long session",
		assistantText: "Here is the current state.",
		fillerCount: 400,
		tail: [msg("user", "t-user", { text: "what does it do?" }), ...readPair(9001)],
		expectKind: "ok",
		expectReason: "no_mutation",
	},
	{
		name: "matches when the last user message is older than the 80-entry window",
		assistantText: "Done.",
		// No user message in the last 80 entries: the window is exactly the last 80,
		// and the mutation sits inside it. Full and tail must slice it identically.
		fillerCount: 400,
		tail: [...Array.from({ length: 40 }, (_, i) => readPair(8000 + i)).flat(), ...writePair("late.ts")],
		expectKind: "engage",
		expectReason: "unvalidated_mutation",
	},
	{
		name: "matches when entries are appended after the assistant turn",
		assistantText: "Done. Implemented the change.",
		fillerCount: 300,
		tail: [msg("user", "t-user", { text: "please implement" }), ...writePair("out.ts")],
		after: [
			msg("tool_call", "t-post", { name: "read", toolCallId: "p1", args: { path: "z.ts" } }),
			msg("tool_result", "t-post-r", { toolName: "read", toolCallId: "p1", isError: false, result: { kind: "ok" } }),
		],
		expectKind: "engage",
		expectReason: "unvalidated_mutation",
	},
];

describe("contracts/finish-contract-tail-read", () => {
	let scratch: string;
	const ORIGINAL_ENV = { ...process.env };

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-tail-read-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_STATE_DIR = join(scratch, "state");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
	});

	afterEach(async () => {
		for (const key of Object.keys(process.env)) {
			if (!(key in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, key);
		}
		for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
			if (value !== undefined) process.env[key] = value;
		}
		resetXdgCache();
		rmSync(scratch, { recursive: true, force: true });
	});

	for (const scenario of SCENARIOS) {
		it(scenario.name, async () => {
			const filler = Array.from({ length: scenario.fillerCount }, (_, i) => readPair(i)).flat();
			const assistant = msg("assistant", ASSISTANT_TURN_ID, { text: scenario.assistantText });
			const entries = [...filler, ...scenario.tail, assistant, ...(scenario.after ?? [])];

			const { meta, writer } = createSession({ cwd: scratch, initialEntries: entries });
			try {
				const fullTurns = openSession(meta.id).turns();
				const tail = readSessionTailTurns(meta.id, TAIL);

				const fullAssessment = assessFinishContract({
					assistantText: scenario.assistantText,
					sessionEntries: collectSessionEntries(fullTurns),
					assistantTurnId: ASSISTANT_TURN_ID,
				});
				const tailAssessment = assessFinishContract({
					assistantText: scenario.assistantText,
					sessionEntries: collectSessionEntries(tail.entries),
					assistantTurnId: ASSISTANT_TURN_ID,
				});

				// Behaviour equivalence: byte-identical assessment either way.
				deepStrictEqual(tailAssessment, fullAssessment);
				strictEqual(tailAssessment.kind, scenario.expectKind);
				strictEqual(tailAssessment.reason, scenario.expectReason);

				// Bounded work: the tail parsed ~TAIL lines, far fewer than the whole
				// session — the cost is bounded by session shape, not length.
				ok(fullTurns.length >= scenario.fillerCount, "full read saw the whole session");
				ok(tail.linesParsed <= TAIL + 1, `tail parsed ${tail.linesParsed} lines, expected <= ${TAIL + 1}`);
				ok(tail.linesParsed < fullTurns.length, "tail parsed fewer lines than the whole-file read");
			} finally {
				await writer.close();
			}
		});
	}
});

describe("engine/session tail-read primitive", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "clio-tail-prim-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function writeJsonl(lines: unknown[]): string {
		const path = join(dir, "current.jsonl");
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		return path;
	}

	it("returns the last N entries identical to the tail of a whole-file read", () => {
		const lines = Array.from({ length: 500 }, (_, i) => ({ kind: "message", turnId: `t${i}`, i }));
		const path = writeJsonl(lines);
		const full = readSessionFileEntries(path);
		// A small chunk forces a genuine backward scan from EOF (offset > 0).
		const tail = readSessionFileTailEntries(path, 50, { chunkBytes: 4096 });
		deepStrictEqual(tail.entries, full.slice(full.length - 50));
		strictEqual(tail.linesParsed, 50);
		strictEqual(tail.reachedStart, false);
	});

	it("grows its window when entries are large (progressive backward read)", () => {
		// Each line ~2KB; 50 lines ~100KB > a tiny 4KB chunk, forcing the window to
		// double until it holds enough complete lines. Result must still equal the
		// whole-file tail exactly.
		const lines = Array.from({ length: 120 }, (_, i) => ({ turnId: `t${i}`, blob: "x".repeat(2000), i }));
		const path = writeJsonl(lines);
		const full = readSessionFileEntries(path);
		const tail = readSessionFileTailEntries(path, 50, { chunkBytes: 4096 });
		deepStrictEqual(tail.entries, full.slice(full.length - 50));
		strictEqual(tail.linesParsed, 50);
	});

	it("reads the whole file (reachedStart) when it holds fewer than N entries", () => {
		const lines = Array.from({ length: 10 }, (_, i) => ({ turnId: `t${i}`, i }));
		const path = writeJsonl(lines);
		const tail = readSessionFileTailEntries(path, 50);
		deepStrictEqual(tail.entries, readSessionFileEntries(path));
		strictEqual(tail.reachedStart, true);
	});

	it("returns nothing for a missing or empty ledger", () => {
		strictEqual(readSessionFileTailEntries(join(dir, "nope.jsonl"), 50).entries.length, 0);
		const empty = join(dir, "empty.jsonl");
		writeFileSync(empty, "");
		const result = readSessionFileTailEntries(empty, 50);
		strictEqual(result.entries.length, 0);
		strictEqual(result.reachedStart, true);
	});

	it("tolerates a torn final line the same way the whole-file reader does", () => {
		const path = join(dir, "torn.jsonl");
		writeFileSync(path, `${JSON.stringify({ turnId: "t0", i: 0 })}\n{ this is not valid json`);
		const tail = readSessionFileTailEntries(path, 50, { onWarning: () => {} });
		deepStrictEqual(tail.entries, readSessionFileEntries(path, { onWarning: () => {} }));
	});
});
