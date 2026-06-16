import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildCodewiki, writeCodewiki } from "../../src/domains/context/index.js";
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

describe("contracts/code_nav", () => {
	let scratch: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-code-nav-"));
		mkdirSync(join(scratch, "src"), { recursive: true });
		mkdirSync(join(scratch, "pkg"), { recursive: true });
		writeFileSync(
			join(scratch, "src", "index.ts"),
			"import { worker } from './worker.js';\nexport function main() { return worker; }\n",
			"utf8",
		);
		writeFileSync(join(scratch, "src", "worker.ts"), "export const worker = 1;\n", "utf8");
		writeFileSync(join(scratch, "pkg", "util.py"), "import os\n\ndef helper():\n    return os.getcwd()\n", "utf8");
		writeCodewiki(scratch, buildCodewiki({ cwd: scratch, language: "polyglot" }));
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
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
		ok(pathsFromFiles(parseJsonOutput(entries.output).files).includes("src/index.ts"));

		const outline = await codeNavTool.run({ mode: "outline", query: "src/index.ts" });
		strictEqual(outline.kind, "ok");
		const outlinePayload = parseJsonOutput(outline.output);
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
});
