import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { listFleetContracts } from "../../src/domains/agents/fleet-contract.js";
import { type AgentRecipeDiagnostic, loadRecipesFromDir } from "../../src/domains/agents/registry.js";
import { pluginContentDigest } from "../../src/domains/plugins/index.js";
import { clearPluginSnapshots } from "../../src/domains/plugins/resources.js";
import { loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TREE_SITTER_MARKER = "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter.js";
const CODE_NAV_EXPORT_MARKER = "var codeNavTool = {";

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
		HOME: root,
		USERPROFILE: root,
		CLIO_CODER_HOME: root,
		CLIO_CODER_CONFIG_DIR: join(root, "config"),
		CLIO_CODER_DATA_DIR: join(root, "data"),
		CLIO_CODER_STATE_DIR: join(root, "state"),
		CLIO_CODER_CACHE_DIR: join(root, "cache"),
		CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
		CLIO_CODER_PACKAGE_ROOT: "",
	};
}

function withIsolatedState<T>(root: string, fn: () => T): T {
	const savedEnv = {
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		CLIO_CODER_HOME: process.env.CLIO_CODER_HOME,
		CLIO_CODER_CONFIG_DIR: process.env.CLIO_CODER_CONFIG_DIR,
		CLIO_CODER_DATA_DIR: process.env.CLIO_CODER_DATA_DIR,
		CLIO_CODER_STATE_DIR: process.env.CLIO_CODER_STATE_DIR,
		CLIO_CODER_CACHE_DIR: process.env.CLIO_CODER_CACHE_DIR,
		CLIO_CODER_REQUIRE_HOME_PREFIX: process.env.CLIO_CODER_REQUIRE_HOME_PREFIX,
		CLIO_CODER_PACKAGE_ROOT: process.env.CLIO_CODER_PACKAGE_ROOT,
	};
	process.env.HOME = root;
	process.env.USERPROFILE = root;
	process.env.CLIO_CODER_HOME = root;
	process.env.CLIO_CODER_CONFIG_DIR = join(root, "config");
	process.env.CLIO_CODER_DATA_DIR = join(root, "data");
	process.env.CLIO_CODER_STATE_DIR = join(root, "state");
	process.env.CLIO_CODER_CACHE_DIR = join(root, "cache");
	process.env.CLIO_CODER_REQUIRE_HOME_PREFIX = "1";
	process.env.CLIO_CODER_PACKAGE_ROOT = "";
	resetXdgCache();
	clearPluginSnapshots();
	try {
		return fn();
	} finally {
		for (const [key, val] of Object.entries(savedEnv)) {
			if (val === undefined) delete process.env[key];
			else process.env[key] = val;
		}
		resetXdgCache();
		clearPluginSnapshots();
	}
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

async function assertInstalledReasoningReplay(bin: string, cwd: string, home: string): Promise<void> {
	const modelId = "dynamo/qwen3.8-27b";
	const thought = "Private packaged fixture calculation: coefficient = 0.002.";
	const requests: Array<{
		messages: Array<{ role: string; content?: unknown; reasoning_content?: string }>;
		max_tokens: number;
	}> = [];
	const server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.method === "GET" && req.url === "/health/liveliness") {
			res.end(JSON.stringify({ status: "healthy" }));
			return;
		}
		if (req.method === "GET" && req.url === "/v1/models") {
			res.end(JSON.stringify({ data: [{ id: modelId }] }));
			return;
		}
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404);
			res.end();
			return;
		}
		const request = JSON.parse(await readRequestBody(req));
		requests.push(request);
		const retained = request.messages.some(
			(message: { reasoning_content?: string }) => message.reasoning_content === thought,
		);
		const delta =
			requests.length === 1 ? { reasoning_content: thought } : { content: retained ? "The coefficient is 0.002." : "" };
		res.setHeader("content-type", "text/event-stream");
		res.end(
			`data: ${JSON.stringify({ model: modelId, choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? "length" : "stop" }] })}\n\ndata: [DONE]\n\n`,
		);
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{
				id: "replay",
				runtime: "litellm",
				url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
				defaultModel: modelId,
				auth: { apiKeyEnvVar: "CLIO_CODER_REPLAY_FIXTURE_KEY" },
			},
		];
		settings.chat.target = "replay";
		settings.chat.model = modelId;
		settings.chat.maxOutputTokens = 16384;
		settings.fleet.profiles = { replay: { target: "replay", model: modelId, thinkingLevel: "xhigh" } };
		settings.context.memory.enabled = false;
		mkdirSync(join(home, "config/agents"), { recursive: true });
		writeFileSync(join(home, "config/settings.yaml"), JSON.stringify(settings));
		writeFileSync(
			join(home, "config/agents/replay-fixture.md"),
			`---
version: 1
name: Packaged replay fixture
description: Exercise a scripted local reasoning continuation.
tools: {required: [read], optional: []}
skills: []
audience: custom
category: research
capabilityClass: read-only
latencyClass: balanced
projectContextTier: bounded
budget: {toolCalls: 10, readReserve: 0, synthesis: true}
resultContract: {kind: artifact-report}
tags: [fixture]
---
Compute the requested coefficient and report the value in one line.
`,
		);
		const result = await run(
			bin,
			["run", "--agent", "replay-fixture", "--agent-profile", "replay", "--json", "Compute the coefficient."],
			cwd,
			{ ...isolatedEnv(home), CLIO_CODER_REPLAY_FIXTURE_KEY: "fixture" },
		);
		strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
		strictEqual(requests.length, 2, "installed native worker retains thought through one bounded repair");
		for (const request of requests) strictEqual(request.max_tokens, 16384);
		const replay = requests[1]?.messages.find((message) => message.reasoning_content === thought);
		ok(replay);
		strictEqual(JSON.stringify(replay.content).includes(thought), false);
		match(result.stdout, /The coefficient is 0.002/u);
	} finally {
		await closeServer(server);
	}
}

/** The class declaration Hono's bundled build emits; the app's HTTP framework, not the CLI's. */
const HONO_MARKER = "var Hono = class";

/**
 * The graphical application stays in apps/clio-coder-gui and this release does
 * not ship it. What the tarball has to show is the absence: no server, no
 * client, no application dependencies, no source tree, and a CLI that says so
 * plainly instead of failing on a missing module.
 */
async function assertGraphicalAppAbsent(packageRoot: string, bin: string, prefix: string, work: string): Promise<void> {
	const foreign = join(work, "gui foreign project");
	const home = join(work, "gui-home");
	mkdirSync(foreign, { recursive: true });
	const env: NodeJS.ProcessEnv = { ...isolatedEnv(home), NODE_ENV: "test", NODE_OPTIONS: "", NODE_PATH: "" };

	ok(!existsSync(join(packageRoot, "docs/html")), "retired HTML documentation must not ship");
	ok(!existsSync(join(packageRoot, "apps")), "the source app tree does not ship");
	ok(!existsSync(join(packageRoot, "dist", "gui")), "no graphical server, worker or client ships");
	ok(!existsSync(join(packageRoot, "dist", "assets", "gui-notices")), "no graphical dependency notices ship");
	strictEqual(
		emittedFilesContaining(packageRoot, HONO_MARKER).size,
		0,
		"the application's HTTP framework is not bundled into the packed dist",
	);

	// The checkout's tsx loader must be unreachable from inside the install: a
	// probe file under the prefix walks up through prefix/node_modules only.
	const probe = join(prefix, "resolve-probe.mjs");
	writeFileSync(
		probe,
		'try { import.meta.resolve("tsx"); process.exit(1); } catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }\n',
	);
	const resolved = execFileSync(process.execPath, [probe], { cwd: prefix, env, encoding: "utf8", timeout: 20_000 });
	strictEqual(resolved, "", "tsx must not resolve from the installed prefix");

	const gui = await run(bin, ["gui", "--no-open"], foreign, env);
	strictEqual(gui.code, 2, `gui without the application:\n${gui.stdout}\n${gui.stderr}`);
	strictEqual(gui.stdout, "", "gui prints nothing on stdout");
	match(gui.stderr, /The Clio Coder graphical application is not included in this build\./u);

	const docs = await run(bin, ["docs", "safety"], foreign, env);
	strictEqual(docs.code, 2, `docs without the application:\n${docs.stdout}\n${docs.stderr}`);
	strictEqual(docs.stdout, "", "docs prints nothing on stdout");
	match(docs.stderr, /not part of this release/u);
	ok(docs.stderr.includes(join(packageRoot, "docs")), `docs names the shipped Markdown directory: ${docs.stderr}`);
	ok(existsSync(join(packageRoot, "docs", "architecture", "safety-model.md")), "and that directory holds the guides");

	// Both commands stay registered, and each one's help is still a zero-exit read.
	for (const command of ["gui", "docs"]) {
		const commandHelp = await run(bin, [command, "--help"], foreign, env);
		strictEqual(commandHelp.code, 0, commandHelp.stderr);
		ok(commandHelp.stdout.length > 0, `${command} --help prints its usage`);
	}

	// Neither is listed in the top-level help this release ships.
	const help = await run(bin, ["--help"], foreign, env);
	strictEqual(help.code, 0, help.stderr);
	doesNotMatch(help.stdout, /^ *clio-coder gui\b/mu, "top-level help does not list the graphical application");
	doesNotMatch(help.stdout, /^ *clio-coder docs\b/mu, "top-level help does not list the docs command");
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
	// pnpm's store does not warm npm's cache. Allow a cold consumer install
	// with normal registry freshness checks after dependency upgrades;
	// the CLI subprocesses below retain their separate 20-second timeout.
	// The cold install, the packed-chunk probes and the library lifecycle below
	// are what the budget carries; none of them starts a server.
	it("loads bundled library packages, agent recipes, and lazy codewiki from an installed package", {
		timeout: 180_000,
	}, async () => {
		const work = mkdtempSync(join(tmpdir(), "clio-coder-installed-package-"));
		const prefix = join(work, "prefix");
		const foreign = join(work, "foreign-project");
		const home = join(work, "home");
		const coverage = join(work, "coverage");
		try {
			mkdirSync(prefix, { recursive: true });
			mkdirSync(foreign, { recursive: true });
			mkdirSync(coverage, { recursive: true });
			const packed = process.env.CLIO_CODER_RELEASE_TARBALL
				? [{ filename: process.env.CLIO_CODER_RELEASE_TARBALL }]
				: (JSON.parse(
						execFileSync("npm", ["pack", "--json", "--silent", "--pack-destination", work], {
							cwd: ROOT,
							encoding: "utf8",
							stdio: ["ignore", "pipe", "ignore"],
						}),
					) as Array<{ filename?: string }>);
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
					"--package-lock=false",
					"--no-audit",
					"--no-fund",
					"--loglevel=error",
					process.env.CLIO_CODER_RELEASE_TARBALL ?? join(work, filename),
				],
				{ cwd: prefix, stdio: "pipe", timeout: 90_000 },
			);

			const packageRoot = join(prefix, "node_modules", "@iowarp", "clio-coder");
			const bin = join(packageRoot, "dist", "cli", "index.js");
			ok(existsSync(join(prefix, "node_modules", ".bin", "clio-coder")), "npm must link the package bin");
			const version = await run(bin, ["--version"], foreign, isolatedEnv(home));
			strictEqual(version.code, 0, version.stderr);
			match(version.stdout, /^Clio Coder \d+\.\d+\.\d+$/mu);

			// Ordinary npm consumers receive unpatched pi-tui dependencies. The built
			// application must carry the compatibility implementation itself.
			const tuiChunks = emittedFilesContaining(packageRoot, "var TuiAltScreen = class");
			strictEqual(tuiChunks.size, 1, "one bundled patched TUI implementation");
			const tuiChunk = [...tuiChunks][0];
			ok(tuiChunk);
			const keyboardChild = `
			 import assert from "node:assert/strict";
			 import { createRequire } from "node:module";
			 import { pathToFileURL } from "node:url";
			 import { existsSync } from "node:fs";
			 import { dirname, join } from "node:path";
			 const bundled = await import(pathToFileURL(process.argv[1]).href);
			 const require = createRequire(pathToFileURL(process.argv[1]));
			 const ordinary = require.resolve("@earendil-works/pi-tui");
			 const stock = await import(pathToFileURL(ordinary).href);
			 assert.equal(stock.TuiAltScreen.prototype.setApplicationInputPolicy, undefined);
			 for (const platform of ["darwin", "linux", "win32"]) {
			  for (const arch of ["arm64", "x64"]) {
			   const filename = platform + "-platform" + (platform === "linux" ? "-x11" : "") + ".node";
			   assert.ok(existsSync(join(dirname(ordinary), "..", "native", platform, "prebuilds", platform + "-" + arch, filename)), filename + " " + arch);
			  }
			 }
			 const noop = () => {};
			 let ingress = noop;
			 const terminal = { columns: 80, rows: 24, kittyProtocolActive: false, start: fn => ingress = fn, stop: noop, write: noop, moveBy: noop, hideCursor: noop, showCursor: noop, clearLine: noop, clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop };
			 const tui = new bundled.TuiAltScreen(terminal);
			 const input = new bundled.Input();
			 const root = new bundled.VStack();
			 root.addChild(new bundled.ScrollView(new bundled.Text("alpha\\nalpha", 0, 0), { primary: true }), { grow: 1 }); root.addChild(input);
			 tui.addChild(root); tui.setFocus(input);
			 bundled.setKeybindings(new bundled.KeybindingsManager(bundled.TUI_KEYBINDINGS, { "tui.altScreen.search": "ctrl+r", "tui.input.submit": "ctrl+u" }));
			 let submitted = 0; let actions = 0; let permission = true;
			 input.onSubmit = () => submitted++;
			 tui.setApplicationInputPolicy(data => { actions++; if (permission && bundled.matchesKey(data, "ctrl+r")) return { consume: true }; if (bundled.matchesKey(data, "ctrl+u")) { input.applyEdit("deleteToLineStart"); return { consume: true }; } });
			 tui.start(); tui.renderNow();
			 try {
			  ingress(String.fromCharCode(18)); assert.equal(tui.isSearchFocused, false);
			  permission = false; ingress(String.fromCharCode(18)); assert.equal(tui.isSearchFocused, true);
			  tui.undoSearchQuery(); tui.closeSearch();
			  for (const char of "draft") ingress(char); ingress(String.fromCharCode(21)); assert.equal(input.getValue(), ""); assert.equal(submitted, 0);
			  const before = actions; ingress(String.fromCharCode(27) + "[108;3:3u"); assert.equal(actions, before);
			  assert.equal(typeof bundled.Editor.prototype.applyEdit, "function");
			  process.stdout.write("packed-keyboard-ok\\n");
			 } finally { tui.stop(); }
			`;
			const keyboardReceipt = execFileSync(process.execPath, ["--input-type=module", "-e", keyboardChild, tuiChunk], {
				cwd: foreign,
				env: isolatedEnv(home),
				encoding: "utf8",
				timeout: 20_000,
			});
			match(keyboardReceipt, /packed-keyboard-ok/u);
			for (const notice of ["pi-tui-LICENSE", "marked-LICENSE", "get-east-asian-width-LICENSE"]) {
				ok(existsSync(join(packageRoot, "dist", "assets", "tui-notices", notice)));
			}

			const codeNavChunks = emittedFilesContaining(packageRoot, CODE_NAV_EXPORT_MARKER);
			strictEqual(codeNavChunks.size, 1, "packed dist must contain one exported code_nav implementation chunk");
			const codeNavChunk = [...codeNavChunks][0];
			ok(codeNavChunk);
			const codeNavChild = `
				import { pathToFileURL } from "node:url";
				const loaded = await import(pathToFileURL(process.argv[1]).href);
				const symbol = await loaded.codeNavTool.run({ source: "clio", mode: "symbol", query: "codeNavTool" });
				const continuation = await loaded.codeNavTool.run({ source: "clio", mode: "path", query: "src/", limit: 1 });
				process.stdout.write(JSON.stringify({ symbol, continuation }));
			`;
			const rawCodeNavResult = execFileSync(
				process.execPath,
				["--input-type=module", "--eval", codeNavChild, codeNavChunk],
				{ cwd: foreign, env: isolatedEnv(home), encoding: "utf8" },
			);
			const codeNavResults = JSON.parse(rawCodeNavResult) as {
				symbol: { kind: string; output?: string; message?: string };
				continuation: { kind: string; output?: string; message?: string };
			};
			const codeNavResult = codeNavResults.symbol;
			strictEqual(codeNavResult.kind, "ok", codeNavResult.message);
			const codeNavPayload = JSON.parse(codeNavResult.output ?? "null") as {
				symbols?: Array<{ name?: string; path?: string }>;
			};
			const stableSymbol = codeNavPayload.symbols?.find((symbol) => symbol.name === "codeNavTool");
			strictEqual(
				stableSymbol?.path,
				join(packageRoot, "src", "tools", "codewiki", "code-nav.ts"),
				"source=clio paths must resolve against the installed package root",
			);
			strictEqual(codeNavResults.continuation.kind, "ok", codeNavResults.continuation.message);
			const continuationPayload = JSON.parse(codeNavResults.continuation.output ?? "null") as { next?: string };
			strictEqual(
				continuationPayload.next,
				"source=clio limit=2",
				"a bundled-map continuation must retain the closed source selector",
			);
			strictEqual(
				existsSync(join(foreign, ".clio-coder")),
				false,
				"source=clio must not resolve, build, or write a workspace code map",
			);

			const overriddenPackageRoot = join(work, "overridden-package-root");
			mkdirSync(join(overriddenPackageRoot, "dist", "assets"), { recursive: true });
			copyFileSync(
				join(packageRoot, "dist", "assets", "codewiki.json"),
				join(overriddenPackageRoot, "dist", "assets", "codewiki.json"),
			);
			const rawOverriddenResult = execFileSync(
				process.execPath,
				["--input-type=module", "--eval", codeNavChild, codeNavChunk],
				{
					cwd: foreign,
					env: { ...isolatedEnv(home), CLIO_CODER_PACKAGE_ROOT: overriddenPackageRoot },
					encoding: "utf8",
				},
			);
			const overriddenResults = JSON.parse(rawOverriddenResult) as {
				symbol: { kind: string; output?: string; message?: string };
			};
			strictEqual(overriddenResults.symbol.kind, "ok", overriddenResults.symbol.message);
			const overriddenPayload = JSON.parse(overriddenResults.symbol.output ?? "null") as {
				symbols?: Array<{ name?: string; path?: string }>;
			};
			const overriddenSymbol = overriddenPayload.symbols?.find((symbol) => symbol.name === "codeNavTool");
			strictEqual(
				overriddenSymbol?.path,
				join(overriddenPackageRoot, "src", "tools", "codewiki", "code-nav.ts"),
				"source=clio must load and resolve paths from the explicit package-root override",
			);

			const libraryHome = join(work, "isolated library home with spaces");
			const libraryProject = join(work, "isolated library project with spaces");
			mkdirSync(libraryHome, { recursive: true });
			mkdirSync(libraryProject, { recursive: true });
			const libraryEnv = isolatedEnv(libraryHome);
			const libraryJson = async (args: string[], cwd = libraryProject, env = libraryEnv): Promise<unknown> => {
				const result = await run(bin, [...args, "--json"], cwd, env);
				strictEqual(result.code, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
				return JSON.parse(result.stdout);
			};

			// 1. Pristine isolated home/project check BEFORE installing any library package:
			// The pristine agents CLI before install is the decisive packaged-runtime assertion.
			// It verifies the packaged binary in an isolated child environment, ensuring that
			// the packaged runtime discovers all 14 built-in agent recipes and resolves their
			// bound skills against the installed package library/skills root before any
			// library packages are installed.
			const pristineBuiltinSpecs = (await libraryJson(["agents", "--all"])) as Array<{ id: string; skills: string[] }>;
			const builtinSourceDir = join(packageRoot, "src", "domains", "agents", "builtins");
			const builtinSourceIds = readdirSync(builtinSourceDir)
				.filter((name) => name.endsWith(".md"))
				.map((name) => name.slice(0, -3))
				.sort();
			strictEqual(builtinSourceIds.length, 14, "expected 14 built-in agent recipes");
			deepStrictEqual(
				pristineBuiltinSpecs.map((spec) => spec.id).sort(),
				builtinSourceIds,
				"pristine environment must list all 14 built-in agent recipes",
			);
			const builtinSpecsWithSkills = pristineBuiltinSpecs.filter((spec) => spec.skills.length > 0);
			ok(builtinSpecsWithSkills.length > 0, "built-in recipes must declare bound skills");

			// Direct loader check in isolated environment:
			withIsolatedState(libraryHome, () => {
				const pristineDiagnostics: AgentRecipeDiagnostic[] = [];
				const pristineRecipes = loadRecipesFromDir(
					{
						source: "builtin",
						dir: builtinSourceDir,
						cwd: libraryProject,
					},
					pristineDiagnostics,
				);
				deepStrictEqual(pristineDiagnostics, [], "loading built-in recipes must emit no diagnostics");
				strictEqual(pristineRecipes.length, 14, "must load all 14 built-in agent recipes through actual loader");

				for (const recipe of pristineRecipes) {
					if (recipe.skills.length > 0) {
						strictEqual(
							recipe.boundSkillPaths.length,
							recipe.skills.length,
							`recipe ${recipe.id} must resolve all declared bound skills`,
						);
						for (const boundPath of recipe.boundSkillPaths) {
							ok(existsSync(boundPath), `bound skill path must exist: ${boundPath}`);
							ok(
								boundPath.startsWith(join(packageRoot, "library", "skills")),
								`bound skill path must resolve strictly within package library/skills: ${boundPath}`,
							);
						}
					} else {
						strictEqual(recipe.boundSkillPaths.length, 0);
					}
				}
			});

			// 2. Verify every packed pin; exercise installation for a skill and a bundle.
			interface CatalogEntry {
				kind: string;
				name: string;
				sourceUrl: string;
				sha256: string;
			}
			const authored = parseYaml(readFileSync(join(ROOT, "library", "registry.yaml"), "utf8")) as {
				entries: CatalogEntry[];
			};
			const discovered = (await libraryJson(["library", "search"])) as {
				entries: CatalogEntry[];
				diagnostics: string[];
			};
			deepStrictEqual(discovered.diagnostics, []);
			deepStrictEqual(
				discovered.entries.map((entry) => `${entry.kind}:${entry.name}`).sort(),
				authored.entries.map((entry) => `${entry.kind}:${entry.name}`).sort(),
				"the installed marketplace must expose every bundled package",
			);
			strictEqual(authored.entries.length, 35, "bundled catalog must contain 35 packages");

			const standaloneSkill = authored.entries.find((entry) => entry.kind === "skill");
			ok(standaloneSkill);
			for (const entry of authored.entries) {
				const packedSource = resolve(packageRoot, "library", entry.sourceUrl);
				strictEqual(discovered.entries.find((item) => item.name === entry.name)?.sourceUrl, packedSource);
				strictEqual(
					relative(packageRoot, packedSource).split(sep)[0],
					"library",
					`package source ${packedSource} must resolve strictly beneath installed package library/`,
				);
				strictEqual(pluginContentDigest(packedSource), entry.sha256, `packed integrity: ${entry.name}`);
				if (entry !== standaloneSkill && entry.name !== "materio") continue;
				const installed = (await libraryJson(["library", "install", `${entry.kind}:${entry.name}`, "--project"])) as {
					path: string;
					sha256: string;
				};
				strictEqual(installed.path, join(libraryProject, ".clio-coder", "plugins", entry.name));
				strictEqual(installed.sha256, entry.sha256, `packed bytes must match the full-tree pin for ${entry.name}`);
			}

			// 3. Load the installed skill and bundle alongside built-in recipes.
			const allAgents = (await libraryJson(["agents", "--all"])) as Array<{ id: string; skills: string[] }>;
			strictEqual(allAgents.length, 20, "must expose exactly 20 agent recipes total");

			withIsolatedState(libraryHome, () => {
				const loadedSkills = loadSkills({ cwd: libraryProject, home: libraryHome, configDir: join(libraryHome, "config") });
				deepStrictEqual(loadedSkills.diagnostics, []);
				strictEqual(loadedSkills.items.length, 7, "one standalone skill and six bundle skills load");

				const availableSkills = new Set(loadedSkills.items.map((skill) => skill.name));
				for (const agent of allAgents.filter((agent) => !builtinSourceIds.includes(agent.id))) {
					for (const skill of agent.skills) {
						ok(availableSkills.has(skill), `${agent.id} references unavailable skill ${skill}`);
					}
				}

				const loadedPrompts = loadPromptTemplates({ cwd: libraryProject, home: libraryHome });
				deepStrictEqual(loadedPrompts.diagnostics, []);
				const materioPrompts = loadedPrompts.items.filter((prompt) => prompt.name.startsWith("materio:"));
				strictEqual(materioPrompts.length, 17, "must load all 17 Materio prompts through prompt loader");
				for (const prompt of materioPrompts) {
					ok(!prompt.unavailable, `prompt ${prompt.name} must not be unavailable`);
					ok(prompt.content.length > 0, `prompt ${prompt.name} content must not be empty`);
					ok(!prompt.content.includes("${component:"), `unresolved component ref in ${prompt.name}`);
				}

				const fleetListings = listFleetContracts(libraryProject);
				const materioFleet = fleetListings.find(
					(fleet) => fleet.source === "plugin" && fleet.name === "materio-execute-task",
				);
				ok(materioFleet, "Materio fleet contract must be discovered through listFleetContracts");
				strictEqual(materioFleet.error, null, materioFleet.error ?? undefined);
				ok(materioFleet.contract, "fleet contract must be parsed");
				strictEqual(materioFleet.contract.steps.length, 2, "Materio fleet must define 2 steps");
			});

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
			// Operator examples and the plain-JS bootstrap coexist with the installed
			// recipe library in the same foreign project, outside the source checkout.
			const recipesBeforeExtension = (await libraryJson(["library", "recipes", "materio"])) as { resources: unknown[] };
			strictEqual(recipesBeforeExtension.resources.length, 30);
			const extensionInstall = await run(
				bin,
				["extensions", "install", join(packageRoot, "examples/extensions/lab-status"), "--project", "--json"],
				libraryProject,
				libraryEnv,
			);
			strictEqual(extensionInstall.code, 0, extensionInstall.stderr);
			const extensionRun = await run(
				bin,
				["extensions", "run", "lab-status", "dashboard", "--json"],
				libraryProject,
				libraryEnv,
			);
			strictEqual(extensionRun.code, 0, extensionRun.stderr);
			const extensionOutput = JSON.parse(extensionRun.stdout) as {
				output: { text: string; panel?: unknown };
				provenance: { contentDigest: string };
			};
			match(extensionOutput.output.text, /SYNTHETIC FIXTURE/);
			ok(extensionOutput.output.panel);
			match(extensionOutput.provenance.contentDigest, /^[a-f0-9]{64}$/);
			const disabledExtension = await run(
				bin,
				["extensions", "disable", "lab-status", "--project"],
				libraryProject,
				libraryEnv,
			);
			strictEqual(disabledExtension.code, 0, disabledExtension.stderr);
			const disabledRun = await run(bin, ["extensions", "run", "lab-status", "dashboard"], libraryProject, libraryEnv);
			strictEqual(disabledRun.code, 1, disabledRun.stderr);
			strictEqual(disabledRun.stdout, "");
			const measurementsInstall = await run(
				bin,
				["extensions", "install", join(packageRoot, "examples/extensions/measurements"), "--project", "--json"],
				libraryProject,
				libraryEnv,
			);
			strictEqual(measurementsInstall.code, 0, measurementsInstall.stderr);
			const workerChunks = emittedFilesContaining(packageRoot, "function createWorkerToolRegistry(");
			strictEqual(workerChunks.size, 1);
			const workerChunk = [...workerChunks][0];
			ok(workerChunk);
			const measurementProbe = join(work, "installed-measurements.mjs");
			writeFileSync(
				measurementProbe,
				`
				import assert from "node:assert/strict";
				import { pathToFileURL } from "node:url";
				const { createWorkerToolRegistry } = await import(pathToFileURL(process.argv[2]).href);
				const registry = createWorkerToolRegistry(undefined, undefined, undefined, undefined, "full-auto");
				const result = await registry.invoke({ tool: "extension_measurements__summarize", args: { values: [1,2,3], units: "seconds" } });
				assert.equal(result.kind, "ok", JSON.stringify(result));
				assert.equal(result.result.kind, "ok", JSON.stringify(result));
				const summary = JSON.parse(result.result.output);
				assert.equal(summary.mean, 2);
				assert.equal(summary.sampleStandardDeviation, 1);
				assert.equal(summary.units, "seconds");
			`,
			);
			const measurementRun = await run(measurementProbe, [workerChunk], libraryProject, libraryEnv);
			strictEqual(measurementRun.code, 0, measurementRun.stderr);
			const recipesAfterExtension = (await libraryJson(["library", "recipes", "materio"])) as { resources: unknown[] };
			// Observation timestamps vary; recipe identity, ownership and availability do not.
			deepStrictEqual(recipesAfterExtension.resources, recipesBeforeExtension.resources);
			const publicTypes = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).exports["./extensions"]
				.types;
			ok(existsSync(join(packageRoot, publicTypes)), "installed extension author types exist");
			await assertInstalledReasoningReplay(bin, libraryProject, join(work, "replay-home"));
			await assertGraphicalAppAbsent(packageRoot, bin, prefix, work);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});
