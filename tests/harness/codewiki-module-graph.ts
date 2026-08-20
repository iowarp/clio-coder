import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emittedJavaScriptContaining, runCliWithCoverage } from "./runtime-module-graph.js";

const TREE_SITTER_PROVENANCE = "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter.js";
const CONTEXT_INDEX_HELP = "clio-coder context index [--json]";

/** Runtime graph and semantic proof shared by source-built and packed-package smokes. */
export async function assertCodewikiLazyLoading(input: {
	packageRoot: string;
	bin: string;
	workRoot: string;
	env: NodeJS.ProcessEnv;
}): Promise<void> {
	const heavy = emittedJavaScriptContaining(input.packageRoot, TREE_SITTER_PROVENANCE);
	ok(heavy.size > 0, "the build must contain a discoverable bundled tree-sitter runtime chunk");
	const indexCommands = emittedJavaScriptContaining(input.packageRoot, CONTEXT_INDEX_HELP);
	ok(indexCommands.size > 0, "the build must contain the nested context-index command");

	const helpCwd = join(input.workRoot, "lazy-help-cwd");
	mkdirSync(helpCwd, { recursive: true });
	const helpCoverageDir = mkdtempSync(join(tmpdir(), "clio-codewiki-help-coverage-"));
	try {
		const help = await runCliWithCoverage({
			bin: input.bin,
			args: ["context", "index", "--help"],
			cwd: helpCwd,
			env: input.env,
			coverageDir: helpCoverageDir,
		});
		strictEqual(help.code, 0, `stdout=${help.stdout} stderr=${help.stderr}`);
		ok(help.stdout.includes("Build the structural codewiki index"));
		ok(
			[...indexCommands].some((path) => help.files.has(path)),
			"nested index help must actually reach its built command",
		);
		strictEqual(
			[...heavy].some((path) => help.files.has(path)),
			false,
			"help must not evaluate tree-sitter",
		);
		strictEqual(existsSync(join(helpCwd, ".clio-coder")), false, "nested help must remain write-free");
	} finally {
		rmSync(helpCoverageDir, { recursive: true, force: true });
	}

	const fixture = join(input.workRoot, "lazy-build-cwd");
	mkdirSync(fixture, { recursive: true });
	writeFileSync(join(fixture, "generator.ts"), "export function* treeSitterOnly() {\n\tyield 1;\n}\n", "utf8");
	const coverageDir = mkdtempSync(join(tmpdir(), "clio-codewiki-build-coverage-"));
	try {
		const built = await runCliWithCoverage({
			bin: input.bin,
			args: ["context", "index", "--json"],
			cwd: fixture,
			env: input.env,
			coverageDir,
		});
		strictEqual(built.code, 0, `stdout=${built.stdout} stderr=${built.stderr}`);
		const payload = JSON.parse(built.stdout) as { indexedSourceFiles: number; codewikiPath: string };
		strictEqual(payload.indexedSourceFiles, 1);
		strictEqual(realpathSync(payload.codewikiPath), realpathSync(join(fixture, ".clio-coder", "codewiki.json")));
		ok(
			[...heavy].some((path) => built.files.has(path)),
			"a real build must evaluate the tree-sitter runtime",
		);
		const codewiki = JSON.parse(readFileSync(payload.codewikiPath, "utf8")) as {
			symbols: Array<{ name: string; kind: string }>;
		};
		ok(
			codewiki.symbols.some((symbol) => symbol.name === "treeSitterOnly" && symbol.kind === "func"),
			"a generator declaration must be extracted by tree-sitter, not the regex fallback",
		);
	} finally {
		rmSync(coverageDir, { recursive: true, force: true });
	}
}
