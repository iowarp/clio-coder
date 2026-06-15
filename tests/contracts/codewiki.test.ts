import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildCodewiki,
	readCodewiki,
	renderCodewikiDigest,
	structuralCodewikiHash,
	updateCodewikiPaths,
	writeCodewiki,
} from "../../src/domains/context/index.js";
import { loadCodewikiForTool } from "../../src/tools/codewiki/shared.js";

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
