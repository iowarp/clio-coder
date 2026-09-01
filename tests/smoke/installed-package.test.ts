import { match, ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TREE_SITTER_MARKER = "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter.js";

interface Result {
	code: number | null;
	stdout: string;
	stderr: string;
}

function isolatedEnv(root: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		NODE_ENV: "test",
		NO_COLOR: "1",
		CLIO_CODER_HOME: root,
		CLIO_CODER_CONFIG_DIR: join(root, "config"),
		CLIO_CODER_DATA_DIR: join(root, "data"),
		CLIO_CODER_STATE_DIR: join(root, "state"),
		CLIO_CODER_CACHE_DIR: join(root, "cache"),
		CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
	};
}

async function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Result> {
	const child = spawn(process.execPath, [bin, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (text: string) => {
		stdout += text;
	});
	child.stderr.on("data", (text: string) => {
		stderr += text;
	});
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`installed CLI timeout: ${args.join(" ")}\n${stdout}\n${stderr}`));
		}, 20_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

function emittedFilesContaining(packageRoot: string, marker: string): Set<string> {
	const matches = new Set<string>();
	for (const entry of readdirSync(join(packageRoot, "dist"), { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
		const path = join(entry.parentPath, entry.name);
		if (readFileSync(path, "utf8").includes(marker)) matches.add(realpathSync(path));
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
				// Ignore builtins and transient files outside the installed package.
			}
		}
	}
	return files;
}

describe("smoke/installed package", { concurrency: false }, () => {
	it("packs once, installs once, and loads a lazy codewiki chunk from a foreign cwd", { timeout: 30_000 }, async () => {
		const work = mkdtempSync(join(tmpdir(), "clio-installed-package-"));
		const prefix = join(work, "prefix");
		const foreign = join(work, "foreign-project");
		const home = join(work, "home");
		const coverage = join(work, "coverage");
		try {
			mkdirSync(prefix, { recursive: true });
			mkdirSync(foreign, { recursive: true });
			mkdirSync(coverage, { recursive: true });
			const packed = JSON.parse(
				execFileSync("npm", ["pack", "--json", "--silent", "--pack-destination", work], {
					cwd: ROOT,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}),
			) as Array<{ filename?: string }>;
			strictEqual(packed.length, 1, "npm pack must produce one tarball");
			const filename = packed[0]?.filename;
			ok(filename);
			execFileSync(
				"npm",
				[
					"install",
					"--prefix",
					prefix,
					"--omit=optional",
					"--prefer-offline",
					"--ignore-scripts",
					"--package-lock=false",
					"--no-audit",
					"--no-fund",
					"--loglevel=error",
					join(work, filename),
				],
				{ cwd: prefix, stdio: "pipe" },
			);

			const packageRoot = join(prefix, "node_modules", "@iowarp", "clio-coder");
			const bin = join(packageRoot, "dist", "cli", "index.js");
			ok(existsSync(join(prefix, "node_modules", ".bin", "clio-coder")), "npm must link the package bin");
			const version = await run(bin, ["--version"], foreign, isolatedEnv(home));
			strictEqual(version.code, 0, version.stderr);
			match(version.stdout, /^Clio Coder \d+\.\d+\.\d+$/mu);

			const lazyChunks = emittedFilesContaining(packageRoot, TREE_SITTER_MARKER);
			ok(lazyChunks.size > 0, "packed dist must contain the tree-sitter implementation chunk");
			writeFileSync(join(foreign, "generator.ts"), "export function* installedLazySymbol() { yield 1; }\n");
			const indexed = await run(bin, ["context", "index", "--json"], foreign, {
				...isolatedEnv(home),
				NODE_V8_COVERAGE: coverage,
				NODE_DISABLE_COMPILE_CACHE: "1",
			});
			strictEqual(indexed.code, 0, indexed.stdout + indexed.stderr);
			const result = JSON.parse(indexed.stdout) as { indexedSourceFiles: number; codewikiPath: string };
			strictEqual(result.indexedSourceFiles, 1);
			ok(
				[...lazyChunks].some((path) => coveredFiles(coverage).has(path)),
				"real indexing must evaluate the lazy chunk",
			);
			const codewiki = JSON.parse(readFileSync(result.codewikiPath, "utf8")) as {
				symbols: Array<{ name: string }>;
			};
			ok(codewiki.symbols.some((symbol) => symbol.name === "installedLazySymbol"));
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});
