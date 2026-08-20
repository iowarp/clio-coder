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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assertCodewikiLazyLoading } from "../harness/codewiki-module-graph.js";
import {
	closeServer,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { emittedJavaScriptContaining, runCliWithCoverage } from "../harness/runtime-module-graph.js";
import { makeScratchHome } from "../harness/scratch-env.js";
import { assertLazyToolLoading } from "../harness/tool-module-graph.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Packages tsup bundles into dist/; none may survive as a runtime import. */
const BUNDLED = ["chalk", "diff", "uuid", "yaml", "typebox", "@vscode/tree-sitter-wasm", "tree-sitter-wasms"];

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

	it("keeps the bundled packages out of the runtime import graph and the install", () => {
		const distDir = join(installedRoot, "dist");
		const leaked: string[] = [];
		let embedsUndici = false;
		for (const entry of readdirSync(distDir, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
			const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
			if (text.includes("node_modules/undici/")) embedsUndici = true;
			for (const name of BUNDLED) {
				const pattern = new RegExp(`^(import|export)\\b[^\\n]*\\bfrom\\s+["']${name}(/|["'])`, "m");
				if (pattern.test(text)) leaked.push(`${entry.name} imports ${name}`);
			}
		}
		strictEqual(leaked.join("; "), "", "bundled packages must not survive as runtime imports");
		strictEqual(embedsUndici, false, "Node's built-in fetch must not carry userland Undici in the packed graph");
		const topLevel = new Set(readdirSync(join(prefix, "node_modules")));
		strictEqual(topLevel.has("undici"), false, "the installed package must not require userland Undici");
		for (const name of ["@vscode", "tree-sitter-wasms"]) {
			strictEqual(topLevel.has(name), false, `${name} must not be installed by the package`);
		}
		ok(existsSync(join(installedRoot, "dist", "assets", "grammars", "tree-sitter.wasm")), "vendored grammars must ship");
	});

	it("runs --version from the installed prefix", async () => {
		const result = await runNode([bin, "--version"], { cwd: prefix, env: { ...process.env, ...scratch.env } });
		strictEqual(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
		match(result.stdout, /Clio Coder \d+\.\d+\.\d+/);
	});

	it("keeps heavyweight tools lazy and invokes each shipped chunk from a foreign cwd", {
		timeout: 240_000,
	}, async () => {
		await assertLazyToolLoading({
			packageRoot: installedRoot,
			bin,
			workRoot: join(work, "installed-lazy-tool-graph"),
			env: scratch.env,
		});
	});

	it("returns the standard reinstall diagnostic when an installed lazy chunk is missing", async () => {
		const brokenRoot = join(prefix, "node_modules", "@iowarp", "clio-coder-broken");
		cpSync(installedRoot, brokenRoot, { recursive: true });
		const chunks = emittedJavaScriptContaining(brokenRoot, "web_fetch: binary or unsupported content type");
		ok(chunks.size > 0, "the copied install must contain a discoverable web_fetch implementation chunk");
		const missingNames = [...chunks].map((path) => path.slice(path.lastIndexOf("/") + 1));
		for (const path of chunks) rmSync(path, { force: true });

		const home = makeScratchHome("clio-pack-broken-lazy-");
		const coverageDir = mkdtempSync(join(tmpdir(), "clio-pack-broken-lazy-coverage-"));
		const cwd = join(work, "broken-lazy-foreign-cwd");
		mkdirSync(cwd, { recursive: true });
		const brokenBin = join(brokenRoot, "dist", "cli", "index.js");
		const initialized = await runCliWithCoverage({
			bin: brokenBin,
			args: ["doctor", "--fix"],
			cwd,
			env: home.env,
			coverageDir,
		});
		strictEqual(initialized.code, 0, `stdout=${initialized.stdout} stderr=${initialized.stderr}`);
		rmSync(coverageDir, { recursive: true, force: true });
		mkdirSync(coverageDir, { recursive: true });

		const model = await startOpenAICompatFixture("broken install diagnostic delivered", {
			toolCall: {
				name: "web_fetch",
				arguments: { url: "http://127.0.0.1:1/must-not-run", format: "raw" },
			},
		});
		seedOpenAICompatToolOrchestrator(join(home.dir, "config"), model.url, "full-auto");
		try {
			const result = await runCliWithCoverage({
				bin: brokenBin,
				args: ["--no-context-files", "--no-skills", "run", "--autonomy", "full-auto", "fetch"],
				cwd,
				env: {
					...home.env,
					CLIO_CODER_TEST_OPENAI_KEY: "broken-pack-key",
					CLIO_CODER_RESIDENCY: "observe",
				},
				coverageDir,
			});
			strictEqual(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
			const providerHistory = JSON.stringify(model.requests);
			match(providerHistory, /installation is incomplete/);
			match(providerHistory, /npm install -g @iowarp\/clio-coder/);
			match(providerHistory, /npm run install:local/);
			ok(
				missingNames.some((name) => providerHistory.includes(name)),
				"the diagnostic must name the missing chunk",
			);
			match(result.stdout, /broken install diagnostic delivered/);
		} finally {
			model.server.closeAllConnections();
			await closeServer(model.server);
			home.cleanup();
			rmSync(coverageDir, { recursive: true, force: true });
		}
	});

	it("keeps tree-sitter lazy and resolves grammars from the installed package", async () => {
		await assertCodewikiLazyLoading({
			packageRoot: installedRoot,
			bin,
			workRoot: join(work, "installed-codewiki-graph"),
			env: scratch.env,
		});
	});
});
