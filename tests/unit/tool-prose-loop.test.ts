import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { assessToolProseLoop } from "../../src/interactive/tool-prose-loop.js";

describe("tool prose loop guard", () => {
	it("ignores short ordinary planning text", () => {
		const assessment = assessToolProseLoop({
			text: "I'll execute the edit tool call now.",
			activeToolNames: ["edit"],
		});

		strictEqual(assessment.kind, "ok");
	});

	it("ignores text once a structured tool call is present", () => {
		const text = "I'll execute the edit tool call now. ".repeat(20);
		const assessment = assessToolProseLoop({
			text,
			activeToolNames: ["edit"],
			hasStructuredToolCall: true,
		});

		strictEqual(assessment.kind, "ok");
	});

	it("detects repeated narration of a tool call without a structured call", () => {
		const text = [
			"The tests confirm the issue.",
			"I'll execute the edit tool call now.",
			"I'll execute the edit tool call now.",
			"I'll execute the edit tool call now.",
			"I'll execute the edit tool call now.",
			"I'll execute the edit tool call now.",
			"Let me reconstruct the same replacement again.",
		]
			.join(" ")
			.repeat(8);
		const assessment = assessToolProseLoop({
			text,
			activeToolNames: ["read", "edit", "package_script"],
		});

		strictEqual(assessment.kind, "loop");
		if (assessment.kind === "loop") {
			strictEqual(assessment.matchCount >= 4, true);
		}
	});
});
