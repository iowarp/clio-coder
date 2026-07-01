import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { docsSearchTool } from "../../src/tools/docs-search.js";

interface DocHit {
	rank: number;
	file: string;
	heading: string;
	breadcrumb: string;
	lines: { start: number; end: number };
	snippetLines: { start: number; end: number };
	snippet: string;
	score: number;
	coverage: number;
	matchedTerms: string[];
	signals: string[];
}

function parsePayload(output: string): {
	version: number;
	query: string;
	corpus: { docs: number; sections: number; excludes: string[] };
	terms: { query: string[]; expanded: string[]; phrases: string[] };
	resultCount: number;
	results: DocHit[];
} {
	const json = output.split("\n[", 1)[0] ?? output;
	return JSON.parse(json) as {
		version: number;
		query: string;
		corpus: { docs: number; sections: number; excludes: string[] };
		terms: { query: string[]; expanded: string[]; phrases: string[] };
		resultCount: number;
		results: DocHit[];
	};
}

// docs_search resolves the bundled docs directory through resolvePackageRoot,
// so a CLIO_PACKAGE_ROOT fixture makes the contract hermetic: a known docs set
// instead of the shipped wording. resolvePackageRoot caches its first
// resolution per process, so one fixture serves the whole file.
describe("contracts/docs_search", () => {
	let scratch: string;
	let previousRoot: string | undefined;

	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-docs-search-"));
		const docs = join(scratch, "docs");
		mkdirSync(docs, { recursive: true });
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
		writeFileSync(
			join(docs, "safety-model.md"),
			[
				"# Safety Model",
				"",
				"Clio's safety net is level-independent and never loosened by autonomy.",
				"",
				"## Autonomy levels",
				"",
				"Autonomy levels map each action class to run, ask, or deny. The default level is auto-edit.",
				"",
				"## Fleet dispatch",
				"",
				"Dispatch admission gating prevents worker permission levels from exceeding the orchestrator max.",
				"",
			].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(docs, "configuration-and-targets.md"),
			[
				"# Configuration and Targets",
				"",
				"## Targets",
				"",
				"A target is a configured model endpoint with a runtime, models, and auth.",
				"",
				"## Settings precedence",
				"",
				"Settings layer built-in, then user, then project scopes; project settings override user settings.",
				"",
			].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(docs, "observability.md"),
			[
				"# Observability",
				"",
				"## Receipts and evidence",
				"",
				"Receipts record dispatch outcomes, findings summaries, and accountability evidence.",
				"",
			].join("\n"),
			"utf8",
		);
		previousRoot = process.env.CLIO_PACKAGE_ROOT;
		process.env.CLIO_PACKAGE_ROOT = scratch;
	});

	after(() => {
		if (previousRoot === undefined) delete process.env.CLIO_PACKAGE_ROOT;
		else process.env.CLIO_PACKAGE_ROOT = previousRoot;
		rmSync(scratch, { recursive: true, force: true });
	});

	it("returns a cited, bounded result for a known doc term", async () => {
		const result = await docsSearchTool.run({ query: "autonomy" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const payload = parsePayload(result.output);
		strictEqual(payload.version, 2);
		ok(payload.corpus.docs >= 2, "corpus metadata reports searched docs");
		ok(payload.corpus.excludes.includes("docs/html/**"), "tool excludes human HTML blueprints");
		ok(payload.results.length > 0, "expected at least one hit for 'autonomy'");
		const top = payload.results[0];
		ok(top, "expected a top hit");
		strictEqual(top.rank, 1);
		strictEqual(top.file, "docs/safety-model.md");
		strictEqual(top.heading, "Autonomy levels");
		strictEqual(top.breadcrumb, "Safety Model > Autonomy levels");
		ok(top.score > 0, "score must be positive");
		ok(top.coverage > 0, "coverage must be reported");
		ok(top.lines.start > 0 && top.lines.end >= top.lines.start, "section line range must be present");
		ok(
			top.snippetLines.start > 0 && top.snippetLines.end >= top.snippetLines.start,
			"snippet line range must be present",
		);
		ok(top.matchedTerms.includes("autonomy"), "matched terms include the query term");
		ok(
			top.signals.some((signal) => signal.includes("heading")),
			"signals explain why the hit ranked",
		);
		ok(top.snippet.length > 0, "snippet must carry the cited passage");
		// Bounded output: the snippet window plus its ellipses stays small.
		for (const hit of payload.results) {
			ok(hit.snippet.length <= 300, `snippet too long: ${hit.snippet.length}`);
		}
	});

	it("ranks a multi-term query by heading and body matches", async () => {
		const result = await docsSearchTool.run({ query: "fleet dispatch" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const payload = parsePayload(result.output);
		const top = payload.results[0];
		ok(top, "expected a top hit");
		strictEqual(top.heading, "Fleet dispatch");
		strictEqual(top.file, "docs/safety-model.md");
	});

	it("finds configuration terms in a different doc", async () => {
		const result = await docsSearchTool.run({ query: "settings precedence" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const payload = parsePayload(result.output);
		ok(
			payload.results.some((hit) => hit.file === "docs/configuration-and-targets.md"),
			"expected a configuration doc hit",
		);
	});

	it("uses Clio vocabulary aliases for semantic-style deterministic retrieval", async () => {
		const result = await docsSearchTool.run({ query: "how do confirmations work" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const payload = parsePayload(result.output);
		ok(payload.terms.expanded.includes("autonomy"), "confirmation query expands to autonomy vocabulary");
		const top = payload.results[0];
		ok(top, "expected an alias-backed hit");
		strictEqual(top.file, "docs/safety-model.md");
		strictEqual(top.heading, "Autonomy levels");
	});

	it("supports narrowing to one bundled markdown file", async () => {
		const result = await docsSearchTool.run({ query: "dispatch evidence", file: "observability.md" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const payload = parsePayload(result.output);
		ok(payload.results.length > 0, "expected observability result");
		for (const hit of payload.results) strictEqual(hit.file, "docs/observability.md");
	});

	it("honors the limit parameter", async () => {
		const result = await docsSearchTool.run({ query: "settings", limit: 1 });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		strictEqual(parsePayload(result.output).results.length, 1);
	});

	it("reports a clean miss for nonsense without erroring", async () => {
		const result = await docsSearchTool.run({ query: "zzqqxnonsensetoken" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("[no matches]"));
		strictEqual(parsePayload(result.output).results.length, 0);
	});

	it("rejects an empty query", async () => {
		const result = await docsSearchTool.run({});
		strictEqual(result.kind, "error");
	});
});
