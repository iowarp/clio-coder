import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import type { ToolRegistry, ToolResult } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * code_nav through a worker registry over a three-file TypeScript workspace
 * indexed on demand. Each mode is held to the exact files and relationships
 * the fixture declares, and the workspace must come out unwritten because the
 * tool builds its index read-only.
 */

const FILES: Record<string, string> = {
	"package.json": JSON.stringify({ name: "navfixture", type: "module", main: "src/index.ts" }),
	"src/index.ts":
		'import { parseGrid } from "./grid.js";\nexport function solve(input: string): number {\n\treturn parseGrid(input).length;\n}\n',
	"src/grid.ts":
		'import { readFileSync } from "node:fs";\nexport interface Grid {\n\tcells: number[];\n}\nexport function parseGrid(text: string): number[] {\n\treturn text.split(",").map(Number);\n}\nexport function loadGrid(path: string): number[] {\n\treturn parseGrid(readFileSync(path, "utf8"));\n}\n',
	"src/cli.ts": 'import { solve } from "./index.js";\nconsole.log(solve(process.argv[2] ?? ""));\n',
};

describe("code_nav tool", () => {
	let scratch: IsolatedClioEnv;
	let registry: ToolRegistry;
	let workspace: string;
	let previousCwd: string;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-code-nav-");
		workspace = join(scratch.dir, "workspace");
		for (const [path, text] of Object.entries(FILES)) {
			mkdirSync(join(workspace, path, ".."), { recursive: true });
			writeFileSync(join(workspace, path), text);
		}
		previousCwd = process.cwd();
		process.chdir(workspace);
		registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: workspace }));
	});
	afterEach(() => {
		process.chdir(previousCwd);
		scratch.restore();
	});

	async function call(args: Record<string, unknown>): Promise<ToolResult> {
		const verdict = await registry.invoke({ tool: ToolNames.CodeNav, args });
		if (verdict.kind !== "ok") throw new Error(`code_nav was not admitted: ${JSON.stringify(verdict)}`);
		return verdict.result;
	}

	async function payload(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const result = await call(args);
		if (result.kind !== "ok") throw new Error(`expected ok for ${JSON.stringify(args)}, got ${JSON.stringify(result)}`);
		return JSON.parse(result.output) as Record<string, unknown>;
	}

	const paths = (value: unknown): string[] => (value as Array<{ path: string }>).map((file) => file.path);

	it("answers every mode from the workspace index without writing to the workspace", async () => {
		const symbol = await payload({ mode: "symbol", query: "parseGrid" });
		deepStrictEqual(
			(symbol.symbols as Array<Record<string, unknown>>).map(({ name, kind, line, path }) => ({ name, kind, line, path })),
			[{ name: "parseGrid", kind: "func", line: 5, path: "src/grid.ts" }],
		);
		deepStrictEqual(paths((await payload({ mode: "path", query: "src/" })).files), [
			"src/cli.ts",
			"src/grid.ts",
			"src/index.ts",
		]);
		deepStrictEqual(paths((await payload({ mode: "entries" })).files), ["src/index.ts", "src/cli.ts"]);
		const outline = await payload({ mode: "outline", query: "src/grid.ts" });
		deepStrictEqual(
			(outline.symbols as Array<{ name: string; kind: string }>).map(({ name, kind }) => [name, kind]),
			[
				["Grid", "iface"],
				["parseGrid", "func"],
				["loadGrid", "func"],
			],
		);
		deepStrictEqual((await payload({ mode: "deps", query: "src/index.ts" })).deps, {
			internal: ["src/grid.ts"],
			external: [],
		});
		deepStrictEqual((await payload({ mode: "dependents", query: "src/grid.ts" })).dependents, ["src/index.ts"]);
		strictEqual(existsSync(join(workspace, ".clio-coder")), false, "the read-only index leaves no artifact behind");
	});

	it("bounds a result by limit and names the continuation, or the next mode to try on a miss", async () => {
		const bounded = await payload({ mode: "path", query: "src/", limit: 1 });
		deepStrictEqual(paths(bounded.files), ["src/cli.ts"]);
		strictEqual(bounded.omitted, 2);
		strictEqual(bounded.next, "limit=2");
		const miss = await payload({ mode: "symbol", query: "noSuchSymbol" });
		deepStrictEqual([miss.symbols, miss.next], [[], "mode=path query=noSuchSymbol"]);
		strictEqual((await payload({ mode: "path", query: "docs/" })).next, "mode=entries");
	});

	it("reports an absent wiki as operator-only instead of generating one", async () => {
		const wiki = await payload({ mode: "wiki" });
		deepStrictEqual(wiki.pages, []);
		match(String(wiki.message), /wiki generation is operator-only/);
		strictEqual(existsSync(join(workspace, ".clio-coder")), false);
	});

	it("names the malformed argument for every mode and refuses an arbitrary source root", async () => {
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ source: workspace, mode: "symbol", query: "solve" }, /source must be workspace or clio; got '/],
			[{ source: "clio", mode: "wiki" }, /source=clio does not provide mode=wiki/],
			[{ mode: "grep", query: "x" }, /mode must be symbol, path, entries, outline, deps, dependents, or wiki; got 'grep'/],
			[{ mode: "symbol" }, /mode=symbol requires query/],
			[{ mode: "path", query: "  " }, /mode=path requires query/],
			[{ mode: "outline" }, /mode=outline requires query path/],
			[{ mode: "deps" }, /mode=deps requires query path/],
			[{ mode: "dependents" }, /mode=dependents requires query path/],
			[{ mode: "outline", query: "src/missing.ts" }, /path 'src\/missing\.ts' is not an indexed file path/],
		];
		for (const [args, expected] of cases) {
			const result = await call(args);
			if (result.kind !== "error") throw new Error(`expected error for ${JSON.stringify(args)}`);
			match(result.message, /^code_nav: /);
			match(result.message, expected, JSON.stringify(args));
		}
	});
});
