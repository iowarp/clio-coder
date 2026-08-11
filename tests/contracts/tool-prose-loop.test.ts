import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_TOOL_NAMES } from "../../src/core/tool-names.js";
import { assessToolProseLoop, shouldAssessToolProse } from "../../src/interactive/tool-prose-loop.js";

const NARRATION = "I'll now execute the read tool call to inspect the file. ";
const FILLER = "The differential renderer compares the previous frame against the next one. ";

describe("contracts/tool-prose-loop sampling", () => {
	/**
	 * The defect this pins: the assessment lower-cases and collapses the whole
	 * accumulated answer, then runs three regexes per active tool over it, and it
	 * ran on every streamed delta. Measured on a 6942-character answer arriving
	 * as 1157 deltas, that was 178ms of synchronous work in the streaming hot
	 * path, growing with answer length, taken from the loop the render timer
	 * waits on.
	 */
	it("samples the answer instead of rescanning it on every delta", () => {
		let assessments = 0;
		let assessedChars = 0;
		let text = "";
		for (let i = 0; i < 1157; i++) {
			text += FILLER.slice(i % 40, (i % 40) + 6);
			if (!shouldAssessToolProse(text.length, assessedChars)) continue;
			assessedChars = text.length;
			assessments += 1;
		}
		ok(text.length > 6000, `answer should be answer-sized, got ${text.length}`);
		ok(assessments <= 16, `expected a handful of scans for ${text.length} chars, got ${assessments}`);
		ok(assessments >= 8, `the guard must still sample regularly, got ${assessments}`);
	});

	it("does not look at answers below the detector's own floor", () => {
		strictEqual(shouldAssessToolProse(1199, 0), false);
		strictEqual(shouldAssessToolProse(1200, 0), true);
	});

	it("still catches a narration loop when sampled rather than run per delta", () => {
		let assessedChars = 0;
		let text = "";
		let caught: number | null = null;
		const tools = [...ALL_TOOL_NAMES];
		// Four repetitions trips the threshold, and the sampled gate must reach
		// that verdict within one stride of where a per-delta scan would.
		for (let i = 0; i < 400 && caught === null; i++) {
			text += i % 3 === 0 ? NARRATION : FILLER;
			if (!shouldAssessToolProse(text.length, assessedChars)) continue;
			assessedChars = text.length;
			if (assessToolProseLoop({ text, activeToolNames: tools, hasStructuredToolCall: false }).kind === "loop") {
				caught = text.length;
			}
		}
		ok(caught !== null, "the sampled guard must still trip on a narration loop");
		ok(caught !== null && caught < 2400, `expected the trip well inside two strides, got ${caught}`);
	});

	it("a structured tool call keeps the guard quiet no matter the length", () => {
		const text = NARRATION.repeat(40);
		strictEqual(
			assessToolProseLoop({ text, activeToolNames: [...ALL_TOOL_NAMES], hasStructuredToolCall: true }).kind,
			"ok",
		);
	});
});
