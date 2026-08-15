/**
 * The package as a user receives it. `npm pack` the checkout, install the
 * tarball into a scratch prefix the way `npm install -g` would, and run the
 * installed binary from there. Everything the runtime resolves from its own
 * package root (grammars, recipes, prompt fragments) must come from the pack,
 * because the scratch prefix has no checkout to fall back on.
 *
 * `--omit=optional` skips the claude-agent-sdk platform binary (224MB); this
 * smoke does not exercise it. `--prefer-offline` keeps a warm npm cache from
 * touching the network; a cold cache fetches the seven runtime deps once.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeScratchHome } from "../harness/scratch-env.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Packages tsup bundles into dist/; none may survive as a runtime import. */
const BUNDLED = ["chalk", "diff", "uuid", "yaml", "typebox", "undici"];

function runNode(
	args: ReadonlyArray<string>,
	options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

describe("smoke/pack-install", { concurrency: false }, () => {
	const scratch = makeScratchHome("clio-pack-install-");
	const work = mkdtempSync(join(tmpdir(), "clio-pack-"));
	const prefix = join(work, "prefix");
	const installedRoot = join(prefix, "node_modules", "@iowarp", "clio-coder");
	const bin = join(installedRoot, "dist", "cli", "index.js");

	before(() => {
		mkdirSync(prefix, { recursive: true });
		const packed = JSON.parse(
			execFileSync("npm", ["pack", "--json", "--silent", "--pack-destination", work], {
				cwd: REPO_ROOT,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}),
		) as Array<{ filename: string }>;
		const filename = packed[0]?.filename;
		ok(filename, "npm pack must report the tarball");
		const tarball = join(work, filename);
		execFileSync(
			"npm",
			[
				"install",
				"--prefix",
				prefix,
				"--omit=optional",
				"--prefer-offline",
				"--no-audit",
				"--no-fund",
				"--loglevel=error",
				tarball,
			],
			{ cwd: prefix, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
	});

	after(() => {
		scratch.cleanup();
		rmSync(work, { recursive: true, force: true });
	});

	it("declares no lifecycle scripts, a shebang bin, and an engines floor", () => {
		const pkg = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
			engines?: Record<string, string>;
			bin?: Record<string, string>;
		};
		for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
			strictEqual(pkg.scripts?.[hook], undefined, `package.json must not declare ${hook}`);
		}
		ok(pkg.engines?.node, "engines.node must be declared");
		strictEqual(pkg.bin?.["clio-coder"], "dist/cli/index.js");
		ok(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"), "installed bin must keep its shebang");
	});

	it("keeps the bundled packages out of the runtime import graph", () => {
		const distDir = join(installedRoot, "dist");
		const leaked: string[] = [];
		for (const entry of readdirSync(distDir, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
			const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
			for (const name of BUNDLED) {
				const pattern = new RegExp(`^(import|export)\\b[^\\n]*\\bfrom\\s+["']${name}(/|["'])`, "m");
				if (pattern.test(text)) leaked.push(`${entry.name} imports ${name}`);
			}
		}
		strictEqual(leaked.join("; "), "", "bundled packages must not survive as runtime imports");
	});

	it("runs --version from the installed prefix", async () => {
		const result = await runNode([bin, "--version"], { cwd: prefix, env: { ...process.env, ...scratch.env } });
		strictEqual(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
		match(result.stdout, /Clio Coder \d+\.\d+\.\d+/);
	});

	it("indexes a TypeScript fixture with grammars resolved from the pack", async () => {
		const fixture = join(work, "fixture");
		mkdirSync(fixture, { recursive: true });
		writeFileSync(
			join(fixture, "hello.ts"),
			"export function greet(name: string): string {\n\treturn name.toUpperCase();\n}\n",
		);
		const result = await runNode([bin, "context", "index", "--json"], {
			cwd: fixture,
			env: { ...process.env, ...scratch.env },
		});
		strictEqual(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
		const payload = JSON.parse(result.stdout) as { indexedSourceFiles: number; codewikiPath: string };
		strictEqual(payload.indexedSourceFiles, 1);
		ok(existsSync(payload.codewikiPath), "context index must write the fixture's codewiki");
		const codewiki = JSON.parse(readFileSync(payload.codewikiPath, "utf8")) as {
			symbols: Array<{ name: string; kind: string }>;
		};
		ok(
			codewiki.symbols.some((symbol) => symbol.name === "greet"),
			`the fixture's exported function must be indexed; saw ${JSON.stringify(codewiki.symbols)}`,
		);
	});
});
