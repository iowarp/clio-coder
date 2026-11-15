import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { assessRepetition, shouldAssessRepetition } from "../../src/session-control/repetition-detector.js";

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
});
