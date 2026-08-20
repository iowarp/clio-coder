import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createContextTool } from "../../src/tools/context/index.js";

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

// context(scope=docs) is a JSON-format observation: the output is always one
// parseable document, never a body with an appended notice line.
function parsePayload(output: string): {
	version: number;
	query: string;
	corpus: { docs: number; sections: number; excludes: string[] };
	terms: { query: string[]; expanded: string[]; phrases: string[] };
	resultCount: number;
	results: DocHit[];
	next?: string;
} {
	return JSON.parse(output) as ReturnType<typeof parsePayload>;
}

// The docs engine resolves the bundled docs directory through
// resolvePackageRoot, so a CLIO_CODER_PACKAGE_ROOT fixture makes the contract
// hermetic: a known docs set instead of the shipped wording.
// resolvePackageRoot caches its first resolution per process, so one fixture
// serves the whole file.
describe("contracts/context docs scope", () => {
	const contextTool = createContextTool();
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
		previousRoot = process.env.CLIO_CODER_PACKAGE_ROOT;
		process.env.CLIO_CODER_PACKAGE_ROOT = scratch;
	});

	after(() => {
		if (previousRoot === undefined) delete process.env.CLIO_CODER_PACKAGE_ROOT;
		else process.env.CLIO_CODER_PACKAGE_ROOT = previousRoot;
		rmSync(scratch, { recursive: true, force: true });
	});

	it("returns a cited, bounded result for a known doc term", async () => {
		const result = await contextTool.run({ scope: "docs", query: "autonomy" });
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

	it("tells the model cited files are bundled docs read from the installed path, never searched for in the workspace", async () => {
		const result = await contextTool.run({ scope: "docs", query: "autonomy" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const payload = JSON.parse(result.output) as { followUp?: string };
		// Docs hits cite corpus-relative files that do not exist in the user's
		// workspace. The system prompt's docs-routing directive tells the model
		// to read the routed document from the installed documentation path, so
		// the follow-up must agree with it: read from that path, never grep or
		// find the workspace for the citation, and route depth back through
		// scope=docs. An earlier wording said "never read ... as files", which
		// contradicted the directive in the same turn.
		ok(typeof payload.followUp === "string");
		ok(payload.followUp.includes("installed documentation path"), payload.followUp);
		ok(payload.followUp.includes("never by searching the workspace"), payload.followUp);
		ok(!payload.followUp.includes("never read"), payload.followUp);
		ok(payload.followUp.includes("scope=docs"), payload.followUp);
	});

	it("lists the corpus instead of erroring when no query is given", async () => {
		const result = await contextTool.run({ scope: "docs" });
		strictEqual(result.kind, "ok", "an omitted query lists the corpus rather than returning an error");
		if (result.kind !== "ok") return;
		const payload = JSON.parse(result.output) as {
			version: number;
			corpus: { docs: number; sections: number; files: string[]; excludes: string[] };
			followUp?: string;
			results?: unknown;
		};
		strictEqual(payload.version, 2);
		ok(payload.corpus.docs >= 2, "corpus lists the searched doc count");
		ok(payload.corpus.sections > 0, "corpus lists the section count");
		ok(Array.isArray(payload.corpus.files) && payload.corpus.files.length > 0, "corpus lists the files");
		ok(payload.corpus.excludes.includes("docs/html/**"), "corpus reports the html exclusion");
		strictEqual(payload.results, undefined, "the listing carries no ranked results");
		ok(
			typeof payload.followUp === "string" && payload.followUp.includes("query="),
			"the listing tells the model to query",
		);
	});

	it("ranks a multi-term query by heading and body matches", async () => {
		const result = await contextTool.run({ scope: "docs", query: "fleet dispatch" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const payload = parsePayload(result.output);
		const top = payload.results[0];
		ok(top, "expected a top hit");
		strictEqual(top.heading, "Fleet dispatch");
		strictEqual(top.file, "docs/safety-model.md");
	});

	it("finds configuration terms in a different doc", async () => {
		const result = await contextTool.run({ scope: "docs", query: "settings precedence" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const payload = parsePayload(result.output);
		ok(
			payload.results.some((hit) => hit.file === "docs/configuration-and-targets.md"),
			"expected a configuration doc hit",
		);
	});

	it("uses Clio vocabulary aliases for semantic-style deterministic retrieval", async () => {
		const result = await contextTool.run({ scope: "docs", query: "how do confirmations work" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const payload = parsePayload(result.output);
		ok(payload.terms.expanded.includes("autonomy"), "confirmation query expands to autonomy vocabulary");
		const top = payload.results[0];
		ok(top, "expected an alias-backed hit");
		strictEqual(top.file, "docs/safety-model.md");
		strictEqual(top.heading, "Autonomy levels");
	});

	it("honors the limit parameter", async () => {
		const result = await contextTool.run({ scope: "docs", query: "settings", limit: 1 });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		strictEqual(parsePayload(result.output).results.length, 1);
	});

	it("reports a clean miss as valid JSON with a populated continuation", async () => {
		const result = await contextTool.run({ scope: "docs", query: "zzqqxnonsensetoken" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const payload = parsePayload(result.output);
		strictEqual(payload.resultCount, 0);
		strictEqual(payload.results.length, 0);
		ok(typeof payload.next === "string" && payload.next.startsWith("query="), "empty results carry an exact next call");
	});

	it("treats a whitespace-only query as no query and lists the corpus", async () => {
		const result = await contextTool.run({ scope: "docs", query: "   " });
		strictEqual(result.kind, "ok", "a blank query lists the corpus rather than erroring");
	});
});
