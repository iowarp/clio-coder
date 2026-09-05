import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Codewiki } from "../../src/domains/context/codewiki/schema.js";
import { readWikiPage, renderWikiPage } from "../../src/domains/context/wiki/frontmatter.js";
import { buildWikiPagePrompt } from "../../src/domains/context/wiki/prompts.js";
import type { DecisionLedgerEntry } from "../../src/domains/session/entries.js";
import { agentDecision } from "../harness/decision.js";

const codewiki: Codewiki = {
	version: 5,
	language: "typescript",
	files: [{ id: "cache", path: "src/cache.ts", lang: "typescript", loc: 20, role: "module", hash: "hash", imports: [] }],
	symbols: [{ name: "main", kind: "func", fileId: "cache", line: 1 }],
	edges: [],
};
function prompt(decisions: DecisionLedgerEntry[], sources = ["src/cache.ts"]) {
	return buildWikiPagePrompt({
		cwd: process.cwd(),
		mode: "init",
		codewiki,
		decisions,
		page: { path: "cache.md", title: "Cache", intent: "Explain the cache", sources, status: "pending", attempts: 0 },
		siblings: [],
		outputDir: "/staging",
		seeded: false,
	});
}
function records(text: string): Array<Record<string, unknown>> {
	const block = /# Recorded decisions\s+```json\s+([\s\S]*?)\s+```/u.exec(text);
	return block ? JSON.parse(block[1] ?? "[]") : [];
}

describe("wiki page decision prompts", () => {
	it("carries recorded arguments, origin, timestamp and refs and instructs citation", async () => {
		const entry = await agentDecision();
		const text = prompt([entry]);
		const record = records(text)[0];
		strictEqual(record?.key, "cache-key");
		strictEqual(record?.value, "capability tuple");
		strictEqual(record?.source, "agent");
		strictEqual(record?.decidedAt, entry.decisions[0]?.decidedAt);
		deepStrictEqual(record?.alternatives, entry.decisions[0]?.alternatives);
		strictEqual(record?.rationale, entry.decisions[0]?.rationale);
		strictEqual(record?.ref, `${entry.interviewId}/cache-key`);
		match(text, /cite its refs in the body/u);
		match(text, /instead of inferring/u);
	});
	it("matches symbols and descendant paths, excludes unrelated and superseded records, and caps at twelve", async () => {
		const entry = await agentDecision();
		const base = entry.decisions[0];
		if (!base) throw new Error("missing decision");
		const operator = { ...base };
		delete operator.source;
		strictEqual(
			records(
				prompt([
					{
						...entry,
						origin: "interview",
						decisions: [{ ...operator, key: "main", rationale: "because", alternatives: [] }],
					},
				]),
			)[0]?.source,
			"operator",
		);
		strictEqual(records(prompt([entry], ["src"])).length, 1);
		doesNotMatch(prompt([entry], ["src/cach"]), /# Recorded decisions/u);
		doesNotMatch(
			prompt([{ ...entry, decisions: [{ ...base, status: "superseded", revisedAt: base.decidedAt }] }]),
			/# Recorded decisions/u,
		);
		doesNotMatch(prompt([]), /# Recorded decisions/u);
		const many = { ...entry, decisions: Array.from({ length: 16 }, (_, i) => ({ ...base, key: `key-${i}` })) };
		strictEqual(records(prompt([many])).length, 12);
		strictEqual(records(prompt([many]))[11]?.key, "key-11");
		strictEqual(
			records(prompt([{ ...entry, decisions: [{ ...base, rationale: "src/cache.ts.bak", alternatives: [] }] }])).length,
			0,
		);
	});
	it("retains optional cited refs through frontmatter repair and rendering", () => {
		const parsed = readWikiPage({
			pagePath: "cache.md",
			content:
				"---\ntitle: Cache\ndecisions:\n  - agent:set/cache-key\n  - agent:set/cache-key\n---\n# Cache\n\nRecorded choice.",
		});
		deepStrictEqual(parsed.metadata.decisions, ["agent:set/cache-key"]);
		deepStrictEqual(
			readWikiPage({ pagePath: "cache.md", content: renderWikiPage(parsed.metadata, parsed.body) }).metadata.decisions,
			parsed.metadata.decisions,
		);
		strictEqual(readWikiPage({ pagePath: "old.md", content: "# Old" }).metadata.decisions, undefined);
	});
});
