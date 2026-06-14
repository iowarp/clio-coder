import { strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { remainingContextMaxTokens, setGlobalDefaultMaxOutputTokens } from "../../src/engine/apis/output-budget.js";

type BudgetModel = Parameters<typeof remainingContextMaxTokens>[0];
type BudgetContext = Parameters<typeof remainingContextMaxTokens>[1];

// A context with no system prompt, messages, or tools contributes ~0 input
// tokens, so the remaining-window budget never constrains these cases.
const emptyContext = { systemPrompt: "", messages: [], tools: [] } as unknown as BudgetContext;

function model(contextWindow: number, maxTokens: number): BudgetModel {
	return { contextWindow, maxTokens } as BudgetModel;
}

describe("contracts/output-budget", () => {
	afterEach(() => setGlobalDefaultMaxOutputTokens(0));

	it("requests the global default when the caller gives no explicit budget", () => {
		setGlobalDefaultMaxOutputTokens(32768);
		// maxTokens 0 => model cap unknown/uncapped; the global default applies directly.
		strictEqual(remainingContextMaxTokens(model(1_000_000, 0), emptyContext, undefined), 32768);
	});

	it("clamps the global default down to a smaller model cap", () => {
		setGlobalDefaultMaxOutputTokens(32768);
		strictEqual(remainingContextMaxTokens(model(1_000_000, 8192), emptyContext, undefined), 8192);
	});

	it("lets an explicit caller budget win over the global default", () => {
		setGlobalDefaultMaxOutputTokens(32768);
		strictEqual(remainingContextMaxTokens(model(1_000_000, 16384), emptyContext, { maxTokens: 4096 }), 4096);
	});

	it("keeps the more-specific tool-turn limit over the global default", () => {
		setGlobalDefaultMaxOutputTokens(32768);
		strictEqual(
			remainingContextMaxTokens(model(1_000_000, 0), emptyContext, undefined, { maxOutputTokens: 16384 }),
			16384,
		);
	});

	it("falls back to the model cap when no global default is set", () => {
		setGlobalDefaultMaxOutputTokens(0);
		strictEqual(remainingContextMaxTokens(model(1_000_000, 8192), emptyContext, undefined), 8192);
	});
});
