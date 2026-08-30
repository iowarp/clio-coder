import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_WORKING_SET_VIEW, type WorkingSetView } from "../../src/domains/context/working-set/contract.js";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { renderEvictedTokensLine } from "../../src/interactive/context-meter.js";
import { renderContextLedgerLines } from "../../src/interactive/context-overlay.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function ledger() {
	return buildContextLedger({
		provider: "mock",
		model: "model-a",
		contextWindow: 4000,
		messageTokens: 1200,
		compactionAuto: true,
	});
}

function view(): WorkingSetView {
	const entries: SessionEntry[] = [
		{
			kind: "message",
			turnId: "u1",
			parentTurnId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			role: "user",
			payload: {},
		},
		{
			kind: "message",
			turnId: "t1",
			parentTurnId: "u1",
			timestamp: "2026-01-01T00:00:02.000Z",
			role: "tool_result",
			payload: {},
		},
		{
			kind: "message",
			turnId: "t2",
			parentTurnId: "t1",
			timestamp: "2026-01-01T00:00:03.000Z",
			role: "tool_result",
			payload: {},
		},
		{
			kind: "message",
			turnId: "t3",
			parentTurnId: "t2",
			timestamp: "2026-01-01T00:00:04.000Z",
			role: "tool_result",
			payload: {},
		},
		{
			kind: "contextEviction",
			turnId: "e1",
			parentTurnId: "t3",
			timestamp: "2026-01-01T00:00:05.000Z",
			policyId: "age-horizon",
			trigger: "pressure",
			evicted: [
				{ ref: { entry: "t1" }, reason: "age_horizon", tokensFreed: 700, marker: "[evicted ref=t1]" },
				{ ref: { entry: "t2" }, reason: "age_horizon", tokensFreed: 500, marker: "[evicted ref=t2]" },
				{ ref: { entry: "t3" }, reason: "age_horizon", tokensFreed: 300, marker: "[evicted ref=t3]" },
			],
			tokensBefore: 3000,
			tokensAfter: 1500,
			pressureBefore: 0.9,
			snapshotIdBefore: null,
		},
		{
			kind: "contextRecall",
			turnId: "r1",
			parentTurnId: "t3",
			timestamp: "2026-01-01T00:00:06.000Z",
			ref: { entry: "t2" },
			trigger: "tool",
			tokensReadmitted: 500,
		},
	];
	return foldWorkingSet(entries);
}

describe("context overlay working-set section", () => {
	it("renders policy, evicted items and tokens, events, recalls, and churn", () => {
		const text = strip(renderContextLedgerLines(ledger(), 68, view()).join("\n"));
		ok(text.includes("working set · policy age-horizon"), text);
		ok(text.includes("3 evicted items · 1,500 tokens · 1 event · 1 recall · churn 0.33"), text);
		ok(text.includes("evicted (outside window) 1,500 tokens"), text);
	});

	it("evicted tokens are one line after the legend, not a meter category", () => {
		const rendered = renderContextLedgerLines(ledger(), 68, view());
		const lines = rendered.map(strip);
		const freeIndex = lines.findIndex((line) => line.includes("Free space"));
		const reserveIndex = lines.findIndex((line) => line.includes("Autocompact reserve"));
		const evictedIndex = lines.findIndex((line) => line.includes("evicted (outside window)"));
		ok(freeIndex >= 0 && reserveIndex === freeIndex + 1 && evictedIndex === reserveIndex + 1, lines.join("\n"));
		const frame = clioTheme().fgSequence("frame");
		if (frame.length > 0) {
			const reserveLine = rendered[reserveIndex] ?? "";
			strictEqual(reserveLine.split(frame).length - 1, 2, "the reserve swatch and label must both use frame styling");
		}
		strictEqual(
			ledger().meter.some((group) => group.label.toLowerCase().includes("evicted")),
			false,
		);
		ok(strip(renderEvictedTokensLine(12_345)).endsWith("12,345 tokens"));
	});

	// The reason is stamped by turn-context.ts, persisted on the assistant
	// entry's promptCache, and folded back into the ledger by
	// noteRunCacheSummary. This is the last hop: the overlay has to say the cold
	// turn was expected, or an operator reads "backend cold" as a provider fault
	// and goes looking for a bug in the prefix cache.
	it("attributes an expected cold turn to working-set eviction instead of warning", () => {
		const coldLedger = (expectedColdReasons?: string[]) =>
			buildContextLedger({
				provider: "mock",
				model: "model-a",
				contextWindow: 4000,
				messageTokens: 1200,
				promptCache: {
					shellReused: true,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					uncachedInputTokens: 12_000,
					backend: null,
					uncachedPrefillTokens: null,
					backendVerdict: "cold",
					...(expectedColdReasons ? { expectedColdReasons } : {}),
				},
			});
		const cacheLineOf = (rendered: string[]): string =>
			rendered.find((line) => strip(line).includes("prompt cache:")) ?? "";

		const explained = renderContextLedgerLines(coldLedger(["working_set_evict"]), 68);
		const explainedText = strip(explained.join("\n"));
		ok(explainedText.includes("prompt cache: shell reused \u00b7 backend cold"), explainedText);
		ok(explainedText.includes("last cold turn: working-set eviction (expected)"), explainedText);

		const unexplained = renderContextLedgerLines(coldLedger(), 68);
		const unexplainedText = strip(unexplained.join("\n"));
		ok(!unexplainedText.includes("last cold turn:"), unexplainedText);

		// Same words, different token: a cold turn Clio caused is explained, and a
		// cold turn it cannot explain stays the warning it always was.
		strictEqual(strip(cacheLineOf(explained)), strip(cacheLineOf(unexplained)));
		const warning = clioTheme().fgSequence("warning");
		if (warning.length > 0) {
			ok(!cacheLineOf(explained).includes(warning), "an explained cold turn must drop the warning token");
			ok(cacheLineOf(unexplained).includes(warning), "an unexplained cold turn must retain the warning token");
		}
	});

	it("renders backend prefill work and cache reads for the last call", () => {
		const measured = buildContextLedger({
			provider: "mock",
			model: "model-a",
			contextWindow: 4000,
			promptCache: {
				shellReused: true,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				uncachedInputTokens: 500,
				backend: {
					promptTokens: 12_000,
					cachedTokens: 11_500,
					predictedTokens: 40,
					promptMs: 125,
					predictedMs: 80,
					source: "llamacpp-timings",
				},
				uncachedPrefillTokens: 500,
				backendVerdict: "hot",
			},
		});
		const text = strip(renderContextLedgerLines(measured, 68).join("\n"));
		ok(text.includes("prefill: 500 uncached · 11,500 cached · 125 ms"), text);
	});

	it("reports missing cache reads without calling the backend cold", () => {
		const unknown = buildContextLedger({
			provider: "mock",
			model: "model-a",
			contextWindow: 4000,
			promptCache: {
				shellReused: true,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				uncachedInputTokens: 12_000,
				backend: {
					promptTokens: 12_000,
					cachedTokens: null,
					predictedTokens: 40,
					promptMs: 125,
					predictedMs: 80,
					source: "lmstudio-timings",
				},
				uncachedPrefillTokens: null,
				backendVerdict: "cold",
				expectedColdReasons: ["residency"],
			},
		});
		const text = strip(renderContextLedgerLines(unknown, 68).join("\n"));
		ok(text.includes("server does not report cache reads"), text);
		ok(text.includes("prefill: 12,000 prompt · 125 ms"), text);
		ok(!text.includes("backend cold"), text);
		ok(!text.includes("last cold turn:"), text);
	});

	it("names every expected cache disturbance in the last-cold-turn line", () => {
		const cases = [
			["residency", "residency change"],
			["thinking_change", "thinking-level change"],
			["tool_surface_change", "tool-surface change"],
			["prompt_recompiled", "prompt recompile"],
			["background_memory", "background memory step"],
		] as const;
		for (const [reason, label] of cases) {
			const withReason = buildContextLedger({
				provider: "mock",
				model: "model-a",
				contextWindow: 4000,
				promptCache: {
					shellReused: true,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					uncachedInputTokens: 12_000,
					backend: null,
					uncachedPrefillTokens: null,
					backendVerdict: "cold",
					expectedColdReasons: [reason],
				},
			});
			const text = strip(renderContextLedgerLines(withReason, 68).join("\n"));
			ok(text.includes(`last cold turn: ${label} (expected)`), text);
		}
	});

	/**
	 * Both local targets showed `policy none` for a whole session at the
	 * shipped default (issue #190): the line read the last applied policy,
	 * which is stamped only by the first eviction event, and eviction runs only
	 * past `compaction.threshold`. The line now states what is configured and
	 * carries the event state beside it.
	 */
	it("names the configured policy with its state, not the last applied one", () => {
		const fresh = strip(
			renderContextLedgerLines(ledger(), 68, EMPTY_WORKING_SET_VIEW, { enabled: true, policy: "structural-v1" }).join(
				"\n",
			),
		);
		ok(fresh.includes("working set · policy structural-v1 · no events yet"), fresh);
		ok(fresh.includes("0 evicted items · 0 tokens · 0 events"), fresh);

		const disabled = strip(
			renderContextLedgerLines(ledger(), 68, EMPTY_WORKING_SET_VIEW, { enabled: false, policy: "structural-v1" }).join(
				"\n",
			),
		);
		ok(disabled.includes("working set · disabled"), disabled);
		ok(!disabled.includes("policy"), disabled);

		// After an event the state suffix goes away, and a policy change made
		// after that event is visible as the difference between the two.
		const applied = strip(
			renderContextLedgerLines(ledger(), 68, view(), { enabled: true, policy: "age-horizon" }).join("\n"),
		);
		ok(applied.includes("working set · policy age-horizon"), applied);
		ok(!applied.includes("no events yet"), applied);
		const changed = strip(
			renderContextLedgerLines(ledger(), 68, view(), { enabled: true, policy: "structural-v1" }).join("\n"),
		);
		ok(changed.includes("working set · policy structural-v1 (last event by age-horizon)"), changed);
	});

	it("churn is n/a with nothing evicted, and the section is absent without a fold", () => {
		const empty = strip(renderContextLedgerLines(ledger(), 68, EMPTY_WORKING_SET_VIEW).join("\n"));
		ok(empty.includes("working set · policy none"), empty);
		ok(empty.includes("0 evicted items · 0 tokens · 0 events · 0 recalls · churn n/a"), empty);
		ok(!empty.includes("outside window"), empty);
		const withoutView = strip(renderContextLedgerLines(ledger(), 68).join("\n"));
		ok(!withoutView.includes("working set"), withoutView);
		const nullView = strip(renderContextLedgerLines(ledger(), 68, null).join("\n"));
		strictEqual(nullView, withoutView);
	});
});
