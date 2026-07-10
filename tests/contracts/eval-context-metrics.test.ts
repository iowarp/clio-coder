import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildCodewiki, structuralCodewikiHash, writeCodewiki } from "../../src/domains/context/index.js";
import { collectContextMetrics } from "../../src/domains/eval/metrics/context.js";

describe("contracts/eval context metrics", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-eval-context-metrics-"));
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "context-metrics", type: "module" }), "utf8");
		writeFileSync(join(scratch, "indexed.ts"), "export const indexed = true;\n", "utf8");
	});

	afterEach(() => rmSync(scratch, { recursive: true, force: true }));

	it("reports source coverage, stable structure, and a nonzero rendered digest", async () => {
		const codewiki = await buildCodewiki({ cwd: scratch, language: "typescript" });
		writeCodewiki(scratch, codewiki);
		// Added after the index: the collector must report partial source coverage,
		// not the former binary 1 and not count package.json as a source file.
		writeFileSync(join(scratch, "not-indexed.ts"), "export const missing = true;\n", "utf8");

		const metrics = collectContextMetrics(scratch);
		strictEqual(metrics["context.indexedFiles"], 1);
		strictEqual(metrics["context.artifactFiles"], 1);
		strictEqual(metrics["context.staleFiles"], 0);
		strictEqual(metrics["context.coverage"], 0.5);
		strictEqual(metrics["context.structuralHash"], structuralCodewikiHash(codewiki));
		const digestTokens = metrics["context.digestTokens"];
		ok(typeof digestTokens === "number" && digestTokens > 0);
	});

	it("does not count deleted ghost entries as indexed or fully covered", async () => {
		const codewiki = await buildCodewiki({ cwd: scratch, language: "typescript" });
		writeCodewiki(scratch, codewiki);
		rmSync(join(scratch, "indexed.ts"));

		const metrics = collectContextMetrics(scratch);
		strictEqual(metrics["context.indexedFiles"], 0);
		strictEqual(metrics["context.artifactFiles"], 1);
		strictEqual(metrics["context.staleFiles"], 1);
		strictEqual(metrics["context.coverage"], 0);
	});
});
