import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { searchDocs } from "../../src/tools/context/docs-engine.js";

const corpus = JSON.parse(
	readFileSync(new URL("../../evals/fixtures/docs-retrieval.json", import.meta.url), "utf8"),
) as Array<{ query: string; file: string; heading: string }>;

test("bundled docs retrieval preserves reference-section recall at the shipped k=5", () => {
	const misses: string[] = [];
	for (const fixture of corpus) {
		const outcome = searchDocs(fixture.query, undefined);
		assert.ok(outcome.ok);
		const results = outcome.payload.results as Array<{ file: string; heading: string }>;
		assert.ok(results.length <= 5);
		if (!results.some((row) => row.file === fixture.file && row.heading === fixture.heading)) misses.push(fixture.query);
	}
	assert.equal(
		misses.length,
		0,
		`recall@5=${(corpus.length - misses.length) / corpus.length}; missing: ${misses.join("; ")}`,
	);
	// An unrelated query is a negative control: the evaluator must reject a
	// retriever returning irrelevant sections rather than merely count results.
	const wrong = searchDocs("zzzxxyyqqqq", undefined);
	assert.ok(wrong.ok);
	assert.equal(wrong.resultCount, 0);
});
