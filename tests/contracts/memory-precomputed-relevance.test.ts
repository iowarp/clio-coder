import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { buildMemoryPromptSection, inspectMemoryPromptSelection } from "../../src/domains/memory/prompt-section.js";
import { rankMemoryByPrecomputedScore } from "../../src/domains/memory/relevance.js";
import type { MemoryRecord } from "../../src/domains/memory/types.js";

function record(id: string, patch: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		id,
		scope: "global",
		key: id,
		lesson: "Keep the original evidence.",
		evidenceRefs: ["run:1"],
		appliesWhen: [],
		avoidWhen: [],
		confidence: 0.9,
		createdAt: "2026-09-01T00:00:00.000Z",
		approved: true,
		...patch,
	};
}

const ids = (candidates: ReadonlyArray<{ record: MemoryRecord }>): string[] =>
	candidates.map(({ record }) => record.id);

test("precomputed scores reorder the candidates they cover", () => {
	const records = [record("a"), record("b"), record("c")];
	const ranked = rankMemoryByPrecomputedScore(records, {
		source: "jev",
		scores: { a: 0.1, b: 0.9, c: 0.4 },
	});
	deepStrictEqual(ids(ranked), ["b", "c", "a"]);
	deepStrictEqual(
		ranked.map(({ score }) => score),
		[0.9, 0.4, 0.1],
	);
	strictEqual(ranked[0]?.source, "jev");
});

// An abstention is not a zero. A scored record must never be able to push an
// unscored one down the ranking, because that would read "do not know" as
// "not relevant" and silently drop it at the item limit.
test("an abstention holds the slot the incoming order gave it", () => {
	const records = [record("first"), record("unscored"), record("third"), record("fourth")];
	const ranked = rankMemoryByPrecomputedScore(records, {
		source: "jev",
		scores: { first: 0.1, third: 0.2, fourth: 0.9 },
	});
	deepStrictEqual(ids(ranked), ["fourth", "unscored", "third", "first"]);
	strictEqual(ranked[1]?.score, null);
});

test("a non-finite or mistyped score is read as an abstention, not as zero", () => {
	const records = [record("a"), record("b"), record("c"), record("d")];
	const ranked = rankMemoryByPrecomputedScore(records, {
		source: "jev",
		scores: { a: Number.NaN, b: Number.POSITIVE_INFINITY, c: 0.5, d: 0.6 },
	});
	deepStrictEqual(ids(ranked), ["a", "b", "d", "c"]);
	deepStrictEqual(
		ranked.map(({ score }) => score),
		[null, null, 0.6, 0.5],
	);
});

test("equal scores keep the incoming order and every record survives ranking", () => {
	const records = [record("a"), record("b"), record("c")];
	const ranked = rankMemoryByPrecomputedScore(records, { source: "jev", scores: { a: 0.5, b: 0.5, c: 0.5 } });
	deepStrictEqual(ids(ranked), ["a", "b", "c"]);
	deepStrictEqual(ids(rankMemoryByPrecomputedScore(records, { source: "jev", scores: {} })), ["a", "b", "c"]);
});

test("an empty score map leaves the selection byte-identical to the legacy one", () => {
	const records = [record("a"), record("b", { createdAt: "2026-09-20T00:00:00.000Z" })];
	const legacy = buildMemoryPromptSection(records, { maxItems: 1 });
	const scored = buildMemoryPromptSection(records, {
		maxItems: 1,
		precomputedRelevance: { source: "jev", scores: {} },
	});
	strictEqual(scored.section, legacy.section);
	deepStrictEqual(
		scored.records.map(({ id }) => id),
		legacy.records.map(({ id }) => id),
	);
});

test("precomputed scores drive prompt selection and are reported per decision", () => {
	const records = [
		record("old", { lesson: "Compaction must retain evidence." }),
		record("recent", { createdAt: "2026-09-20T00:00:00.000Z" }),
	];
	const result = inspectMemoryPromptSelection(records, {
		maxItems: 1,
		precomputedRelevance: { source: "jev", scores: { old: 0.95, recent: 0.05 } },
	});
	deepStrictEqual(
		result.records.map(({ id }) => id),
		["old"],
	);
	deepStrictEqual(
		result.decisions.map(({ id, reason, precomputed }) => [id, reason, precomputed?.score]),
		[
			["old", "selected", 0.95],
			["recent", "item-limit", 0.05],
		],
	);
	strictEqual(result.decisions[0]?.relevance, undefined);
});

// Both rankers are orthogonal: lexical sets the base order, precomputed
// permutes what it scored inside it, and each reports its own diagnostics.
test("precomputed scores compose with the lexical ranker rather than replacing it", () => {
	const records = [
		record("general", { lesson: "Preserve operator authority." }),
		record("a", { lesson: "Compaction receipts persist before reduction." }),
		record("b", { lesson: "Compaction summaries cite sources." }),
	];
	const relevance = { taskText: "compaction" };
	const lexicalOnly = inspectMemoryPromptSelection(records, { relevance });
	deepStrictEqual(
		lexicalOnly.decisions.map(({ id }) => id),
		["a", "general", "b"],
	);
	const combined = inspectMemoryPromptSelection(records, {
		relevance,
		precomputedRelevance: { source: "jev", scores: { a: 0.2, b: 0.8 } },
	});
	deepStrictEqual(
		combined.decisions.map(({ id }) => id),
		["b", "general", "a"],
	);
	strictEqual(combined.decisions.find(({ id }) => id === "general")?.relevance?.fallback, true);
	strictEqual(combined.decisions.find(({ id }) => id === "general")?.precomputed?.score, null);
	strictEqual(combined.decisions.find(({ id }) => id === "b")?.relevance?.matches.taskTerms[0], "compaction");
});

test("precomputed ranking cannot bypass eligibility gates or budget limits", () => {
	const records = [
		record("safe"),
		record("unapproved", { approved: false }),
		record("no-evidence", { evidenceRefs: [] }),
		record("regressed", { regressions: ["run:bad"] }),
		record("wrong-repo", { scope: "repo", repository: { kind: "canonical-path", key: "/other" } }),
	];
	const precomputedRelevance = {
		source: "jev",
		scores: { unapproved: 1, "no-evidence": 1, regressed: 1, "wrong-repo": 1, safe: 0.01 },
	};
	deepStrictEqual(
		inspectMemoryPromptSelection(records, { precomputedRelevance }).decisions.map(({ id }) => id),
		["safe"],
	);
	strictEqual(buildMemoryPromptSection(records, { precomputedRelevance, tokenBudget: 1 }).section, "");
});

test("scoring a record that is not a candidate changes nothing", () => {
	const records = [record("a"), record("b")];
	const ranked = rankMemoryByPrecomputedScore(records, { source: "jev", scores: { ghost: 1, a: 0.3, b: 0.4 } });
	deepStrictEqual(ids(ranked), ["b", "a"]);
});
