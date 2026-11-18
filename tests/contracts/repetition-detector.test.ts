import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	assessDraftLoop,
	assessRepetition,
	assessToolCallFlood,
	shouldAssessRepetition,
	thinkingOverrunReason,
} from "../../src/session-control/repetition-detector.js";

test("a stream cycling a few sentences or paragraphs is repeating; varied long output is not", () => {
	const sentences =
		"I need to check the outline record before writing. The outline has seven sections. Let me read it again to be sure. ";
	strictEqual(assessRepetition(sentences.repeat(60)).kind, "repeating");
	const paragraphs = [
		"The background section frames delegation as a governance problem in agentic systems, and the claims rest on verified sources.",
		"Each claim maps to evidence records that the desk validates before the section can be marked ready for review.",
		"The writing plan allocates four hundred and fifty words across three tasks that cover settlement, admission and confinement.",
	].join("\n\n");
	const looping = assessRepetition(`${paragraphs}\n\n`.repeat(44));
	strictEqual(looping.kind, "repeating");
	const varied = Array.from(
		{ length: 200 },
		(_, row) => `| run-${row} | ${(row * 37) % 101} ms | target ${row % 7} | settled with ${row * 3} tokens |`,
	).join("\n");
	deepStrictEqual(assessRepetition(varied), { kind: "ok" });
	const prose = Array.from(
		{ length: 120 },
		(_, index) => `Step ${index} reads file number ${index * 13} and records its digest for the audit trail.`,
	).join(" ");
	deepStrictEqual(assessRepetition(prose), { kind: "ok" });
	strictEqual(shouldAssessRepetition(3_999, 0), false);
	strictEqual(shouldAssessRepetition(5_000, 4_500), false);
	strictEqual(shouldAssessRepetition(5_600, 4_500), true);
	const call = (name: string, args: Record<string, unknown>) => ({ type: "toolCall", id: name, name, arguments: args });
	const reads = { content: Array.from({ length: 12 }, (_, index) => call("read", { path: `src/file-${index}.ts` })) };
	deepStrictEqual(assessToolCallFlood(reads, 12), { kind: "ok" }, "distinct parallel reads are not a flood");
	const writes = { content: Array.from({ length: 6 }, () => call("write", { path: "src/format.ts", content: "x" })) };
	deepStrictEqual(assessToolCallFlood(writes, 4), { kind: "ok" }, "only complete calls are judged");
	deepStrictEqual(assessToolCallFlood(writes, 5), { kind: "flooding", toolName: "write", repeats: 5 });
	// Rewrites of one file whose content differs within the first 200 characters are the same loop (bt-39 b).
	const rewrites = {
		content: Array.from({ length: 5 }, (_, index) => call("write", { content: `v${index}`, path: "src/format.ts" })),
	};
	deepStrictEqual(assessToolCallFlood(rewrites, 5), {
		kind: "flooding",
		toolName: "write",
		repeats: 5,
		path: "src/format.ts",
	});
	const hunks = {
		content: Array.from({ length: 6 }, (_, index) => call("edit", { path: "a.ts", oldText: `${index}` })),
	};
	deepStrictEqual(assessToolCallFlood(hunks, 6), { kind: "ok" }, "parallel edits to one file are not a flood");
});

test("reasoning that keeps re-drafting the same short code lines is a loop the sentence check misses (bt-25)", () => {
	// bt-25: 68K characters re-drafting one harness, `class Clock:` 28 times, with most lines still distinct.
	const draft = (round: number) =>
		[
			`Attempt ${round}: maybe the backoff should be computed from attempt ${round * 3} with jitter ${round % 7}.`,
			"from jobq.queue import JobQueue, Job",
			"class Clock:",
			"    def __init__(self, now=0.0):",
			`    # tick ${round} keeps the fake time at ${round * 0.25} seconds for the retry path under test`,
			"        self.now = now",
			`Then the queue would retry job ${round} after ${round * 11} ms, unless the cap of ${round + 4} applies first.`,
			`Wait, that contradicts round ${round - 1}; the delay for attempt ${round} needs re-deriving from the spec once more.`,
		].join("\n");
	const loop = Array.from({ length: 60 }, (_, round) => draft(round)).join("\n\n");
	ok(loop.length >= 24_000, String(loop.length));
	deepStrictEqual(assessRepetition(loop), { kind: "ok" }, "short units under the sentence floor slip past");
	const found = assessDraftLoop(loop);
	strictEqual(found.kind, "repeating");
	// One careful draft, then varied reasoning, is not a loop.
	const once = `${draft(1)}\n${Array.from({ length: 400 }, (_, index) => `Step ${index} checks case ${index * 7} of the retry table.`).join("\n")}`;
	deepStrictEqual(assessDraftLoop(once), { kind: "ok" });
	deepStrictEqual(assessDraftLoop(loop.slice(0, 20_000)), { kind: "ok" }, "short reasoning is not judged");

	// Absolute trigger: reasoning past three quarters of the output cap, about four characters a token.
	strictEqual(thinkingOverrunReason(4 * 12_000, 16_384), null);
	match(
		String(thinkingOverrunReason(4 * 12_300, 16_384)),
		/reasoning reached about 12300 tokens of its 16384-token output limit/u,
	);
	strictEqual(thinkingOverrunReason(4 * 100_000, undefined), null);
});
