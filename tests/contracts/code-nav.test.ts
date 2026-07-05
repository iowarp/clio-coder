import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildCodewiki,
	listWikiPages,
	wikiDir,
	writeCodewiki,
	writeWikiMeta,
} from "../../src/domains/context/index.js";
import { codeNavTool } from "../../src/tools/codewiki/code-nav.js";

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
		writeCodewiki(scratch, await buildCodewiki({ cwd: scratch, language: "polyglot" }));
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

	it("returns a helpful empty wiki payload when no Markdown wiki exists", async () => {
		const result = await codeNavTool.run({ mode: "wiki" });

		strictEqual(result.kind, "ok");
		const payload = parseJsonOutput(result.output);
		ok(Array.isArray(payload.pages) && payload.pages.length === 0);
		strictEqual((payload.staleness as Record<string, unknown>).state, "absent");
		strictEqual(payload.message, "no wiki exists; run clio context wiki");
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
