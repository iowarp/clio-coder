import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildCodewiki,
	buildCodewikiWithTreeSitter,
	readCodewiki,
	renderCodewikiDigest,
	structuralCodewikiHash,
	updateCodewikiPaths,
	writeCodewiki,
} from "../../src/domains/context/index.js";
import { loadCodewikiForTool } from "../../src/tools/codewiki/shared.js";

type BuiltCodewiki = ReturnType<typeof buildCodewiki>;

function hasSymbol(codewiki: BuiltCodewiki, path: string, name: string, kind?: string): boolean {
	const file = codewiki.files.find((item) => item.path === path);
	if (!file) return false;
	return codewiki.symbols.some(
		(symbol) => symbol.fileId === file.id && symbol.name === name && (!kind || symbol.kind === kind),
	);
}

describe("contracts/codewiki", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-codewiki-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("writes v3 normalized files, symbols, and edges", () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(
			join(scratch, "src", "index.ts"),
			[
				"/**",
				" * Starts the application.",
				" */",
				"import { worker } from './worker.js';",
				"export function main() { return worker; }",
				"",
			].join("\n"),
			"utf8",
		);
		writeFileSync(join(scratch, "src", "math.test.ts"), "export const testValue = 1;\n", "utf8");
		writeFileSync(join(scratch, "src", "worker.ts"), "export const worker = true;\n", "utf8");

		const codewiki = buildCodewiki({ cwd: scratch, language: "typescript", generatedAt: "2026-05-01T00:00:00.000Z" });
		writeCodewiki(scratch, codewiki);
		const serialized = readFileSync(join(scratch, ".clio", "codewiki.json"), "utf8");
		strictEqual(serialized.includes("\n  "), false);
		strictEqual(serialized.endsWith("\n"), true);
		deepStrictEqual(JSON.parse(serialized), codewiki);
		const read = readCodewiki(scratch);
		ok(read);
		strictEqual(read.version, 3);
		strictEqual(read.files.find((file) => file.path === "src/index.ts")?.role, "entry");
		strictEqual(read.files.find((file) => file.path === "src/math.test.ts")?.role, "test");
		strictEqual(read.files.find((file) => file.path === "src/worker.ts")?.role, "module");
		ok(read.symbols.some((symbol) => symbol.name === "main" && symbol.kind === "func"));
		const index = read.files.find((file) => file.path === "src/index.ts");
		const worker = read.files.find((file) => file.path === "src/worker.ts");
		ok(index);
		ok(worker);
		ok(read.edges.some((edge) => edge.fileId === index.id && "toFileId" in edge && edge.toFileId === worker.id));
	});

	it("indexes the whole tree when a grammar crashes on one file", async () => {
		// Some web-tree-sitter grammars throw on otherwise valid input. A single crashing
		// file must degrade to no extraction for that file, never abort the whole build.
		mkdirSync(join(scratch, "fixtures"), { recursive: true });
		writeFileSync(
			join(scratch, "app.py"),
			["import json", "", "class ApiClient:", "    def get(self, path):", "        return path", ""].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(scratch, "fixtures", "sample.rb"),
			[
				"require 'json'",
				"",
				"class ApiClient",
				"  def initialize(base_url)",
				"    @base_url = base_url",
				"  end",
				"",
				"  def get(path)",
				"    fetch(path, 'GET')",
				"  end",
				"end",
				"",
			].join("\n"),
			"utf8",
		);

		const codewiki = await buildCodewikiWithTreeSitter({ cwd: scratch, language: "python" });
		ok(codewiki.files.some((file) => file.path === "app.py"));
		ok(codewiki.files.some((file) => file.path === "fixtures/sample.rb"));
		ok(codewiki.symbols.some((symbol) => symbol.name === "ApiClient"));
	});

	it("treats v1 codewiki files as stale instead of throwing", () => {
		mkdirSync(join(scratch, ".clio"), { recursive: true });
		writeFileSync(
			join(scratch, ".clio", "codewiki.json"),
			JSON.stringify({
				version: 1,
				generatedAt: "2026-05-01T00:00:00.000Z",
				language: "typescript",
				entries: [{ path: "src/index.ts", exports: [], imports: [], role: "entry point" }],
			}),
			"utf8",
		);

		strictEqual(readCodewiki(scratch), null);
	});

	it("upgrades v2 codewiki files to v3 on read", () => {
		mkdirSync(join(scratch, ".clio"), { recursive: true });
		writeFileSync(
			join(scratch, ".clio", "codewiki.json"),
			JSON.stringify({
				version: 2,
				generatedAt: "2026-05-01T00:00:00.000Z",
				language: "typescript",
				entries: [
					{ path: "src/index.ts", exports: ["main"], imports: ["src/worker.ts"], kind: "entry-point" },
					{ path: "src/worker.ts", exports: ["worker"], imports: [], kind: "module" },
				],
			}),
			"utf8",
		);

		const read = readCodewiki(scratch);
		ok(read);
		strictEqual(read.version, 3);
		strictEqual(read.files.find((file) => file.path === "src/index.ts")?.role, "entry");
		ok(read.symbols.some((symbol) => symbol.name === "main"));
	});

	it("indexes non-empty source files across languages, including single-file repositories", () => {
		writeFileSync(join(scratch, "rendergit.py"), "import sys\n\ndef render(path):\n    return path\n", "utf8");
		mkdirSync(join(scratch, "cmd"), { recursive: true });
		writeFileSync(join(scratch, "cmd", "serve.go"), "package main\n\nfunc main() {}\n", "utf8");
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "lib.rs"), "pub fn run() {}\n", "utf8");

		const codewiki = buildCodewiki({ cwd: scratch, language: "polyglot" });

		deepStrictEqual(
			codewiki.files
				.filter((file) => file.lang !== "config")
				.map((file) => file.path)
				.sort(),
			["cmd/serve.go", "rendergit.py", "src/lib.rs"],
		);
		ok(codewiki.symbols.some((symbol) => symbol.name === "render" && symbol.kind === "func"));
		ok(codewiki.symbols.some((symbol) => symbol.name === "main" && symbol.kind === "func"));
		ok(codewiki.symbols.some((symbol) => symbol.name === "run" && symbol.kind === "func"));
	});

	it("uses web-tree-sitter WASM extraction before regex fallback", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "stream.ts"), "export function* stream() {\n  yield 1;\n}\n", "utf8");

		const fallback = buildCodewiki({ cwd: scratch, language: "typescript" });
		const wasm = await buildCodewikiWithTreeSitter({ cwd: scratch, language: "typescript" });

		strictEqual(
			fallback.symbols.some((symbol) => symbol.name === "stream"),
			false,
		);
		ok(wasm.symbols.some((symbol) => symbol.name === "stream" && symbol.kind === "func"));
	});

	it("indexes TS declarations but skips local variables and control-flow junk in both extraction tiers", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(
			join(scratch, "src", "declarations.ts"),
			[
				" export const exportedValue = 1;",
				"const topLevelValue = 2;",
				"let topLevelCount = 3;",
				"",
				"export function compute(input: number) {",
				"  const localConst = input + topLevelValue;",
				"  let localLet = localConst + topLevelCount;",
				"  if (localLet > 0) {",
				"    return localLet;",
				"  }",
				"  return 0;",
				"}",
				"",
				"export class Widget {",
				"  render() {",
				"    return compute(1);",
				"  }",
				"",
				"  static build() {",
				"    return new Widget();",
				"  }",
				"}",
				"",
			].join("\n"),
			"utf8",
		);

		const regex = buildCodewiki({ cwd: scratch, language: "typescript" });
		const wasm = await buildCodewikiWithTreeSitter({ cwd: scratch, language: "typescript" });

		for (const codewiki of [regex, wasm]) {
			ok(hasSymbol(codewiki, "src/declarations.ts", "exportedValue", "const"));
			ok(hasSymbol(codewiki, "src/declarations.ts", "topLevelValue", "const"));
			ok(hasSymbol(codewiki, "src/declarations.ts", "topLevelCount", "var"));
			ok(hasSymbol(codewiki, "src/declarations.ts", "compute", "func"));
			ok(hasSymbol(codewiki, "src/declarations.ts", "Widget", "class"));
			ok(hasSymbol(codewiki, "src/declarations.ts", "render", "method"));
			ok(hasSymbol(codewiki, "src/declarations.ts", "build", "method"));
			strictEqual(hasSymbol(codewiki, "src/declarations.ts", "localConst"), false);
			strictEqual(hasSymbol(codewiki, "src/declarations.ts", "localLet"), false);
			strictEqual(hasSymbol(codewiki, "src/declarations.ts", "if", "method"), false);
		}
	});

	it("indexes Python module assignments and tree-sitter class attributes but skips function-local assignments", async () => {
		writeFileSync(
			join(scratch, "settings.py"),
			[
				"MODULE_LIMIT = 3",
				"module_value = 'ready'",
				"",
				"class Settings:",
				"    class_attr = True",
				"",
				"    def load(self):",
				"        local_attr = False",
				"        return self.class_attr",
				"",
				"def build():",
				"    local_value = module_value",
				"    return local_value",
				"",
			].join("\n"),
			"utf8",
		);

		const regex = buildCodewiki({ cwd: scratch, language: "python" });
		ok(hasSymbol(regex, "settings.py", "MODULE_LIMIT", "const"));
		ok(hasSymbol(regex, "settings.py", "module_value", "var"));
		strictEqual(hasSymbol(regex, "settings.py", "local_value"), false);
		strictEqual(hasSymbol(regex, "settings.py", "local_attr"), false);

		const wasm = await buildCodewikiWithTreeSitter({ cwd: scratch, language: "python" });
		ok(hasSymbol(wasm, "settings.py", "MODULE_LIMIT", "const"));
		ok(hasSymbol(wasm, "settings.py", "module_value", "var"));
		ok(hasSymbol(wasm, "settings.py", "class_attr", "var"));
		strictEqual(hasSymbol(wasm, "settings.py", "local_value"), false);
		strictEqual(hasSymbol(wasm, "settings.py", "local_attr"), false);
	});

	it("records empty source package markers as files with zero symbols", () => {
		mkdirSync(join(scratch, "pkg"), { recursive: true });
		writeFileSync(join(scratch, "pkg", "__init__.py"), "", "utf8");

		const codewiki = buildCodewiki({ cwd: scratch, language: "python" });
		const marker = codewiki.files.find((file) => file.path === "pkg/__init__.py");

		ok(marker);
		strictEqual(marker.loc, 0);
		strictEqual(
			codewiki.symbols.some((symbol) => symbol.fileId === marker.id),
			false,
		);
	});

	it("updates changed source paths incrementally", () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "alpha.ts"), "export const alpha = 1;\n", "utf8");
		const original = buildCodewiki({
			cwd: scratch,
			language: "typescript",
			generatedAt: "2026-05-01T00:00:00.000Z",
		});
		writeFileSync(join(scratch, "src", "beta.py"), "def beta():\n    return True\n", "utf8");

		const added = updateCodewikiPaths(scratch, original, ["src/beta.py"]);
		ok(added !== original);
		const betaFile = added.files.find((file) => file.path === "src/beta.py");
		ok(betaFile);
		ok(added.symbols.some((symbol) => symbol.fileId === betaFile.id && symbol.name === "beta"));

		rmSync(join(scratch, "src", "alpha.ts"));
		const removed = updateCodewikiPaths(scratch, added, ["src/alpha.ts"]);
		strictEqual(
			removed.files.some((file) => file.path === "src/alpha.ts"),
			false,
		);

		const untouched = updateCodewikiPaths(scratch, removed, ["README.md"]);
		strictEqual(untouched, removed);
	});

	it("hashes structural output deterministically across runs", () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const value = 1;\n", "utf8");

		const first = buildCodewiki({ cwd: scratch, language: "typescript", generatedAt: "2026-05-01T00:00:00.000Z" });
		const second = buildCodewiki({ cwd: scratch, language: "typescript", generatedAt: "2027-01-01T00:00:00.000Z" });

		strictEqual(structuralCodewikiHash(first), structuralCodewikiHash(second));
		deepStrictEqual(first, second);
	});

	it("renders a compact deterministic digest with entries, symbols, areas, and deps", () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(
			join(scratch, "src", "index.ts"),
			"import { worker } from './worker.js';\nexport function main() { return worker; }\n",
			"utf8",
		);
		writeFileSync(
			join(scratch, "src", "worker.ts"),
			"export class Worker {}\nexport const worker = new Worker();\n",
			"utf8",
		);

		const codewiki = buildCodewiki({ cwd: scratch, language: "typescript" });
		const digest = renderCodewikiDigest(codewiki, 200);

		ok(digest.includes("codewiki v3 language=typescript"));
		ok(digest.includes("areas: src=2"));
		ok(digest.includes("- src/index.ts"));
		ok(digest.includes("- Worker class src/worker.ts:1"));
		ok(digest.includes("internal=[src/worker.ts]"));
		strictEqual(digest, renderCodewikiDigest(codewiki, 200));
	});

	it("rebuilds missing or stale codewiki on tool demand", () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		mkdirSync(join(scratch, ".clio"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const rebuilt = true;\n", "utf8");
		writeFileSync(
			join(scratch, ".clio", "codewiki.json"),
			JSON.stringify({
				version: 1,
				generatedAt: "2026-05-01T00:00:00.000Z",
				language: "typescript",
				entries: [],
			}),
			"utf8",
		);

		const loaded = loadCodewikiForTool(scratch);
		if (!loaded.ok) throw new Error(loaded.message);
		strictEqual(loaded.codewiki.version, 3);
		ok(loaded.codewiki.symbols.some((symbol) => symbol.name === "rebuilt"));
		ok(existsSync(join(scratch, ".clio", "codewiki.json")));
		ok(existsSync(join(scratch, ".clio", "state.json")));
	});
});
