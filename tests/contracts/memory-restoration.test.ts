import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { renderMemoryRestoration } from "../../src/domains/memory/restoration.js";
import type { TaskMemoryEntry, TaskMemorySnapshot } from "../../src/domains/memory/task-bank.js";

function entry(id: string, kind: TaskMemoryEntry["kind"], content: string): TaskMemoryEntry {
	return {
		id,
		kind,
		content,
		createdAt: "2026-09-21T14:50:00.000Z",
		lastTouchedAt: "2026-09-21T15:20:00.000Z",
		injectionCount: 0,
	};
}

// Audit provenance: reports/memory-audit-01/BANK.md, row-01, row-08 and row-18.
// Content below reconstructs their UI-wrapped lines using single spaces; dates
// are synthetic for deterministic ordering. It is remembered, unverified text,
// not approved durable memory or independent evidence of the retry inference.
const audit: TaskMemorySnapshot = {
	version: 1,
	status: entry(
		"tm-s-1",
		"status",
		"Review fixes in progress: added regression tests for identity/epoch distinction and unknown→known re-arm; test run shows 8 failures; source edit to pressure.ts failed on oldText mismatch at edits[9].",
	),
	knowledge: [
		entry(
			"tm-k-d",
			"knowledge",
			"src/core/defaults.ts defines retry budgets: maxRetries defaults to 2 (lines 534, 672) and timeoutMs defaults to 60000 (line 700); these are the finite transaction vs transport retry budget anchors for CONTRACTS.md.",
		),
	],
	procedural: [
		entry(
			"tm-p-b",
			"procedural",
			"Source sampling shows captureRuntimeContextSnapshot identity lives near src/domains/session/context-accounting.ts (compactionThresholds, effectiveContextWindow) while TurnContext is defined in src/interactive/turn-context.ts; these are the seams to cite for budget/runtime contracts.",
		),
	],
};

test("supplied current handoff suppresses stale audit status without inserting the handoff again", () => {
	const current =
		"Current authoritative handoff: final validation reports 32 passed and 0 failed; use the corrected summary retry contract.";
	const result = renderMemoryRestoration({
		bank: audit,
		currentState: { kind: "handoff", text: current },
		maxTokens: 1000,
	});
	ok(!result.message.includes("8 failures"));
	ok(!result.message.includes("32 passed"));
	ok(!result.message.includes(current));
	ok(result.message.includes("unverified"));
	ok(result.message.includes("[tm-p-b] remembered procedural"));
	ok(result.message.includes("[tm-k-d] remembered knowledge"));
	deepStrictEqual(result.omittedEntryIds, ["tm-s-1"]);
});

test("without current state, private status is historical and remembered inference is never labelled verified", () => {
	const result = renderMemoryRestoration({ bank: audit, currentState: null, maxTokens: 1000 });
	ok(result.message.includes("[tm-s-1] historical status"));
	ok(result.message.includes("unverified"));
	ok(result.message.includes("8 failures"), "preserve history rather than inventing a corrected result");
	ok(!result.message.includes("32 passed"));
	strictEqual(result.citedEntryIds.length, 3);
});

test("summary state has the same status precedence and never duplicates its supplied text", () => {
	const result = renderMemoryRestoration({
		bank: audit,
		currentState: { kind: "summary", text: "UNIQUE CURRENT SUMMARY" },
		maxTokens: 1000,
	});
	ok(!result.message.includes("tm-s-1"));
	ok(!result.message.includes("UNIQUE CURRENT SUMMARY"));
});

test("blank current-state placeholders cannot suppress historical status", () => {
	for (const text of ["", " \n\t "]) {
		const result = renderMemoryRestoration({ bank: audit, currentState: { kind: "handoff", text }, maxTokens: 1000 });
		ok(result.message.includes("[tm-s-1] historical status"));
		ok(!result.omittedEntryIds.includes("tm-s-1"));
	}
});

test("remembered source is losslessly quoted; normalization never rewrites its whitespace", () => {
	const content = '  Inspect\n\tthe "exact" source.  ';
	const bank: TaskMemorySnapshot = {
		version: 1,
		status: null,
		knowledge: [entry("quoted", "knowledge", content)],
		procedural: [],
	};
	const result = renderMemoryRestoration({ bank, currentState: null, maxTokens: 200 });
	const quote = result.message.split("remembered knowledge: ")[1];
	ok(quote);
	strictEqual(JSON.parse(quote), content);
	strictEqual(bank.knowledge[0]?.content, content);
});

test("only exact whitespace-normalized derivatives collapse, retaining knowledge and procedure provenance", () => {
	// Synthetic duplicate derivative inspired by tm-k-5 / tm-p-4 drift notes.
	// The original two notes differ; this fixture deliberately duplicates one
	// normalized sentence, and does not assert originals are semantically equal.
	const bank: TaskMemorySnapshot = {
		version: 1,
		status: null,
		knowledge: [
			entry("tm-k-5-derived", "knowledge", "The installed skill carries a drift warning."),
			entry("near-duplicate", "knowledge", "The installed skill carries a drift warning!"),
		],
		procedural: [entry("tm-p-4-derived", "procedural", "The installed\n skill carries\t a drift warning.")],
	};
	const result = renderMemoryRestoration({ bank, currentState: null, maxTokens: 400 });
	strictEqual(result.message.split("The installed skill carries a drift warning.").length - 1, 1);
	ok(result.message.includes("The installed skill carries a drift warning!"));
	ok(result.message.includes("[tm-k-5-derived] [tm-p-4-derived]"));
	strictEqual(result.citedEntryIds.length, 3);
	strictEqual(bank.procedural[0]?.content, "The installed\n skill carries\t a drift warning.");
});

test("full Unicode wrapper, labels and all duplicate reference IDs fit the exact estimator budget", () => {
	const bank: TaskMemorySnapshot = {
		version: 1,
		status: null,
		knowledge: [entry("知識-".repeat(20), "knowledge", "🧪 証拠を確認する")],
		procedural: [entry("手順-".repeat(20), "procedural", "🧪 証拠を確認する")],
	};
	const full = renderMemoryRestoration({ bank, currentState: null, maxTokens: 1000 });
	const required = Math.ceil(full.message.length / 4);
	strictEqual(full.tokens, required);
	const exact = renderMemoryRestoration({ bank, currentState: null, maxTokens: required });
	strictEqual(exact.message, full.message);
	const small = renderMemoryRestoration({ bank, currentState: null, maxTokens: required - 1 });
	strictEqual(small.message, "");
	strictEqual(small.tokens, 0);
	deepStrictEqual(small.citedEntryIds, []);
	strictEqual(small.omittedEntryIds.length, 2);
});

test("a long historical row does not block a later fitting procedural reference", () => {
	const bank: TaskMemorySnapshot = {
		version: 1,
		status: entry("old-status", "status", "historical detail ".repeat(100)),
		knowledge: [],
		procedural: [entry("procedure", "procedural", "Inspect the receipt.")],
	};
	const result = renderMemoryRestoration({ bank, currentState: null, maxTokens: 60 });
	deepStrictEqual(result.citedEntryIds, ["procedure"]);
	deepStrictEqual(result.omittedEntryIds, ["old-status"]);
	ok(result.tokens <= 60);
});

test("ties are independent of input order; timestamps remain recency rather than claimed verification", () => {
	const bank: TaskMemorySnapshot = {
		version: 1,
		status: null,
		knowledge: [entry("b", "knowledge", "Second source."), entry("a", "knowledge", "First source.")],
		procedural: [entry("c", "procedural", "Third source.")],
	};
	const first = renderMemoryRestoration({ bank, currentState: null, maxTokens: 400 });
	const second = renderMemoryRestoration({
		bank: { ...bank, knowledge: [...bank.knowledge].reverse() },
		currentState: null,
		maxTokens: 400,
	});
	deepStrictEqual(first, second);
	deepStrictEqual(first.citedEntryIds, ["a", "b", "c"]);
	ok(!first.message.includes("2026-09-21"));
	for (const value of [first, first.citedEntryIds, first.omittedEntryIds]) ok(Object.isFrozen(value));
});

test("invalid or empty budgets never emit a wrapper-only message or expand the cap", () => {
	for (const maxTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1]) {
		const result = renderMemoryRestoration({ bank: audit, currentState: null, maxTokens });
		strictEqual(result.message, "");
		strictEqual(result.tokens, 0);
		deepStrictEqual(result.citedEntryIds, []);
	}
	strictEqual(
		renderMemoryRestoration({
			bank: { version: 1, status: null, knowledge: [], procedural: [] },
			currentState: null,
			maxTokens: 100,
		}).message,
		"",
	);
});
