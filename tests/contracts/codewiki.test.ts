import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runContextIndexCommand } from "../../src/cli/context-index.js";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import {
	type Codewiki,
	codewikiPath,
	fallbackExtraction,
	parseCodewikiRaw,
	serializeCodewiki,
} from "../../src/domains/context/codewiki/indexer.js";
import { createTreeSitterExtractor } from "../../src/domains/context/codewiki/tree-sitter.js";
import { createContextBundle } from "../../src/domains/context/extension.js";
import {
	buildCodewiki,
	codewikiNeedsBackfill,
	computeFingerprint,
	readClioState,
	readCodewiki,
	renderCodewikiDigest,
	runContextRefresh,
	structuralCodewikiHash,
	updateCodewikiPaths,
	writeClioState,
	writeCodewiki,
} from "../../src/domains/context/index.js";
import { loadCodewikiForTool } from "../../src/tools/codewiki/shared.js";
import { createFileMutationObserver } from "../../src/tools/observers.js";
import { writeTool } from "../../src/tools/write.js";

type BuiltCodewiki = Awaited<ReturnType<typeof buildCodewiki>>;
type ContextBundle = ReturnType<typeof createContextBundle>;

const INDEXED_AT = "2026-05-01T00:00:00.000Z";

function hasSymbol(codewiki: BuiltCodewiki, path: string, name: string, kind?: string): boolean {
	const file = codewiki.files.find((item) => item.path === path);
	if (!file) return false;
	return codewiki.symbols.some(
		(symbol) => symbol.fileId === file.id && symbol.name === name && (!kind || symbol.kind === kind),
	);
}

function symbolFor(
	codewiki: BuiltCodewiki,
	path: string,
	name: string,
	kind?: string,
): BuiltCodewiki["symbols"][number] | undefined {
	const file = codewiki.files.find((item) => item.path === path);
	if (!file) return undefined;
	return codewiki.symbols.find(
		(symbol) => symbol.fileId === file.id && symbol.name === name && (!kind || symbol.kind === kind),
	);
}

function hasInternalEdge(codewiki: BuiltCodewiki, fromPath: string, toPath: string): boolean {
	const from = codewiki.files.find((item) => item.path === fromPath);
	const to = codewiki.files.find((item) => item.path === toPath);
	if (!from || !to) return false;
	return codewiki.edges.some((edge) => edge.fileId === from.id && "toFileId" in edge && edge.toFileId === to.id);
}

function hasExternalEdge(codewiki: BuiltCodewiki, fromPath: string, externalModule: string): boolean {
	const from = codewiki.files.find((item) => item.path === fromPath);
	if (!from) return false;
	return codewiki.edges.some(
		(edge) => edge.fileId === from.id && "externalModule" in edge && edge.externalModule === externalModule,
	);
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<T> {
	const originalWrite = process.stdout.write;
	process.stdout.write = (() => true) as typeof process.stdout.write;
	try {
		return await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
}

function writeIndexedCodewiki(cwd: string, codewiki: BuiltCodewiki): void {
	writeCodewiki(cwd, codewiki);
	writeClioState(cwd, {
		version: 1,
		projectType: codewiki.language,
		fingerprint: computeFingerprint(cwd, codewiki),
		codewikiVersion: codewiki.version,
		lastSessionAt: INDEXED_AT,
		lastIndexedAt: INDEXED_AT,
	});
}

async function withContextBundle(cwd: string, fn: (bundle: ContextBundle) => Promise<void>): Promise<void> {
	const originalCwd = process.cwd();
	process.chdir(cwd);
	const bundle = createContextBundle({ bus: createSafeEventBus(), getContract: () => undefined });
	try {
		await bundle.extension.start();
		await fn(bundle);
	} finally {
		try {
			await bundle.extension.stop?.();
		} finally {
			process.chdir(originalCwd);
		}
	}
}

async function waitForCodewiki(
	cwd: string,
	predicate: (codewiki: BuiltCodewiki) => boolean,
	message: string,
): Promise<BuiltCodewiki> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const codewiki = readCodewiki(cwd);
		if (codewiki && predicate(codewiki)) return codewiki;
		await delay(25);
	}
	throw new Error(message);
}

describe("contracts/codewiki", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-codewiki-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("writes v5 normalized files, symbols, imports, hashes, summaries, and edges", async () => {
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

		const codewiki = await buildCodewiki({
			cwd: scratch,
			language: "typescript",
			generatedAt: "2026-05-01T00:00:00.000Z",
		});
		writeCodewiki(scratch, codewiki);
		const serialized = readFileSync(join(scratch, ".clio-coder", "codewiki.json"), "utf8");
		strictEqual(serialized.includes("\n  "), false);
		strictEqual(serialized.endsWith("\n"), true);
		deepStrictEqual(JSON.parse(serialized), codewiki);
		const read = readCodewiki(scratch);
		ok(read);
		strictEqual(read.version, 5);
		strictEqual(read.files.find((file) => file.path === "src/index.ts")?.role, "entry");
		strictEqual(read.files.find((file) => file.path === "src/math.test.ts")?.role, "test");
		strictEqual(read.files.find((file) => file.path === "src/worker.ts")?.role, "module");
		ok(read.symbols.some((symbol) => symbol.name === "main" && symbol.kind === "func"));
		const index = read.files.find((file) => file.path === "src/index.ts");
		const worker = read.files.find((file) => file.path === "src/worker.ts");
		ok(index);
		ok(worker);
		ok(/^[a-f0-9]{16}$/.test(index.hash));
		deepStrictEqual(index.imports, ["./worker.js"]);
		strictEqual(index.summary, "Starts the application.");
		strictEqual(codewikiNeedsBackfill(read), false);
		ok(read.edges.some((edge) => edge.fileId === index.id && "toFileId" in edge && edge.toFileId === worker.id));
	});

	it("indexes the whole tree when a grammar crashes on one file", async () => {
		// Some tree-sitter grammars throw on otherwise valid input. A single crashing
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

		const codewiki = await buildCodewiki({ cwd: scratch, language: "python" });
		ok(codewiki.files.some((file) => file.path === "app.py"));
		ok(codewiki.files.some((file) => file.path === "fixtures/sample.rb"));
		ok(codewiki.symbols.some((symbol) => symbol.name === "ApiClient"));
	});

	it("loads grammars on demand and throws for paths never ensured", async () => {
		const extractor = await createTreeSitterExtractor();
		throws(() => extractor.extract("app.py", "def run():\n    return 1\n"), /grammar not loaded/);

		await extractor.ensureGrammarsForPaths(["app.py"]);
		const extraction = extractor.extract("app.py", "def run():\n    return 1\n");
		ok(extraction.symbols.some((symbol) => symbol.name === "run" && symbol.kind === "func"));

		// Ensuring python must not implicitly load unrelated grammars.
		throws(() => extractor.extract("main.go", "package main\nfunc main() {}\n"), /grammar not loaded/);
	});

	it("treats v1 codewiki files as stale instead of throwing", () => {
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
		writeFileSync(
			join(scratch, ".clio-coder", "codewiki.json"),
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

	it("upgrades v2 and v3 codewiki files to degraded v5 on read", async () => {
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
		writeFileSync(
			join(scratch, ".clio-coder", "codewiki.json"),
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
		strictEqual(read.version, 5);
		strictEqual(read.files.find((file) => file.path === "src/index.ts")?.role, "entry");
		deepStrictEqual(read.files.find((file) => file.path === "src/index.ts")?.imports, []);
		strictEqual(read.files.find((file) => file.path === "src/index.ts")?.hash, "");
		ok(read.symbols.some((symbol) => symbol.name === "main"));
		strictEqual(codewikiNeedsBackfill(read), true);

		writeFileSync(
			join(scratch, ".clio-coder", "codewiki.json"),
			JSON.stringify({
				version: 3,
				language: "typescript",
				files: [
					{ id: "f_index", path: "src/index.ts", lang: "typescript", loc: 1, role: "entry" },
					{ id: "f_worker", path: "src/worker.ts", lang: "typescript", loc: 1, role: "module" },
				],
				symbols: [{ name: "main", kind: "const", fileId: "f_index", line: 1 }],
				edges: [{ fileId: "f_index", toFileId: "f_worker" }],
			}),
			"utf8",
		);

		const upgradedV3 = readCodewiki(scratch);
		ok(upgradedV3);
		strictEqual(upgradedV3.version, 5);
		strictEqual(upgradedV3.files.find((file) => file.path === "src/index.ts")?.hash, "");
		deepStrictEqual(upgradedV3.files.find((file) => file.path === "src/index.ts")?.imports, []);
		strictEqual(codewikiNeedsBackfill(upgradedV3), true);

		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const main = 1;\n", "utf8");
		writeFileSync(join(scratch, "src", "worker.ts"), "export const worker = 1;\n", "utf8");
		const rebuilt = await buildCodewiki({ cwd: scratch, language: "typescript" });
		strictEqual(codewikiNeedsBackfill(rebuilt), false);
	});

	it("migrates v4 for a full extraction backfill and strips unsupported signature fields", () => {
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
		writeFileSync(
			join(scratch, ".clio-coder", "codewiki.json"),
			JSON.stringify({
				version: 4,
				language: "typescript",
				files: [
					{
						id: "f_legacy",
						path: "src/legacy.ts",
						lang: "typescript",
						loc: 4,
						role: "module",
						hash: "abc123",
						imports: [],
					},
				],
				symbols: [
					{ name: "main", kind: "func", fileId: "f_legacy", line: 1, sig: "export function main() {}" },
					{ name: "Service", kind: "class", fileId: "f_legacy", line: 2, sig: "export class Service {}" },
					{ name: "value", kind: "const", fileId: "f_legacy", line: 3, sig: "export const value = 1;" },
					{ name: "state", kind: "var", fileId: "f_legacy", line: 4, sig: "let state = 1;" },
					{ name: "Runnable", kind: "trait", fileId: "f_legacy", line: 5, sig: "pub trait Runnable {}" },
					{ name: "Shape", kind: "iface", fileId: "f_legacy", line: 6, sig: "interface Shape {}" },
				],
				edges: [],
			}),
			"utf8",
		);

		const read = readCodewiki(scratch);
		ok(read);
		strictEqual(read.version, 5);
		strictEqual(read.files[0]?.hash, "");
		strictEqual(codewikiNeedsBackfill(read), true);
		strictEqual(symbolFor(read, "src/legacy.ts", "main", "func")?.sig, "export function main() {}");
		strictEqual(symbolFor(read, "src/legacy.ts", "Service", "class")?.sig, "export class Service {}");
		strictEqual(symbolFor(read, "src/legacy.ts", "value", "const")?.sig, undefined);
		strictEqual(symbolFor(read, "src/legacy.ts", "state", "var")?.sig, undefined);
		strictEqual(symbolFor(read, "src/legacy.ts", "Runnable", "trait")?.sig, undefined);
		strictEqual(symbolFor(read, "src/legacy.ts", "Shape", "iface")?.sig, undefined);
	});

	it("rejects semantically invalid native v5 artifacts", () => {
		const valid: Codewiki = {
			version: 5,
			language: "typescript",
			files: [
				{
					id: "f_source",
					path: "src/source.ts",
					lang: "typescript",
					loc: 2,
					role: "module",
					hash: "0123456789abcdef",
					imports: [],
				},
			],
			symbols: [{ name: "source", kind: "const", fileId: "f_source", line: 2 }],
			edges: [{ fileId: "f_source", externalModule: "node:fs" }],
		};
		ok(parseCodewikiRaw(JSON.stringify(valid)));
		const firstFile = (artifact: Codewiki): Codewiki["files"][number] => {
			const file = artifact.files[0];
			if (!file) throw new Error("native-v5 fixture has no file");
			return file;
		};
		const firstSymbol = (artifact: Codewiki): Codewiki["symbols"][number] => {
			const symbol = artifact.symbols[0];
			if (!symbol) throw new Error("native-v5 fixture has no symbol");
			return symbol;
		};
		const firstEdge = (artifact: Codewiki): Codewiki["edges"][number] => {
			const edge = artifact.edges[0];
			if (!edge) throw new Error("native-v5 fixture has no edge");
			return edge;
		};

		const invalidCases: ReadonlyArray<readonly [string, (artifact: Codewiki) => void]> = [
			[
				"duplicate file id",
				(artifact) => {
					artifact.files.push({ ...firstFile(artifact), path: "src/other.ts" });
				},
			],
			[
				"duplicate file path",
				(artifact) => {
					artifact.files.push({ ...firstFile(artifact), id: "f_other" });
				},
			],
			["absolute path", (artifact) => (firstFile(artifact).path = "/src/source.ts")],
			["non-normalized path", (artifact) => (firstFile(artifact).path = "src/../source.ts")],
			["backslash path", (artifact) => (firstFile(artifact).path = "src\\source.ts")],
			["noncanonical hash length", (artifact) => (firstFile(artifact).hash = "0123456789abcde")],
			["noncanonical hash case", (artifact) => (firstFile(artifact).hash = "0123456789abcdeF")],
			["dangling symbol file", (artifact) => (firstSymbol(artifact).fileId = "f_missing")],
			["symbol line past loc", (artifact) => (firstSymbol(artifact).line = 3)],
			["dangling edge source", (artifact) => (firstEdge(artifact).fileId = "f_missing")],
			[
				"dangling internal edge target",
				(artifact) => {
					artifact.edges = [{ fileId: "f_source", toFileId: "f_missing" }];
				},
			],
		];
		for (const [name, mutate] of invalidCases) {
			const artifact = structuredClone(valid);
			mutate(artifact);
			strictEqual(parseCodewikiRaw(JSON.stringify(artifact)), null, name);
		}
	});

	it("indexes non-empty source files across languages, including single-file repositories", async () => {
		writeFileSync(join(scratch, "rendergit.py"), "import sys\n\ndef render(path):\n    return path\n", "utf8");
		mkdirSync(join(scratch, "cmd"), { recursive: true });
		writeFileSync(join(scratch, "cmd", "serve.go"), "package main\n\nfunc main() {}\n", "utf8");
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "lib.rs"), "pub fn run() {}\n", "utf8");

		const codewiki = await buildCodewiki({ cwd: scratch, language: "polyglot" });

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

	it("uses tree-sitter extraction in the unified builder", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "stream.ts"), "export function* stream() {\n  yield 1;\n}\n", "utf8");

		const codewiki = await buildCodewiki({ cwd: scratch, language: "typescript" });

		ok(codewiki.symbols.some((symbol) => symbol.name === "stream" && symbol.kind === "func"));
	});

	it("writes signatures only for function, method, class, and type symbols", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(
			join(scratch, "src", "signatures.ts"),
			[
				"export const exportedValue = 1;",
				"let mutableValue = 2;",
				"export type Payload = { value: number };",
				"export class Service {",
				"  run(): number { return exportedValue; }",
				"}",
				"export function makePayload(): Payload { return { value: mutableValue }; }",
				"",
			].join("\n"),
			"utf8",
		);

		const codewiki = await buildCodewiki({ cwd: scratch, language: "typescript" });

		ok(symbolFor(codewiki, "src/signatures.ts", "Payload", "type")?.sig);
		ok(symbolFor(codewiki, "src/signatures.ts", "Service", "class")?.sig);
		ok(symbolFor(codewiki, "src/signatures.ts", "run", "method")?.sig);
		ok(symbolFor(codewiki, "src/signatures.ts", "makePayload", "func")?.sig);
		strictEqual(symbolFor(codewiki, "src/signatures.ts", "exportedValue", "const")?.sig, undefined);
		strictEqual(symbolFor(codewiki, "src/signatures.ts", "mutableValue", "var")?.sig, undefined);
	});

	it("indexes TS declarations but skips local variables and control-flow junk", async () => {
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

		const codewiki = await buildCodewiki({ cwd: scratch, language: "typescript" });

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
	});

	it("indexes Python module and class assignments but skips function-local assignments", async () => {
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

		const codewiki = await buildCodewiki({ cwd: scratch, language: "python" });
		ok(hasSymbol(codewiki, "settings.py", "MODULE_LIMIT", "const"));
		ok(hasSymbol(codewiki, "settings.py", "module_value", "var"));
		ok(hasSymbol(codewiki, "settings.py", "class_attr", "var"));
		strictEqual(hasSymbol(codewiki, "settings.py", "local_value"), false);
		strictEqual(hasSymbol(codewiki, "settings.py", "local_attr"), false);
	});

	it("records empty source package markers as files with zero symbols", async () => {
		mkdirSync(join(scratch, "pkg"), { recursive: true });
		writeFileSync(join(scratch, "pkg", "__init__.py"), "", "utf8");

		const codewiki = await buildCodewiki({ cwd: scratch, language: "python" });
		const marker = codewiki.files.find((file) => file.path === "pkg/__init__.py");

		ok(marker);
		strictEqual(marker.loc, 0);
		strictEqual(
			codewiki.symbols.some((symbol) => symbol.fileId === marker.id),
			false,
		);
	});

	it("persists Python module docstring summaries", async () => {
		writeFileSync(
			join(scratch, "app.py"),
			[
				'"""Runs the Python entry point.',
				"",
				"More detail for the summary.",
				'"""',
				"",
				"def main():",
				"    return 0",
				"",
			].join("\n"),
			"utf8",
		);

		const codewiki = await buildCodewiki({ cwd: scratch, language: "python" });
		strictEqual(
			codewiki.files.find((file) => file.path === "app.py")?.summary,
			"Runs the Python entry point. More detail for the summary.",
		);
	});

	it("updates changed source paths incrementally", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "alpha.ts"), "export const alpha = 1;\n", "utf8");
		const original = await buildCodewiki({
			cwd: scratch,
			language: "typescript",
			generatedAt: "2026-05-01T00:00:00.000Z",
		});
		writeFileSync(join(scratch, "src", "beta.py"), "def beta():\n    return True\n", "utf8");

		const added = await updateCodewikiPaths(scratch, original, ["src/beta.py"]);
		ok(added !== original);
		const betaFile = added.files.find((file) => file.path === "src/beta.py");
		ok(betaFile);
		ok(added.symbols.some((symbol) => symbol.fileId === betaFile.id && symbol.name === "beta"));

		rmSync(join(scratch, "src", "alpha.ts"));
		const removed = await updateCodewikiPaths(scratch, added, ["src/alpha.ts"]);
		strictEqual(
			removed.files.some((file) => file.path === "src/alpha.ts"),
			false,
		);

		const untouched = await updateCodewikiPaths(scratch, removed, ["README.md"]);
		strictEqual(untouched, removed);
	});

	it("reconciles a rename when both old and new paths are reported", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(
			join(scratch, "src", "index.ts"),
			"import { helper } from './old-name.js';\nexport const main = helper;\n",
			"utf8",
		);
		writeFileSync(join(scratch, "src", "old-name.ts"), "export const helper = 1;\n", "utf8");
		const original = await buildCodewiki({ cwd: scratch, language: "typescript" });
		ok(hasInternalEdge(original, "src/index.ts", "src/old-name.ts"));

		renameSync(join(scratch, "src", "old-name.ts"), join(scratch, "src", "new-name.ts"));
		writeFileSync(
			join(scratch, "src", "index.ts"),
			"import { helper } from './new-name.js';\nexport const main = helper;\n",
			"utf8",
		);

		// A rename reported with only the destination keeps the stale source record;
		// renames are intentionally not inferred, and the fingerprint rail triggers a
		// full rebuild for moves no tool reported.
		const destinationOnly = await updateCodewikiPaths(scratch, original, ["src/new-name.ts"]);
		ok(destinationOnly.files.some((file) => file.path === "src/old-name.ts"));
		ok(hasSymbol(destinationOnly, "src/new-name.ts", "helper", "const"));

		const updated = await updateCodewikiPaths(scratch, original, ["src/old-name.ts", "src/new-name.ts", "src/index.ts"]);
		deepStrictEqual(updated, await buildCodewiki({ cwd: scratch, language: "typescript" }));
		strictEqual(
			updated.files.some((file) => file.path === "src/old-name.ts"),
			false,
		);
		ok(hasSymbol(updated, "src/new-name.ts", "helper", "const"));
		ok(hasInternalEdge(updated, "src/index.ts", "src/new-name.ts"));
	});

	it("matches full rebuilds after incremental add, import modification, and delete", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		mkdirSync(join(scratch, "pkg"), { recursive: true });
		writeFileSync(
			join(scratch, "src", "index.ts"),
			"import { worker } from './worker.js';\nexport const main = worker;\n",
			"utf8",
		);
		writeFileSync(join(scratch, "src", "worker.ts"), "export const worker = 1;\n", "utf8");
		writeFileSync(
			join(scratch, "pkg", "main.py"),
			"from .helper import helper\n\ndef run():\n    return helper()\n",
			"utf8",
		);
		writeFileSync(join(scratch, "pkg", "helper.py"), "def helper():\n    return 1\n", "utf8");

		let incremental = await buildCodewiki({ cwd: scratch, language: "polyglot" });

		writeFileSync(
			join(scratch, "src", "feature.ts"),
			"import { worker } from './worker.js';\nexport const feature = worker;\n",
			"utf8",
		);
		incremental = await updateCodewikiPaths(scratch, incremental, ["src/feature.ts"]);
		deepStrictEqual(incremental, await buildCodewiki({ cwd: scratch, language: "polyglot" }));

		writeFileSync(
			join(scratch, "src", "index.ts"),
			"import { feature } from './feature.js';\nexport const main = feature;\n",
			"utf8",
		);
		incremental = await updateCodewikiPaths(scratch, incremental, ["src/index.ts"]);
		deepStrictEqual(incremental, await buildCodewiki({ cwd: scratch, language: "polyglot" }));

		rmSync(join(scratch, "src", "worker.ts"));
		incremental = await updateCodewikiPaths(scratch, incremental, ["src/worker.ts"]);
		deepStrictEqual(incremental, await buildCodewiki({ cwd: scratch, language: "polyglot" }));
		ok(hasExternalEdge(incremental, "src/feature.ts", "./worker.js"));
	});

	it("keeps extension incremental bytes equal to a full rebuild across cached batches", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(
			join(scratch, "src", "index.ts"),
			"import { worker } from './worker.js';\nexport const main = worker;\n",
			"utf8",
		);
		writeFileSync(join(scratch, "src", "worker.ts"), "export const worker = 1;\n", "utf8");
		writeFileSync(join(scratch, "src", "remove.ts"), "export const remove = true;\n", "utf8");
		const initial = await buildCodewiki({ cwd: scratch, language: "typescript" });
		writeIndexedCodewiki(scratch, initial);

		await withContextBundle(scratch, async (bundle) => {
			writeFileSync(
				join(scratch, "src", "feature.ts"),
				"import { worker } from './worker.js';\nexport const feature = worker;\n",
				"utf8",
			);
			bundle.contract.noteFileChanges(["src/feature.ts"], scratch);
			await waitForCodewiki(
				scratch,
				(codewiki) => hasSymbol(codewiki, "src/feature.ts", "feature", "const"),
				"feature.ts was not indexed incrementally",
			);

			writeFileSync(
				join(scratch, "src", "index.ts"),
				"import { feature } from './feature.js';\nexport const main = feature;\n",
				"utf8",
			);
			bundle.contract.noteFileChanges([join(scratch, "src", "index.ts")], scratch);
			await waitForCodewiki(
				scratch,
				(codewiki) =>
					codewiki.files.find((file) => file.path === "src/index.ts")?.imports.includes("./feature.js") ?? false,
				"index.ts import change was not indexed incrementally",
			);

			rmSync(join(scratch, "src", "worker.ts"));
			bundle.contract.noteFileChanges(["src/worker.ts"], scratch);
		});

		const actual = readFileSync(codewikiPath(scratch), "utf8");
		const rebuilt = await buildCodewiki({ cwd: scratch, language: "typescript" });
		strictEqual(actual, serializeCodewiki(rebuilt));
	});

	it("misses the extension cache after an external codewiki overwrite", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "base.ts"), "export const baseBefore = true;\n", "utf8");
		const initial = await buildCodewiki({ cwd: scratch, language: "typescript" });
		writeIndexedCodewiki(scratch, initial);

		await withContextBundle(scratch, async (bundle) => {
			writeFileSync(join(scratch, "src", "first.ts"), "export const first = true;\n", "utf8");
			bundle.contract.noteFileChanges(["src/first.ts"], scratch);
			const afterBatchOne = await waitForCodewiki(
				scratch,
				(codewiki) => hasSymbol(codewiki, "src/first.ts", "first", "const"),
				"first.ts was not indexed incrementally",
			);
			const markerFile: BuiltCodewiki["files"][number] = {
				id: "f_external_marker",
				path: "virtual/external-marker.ts",
				lang: "typescript",
				loc: 1,
				role: "module",
				hash: "eeeeeeeeeeeeeeee",
				imports: [],
			};
			writeCodewiki(scratch, {
				...afterBatchOne,
				files: [...afterBatchOne.files, markerFile],
				symbols: [...afterBatchOne.symbols, { name: "externalMarker", kind: "const", fileId: markerFile.id, line: 1 }],
			});

			writeFileSync(join(scratch, "src", "base.ts"), "export const baseAfter = true;\n", "utf8");
			bundle.contract.noteFileChanges(["src/base.ts"], scratch);
		});

		const final = readCodewiki(scratch);
		ok(final);
		ok(hasSymbol(final, "virtual/external-marker.ts", "externalMarker", "const"));
		ok(hasSymbol(final, "src/base.ts", "baseAfter", "const"));
		strictEqual(hasSymbol(final, "src/base.ts", "baseBefore", "const"), false);
	});

	it("reads only changed files during incremental updates", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		for (let index = 0; index < 6; index += 1) {
			writeFileSync(join(scratch, "src", `file-${index}.ts`), `export const value${index} = ${index};\n`, "utf8");
		}
		const original = await buildCodewiki({ cwd: scratch, language: "typescript" });
		writeFileSync(join(scratch, "src", "file-3.ts"), "export const value3 = 33;\n", "utf8");
		const reads: string[] = [];

		const updated = await updateCodewikiPaths(scratch, original, ["src/file-3.ts"], {
			readFile(path) {
				reads.push(relative(scratch, path).split("\\").join("/"));
				try {
					return readFileSync(path, "utf8");
				} catch {
					return null;
				}
			},
		});

		deepStrictEqual(reads, ["src/file-3.ts"]);
		deepStrictEqual(updated, await buildCodewiki({ cwd: scratch, language: "typescript" }));
	});

	it("hashes structural output deterministically across runs", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const value = 1;\n", "utf8");

		const first = await buildCodewiki({ cwd: scratch, language: "typescript", generatedAt: "2026-05-01T00:00:00.000Z" });
		const second = await buildCodewiki({ cwd: scratch, language: "typescript", generatedAt: "2027-01-01T00:00:00.000Z" });

		strictEqual(structuralCodewikiHash(first), structuralCodewikiHash(second));
		deepStrictEqual(first, second);
	});

	it("renders a compact deterministic digest with entries, symbols, areas, and deps", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(
			join(scratch, "src", "index.ts"),
			[
				"/**",
				" * Starts the digest entry.",
				" */",
				"import { worker } from './worker.js';",
				"export function main() { return worker; }",
				"",
			].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(scratch, "src", "worker.ts"),
			"export class Worker {}\nexport const worker = new Worker();\n",
			"utf8",
		);

		const codewiki = await buildCodewiki({ cwd: scratch, language: "typescript" });
		const digest = renderCodewikiDigest(codewiki, 200);

		ok(digest.includes("codewiki v5 language=typescript"));
		ok(digest.includes("areas: src=2"));
		ok(digest.includes("- src/index.ts"));
		ok(digest.includes("Starts the digest entry."));
		ok(digest.includes("- Worker class src/worker.ts:1"));
		ok(digest.includes("internal=[src/worker.ts]"));
		strictEqual(digest, renderCodewikiDigest(codewiki, 200));
	});

	it("rebuilds missing or stale codewiki on tool demand", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const rebuilt = true;\n", "utf8");
		writeFileSync(
			join(scratch, ".clio-coder", "codewiki.json"),
			JSON.stringify({
				version: 1,
				generatedAt: "2026-05-01T00:00:00.000Z",
				language: "typescript",
				entries: [],
			}),
			"utf8",
		);

		const loaded = await loadCodewikiForTool(scratch);
		if (!loaded.ok) throw new Error(loaded.message);
		strictEqual(loaded.codewiki.version, 5);
		ok(loaded.codewiki.symbols.some((symbol) => symbol.name === "rebuilt"));
		ok(existsSync(join(scratch, ".clio-coder", "codewiki.json")));
		ok(existsSync(join(scratch, ".clio-coder", "state.json")));
		strictEqual(readClioState(scratch)?.codewikiVersion, 5);
	});

	it("backfills degraded upgraded codewiki artifacts on tool demand", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const backfilled = true;\n", "utf8");
		writeFileSync(
			join(scratch, ".clio-coder", "codewiki.json"),
			JSON.stringify({
				version: 3,
				language: "typescript",
				files: [{ id: "f_index", path: "src/index.ts", lang: "typescript", loc: 1, role: "entry" }],
				symbols: [{ name: "old", kind: "const", fileId: "f_index", line: 1 }],
				edges: [],
			}),
			"utf8",
		);

		const degraded = readCodewiki(scratch);
		ok(degraded);
		strictEqual(codewikiNeedsBackfill(degraded), true);
		const loaded = await loadCodewikiForTool(scratch);
		if (!loaded.ok) throw new Error(loaded.message);
		strictEqual(codewikiNeedsBackfill(loaded.codewiki), false);
		ok(loaded.codewiki.symbols.some((symbol) => symbol.name === "backfilled"));
	});

	it("rebuilds stale codewiki artifacts on tool demand after source edits", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		const sourcePath = join(scratch, "src", "index.ts");
		const indexedAt = "2026-05-01T00:00:00.000Z";
		writeFileSync(sourcePath, "export const staleBefore = true;\n", "utf8");
		const original = await buildCodewiki({ cwd: scratch, language: "typescript", generatedAt: indexedAt });
		writeCodewiki(scratch, original);
		writeClioState(scratch, {
			version: 1,
			projectType: "typescript",
			fingerprint: computeFingerprint(scratch, original),
			codewikiVersion: original.version,
			lastSessionAt: indexedAt,
			lastIndexedAt: indexedAt,
		});

		writeFileSync(sourcePath, "export const freshAfter = true;\n", "utf8");
		const future = new Date(Date.now() + 1000);
		utimesSync(sourcePath, future, future);

		const loaded = await loadCodewikiForTool(scratch);

		if (!loaded.ok) throw new Error(loaded.message);
		ok(loaded.codewiki.symbols.some((symbol) => symbol.name === "freshAfter"));
		strictEqual(
			loaded.codewiki.symbols.some((symbol) => symbol.name === "staleBefore"),
			false,
		);
		strictEqual(readClioState(scratch)?.fingerprint.treeHash, computeFingerprint(scratch, loaded.codewiki).treeHash);
	});

	it("builds identical artifacts through refresh and context-index paths", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		mkdirSync(join(scratch, "pkg"), { recursive: true });
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "codewiki-path-equality" }), "utf8");
		writeFileSync(
			join(scratch, "src", "index.ts"),
			"import { value } from './value.js';\nexport const main = value;\n",
			"utf8",
		);
		writeFileSync(join(scratch, "src", "value.ts"), "export const value = 1;\n", "utf8");
		writeFileSync(
			join(scratch, "pkg", "tool.py"),
			"from .helper import helper\n\ndef run():\n    return helper()\n",
			"utf8",
		);
		writeFileSync(join(scratch, "pkg", "helper.py"), "def helper():\n    return 1\n", "utf8");
		writeFileSync(join(scratch, "main.go"), 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println(1) }\n', "utf8");

		await runContextRefresh({ cwd: scratch });
		const refreshed = readCodewiki(scratch);
		ok(refreshed);
		strictEqual(readClioState(scratch)?.codewikiVersion, 5);

		const originalCwd = process.cwd();
		process.chdir(scratch);
		try {
			const exitCode = await captureStdout(() => runContextIndexCommand(["--json"]));
			strictEqual(exitCode, 0);
		} finally {
			process.chdir(originalCwd);
		}
		const indexed = readCodewiki(scratch);
		ok(indexed);
		strictEqual(readClioState(scratch)?.codewikiVersion, 5);
		deepStrictEqual(indexed, refreshed);
	});

	it("extracts imports across supported grammars", async () => {
		mkdirSync(join(scratch, "ts"), { recursive: true });
		writeFileSync(join(scratch, "ts", "main.ts"), "import { dep } from './dep.js';\nexport const main = dep;\n", "utf8");
		writeFileSync(join(scratch, "ts", "dep.ts"), "export const dep = 1;\n", "utf8");

		mkdirSync(join(scratch, "py"), { recursive: true });
		writeFileSync(
			join(scratch, "py", "main.py"),
			"from .helper import helper\n\ndef run():\n    return helper()\n",
			"utf8",
		);
		writeFileSync(join(scratch, "py", "helper.py"), "def helper():\n    return 1\n", "utf8");

		mkdirSync(join(scratch, "go"), { recursive: true });
		writeFileSync(
			join(scratch, "go", "main.go"),
			'package main\n\nimport "./local"\n\nfunc main() { local.Run() }\n',
			"utf8",
		);
		writeFileSync(join(scratch, "go", "local.go"), "package local\n\nfunc Run() {}\n", "utf8");

		mkdirSync(join(scratch, "rust"), { recursive: true });
		writeFileSync(
			join(scratch, "rust", "lib.rs"),
			"use crate::foo::{bar, baz};\nextern crate serde;\npub fn run() {}\n",
			"utf8",
		);

		mkdirSync(join(scratch, "c"), { recursive: true });
		writeFileSync(join(scratch, "c", "main.c"), "#include <stdio.h>\nint main() { return 0; }\n", "utf8");

		mkdirSync(join(scratch, "java"), { recursive: true });
		writeFileSync(join(scratch, "java", "App.java"), "import java.util.List;\nclass App { void run() {} }\n", "utf8");

		mkdirSync(join(scratch, "rb", "vendor"), { recursive: true });
		writeFileSync(
			join(scratch, "rb", "app.rb"),
			"require_relative 'helper'\nrequire 'vendor/tool'\nclass App\nend\n",
			"utf8",
		);
		writeFileSync(join(scratch, "rb", "helper.rb"), "class Helper\nend\n", "utf8");
		writeFileSync(join(scratch, "rb", "vendor", "tool.rb"), "class Tool\nend\n", "utf8");

		const codewiki = await buildCodewiki({ cwd: scratch, language: "polyglot" });

		ok(hasInternalEdge(codewiki, "ts/main.ts", "ts/dep.ts"));
		ok(hasInternalEdge(codewiki, "py/main.py", "py/helper.py"));
		ok(hasInternalEdge(codewiki, "go/main.go", "go/local.go"));
		ok(hasExternalEdge(codewiki, "rust/lib.rs", "crate::foo::{bar, baz}"));
		ok(hasExternalEdge(codewiki, "rust/lib.rs", "serde"));
		ok(hasExternalEdge(codewiki, "c/main.c", "stdio.h"));
		ok(hasExternalEdge(codewiki, "java/App.java", "java.util.List"));
		ok(hasInternalEdge(codewiki, "rb/app.rb", "rb/helper.rb"));
		ok(hasExternalEdge(codewiki, "rb/app.rb", "vendor/tool"));
		strictEqual(hasInternalEdge(codewiki, "rb/app.rb", "rb/vendor/tool.rb"), false);
	});

	it("indexes C# declarations and using directives without method locals", async () => {
		writeFileSync(
			join(scratch, "Widget.cs"),
			[
				"using System.Text;",
				"",
				"public interface IService {",
				"    void Run();",
				"}",
				"",
				"public class Widget {",
				"    public string Name { get; set; }",
				"    public static readonly int Max = 3;",
				"",
				"    public Widget() {}",
				"",
				"    public void Run() {",
				"        var localValue = 1;",
				"    }",
				"}",
				"",
				"public record Thing(int Id);",
				"public struct Bag {}",
				"public enum Color { Red }",
				"",
			].join("\n"),
			"utf8",
		);

		const codewiki = await buildCodewiki({ cwd: scratch, language: "polyglot" });

		ok(hasSymbol(codewiki, "Widget.cs", "IService", "iface"));
		ok(hasSymbol(codewiki, "Widget.cs", "Widget", "class"));
		ok(hasSymbol(codewiki, "Widget.cs", "Name", "var"));
		ok(hasSymbol(codewiki, "Widget.cs", "Max", "const"));
		ok(hasSymbol(codewiki, "Widget.cs", "Run", "method"));
		ok(hasSymbol(codewiki, "Widget.cs", "Thing", "type"));
		ok(hasSymbol(codewiki, "Widget.cs", "Bag", "type"));
		ok(hasSymbol(codewiki, "Widget.cs", "Color", "type"));
		ok(hasExternalEdge(codewiki, "Widget.cs", "System.Text"));
		strictEqual(hasSymbol(codewiki, "Widget.cs", "localValue"), false);
	});

	it("extracts C# declarations through the regex fallback when tree-sitter fails", () => {
		const extraction = fallbackExtraction(
			"c#",
			"Widget.cs",
			[
				"using System.Text;",
				"using static System.Math;",
				"using Alias = System.Collections.Generic;",
				"",
				"public interface IService {",
				"    void Run();",
				"}",
				"",
				"public sealed class Widget {",
				"    public const int Max = 3;",
				"",
				"    public void Run(int count) {",
				"    }",
				"}",
				"",
				"public record Thing(int Id);",
				"public struct Bag {}",
				"public enum Color { Red }",
				"",
			].join("\n"),
		);

		const kindsByName = new Map(extraction.symbols.map((symbol) => [symbol.name, symbol.kind]));
		strictEqual(kindsByName.get("IService"), "iface");
		strictEqual(kindsByName.get("Widget"), "class");
		strictEqual(kindsByName.get("Max"), "const");
		strictEqual(kindsByName.get("Run"), "method");
		strictEqual(kindsByName.get("Thing"), "type");
		strictEqual(kindsByName.get("Bag"), "type");
		strictEqual(kindsByName.get("Color"), "type");
		deepStrictEqual(extraction.imports, ["System.Collections.Generic", "System.Math", "System.Text"]);
	});

	it("skips Go function-local var and const specs while keeping package declarations", async () => {
		writeFileSync(
			join(scratch, "main.go"),
			[
				"package main",
				"",
				"const PackageConst = 1",
				"var PackageVar = 2",
				"",
				"func main() {",
				"    const localConst = 3",
				"    var localVar = 4",
				"}",
				"",
			].join("\n"),
			"utf8",
		);

		const codewiki = await buildCodewiki({ cwd: scratch, language: "go" });

		ok(hasSymbol(codewiki, "main.go", "PackageConst", "const"));
		ok(hasSymbol(codewiki, "main.go", "PackageVar", "var"));
		strictEqual(hasSymbol(codewiki, "main.go", "localConst"), false);
		strictEqual(hasSymbol(codewiki, "main.go", "localVar"), false);
	});

	it("awaits the final incremental codewiki write during context extension stop", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const seeded = true;\n", "utf8");
		const initial = await buildCodewiki({ cwd: scratch, language: "typescript" });
		writeIndexedCodewiki(scratch, initial);
		const originalCwd = process.cwd();
		process.chdir(scratch);
		try {
			const bundle = createContextBundle({ bus: createSafeEventBus(), getContract: () => undefined });
			await bundle.extension.start();
			writeFileSync(join(scratch, "src", "late.ts"), "export const stopWritten = true;\n", "utf8");
			// Not awaited through waitForCodewiki on purpose: stop() must drain the
			// incremental queue itself before the process is allowed to exit.
			bundle.contract.noteFileChanges(["src/late.ts"], scratch);
			await bundle.extension.stop?.();
		} finally {
			process.chdir(originalCwd);
		}

		const codewiki = readCodewiki(scratch);
		ok(codewiki);
		ok(hasSymbol(codewiki, "src/late.ts", "stopWritten", "const"));
	});

	it("drains session-start freshness and performs no later write after stop", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const beforeStart = true;\n", "utf8");
		writeIndexedCodewiki(scratch, await buildCodewiki({ cwd: scratch, language: "typescript" }));
		writeFileSync(join(scratch, "src", "index.ts"), "export const refreshedAtStart = true;\n", "utf8");
		const originalCwd = process.cwd();
		process.chdir(scratch);
		try {
			const bus = createSafeEventBus();
			const bundle = createContextBundle({ bus, getContract: () => undefined });
			await bundle.extension.start();
			bus.emit(BusChannels.SessionStart, { at: Date.now() });
			await bundle.extension.stop?.();
		} finally {
			process.chdir(originalCwd);
		}

		const committed = readCodewiki(scratch);
		ok(committed);
		ok(hasSymbol(committed, "src/index.ts", "refreshedAtStart", "const"));
		const bytesAtStop = readFileSync(codewikiPath(scratch), "utf8");
		await delay(100);
		strictEqual(readFileSync(codewikiPath(scratch), "utf8"), bytesAtStop);
	});

	it("leaves a never-indexed directory alone across context extension start and stop", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const untouched = true;\n", "utf8");
		const originalCwd = process.cwd();
		process.chdir(scratch);
		try {
			const bundle = createContextBundle({ bus: createSafeEventBus(), getContract: () => undefined });
			await bundle.extension.start();
			await bundle.extension.stop?.();
		} finally {
			process.chdir(originalCwd);
		}

		// Indexing is opt-in; exiting in a directory is not a request to index it (issue #99).
		strictEqual(existsSync(join(scratch, ".clio-coder")), false);
		strictEqual(readCodewiki(scratch), null);
	});

	/**
	 * `withStateFileLock` creates the lock's parent before anything inside it can
	 * decide there is nothing to do, so `coordinateCodewikiWrite` acquired a lease
	 * in `.clio-coder/` and only then rechecked `requireExisting`. Every
	 * successful write in a never-indexed project therefore left an empty
	 * `.clio-coder/` behind: the lock file was created, released, and deleted, and
	 * the directory stayed (issue #248). Indexing is opt-in, and a write is not a
	 * request to index.
	 */
	it("leaves no .clio-coder behind when a never-indexed project reports a file change", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const written = true;\n", "utf8");

		await withContextBundle(scratch, async (bundle) => {
			bundle.contract.noteFileChanges([join(scratch, "src", "index.ts")], scratch);
		});

		strictEqual(existsSync(join(scratch, ".clio-coder")), false, "the no-op materialized no state directory");
		strictEqual(readCodewiki(scratch), null, "and indexed nothing");
	});

	/**
	 * The observer path end to end: the real `write` tool, the real middleware
	 * hook that reports its mutation, and the real incremental refresh behind it.
	 * The only thing on disk afterwards is the file the operator asked for.
	 */
	it("produces only the requested mutation for a successful write in a never-indexed project", async () => {
		const target = join(scratch, "probe", "output.txt");
		await withContextBundle(scratch, async (bundle) => {
			const observer = createFileMutationObserver((event) => bundle.contract.noteFileChanges(event.paths, scratch));
			const result = await writeTool.run({ path: target, content: "hello\n" });
			strictEqual(result.kind, "ok", JSON.stringify(result));
			observer.evaluate({
				toolName: "write",
				toolArgs: { path: target, content: "hello\n" },
				metadata: { resultKind: "ok" },
			} as never);
		});

		strictEqual(readFileSync(target, "utf8"), "hello\n", "the write itself still happened");
		strictEqual(existsSync(join(scratch, ".clio-coder")), false, "and left no residue beside it");
		deepStrictEqual(readdirSync(scratch).sort(), ["probe"], "nothing else appeared in the project");
	});

	/**
	 * The other half: an indexed project still runs its incremental refresh under
	 * the same queue and lock, and the recheck under the lock is still what
	 * decides the race.
	 */
	it("still refreshes incrementally once the project has a codewiki", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const before = 1;\n", "utf8");
		const seeded = await buildCodewiki({ cwd: scratch, language: "typescript" });
		writeCodewiki(scratch, seeded);
		ok(readCodewiki(scratch), "the fixture is indexed");

		writeFileSync(join(scratch, "src", "index.ts"), "export const afterIncremental = 2;\n", "utf8");
		await withContextBundle(scratch, async (bundle) => {
			bundle.contract.noteFileChanges([join(scratch, "src", "index.ts")], scratch);
		});

		const codewiki = readCodewiki(scratch);
		ok(codewiki);
		ok(hasSymbol(codewiki, "src/index.ts", "afterIncremental", "const"), "the incremental refresh still lands");
	});

	it("skips TS function-local functions, classes, and object-literal methods", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(
			join(scratch, "src", "nested.ts"),
			[
				"export function outer() {",
				"  function innerFn() {",
				"    return 1;",
				"  }",
				"  class LocalClass {",
				"    localMethod() {",
				"      return 2;",
				"    }",
				"  }",
				"  return new LocalClass();",
				"}",
				"",
				"const registry = {",
				"  handler() {",
				"    return 3;",
				"  },",
				"};",
				"",
				"export class Service {",
				"  start() {",
				"    return outer();",
				"  }",
				"}",
				"",
			].join("\n"),
			"utf8",
		);

		const codewiki = await buildCodewiki({ cwd: scratch, language: "typescript" });

		ok(hasSymbol(codewiki, "src/nested.ts", "outer", "func"));
		ok(hasSymbol(codewiki, "src/nested.ts", "registry", "const"));
		ok(hasSymbol(codewiki, "src/nested.ts", "Service", "class"));
		ok(hasSymbol(codewiki, "src/nested.ts", "start", "method"));
		strictEqual(hasSymbol(codewiki, "src/nested.ts", "innerFn"), false);
		strictEqual(hasSymbol(codewiki, "src/nested.ts", "LocalClass"), false);
		strictEqual(hasSymbol(codewiki, "src/nested.ts", "localMethod"), false);
		strictEqual(hasSymbol(codewiki, "src/nested.ts", "handler"), false);
	});

	it("skips Python function-local nested functions and classes", async () => {
		writeFileSync(
			join(scratch, "service.py"),
			[
				"class Service:",
				"    def handle(self):",
				"        def inner():",
				"            return 1",
				"",
				"        class LocalError(Exception):",
				"            pass",
				"",
				"        return inner()",
				"",
				"def build():",
				"    def helper():",
				"        return 2",
				"    return helper()",
				"",
			].join("\n"),
			"utf8",
		);

		const codewiki = await buildCodewiki({ cwd: scratch, language: "python" });

		ok(hasSymbol(codewiki, "service.py", "Service", "class"));
		ok(hasSymbol(codewiki, "service.py", "handle", "method"));
		ok(hasSymbol(codewiki, "service.py", "build", "func"));
		strictEqual(hasSymbol(codewiki, "service.py", "inner"), false);
		strictEqual(hasSymbol(codewiki, "service.py", "helper"), false);
		strictEqual(hasSymbol(codewiki, "service.py", "LocalError"), false);
	});

	it("labels Rust impl functions as methods and skips nested function items", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(
			join(scratch, "src", "lib.rs"),
			[
				"pub fn free_fn() {",
				"    fn nested_fn() {}",
				"}",
				"",
				"pub struct Widget;",
				"",
				"impl Widget {",
				"    pub fn method_a(&self) {}",
				"    fn method_b() {",
				"        fn deep() {}",
				"    }",
				"}",
				"",
			].join("\n"),
			"utf8",
		);

		const codewiki = await buildCodewiki({ cwd: scratch, language: "rust" });

		ok(hasSymbol(codewiki, "src/lib.rs", "free_fn", "func"));
		ok(hasSymbol(codewiki, "src/lib.rs", "Widget", "type"));
		ok(hasSymbol(codewiki, "src/lib.rs", "method_a", "method"));
		ok(hasSymbol(codewiki, "src/lib.rs", "method_b", "method"));
		strictEqual(hasSymbol(codewiki, "src/lib.rs", "nested_fn"), false);
		strictEqual(hasSymbol(codewiki, "src/lib.rs", "deep"), false);
	});

	it("records Java field declarators and classifies constants without the type name", async () => {
		writeFileSync(
			join(scratch, "Config.java"),
			[
				"class Config {",
				"    public String name;",
				"    private int count, total;",
				"    public static final int MAX_SIZE = 3;",
				'    static final String NAME = "clio";',
				"    void run() {",
				"        int local = 1;",
				"    }",
				"}",
				"",
			].join("\n"),
			"utf8",
		);

		const codewiki = await buildCodewiki({ cwd: scratch, language: "java" });

		ok(hasSymbol(codewiki, "Config.java", "name", "var"));
		ok(hasSymbol(codewiki, "Config.java", "count", "var"));
		ok(hasSymbol(codewiki, "Config.java", "total", "var"));
		ok(hasSymbol(codewiki, "Config.java", "MAX_SIZE", "const"));
		ok(hasSymbol(codewiki, "Config.java", "NAME", "const"));
		ok(hasSymbol(codewiki, "Config.java", "run", "method"));
		strictEqual(hasSymbol(codewiki, "Config.java", "String"), false);
		strictEqual(hasSymbol(codewiki, "Config.java", "int"), false);
		strictEqual(hasSymbol(codewiki, "Config.java", "local"), false);
	});

	it("excludes gitignored scratch directories from the index", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "real.ts"), "export const real = 1;\n", "utf8");
		for (const dir of [".superpowers", ".codex", ".claude"]) {
			mkdirSync(join(scratch, dir), { recursive: true });
			writeFileSync(join(scratch, dir, "scratch.ts"), "export const scratch = 1;\n", "utf8");
		}

		const codewiki = await buildCodewiki({ cwd: scratch, language: "typescript" });

		ok(codewiki.files.some((file) => file.path === "src/real.ts"));
		strictEqual(
			codewiki.files.some((file) =>
				[".superpowers/", ".codex/", ".claude/"].some((prefix) => file.path.startsWith(prefix)),
			),
			false,
		);
		strictEqual(hasSymbol(codewiki, ".superpowers/scratch.ts", "scratch"), false);
	});

	it("keeps incremental and full rebuilds equal while excluding scratch directories", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		mkdirSync(join(scratch, ".superpowers"), { recursive: true });
		writeFileSync(join(scratch, "src", "alpha.ts"), "export const alpha = 1;\n", "utf8");
		writeFileSync(join(scratch, ".superpowers", "plan.ts"), "export const plan = 1;\n", "utf8");

		let incremental = await buildCodewiki({ cwd: scratch, language: "typescript" });
		deepStrictEqual(incremental, await buildCodewiki({ cwd: scratch, language: "typescript" }));

		// A scratch-dir path never enters the index, even through the incremental path.
		writeFileSync(join(scratch, ".superpowers", "plan.ts"), "export const plan = 2;\n", "utf8");
		const afterScratch = await updateCodewikiPaths(scratch, incremental, [".superpowers/plan.ts"]);
		strictEqual(afterScratch, incremental);

		// A real edit stays byte-identical to a full rebuild with scratch present.
		writeFileSync(join(scratch, "src", "beta.ts"), "export const beta = 1;\n", "utf8");
		incremental = await updateCodewikiPaths(scratch, incremental, ["src/beta.ts"]);
		deepStrictEqual(incremental, await buildCodewiki({ cwd: scratch, language: "typescript" }));
	});
});
