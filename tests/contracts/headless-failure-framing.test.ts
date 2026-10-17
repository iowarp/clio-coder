import { doesNotMatch, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { prefixHeadlessFailure } from "../../src/cli/modes/print.js";
import type { ChatLoopRunSnapshot } from "../../src/session-control/chat-loop.js";

test("headless budget and admission stops do not report an endpoint outage", () => {
	const chat = {
		lastRunSnapshot: () => ({ targetId: "openai-codex", runtimeId: "openai-codex" }) as ChatLoopRunSnapshot,
	};
	const budget = "budget_ceiling: this run's priced spend $0.0007 reached its --max-cost-usd $0.0006 cap.";
	strictEqual(prefixHeadlessFailure(chat, budget), budget);
	const admission = "IMAGE_INPUT_UNSUPPORTED: this route does not accept images";
	strictEqual(prefixHeadlessFailure(chat, admission, true), admission);
	const provider = prefixHeadlessFailure(chat, "HTTP 503");
	match(provider, /target 'openai-codex' \(openai-codex\): HTTP 503/u);
	doesNotMatch(provider, /endpoint unavailable/u);
});
