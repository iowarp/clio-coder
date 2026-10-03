import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { listDocsCorpus, searchDocs } from "../../src/tools/context/docs-engine.js";
import { createContextTool, runDocsScope } from "../../src/tools/context/index.js";
import type { DocsHeadingState } from "../../src/tools/docs-headings.js";
import { docsHeading } from "../../src/tools/docs-headings.js";
import { createClioDocsTool, createClioLibraryTool } from "../../src/tools/gateway/clio-context-tools.js";
import { reserveObservation } from "../../src/tools/observation.js";
import { DEFAULT_DOCS_HEAD_LINES, readTool } from "../../src/tools/read.js";
import { createRegistry } from "../../src/tools/registry.js";
import { webFetchTool, webReadTool } from "../../src/tools/web-fetch.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * The web split and the context split. web_read is never an outward action
 * whatever its arguments; web_fetch keeps the outward rules. clio_docs and
 * clio_library return what context(scope="docs"|"library") returned, and the
 * context tool refuses both scopes with the exact gateway replacement.
 */

describe("web_read and web_fetch", () => {
	it("classifies web_read as read whatever the arguments and keeps web_fetch's outward rule", () => {
		const outward = { url: "https://example.invalid/post", method: "POST", body: "payload" };
		strictEqual(classify({ tool: ToolNames.WebRead, args: outward }).actionClass, "read");
		strictEqual(classify({ tool: ToolNames.WebRead, args: { url: "https://example.invalid/" } }).actionClass, "read");
		strictEqual(classify({ tool: ToolNames.WebFetch, args: outward }).actionClass, "write");
		deepStrictEqual(classify({ tool: ToolNames.WebFetch, args: outward }).reasons, ["web-fetch:outward"]);
		strictEqual(classify({ tool: ToolNames.WebFetch, args: { url: "https://example.invalid/" } }).actionClass, "read");
	});

	it("parks an outward web_fetch at default while the same arguments run through web_read as a plain GET", async () => {
		const parks: string[] = [];
		const registry = createRegistry({ safety: createWorkerSafety(), autonomy: () => "default" });
		registry.register(webReadTool);
		registry.register(webFetchTool);
		registry.onPermissionRequired((call, _decision, meta) => {
			parks.push(call.tool);
			registry.cancelParkedCall(meta.requestId, "denied by the test");
		});
		const args = { url: "ftp://example.invalid/resource", method: "POST", body: "payload" };
		const fetched = await registry.invoke({ tool: ToolNames.WebFetch, args });
		strictEqual(fetched.kind, "blocked", "an outward request asks at default; the test denied it");
		deepStrictEqual(parks, [ToolNames.WebFetch]);
		const read = await registry.invoke({ tool: ToolNames.WebRead, args });
		strictEqual(read.kind, "ok", "web_read never asks: nothing it accepts is outward");
		if (read.kind !== "ok" || read.result.kind !== "error") throw new Error(JSON.stringify(read));
		ok(read.result.message.startsWith("web_read: unsupported scheme ftp:"), read.result.message);
		deepStrictEqual(parks, [ToolNames.WebFetch]);
	});

	it("exposes web_read without method, headers, or body in its schema", () => {
		const properties = Object.keys((webReadTool.parameters as { properties: Record<string, unknown> }).properties);
		deepStrictEqual(properties.sort(), ["format", "max_bytes", "timeout_ms", "url"]);
	});
});

describe("clio_docs and clio_library", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-gateway-context-");
	});
	afterEach(() => env.restore());

	it("returns the documentation corpus and ranked sections exactly as the docs scope did", async () => {
		const docs = createClioDocsTool();
		const corpus = listDocsCorpus();
		ok(corpus.ok, corpus.ok ? "" : corpus.message);
		if (corpus.ok) {
			const followUp = (corpus.payload as { followUp: string }).followUp;
			ok(followUp.includes('gateway(op="call", capability="clio_docs"'), followUp);
			ok(!followUp.includes("scope=docs"), followUp);
		}
		const listed = await docs.run({}, {});
		if (listed.kind !== "ok") throw new Error(listed.message);
		if (!corpus.ok) return;
		strictEqual(listed.output, JSON.stringify(corpus.payload));
		const observation = (listed.details as { observation: { tool: string } }).observation;
		strictEqual(observation.tool, ToolNames.ClioDocs);

		const search = searchDocs("gateway", 3);
		ok(search.ok, search.ok ? "" : search.message);
		if (search.ok) {
			const followUp = (search.payload as { followUp: string }).followUp;
			ok(followUp.includes('gateway(op="call", capability="clio_docs"'), followUp);
			ok(!followUp.includes("scope=docs"), followUp);
		}
		const searched = await docs.run({ query: "gateway", limit: 3 }, {});
		if (searched.kind !== "ok" || !search.ok) throw new Error(JSON.stringify(searched));
		strictEqual(searched.output, JSON.stringify(search.payload));
		// The former scope function under the context name yields the same body.
		const legacy = runDocsScope({ query: "gateway", limit: 3 }, reserveObservation(16 * 1024), undefined);
		if (legacy.kind !== "ok") throw new Error(legacy.message);
		strictEqual(searched.output, legacy.output);
	});

	it("ranks current guidance ahead of release notes for configuration and worker queries", () => {
		for (const query of [
			"How do I configure a different model for workers?",
			"In v0.5.0, how do I configure a different model for workers?",
		]) {
			const workerQuery = searchDocs(query, 5);
			ok(workerQuery.ok, workerQuery.ok ? "" : workerQuery.message);
			if (!workerQuery.ok) return;
			const workerResults = (workerQuery.payload as { results: Array<{ file: string }> }).results;
			// A release handoff is a dated record of one cut, not operator guidance.
			ok(!workerResults.slice(0, 3).some((result) => /handoff/u.test(result.file)), JSON.stringify(workerResults));
			ok(
				workerResults.some((result) => result.file === "docs/guide/configuration-and-targets.md"),
				JSON.stringify(workerResults),
			);
		}

		const defaultsQuery = searchDocs(
			"What are the default chat settings for thinking and prewarm, and when does prewarming run?",
			5,
		);
		ok(defaultsQuery.ok, defaultsQuery.ok ? "" : defaultsQuery.message);
		if (!defaultsQuery.ok) return;
		const defaultsResults = (defaultsQuery.payload as { results: Array<{ file: string }> }).results;
		strictEqual(defaultsResults[0]?.file, "docs/guide/configuration-reference.md");
	});

	it("makes every ranked hit directly readable at its exact bundled section range", async () => {
		const result = await createClioDocsTool().run({ query: "headless run command dispatch target model flags" });
		ok(result.kind === "ok", JSON.stringify(result));
		const payload = JSON.parse(result.output) as {
			results: Array<{
				file: string;
				lines: { start: number; end: number };
				read: { tool: string; args: { path: string; offset: number; limit: number; line_numbers: boolean } };
			}>;
		};
		ok(payload.results.length > 0);
		for (const hit of payload.results) {
			strictEqual(hit.read.tool, ToolNames.Read);
			deepStrictEqual(hit.read.args, {
				path: join(resolvePackageRoot(), hit.file),
				offset: hit.lines.start,
				limit: hit.lines.end - hit.lines.start + 1,
				line_numbers: true,
			});
			const source = readFileSync(hit.read.args.path, "utf8").split("\n");
			if (source[source.length - 1] === "") source.pop();
			ok(hit.lines.end <= source.length, "range ends on a physical file line");
			const read = await readTool.run(hit.read.args);
			ok(read.kind === "ok", JSON.stringify(read));
			const body = source
				.slice(hit.lines.start - 1, hit.lines.end)
				.map((line, index) => `${hit.lines.start + index} | ${line}`)
				.join("\n");
			ok(read.output.startsWith(body), read.output);
			ok(!read.output.includes("Section index (inclusive line ranges)"));
		}
	});

	it("bounds implicit bundled-doc reads, preserving explicit windows and full reads", async () => {
		const path = join(resolvePackageRoot(), "docs", "guide", "fleet-dispatch.md");
		const head = await readTool.run({ path });
		ok(head.kind === "ok", JSON.stringify(head));
		const observation = head.details?.observation as { shownCount: number; truncated: boolean; next?: string };
		strictEqual(observation.shownCount, DEFAULT_DOCS_HEAD_LINES);
		strictEqual(observation.truncated, true);
		strictEqual(observation.next, undefined);
		ok(head.output.includes("Section index (inclusive line ranges):"));
		ok(head.output.includes("offset=1 without limit"));
		const headings = [...head.output.matchAll(/^(\d+)-(\d+) \|\s*(.+)$/gm)];
		ok(headings.length > 1);
		const source = readFileSync(path, "utf8").split("\n");
		if (source[source.length - 1] === "") source.pop();
		for (const match of headings) {
			const start = Number(match[1]);
			const end = Number(match[2]);
			ok(end >= start);
			ok(source[start - 1]?.includes(match[3] ?? ""), "index heading matches its physical line");
		}
		strictEqual(Number(headings.at(-1)?.[2]), source.length);
		for (const args of [{ offset: 1 }, { limit: 3 }, { tail: 3 }]) {
			const explicit = await readTool.run({ path, ...args });
			ok(explicit.kind === "ok", JSON.stringify(explicit));
			ok(!explicit.output.includes("Section index (inclusive line ranges):"));
			const count = (explicit.details?.observation as { shownCount: number }).shownCount;
			if ("offset" in args) ok(count > DEFAULT_DOCS_HEAD_LINES);
			else strictEqual(count, 3);
		}
		const ordinary = await readTool.run({ path: join(resolvePackageRoot(), "src", "tools", "dispatch-schema.ts") });
		ok(ordinary.kind === "ok", JSON.stringify(ordinary));
		ok(!ordinary.output.includes("Section index (inclusive line ranges):"));
		ok((ordinary.details?.observation as { shownCount: number }).shownCount > DEFAULT_DOCS_HEAD_LINES);
	});

	it("keeps headings inside fenced examples out of retrieval and read indexes", () => {
		const state: DocsHeadingState = {};
		for (const line of ["````markdown", "# Example", "```", "## Still an example", "~~~~", "# Also an example"]) {
			strictEqual(docsHeading(line, state), null);
		}
		strictEqual(docsHeading("````", state), null);
		deepStrictEqual(docsHeading("## Real section", state), { level: 2, heading: "Real section" });
	});

	it("returns portable Markdown heading anchors, including duplicates and Unicode", () => {
		const punctuation = searchDocs("Welcome Launchpad Session Header", 12);
		ok(punctuation.ok, punctuation.ok ? "" : punctuation.message);
		if (!punctuation.ok) return;
		const punctuationResult = (
			punctuation.payload as { results: Array<{ file: string; heading: string; anchor: string }> }
		).results.find(
			(result) =>
				result.file === "docs/architecture/tui-design.md" && result.heading === "4.1 Welcome Launchpad & Session Header",
		);
		strictEqual(punctuationResult?.anchor, "#41-welcome-launchpad--session-header");

		const unicode = searchDocs("19 Origin Glyphs", 12);
		ok(unicode.ok, unicode.ok ? "" : unicode.message);
		if (!unicode.ok) return;
		const unicodeResult = (
			unicode.payload as { results: Array<{ file: string; heading: string; anchor: string }> }
		).results.find(
			(result) => result.file === "docs/guide/glossary.md" && result.heading === "19. Origin Glyphs (`◇`/`◆`)",
		);
		strictEqual(unicodeResult?.anchor, "#19-origin-glyphs-");

		const duplicate = searchDocs("include_tree context limit scope settings", 12);
		ok(duplicate.ok, duplicate.ok ? "" : duplicate.message);
		if (!duplicate.ok) return;
		const duplicateResult = (
			duplicate.payload as { results: Array<{ file: string; heading: string; anchor: string }> }
		).results.find((result) => result.file === "docs/guide/configuration-reference.md" && result.heading === "`context`");
		strictEqual(duplicateResult?.anchor, "#context-1");

		const firstDuplicate = searchDocs("context CLI setting", 12);
		ok(firstDuplicate.ok, firstDuplicate.ok ? "" : firstDuplicate.message);
		if (!firstDuplicate.ok) return;
		const firstDuplicateResult = (
			firstDuplicate.payload as { results: Array<{ file: string; heading: string; anchor: string }> }
		).results.find((result) => result.file === "docs/guide/configuration-reference.md" && result.heading === "`context`");
		strictEqual(firstDuplicateResult?.anchor, "#context");
	});

	it("refuses the library read on a worker registry exactly as the context scope did", async () => {
		const worker = createClioLibraryTool({ getCwd: () => env.dir, skillMarketplace: false });
		const result = await worker.run({}, {});
		strictEqual(result.kind, "error");
		if (result.kind === "error") ok(result.message.includes("unavailable"), result.message);
	});

	it("drops docs and library from context and names the gateway replacement", async () => {
		const context = createContextTool({ getCwd: () => env.dir });
		for (const [scope, capability] of [
			["docs", ToolNames.ClioDocs],
			["library", ToolNames.ClioLibrary],
		] as const) {
			const result = await context.run({ scope }, {});
			strictEqual(result.kind, "error");
			if (result.kind !== "error") return;
			ok(result.message.includes(`capability="${capability}"`), result.message);
			ok(result.message.includes('gateway(op="call"'), result.message);
		}
		const schema = (context.parameters as { properties: { scope: { enum?: string[]; anyOf?: unknown[] } } }).properties;
		const scopes = JSON.stringify(schema.scope);
		ok(!scopes.includes('"docs"') && !scopes.includes('"library"'), scopes);
		ok(!("kind" in schema), "the library kind argument left the context schema");
	});
});
