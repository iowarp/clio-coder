import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	buildMemoryPromptSection,
	inspectMemoryPromptSelection,
	renderMemoryPromptSection,
} from "../../src/domains/memory/prompt-section.js";
import { rankMemoryByRelevance } from "../../src/domains/memory/relevance.js";
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

test("the entire rendered memory section must fit, including its fixed header", () => {
	const item = record("one");
	const required = Math.ceil(renderMemoryPromptSection([item]).length / 4);
	const tooSmall = buildMemoryPromptSection([item], { tokenBudget: required - 1 });
	deepStrictEqual(tooSmall.records, []);
	strictEqual(tooSmall.section, "");
	strictEqual(tooSmall.tokens, 0);
	const exact = buildMemoryPromptSection([item], { tokenBudget: required });
	deepStrictEqual(
		exact.records.map(({ id }) => id),
		["one"],
	);
	strictEqual(exact.tokens, required);
	ok(exact.tokens <= required);
});

test("legacy priority stays default while relevance requires explicit input", () => {
	const old = record("old", { lesson: "Compaction must retain exact evidence references." });
	const recent = record("recent", {
		lesson: "A linter accepts this formatting.",
		createdAt: "2026-09-20T00:00:00.000Z",
	});
	const records = [old, recent];
	deepStrictEqual(
		buildMemoryPromptSection(records, { maxItems: 1 }).records.map(({ id }) => id),
		["recent"],
	);
	deepStrictEqual(
		buildMemoryPromptSection(records, { maxItems: 1, relevance: { taskText: "compaction evidence" } }).records.map(
			({ id }) => id,
		),
		["old"],
	);
});

test("high lexical overlap cannot bypass approval, evidence, regression, scopes, or identities", () => {
	const relevant = { lesson: "compaction evidence budget" };
	const records = [
		record("safe"),
		record("unapproved", { ...relevant, approved: false }),
		record("no-evidence", { ...relevant, evidenceRefs: [] }),
		record("regressed", { ...relevant, regressions: ["run:bad"] }),
		record("wrong-repo", { ...relevant, scope: "repo", repository: { kind: "canonical-path", key: "/other" } }),
		record("missing-repo", { ...relevant, scope: "repo" }),
		record("wrong-runtime", { ...relevant, scope: "runtime", runtime: { kind: "runtime", key: "other" } }),
		record("wrong-agent", { ...relevant, scope: "agent", agent: { kind: "agent", key: "other" } }),
		record("excluded-scope", { ...relevant, scope: "language" }),
	];
	const options = {
		scopes: ["global", "repo", "runtime", "agent"] as const,
		activeRepository: { kind: "canonical-path", key: "/active" } as const,
		activeRuntime: { kind: "runtime", key: "active" } as const,
		activeAgent: { kind: "agent", key: "active" } as const,
		relevance: { taskText: "compaction evidence budget" },
	};
	const result = inspectMemoryPromptSelection(records, options);
	deepStrictEqual(
		result.decisions.map(({ id }) => id),
		["safe"],
	);
	for (const scope of ["repo", "runtime", "agent"] as const) {
		const scoped = record(scope, {
			...relevant,
			scope,
			repository: options.activeRepository,
			runtime: options.activeRuntime,
			agent: options.activeAgent,
		});
		strictEqual(
			buildMemoryPromptSection([scoped], { ...options, activeRepository: null, activeRuntime: null, activeAgent: null })
				.records.length,
			0,
		);
		strictEqual(buildMemoryPromptSection([scoped], options).records.length, 1);
	}
});

test("Unicode, long evidence, identity, and applicability text all consume the rendered budget", () => {
	const item = record("unicode", {
		scope: "repo",
		repository: { kind: "canonical-path", key: "/場所/研究" },
		lesson: "🧪 重試には証拠が必要です",
		evidenceRefs: ["証拠".repeat(80)],
		appliesWhen: ["計算\n実行"],
		avoidWhen: ["未承認の設定"],
	});
	const section = renderMemoryPromptSection([item]);
	ok(item.repository);
	ok(section.includes("Applies when: 計算 実行."));
	ok(section.includes("Avoid when: 未承認の設定."));
	const required = Math.ceil(section.length / 4);
	strictEqual(
		buildMemoryPromptSection([item], { activeRepository: item.repository, tokenBudget: required }).tokens,
		required,
	);
	strictEqual(
		buildMemoryPromptSection([item], { activeRepository: item.repository, tokenBudget: required - 1 }).section,
		"",
	);
});

test("oversized high-priority records do not starve a later fitting lesson", () => {
	const big = record("big", { lesson: "x".repeat(2000), createdAt: "2026-09-20T00:00:00.000Z" });
	const small = record("small");
	const result = inspectMemoryPromptSelection([big, small], { tokenBudget: 100, maxItems: 1 });
	deepStrictEqual(
		result.records.map(({ id }) => id),
		["small"],
	);
	deepStrictEqual(
		result.decisions.map(({ id, reason }) => ({ id, reason })),
		[
			{ id: "big", reason: "token-budget" },
			{ id: "small", reason: "selected" },
		],
	);
});

test("one zero-overlap fallback has an opportunity and a measurable relevant-item cost", () => {
	const records = [
		record("general", { lesson: "Preserve operator authority." }),
		record("a", { lesson: "Compaction receipts persist before reduction." }),
		record("b", { lesson: "Compaction summaries cite sources." }),
	];
	const result = inspectMemoryPromptSelection(records, { maxItems: 2, relevance: { taskText: "compaction" } });
	deepStrictEqual(
		result.records.map(({ id }) => id),
		["a", "general"],
	);
	strictEqual(result.decisions.find(({ id }) => id === "general")?.relevance?.fallback, true);
	strictEqual(result.decisions.find(({ id }) => id === "b")?.reason, "item-limit");
});

test("a general fallback is a budget opportunity, not a guaranteed semantic constraint", () => {
	const records = [
		record("general", { lesson: "Preserve operator authority. ".repeat(50) }),
		record("a", { lesson: "Compaction receipts persist." }),
		record("b", { lesson: "Compaction cites sources." }),
	];
	const result = inspectMemoryPromptSelection(records, {
		tokenBudget: 120,
		maxItems: 2,
		relevance: { taskText: "compaction" },
	});
	deepStrictEqual(
		result.records.map(({ id }) => id),
		["a", "b"],
	);
	strictEqual(result.decisions.find(({ id }) => id === "general")?.reason, "token-budget");
});

test("paths and symbols match exact lexical features, with stable independent input ordering", () => {
	const records = [
		record("a", { lesson: "Inspect src/context.ts and resolveReserve." }),
		record("b", { lesson: "Inspect src/context.ts and resolveReserve." }),
		record("substring", { lesson: "Inspect oldsrc/context.ts and resolveReserveElsewhere." }),
	];
	const input = { taskText: "", activePaths: ["./src/context.ts"], activeSymbols: ["resolveReserve"] };
	const first = rankMemoryByRelevance(records, {}, input);
	const second = rankMemoryByRelevance([...records].reverse(), {}, input);
	deepStrictEqual(
		first.map(({ record, score }) => [record.id, score]),
		second.map(({ record, score }) => [record.id, score]),
	);
	strictEqual(first.find(({ record }) => record.id === "substring")?.score, 0);
	deepStrictEqual(first[0]?.matches, { taskTerms: [], paths: ["src/context.ts"], symbols: ["resolvereserve"] });
	const section = buildMemoryPromptSection(records, { relevance: input }).section;
	strictEqual(section, buildMemoryPromptSection([...records].reverse(), { relevance: input }).section);
	ok(!section.includes("score="));
});

test("normalization is deterministic and duplicate features cannot inflate scores", () => {
	const records = [record("match", { lesson: "Résumé Δοκιμή resolveReserve" })];
	const once = rankMemoryByRelevance(records, {}, { taskText: "RÉSUMÉ ΔΟΚΙΜΉ", activeSymbols: ["resolveReserve"] });
	const twice = rankMemoryByRelevance(
		records,
		{},
		{ taskText: "RÉSUMÉ ΔΟΚΙΜΉ RÉSUMÉ", activeSymbols: ["resolveReserve", "resolveReserve"] },
	);
	deepStrictEqual(once, twice);
	ok((once[0]?.score ?? 0) > 0);
});

test("empty overlap keeps legacy ties and invalid budgets fail closed", () => {
	const records = [record("b"), record("a")];
	deepStrictEqual(
		buildMemoryPromptSection(records, { relevance: { taskText: "unrelated" } }).records.map(({ id }) => id),
		["a", "b"],
	);
	for (const tokenBudget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		strictEqual(buildMemoryPromptSection(records, { tokenBudget }).section, "");
	}
	for (const maxItems of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		strictEqual(buildMemoryPromptSection(records, { maxItems }).section, "");
	}
});
