import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildCodewiki,
	computeFingerprint,
	listWikiPages,
	wikiDir,
	writeClioState,
	writeCodewiki,
	writeWikiMeta,
} from "../../src/domains/context/index.js";
import { codeNavTool } from "../../src/tools/codewiki/code-nav.js";
import { loadCodewikiForTool } from "../../src/tools/codewiki/shared.js";

function parseJsonOutput(output: string): Record<string, unknown> {
	const json = output.split("\n[", 1)[0] ?? output;
	const parsed = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("expected object output");
	}
	return parsed as Record<string, unknown>;
}

function pathsFromFiles(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => {
			if (typeof item !== "object" || item === null || Array.isArray(item)) return "";
			const path = (item as Record<string, unknown>).path;
			return typeof path === "string" ? path : "";
		})
		.filter((path) => path.length > 0);
}

function writeWikiPage(cwd: string, name: string, text: string): void {
	mkdirSync(wikiDir(cwd), { recursive: true });
	writeFileSync(join(wikiDir(cwd), name), text, "utf8");
}

function git(cwd: string, args: ReadonlyArray<string>): string {
	return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initGitRepo(cwd: string): string {
	git(cwd, ["init"]);
	git(cwd, ["config", "user.email", "clio-test@example.com"]);
	git(cwd, ["config", "user.name", "Clio Test"]);
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "initial"]);
	return git(cwd, ["rev-parse", "HEAD"]);
}

describe("contracts/code_nav", () => {
	let scratch: string;
	let originalCwd: string;

	beforeEach(async () => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-code-nav-"));
		mkdirSync(join(scratch, "src"), { recursive: true });
		mkdirSync(join(scratch, "pkg"), { recursive: true });
		writeFileSync(
			join(scratch, "src", "index.ts"),
			[
				"/**",
				" * Runs the TypeScript entry.",
				" */",
				"import { worker } from './worker.js';",
				"export function main() { return worker; }",
				"",
			].join("\n"),
			"utf8",
		);
		writeFileSync(join(scratch, "src", "worker.ts"), "export const worker = 1;\n", "utf8");
		writeFileSync(join(scratch, "pkg", "util.py"), "import os\n\ndef helper():\n    return os.getcwd()\n", "utf8");
		const generatedAt = "2026-05-01T00:00:00.000Z";
		const codewiki = await buildCodewiki({ cwd: scratch, language: "polyglot", generatedAt });
		writeCodewiki(scratch, codewiki);
		writeClioState(scratch, {
			version: 1,
			projectType: "polyglot",
			fingerprint: computeFingerprint(scratch, codewiki),
			codewikiVersion: codewiki.version,
			lastSessionAt: generatedAt,
			lastIndexedAt: generatedAt,
		});
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	it("path mode with an explicit /g regex matches every path (no sticky lastIndex skips)", async () => {
		const result = await codeNavTool.run({ mode: "path", query: "/\\.ts$/g" });
		strictEqual(result.kind, "ok");
		const paths = pathsFromFiles(parseJsonOutput(result.output).files);
		ok(paths.includes("src/index.ts"), "src/index.ts matched");
		ok(paths.includes("src/worker.ts"), "src/worker.ts matched (a reused /g regex would skip one)");
	});

	it("supports symbol, path, entries, outline, deps, and dependents modes", async () => {
		const symbol = await codeNavTool.run({ mode: "symbol", query: "worker" });
		strictEqual(symbol.kind, "ok");
		const symbolPayload = parseJsonOutput(symbol.output);
		ok(pathsFromFiles(symbolPayload.files).includes("src/worker.ts"));
		ok(
			Array.isArray(symbolPayload.symbols) &&
				symbolPayload.symbols.some((item) => {
					if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
					const record = item as Record<string, unknown>;
					return record.name === "worker" && record.path === "src/worker.ts" && typeof record.line === "number";
				}),
		);

		const path = await codeNavTool.run({ mode: "path", query: "util.py" });
		strictEqual(path.kind, "ok");
		ok(pathsFromFiles(parseJsonOutput(path.output).files).includes("pkg/util.py"));

		const entries = await codeNavTool.run({ mode: "entries" });
		strictEqual(entries.kind, "ok");
		const entriesPayload = parseJsonOutput(entries.output);
		ok(pathsFromFiles(entriesPayload.files).includes("src/index.ts"));

		const outline = await codeNavTool.run({ mode: "outline", query: "src/index.ts" });
		strictEqual(outline.kind, "ok");
		const outlinePayload = parseJsonOutput(outline.output);
		const outlineFile = outlinePayload.file as Record<string, unknown>;
		strictEqual(outlineFile.summary, "Runs the TypeScript entry.");
		ok(
			Array.isArray(outlinePayload.symbols) &&
				outlinePayload.symbols.some((item) => {
					if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
					return (item as Record<string, unknown>).name === "main";
				}),
		);

		const deps = await codeNavTool.run({ mode: "deps", query: "src/index.ts" });
		strictEqual(deps.kind, "ok");
		const depsPayload = parseJsonOutput(deps.output);
		const depLists = depsPayload.deps as { internal?: unknown };
		ok(Array.isArray(depLists.internal) && depLists.internal.includes("src/worker.ts"));

		const dependents = await codeNavTool.run({ mode: "dependents", query: "src/worker.ts" });
		strictEqual(dependents.kind, "ok");
		const dependentsPayload = parseJsonOutput(dependents.output);
		ok(Array.isArray(dependentsPayload.dependents) && dependentsPayload.dependents.includes("src/index.ts"));
	});

	it("redirects a symbol name fed to a path mode instead of a bare not-found", async () => {
		// Point-of-failure conditioning: a bare "not in the codewiki" gave a
		// live worker nothing to pivot on and it retried the identical call
		// into the loop guard. The error must name the working alternatives.
		const result = await codeNavTool.run({ mode: "deps", query: "someSymbolName" });
		strictEqual(result.kind, "error");
		ok(result.kind === "error" && result.message.includes("deps/dependents/outline take file paths"));
		ok(result.kind === "error" && result.message.includes("mode=symbol query=someSymbolName"));
		ok(result.kind === "error" && result.message.includes("grep/read"));
	});

	it("reloads stale codewiki before serving symbol results", async () => {
		const workerPath = join(scratch, "src", "worker.ts");
		writeFileSync(workerPath, "export const freshWorker = 2;\n", "utf8");
		const future = new Date(Date.now() + 1000);
		utimesSync(workerPath, future, future);

		const result = await codeNavTool.run({ mode: "symbol", query: "freshWorker" });

		strictEqual(result.kind, "ok");
		const payload = parseJsonOutput(result.output);
		ok(pathsFromFiles(payload.files).includes("src/worker.ts"));
		ok(
			Array.isArray(payload.symbols) &&
				payload.symbols.some((item) => {
					if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
					return (item as Record<string, unknown>).name === "freshWorker";
				}),
		);
	});

	it("reuses fresh codewiki artifact objects and invalidates after artifact rewrites", async () => {
		const first = await loadCodewikiForTool(scratch);
		const second = await loadCodewikiForTool(scratch);
		ok(first.ok);
		ok(second.ok);
		strictEqual(second.codewiki, first.codewiki);

		writeFileSync(join(scratch, "src", "cache.ts"), "export const cacheProbe = 1;\n", "utf8");
		const generatedAt = "2026-05-01T00:00:01.000Z";
		const rebuilt = await buildCodewiki({ cwd: scratch, language: "polyglot", generatedAt });
		writeCodewiki(scratch, rebuilt);
		writeClioState(scratch, {
			version: 1,
			projectType: "polyglot",
			fingerprint: computeFingerprint(scratch, rebuilt),
			codewikiVersion: rebuilt.version,
			lastSessionAt: generatedAt,
			lastIndexedAt: generatedAt,
		});
		const future = new Date(Date.now() + 1000);
		utimesSync(join(scratch, ".clio", "codewiki.json"), future, future);

		const third = await loadCodewikiForTool(scratch);
		const fourth = await loadCodewikiForTool(scratch);
		ok(third.ok);
		ok(fourth.ok);
		notStrictEqual(third.codewiki, first.codewiki);
		strictEqual(fourth.codewiki, third.codewiki);
		ok(third.codewiki.symbols.some((symbol) => symbol.name === "cacheProbe"));
	});

	it("returns a helpful empty wiki payload when no Markdown wiki exists", async () => {
		const result = await codeNavTool.run({ mode: "wiki" });

		strictEqual(result.kind, "ok");
		const payload = parseJsonOutput(result.output);
		ok(Array.isArray(payload.pages) && payload.pages.length === 0);
		strictEqual((payload.staleness as Record<string, unknown>).state, "absent");
		strictEqual(payload.message, "no wiki exists; wiki generation is operator-only: run `clio context wiki --update`");
	});

	it("lists Markdown wiki pages and staleness through mode=wiki", async () => {
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n\nStart here.\n");
		writeWikiPage(scratch, "architecture.md", "# Architecture\n\nRuntime map.\n");
		writeWikiMeta(scratch, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: null,
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: listWikiPages(scratch),
		});

		const result = await codeNavTool.run({ mode: "wiki" });

		strictEqual(result.kind, "ok");
		const payload = parseJsonOutput(result.output);
		ok(Array.isArray(payload.pages));
		const pages = payload.pages as Array<Record<string, unknown>>;
		deepStrictEqual(
			pages.map((page) => page.path),
			["architecture.md", "quickstart.md"],
		);
		strictEqual(pages.find((page) => page.path === "quickstart.md")?.title, "Quickstart");
		strictEqual((payload.staleness as Record<string, unknown>).state, "fresh");
	});

	it("resolves wiki queries by page id or title with a summary and readable path", async () => {
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n\nStart here.\n");
		writeWikiPage(scratch, "runtime-map.md", "# Architecture\n\nThe runtime starts in `src/index.ts`.\n");
		writeWikiMeta(scratch, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: null,
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: listWikiPages(scratch),
		});

		const byId = await codeNavTool.run({ mode: "wiki", query: "runtime-map" });
		strictEqual(byId.kind, "ok");
		const idPage = parseJsonOutput(byId.output).page as Record<string, unknown>;
		deepStrictEqual(idPage, {
			id: "runtime-map",
			title: "Architecture",
			summary: "The runtime starts in `src/index.ts`.",
			path: ".clio/wiki/runtime-map.md",
		});

		const byTitle = await codeNavTool.run({ mode: "wiki", query: "Architecture" });
		strictEqual(byTitle.kind, "ok");
		deepStrictEqual(parseJsonOutput(byTitle.output).page, idPage);
	});

	it("rejects unmatched wiki queries instead of silently returning the page listing", async () => {
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n\nStart here.\n");
		writeWikiMeta(scratch, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: null,
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: listWikiPages(scratch),
		});

		const listing = await codeNavTool.run({ mode: "wiki" });
		const missing = await codeNavTool.run({ mode: "wiki", query: "fleet" });
		strictEqual(listing.kind, "ok");
		strictEqual(missing.kind, "error");
		if (missing.kind === "error") {
			strictEqual(missing.message, "code_nav: no wiki page matches 'fleet'; pages are: quickstart (Quickstart)");
			ok(!missing.message.includes(listing.output));
		}
	});

	it("returns distinct payloads for distinct wiki pages", async () => {
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n\nStart here.\n");
		writeWikiPage(scratch, "architecture.md", "# Architecture\n\nRuntime map.\n");
		writeWikiMeta(scratch, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: null,
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: listWikiPages(scratch),
		});

		const quickstart = await codeNavTool.run({ mode: "wiki", query: "quickstart" });
		const architecture = await codeNavTool.run({ mode: "wiki", query: "architecture" });
		strictEqual(quickstart.kind, "ok");
		strictEqual(architecture.kind, "ok");
		notStrictEqual(quickstart.output, architecture.output);
	});

	it("makes stale wiki results actionable without granting model-side regeneration", async () => {
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n\nStart here.\n");
		const head = initGitRepo(scratch);
		writeWikiMeta(scratch, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: head,
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: listWikiPages(scratch),
		});
		writeFileSync(join(scratch, "src", "after-wiki.ts"), "export const afterWiki = true;\n", "utf8");
		git(scratch, ["add", "src/after-wiki.ts"]);
		git(scratch, ["commit", "-m", "change after wiki"]);

		const result = await codeNavTool.run({ mode: "wiki", query: "quickstart" });
		strictEqual(result.kind, "ok");
		const payload = parseJsonOutput(result.output);
		strictEqual((payload.staleness as Record<string, unknown>).state, "stale");
		match(String(payload.message), /pages may be outdated/i);
		match(String(payload.message), /wiki regeneration is operator-only/);
		match(String(payload.message), /clio context wiki --update/);
	});

	it("advertises wiki in the mode enum and keeps unknown modes rejected", async () => {
		const parameters = codeNavTool.parameters as unknown as {
			properties?: { mode?: { enum?: unknown } };
		};
		const modeEnum = parameters.properties?.mode?.enum;
		ok(Array.isArray(modeEnum));
		ok(modeEnum.includes("wiki"));

		const result = await codeNavTool.run({ mode: "unknown" });
		strictEqual(result.kind, "error");
		strictEqual(
			result.message,
			"code_nav: mode must be symbol, path, entries, outline, deps, dependents, or wiki; got 'unknown'",
		);
	});
});
