import { deepStrictEqual, doesNotMatch, match } from "node:assert/strict";
import { describe, it } from "node:test";
import { nodeComponentRemedyEvent } from "../../src/domains/dispatch/failure-classification.js";

describe("node tools remedy relay", () => {
	it("rewrites a relayed worker frame to the node-side install command", () => {
		const message =
			"The copilot-sdk runtime needs @github/copilot-sdk@1.0.26. Run: clio-coder tools install copilot-sdk. This installs a separate component at /home/u/c/copilot-sdk/1.0.26; it does not change Clio's installation.";
		const frame = { type: "agent_end", detail: { errorMessage: message, lines: [message] }, count: 1 };
		const relayed = nodeComponentRemedyEvent(frame, "loop");
		const text = JSON.stringify(relayed);
		doesNotMatch(text, /Run: clio-coder tools install copilot-sdk/);
		match(text, /clio-coder fleet nodes tools install loop copilot-sdk --yes/);
		deepStrictEqual(frame.detail.lines, [message]);
		deepStrictEqual(relayed.count, 1);
	});
});
