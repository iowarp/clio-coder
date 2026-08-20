import { ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TREE_SITTER_PROVENANCE = "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter.js";
const CONTEXT_INDEX_HELP = "clio-coder context index [--json]";

interface CoveredRun {
	code: number | null;
	stdout: string;
	stderr: string;
	files: Set<string>;
}

function emittedFilesContaining(root: string, needle: string): Set<string> {
	const matches = new Set<string>();
	for (const entry of readdirSync(join(root, "dist"), { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
		const path = join(entry.parentPath, entry.name);
		if (readFileSync(path, "utf8").includes(needle)) matches.add(realpathSync(path));
	}
	return matches;
}

function coveredFiles(directory: string): Set<string> {
	const files = new Set<string>();
	for (const name of readdirSync(directory)) {
		if (!name.endsWith(".json")) continue;
		const payload = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
			result?: Array<{ url?: string }>;
		};
		for (const script of payload.result ?? []) {
			if (!script.url?.startsWith("file:")) continue;
			try {
				files.add(realpathSync(fileURLToPath(script.url)));
			} catch {
				// Builtins, deleted temp files, and non-file coverage entries are irrelevant.
			}
		}
	}
	return files;
}

async function coveredRun(
	bin: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	coverageDir: string,
): Promise<CoveredRun> {
	mkdirSync(coverageDir, { recursive: true });
	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		...env,
		NODE_V8_COVERAGE: coverageDir,
		NODE_DISABLE_COMPILE_CACHE: "1",
	};
	delete childEnv.CLIO_CODER_PACKAGE_ROOT;
	const child = spawn(process.execPath, [bin, ...args], { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`covered CLI exceeded 30 seconds: ${args.join(" ")}`));
		}, 30_000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (status) => {
			clearTimeout(timeout);
			resolve(status);
		});
	});
	return { code, stdout, stderr, files: coveredFiles(coverageDir) };
}

/** Runtime graph and semantic proof shared by source-built and packed-package smokes. */
export async function assertCodewikiLazyLoading(input: {
	packageRoot: string;
	bin: string;
	workRoot: string;
	env: NodeJS.ProcessEnv;
}): Promise<void> {
	const heavy = emittedFilesContaining(input.packageRoot, TREE_SITTER_PROVENANCE);
	ok(heavy.size > 0, "the build must contain a discoverable bundled tree-sitter runtime chunk");
	const indexCommands = emittedFilesContaining(input.packageRoot, CONTEXT_INDEX_HELP);
	ok(indexCommands.size > 0, "the build must contain the nested context-index command");

	const helpCwd = join(input.workRoot, "lazy-help-cwd");
	mkdirSync(helpCwd, { recursive: true });
	const helpCoverageDir = mkdtempSync(join(tmpdir(), "clio-codewiki-help-coverage-"));
	try {
		const help = await coveredRun(input.bin, ["context", "index", "--help"], helpCwd, input.env, helpCoverageDir);
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
		const built = await coveredRun(input.bin, ["context", "index", "--json"], fixture, input.env, coverageDir);
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
