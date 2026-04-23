import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { patchReasoningSummaryPayload } from "../../src/engine/provider-payload.js";

describe("engine/provider-payload patchReasoningSummaryPayload", () => {
	it("forces detailed summaries for openai-codex high thinking", () => {
		const next = patchReasoningSummaryPayload(
			{ reasoning: { effort: "high", summary: "auto" }, text: { verbosity: "medium" } },
			{ api: "openai-codex-responses", id: "gpt-5.4" } as never,
			"high",
		) as Record<string, unknown>;
		deepStrictEqual(next.reasoning, { effort: "high", summary: "detailed" });
	});

	it("forces concise summaries for openai-codex low thinking", () => {
		const next = patchReasoningSummaryPayload(
			{ reasoning: { effort: "low", summary: "auto" } },
			{ api: "openai-codex-responses", id: "gpt-5.4" } as never,
			"low",
		) as Record<string, unknown>;
		deepStrictEqual(next.reasoning, { effort: "low", summary: "concise" });
	});

	it("leaves non-openai payloads untouched", () => {
		const next = patchReasoningSummaryPayload(
			{ reasoning: { effort: "high", summary: "auto" } },
			{ api: "anthropic-messages", id: "claude-sonnet" } as never,
			"high",
		);
		strictEqual(next, undefined);
	});
});
