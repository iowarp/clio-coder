import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { requestFits } from "../../src/domains/context/budget/request-fit.js";
import {
	estimateAgentContextBreakdown,
	estimateAgentMessageTokens,
} from "../../src/domains/session/context-accounting.js";

test("request admission includes output, accepts equality, and refuses unknown or invalid budgets", () => {
	strictEqual(requestFits(24_000, 12_000, 32_000), false);
	strictEqual(requestFits(24_000, 8_000, 32_000), true);
	for (const invalid of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
		strictEqual(requestFits(invalid, 1, 100), false);
		strictEqual(requestFits(1, invalid, 100), false);
		strictEqual(requestFits(1, 1, invalid), false);
	}
	strictEqual(requestFits(0, 0, 0), false);
});

test("pending user framing and images have the same price as an installed message", () => {
	const image = { type: "image", data: "AA==", mimeType: "image/png" };
	const message = { role: "user", content: [{ type: "text", text: "inspect" }, image] };
	const pending = estimateAgentContextBreakdown({
		systemPrompt: "",
		tools: [],
		messages: [],
		pendingUserText: "inspect",
		pendingUserImages: [image],
	});
	strictEqual(pending.pendingUserTokens, estimateAgentMessageTokens(message));
	strictEqual(pending.pendingUserTokens > 1200, true);
});
