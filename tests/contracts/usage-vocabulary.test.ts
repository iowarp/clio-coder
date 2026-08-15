/**
 * One quantity, one word for it, across every surface that shows it.
 *
 * The chat panel's turn line and the `/cost` overlay report the same two
 * numbers about the same session and used to name them differently. The panel
 * said `over 65 calls` while the overlay said `requests`, and the panel marked
 * an estimated reasoning total with `≈` while the overlay printed a bare
 * number. The second one is worse than a wording mismatch: the cost tally sums
 * only what providers reported, and the panel falls back to estimating from
 * the reasoning text it displayed, so on a model that reports nothing a footer
 * reading `r≈900` sat beside an overlay reading `reasoning 0` with nothing to
 * say why.
 */
import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { costAggregateForAmount } from "../../src/domains/observability/index.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { type CostRow, formatCostOverlayBodyLines } from "../../src/interactive/cost-overlay.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function costRow(overrides: Partial<CostRow> = {}): CostRow {
	return {
		providerId: "openai",
		modelId: "gpt-5",
		runs: 3,
		tokens: 5_000,
		input: 3_000,
		output: 1_500,
		cacheRead: 400,
		cacheWrite: 100,
		reasoningTokens: 0,
		apiCalls: 65,
		cost: costAggregateForAmount(1.5, "known"),
		...overrides,
	};
}

function costBody(rows: ReadonlyArray<CostRow>): string {
	return strip(formatCostOverlayBodyLines(costAggregateForAmount(1.5, "known"), 8_000, rows, 80).join("\n"));
}

function panelBody(usage: Record<string, number>, thinking?: string): string {
	const panel = createChatPanel({ getOutputVerbosity: () => "verbose" });
	const content = thinking === undefined ? [{ type: "text", text: "answer" }] : [{ type: "thinking", thinking }];
	const message = { role: "assistant", content, usage, stopReason: "stop" };
	panel.applyEvent({ type: "message_end", message } as unknown as ChatLoopEvent);
	panel.applyEvent({ type: "agent_end", messages: [message, message] } as unknown as ChatLoopEvent);
	return strip(panel.render(160).join("\n"));
}

describe("contracts/usage vocabulary", () => {
	it("calls a model call a call on both surfaces", () => {
		const body = costBody([costRow()]);
		ok(body.includes("model calls"), `the overlay names the model-call count, got: ${body}`);
		ok(!/\brequests\b/.test(body), `"requests" is the other surface's word for the same number: ${body}`);
		ok(!/avg\/request/.test(body), `the cache-read aside follows the same word: ${body}`);

		const panel = panelBody({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
		ok(/over 2 calls/.test(panel), `the panel names the same count the same way, got: ${panel}`);
	});

	it("says the overlay reasoning total counts only what the provider reported", () => {
		const body = costBody([costRow({ reasoningTokens: 0 })]);
		const reasoningLine = body.split("\n").find((line) => line.trimStart().startsWith("reasoning")) ?? "";
		ok(
			reasoningLine.includes("provider-reported only"),
			`the row states which of the two tallies it is, got: ${reasoningLine}`,
		);
	});

	it("marks an estimated panel total and leaves a reported one unmarked", () => {
		const estimated = panelBody({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, "some reasoning text here");
		ok(/reasoning ≈\d+ estimated/.test(estimated), `an estimate is marked, got: ${estimated}`);

		const reported = panelBody(
			{ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoningTokens: 42 },
			"some reasoning text here",
		);
		ok(/reasoning 84 provider/.test(reported), `a reported total is unmarked, got: ${reported}`);
		ok(!reported.includes("≈"), `a reported total carries no estimate marker, got: ${reported}`);
	});
});
