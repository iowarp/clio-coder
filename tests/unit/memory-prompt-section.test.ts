import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildMemoryPromptSection,
	MEMORY_PROMPT_DEFAULT_MAX_ITEMS,
	type MemoryRecord,
	memoryIdFromEvidence,
	renderMemoryPromptSection,
	selectMemoryForPrompt,
} from "../../src/domains/memory/index.js";

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	const id = overrides.id ?? memoryIdFromEvidence("default");
	return {
		id,
		scope: "repo",
		key: `evidence:${id}`,
		lesson: "Use cited evidence before preserving this workflow lesson.",
		evidenceRefs: ["default"],
		appliesWhen: [],
		avoidWhen: [],
		confidence: 0.6,
		createdAt: "2026-04-29T00:00:00.000Z",
		approved: false,
		...overrides,
	};
}

describe("memory prompt section", () => {
	it("injects approved, in-scope, evidence-linked memory only", () => {
		const approved = record({
			id: memoryIdFromEvidence("approved"),
			evidenceRefs: ["approved"],
			approved: true,
			lastVerifiedAt: "2026-04-29T00:00:00.000Z",
			lesson: "Run the repo verifier before claiming completion.",
		});
		const proposed = record({
			id: memoryIdFromEvidence("proposed"),
			evidenceRefs: ["proposed"],
			approved: false,
		});
		const rejected = record({
			id: memoryIdFromEvidence("rejected"),
			evidenceRefs: ["rejected"],
			approved: false,
			rejectedAt: "2026-04-29T00:01:00.000Z",
		});
		const regressed = record({
			id: memoryIdFromEvidence("regressed"),
			evidenceRefs: ["regressed"],
			approved: true,
			lastVerifiedAt: "2026-04-29T00:02:00.000Z",
			regressions: ["eval-x"],
		});
		const noEvidence = record({
			id: memoryIdFromEvidence("no-evidence"),
			evidenceRefs: [],
			approved: true,
			lastVerifiedAt: "2026-04-29T00:03:00.000Z",
		});
		const outOfScope = record({
			id: memoryIdFromEvidence("hpc"),
			scope: "hpc-domain",
			evidenceRefs: ["hpc"],
			approved: true,
			lastVerifiedAt: "2026-04-29T00:04:00.000Z",
		});

		const selected = selectMemoryForPrompt([approved, proposed, rejected, regressed, noEvidence, outOfScope]);

		deepStrictEqual(
			selected.map((r) => r.id),
			[approved.id],
		);
	});

	it("omits the section entirely when no memory applies", () => {
		const built = buildMemoryPromptSection([]);
		strictEqual(built.section, "");
		strictEqual(built.records.length, 0);
		strictEqual(built.tokens, 0);
	});

	it("only emits the section when at least one approved record applies", () => {
		const proposed = record({
			id: memoryIdFromEvidence("only-proposed"),
			evidenceRefs: ["only-proposed"],
			approved: false,
		});
		const built = buildMemoryPromptSection([proposed]);
		strictEqual(built.section, "");
		strictEqual(built.records.length, 0);
	});

	it("orders the section deterministically by recency, then id", () => {
		const recordsInput: MemoryRecord[] = [];
		for (let i = 0; i < 4; i += 1) {
			recordsInput.push(
				record({
					id: memoryIdFromEvidence(`mem-${i}`),
					evidenceRefs: [`mem-${i}`],
					approved: true,
					lastVerifiedAt: `2026-04-29T00:0${i}:00.000Z`,
					lesson: `lesson ${i}`,
				}),
			);
		}
		const reversed = [...recordsInput].reverse();
		const a = selectMemoryForPrompt(reversed);
		const b = selectMemoryForPrompt(recordsInput);
		deepStrictEqual(
			a.map((r) => r.id),
			b.map((r) => r.id),
		);
		// Most recent verified record comes first.
		strictEqual(a[0]?.lastVerifiedAt, "2026-04-29T00:03:00.000Z");
	});

	it("enforces the max item count even when budget allows more", () => {
		const oversize: MemoryRecord[] = [];
		for (let i = 0; i < MEMORY_PROMPT_DEFAULT_MAX_ITEMS + 3; i += 1) {
			oversize.push(
				record({
					id: memoryIdFromEvidence(`many-${i}`),
					evidenceRefs: [`many-${i}`],
					approved: true,
					lastVerifiedAt: `2026-04-29T00:0${i % 6}:0${i % 10}.000Z`,
					lesson: `lesson ${i}`,
				}),
			);
		}
		const selected = selectMemoryForPrompt(oversize, { tokenBudget: 10_000 });
		strictEqual(selected.length, MEMORY_PROMPT_DEFAULT_MAX_ITEMS);
	});

	it("respects the token budget", () => {
		const big = record({
			id: memoryIdFromEvidence("big"),
			evidenceRefs: ["big"],
			approved: true,
			lastVerifiedAt: "2026-04-29T00:05:00.000Z",
			lesson: "x".repeat(2000),
		});
		const tiny = record({
			id: memoryIdFromEvidence("tiny"),
			evidenceRefs: ["tiny"],
			approved: true,
			lastVerifiedAt: "2026-04-29T00:06:00.000Z",
			lesson: "short lesson",
		});
		const selected = selectMemoryForPrompt([big, tiny], { tokenBudget: 50 });
		// The 2000-char lesson estimates ~500 tokens; the small one fits.
		ok(selected.every((r) => r.id !== big.id));
		ok(selected.some((r) => r.id === tiny.id));
	});

	it("renders evidence ids and scope into the section text", () => {
		const approved = record({
			id: memoryIdFromEvidence("rendered"),
			scope: "global",
			evidenceRefs: ["evidence-7", "evidence-8"],
			approved: true,
			lastVerifiedAt: "2026-04-29T00:07:00.000Z",
			lesson: "Always preserve  validated   artifacts.",
		});
		const text = renderMemoryPromptSection([approved]);
		ok(text.startsWith("# Memory"));
		ok(text.includes(`[${approved.id}]`));
		ok(text.includes("scope=global"));
		ok(text.includes("Evidence: evidence-7, evidence-8."));
		ok(text.includes("Always preserve validated artifacts."));
	});

	it("returns an empty section when budget or maxItems is zero", () => {
		const approved = record({
			id: memoryIdFromEvidence("approved"),
			evidenceRefs: ["approved"],
			approved: true,
			lastVerifiedAt: "2026-04-29T00:00:00.000Z",
		});
		strictEqual(selectMemoryForPrompt([approved], { tokenBudget: 0 }).length, 0);
		strictEqual(selectMemoryForPrompt([approved], { maxItems: 0 }).length, 0);
	});
});
