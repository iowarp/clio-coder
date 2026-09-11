import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
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
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { listFleetContracts } from "../../src/domains/agents/fleet-contract.js";
import { type AgentRecipeDiagnostic, loadRecipesFromDir } from "../../src/domains/agents/registry.js";
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

/** 43 URL-safe characters, the exact shape the background configuration schema pins. */
const WEB_TEST_TOKEN = "installed-web-smoke-token-0123456789abcdefg";
const HONO_MARKER = "var Hono = class";

/** A `clio-coder web` child: started from a foreign cwd, torn down with SIGTERM and a bounded SIGKILL fallback. */
interface WebServer {
	origin: string;
	child: ChildProcess;
	stdout: () => string;
	stderr: () => string;
	/** Returns the exit code and signal so the caller can assert a clean stop. */
	close: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function startInstalledWeb(
	bin: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	readyPattern: RegExp,
): Promise<WebServer> {
	const child = spawn(process.execPath, [bin, "web", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (text: string) => {
		stdout += text;
	});
	child.stderr?.on("data", (text: string) => {
		stderr += text;
	});
	let spawnError: Error | undefined;
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
		child.once("error", (error) => {
			spawnError = error;
			resolve({ code: null, signal: null });
		});
	});
	const close = async () => {
		if (!spawnError && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			const fallback = setTimeout(() => child.kill("SIGKILL"), 10_000);
			await exited;
			clearTimeout(fallback);
		}
		return exited;
	};
	try {
		const deadline = Date.now() + 10_000;
		let found: RegExpMatchArray | null = null;
		while (Date.now() < deadline) {
			found = stdout.match(readyPattern);
			if (found) break;
			if (spawnError) throw spawnError;
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error(`installed web server exited before it was ready:\n${stdout}\n${stderr}`);
			await delay(50);
		}
		ok(found, `installed web server did not print its launch line within 10s:\n${stdout}\n${stderr}`);
		const url = found[0].match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0];
		ok(url, `ready line carries a loopback URL: ${found[0]}`);
		return { origin: new URL(url).origin, child, stdout: () => stdout, stderr: () => stderr, close };
	} catch (error) {
		await close();
		throw error;
	}
}

function webRequest(origin: string, token: string | undefined, path: string, body?: unknown): Promise<Response> {
	return fetch(`${origin}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
			"Content-Type": "application/json",
			"Idempotency-Key": crypto.randomUUID(),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(15_000),
	});
}

/** Files the CLI evaluated for one invocation, from a fresh V8 coverage directory. */
function filesLoadedBy(
	bin: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	coverageDir: string,
): Set<string> {
	rmSync(coverageDir, { recursive: true, force: true });
	mkdirSync(coverageDir, { recursive: true });
	const result = execFileSync(process.execPath, [bin, ...args], {
		cwd,
		env: { ...env, NODE_V8_COVERAGE: coverageDir, NODE_DISABLE_COMPILE_CACHE: "1" },
		encoding: "utf8",
		timeout: 20_000,
	});
	ok(result.length > 0, `${args.join(" ")} printed nothing`);
	return coveredFiles(coverageDir);
}

/**
 * R1: the packaged `clio-coder web` runs from the installed prefix alone.
 *
 * Everything here goes through the installed CLI and plain HTTP; nothing imports
 * the app's source modules, so the assertions hold for what npm shipped rather
 * than for the checkout. A foreground server and one service-configuration
 * server are started in turn; neither opens a browser or touches systemd.
 */
async function assertInstalledWebApp(packageRoot: string, bin: string, prefix: string, work: string): Promise<void> {
	strictEqual(WEB_TEST_TOKEN.length, 43, "the background configuration schema pins a 43-character token");
	match(WEB_TEST_TOKEN, /^[\w-]+$/u);
	const webDist = join(packageRoot, "dist", "web");
	const foreign = join(work, "web foreign project");
	const home = join(work, "web-home");
	mkdirSync(foreign, { recursive: true });
	const env: NodeJS.ProcessEnv = { ...isolatedEnv(home), NODE_ENV: "test", NODE_OPTIONS: "", NODE_PATH: "" };

	// The checkout's tsx loader must be unreachable from inside the install: a
	// probe file under the prefix walks up through prefix/node_modules only.
	ok(!existsSync(join(packageRoot, "apps")), "the source app tree does not ship");
	const probe = join(prefix, "resolve-probe.mjs");
	writeFileSync(
		probe,
		'try { import.meta.resolve("tsx"); process.exit(1); } catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }\n',
	);
	const resolved = execFileSync(process.execPath, [probe], { cwd: prefix, env, encoding: "utf8", timeout: 20_000 });
	strictEqual(resolved, "", "tsx must not resolve from the installed prefix");

	// Importing the server entry is inert: no listener, no output.
	const entry = join(webDist, "server.js");
	const imported = execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const entry = await import(${JSON.stringify(pathToFileURL(entry).href)}); if (typeof entry.main !== "function") throw new Error("missing main");`,
		],
		{ cwd: foreign, env, encoding: "utf8", timeout: 20_000 },
	);
	strictEqual(imported, "", "importing dist/web/server.js must not start a server");

	const server = await startInstalledWeb(
		bin,
		["--no-open", "--port", "0", "--token", WEB_TEST_TOKEN],
		foreign,
		env,
		/http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+/u,
	);
	try {
		const { origin } = server;
		match(server.stdout(), new RegExp(`/#token=${WEB_TEST_TOKEN}$`, "mu"), "the printed link carries the supplied token");
		const request = (path: string, body?: unknown) => webRequest(origin, WEB_TEST_TOKEN, path, body);

		strictEqual((await webRequest(origin, undefined, "/api/meta")).status, 401, "API requires the launch token");
		const meta = (await (await request("/api/meta")).json()) as { clio: string; apiVersion: number; pwa: boolean };
		strictEqual(meta.clio, JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version);
		strictEqual(meta.apiVersion, 1);
		strictEqual(meta.pwa, false, "a foreground server is not installable");

		const runtimeResponse = await request("/api/_diagnostics/runtime");
		strictEqual(runtimeResponse.status, 200);
		const runtime = (await runtimeResponse.json()) as Record<
			"server" | "reads" | "ops",
			{ entry: string; packageRoot: string; execArgv: string[]; threadId?: number }
		>;
		for (const [kind, file] of [
			["server", "server.js"],
			["reads", "reads-worker.js"],
			["ops", "ops-worker.js"],
		] as const) {
			strictEqual(runtime[kind].entry, pathToFileURL(join(webDist, file)).href, `${kind} runs the emitted entry`);
			strictEqual(runtime[kind].packageRoot, packageRoot, `${kind} resolves the installed package root`);
			deepStrictEqual(
				runtime[kind].execArgv.filter((arg) => arg === "--import" || arg.includes("tsx")),
				[],
				`${kind} runs without a loader`,
			);
		}
		const threads = [runtime.reads.threadId, runtime.ops.threadId];
		ok(
			threads.every((id) => typeof id === "number" && id > 0),
			`worker thread ids: ${threads.join(",")}`,
		);
		ok(threads[0] !== threads[1], "reads and ops are distinct worker threads");

		const tools = await request("/api/toolchain/tools");
		strictEqual(tools.status, 200);
		strictEqual(((await tools.json()) as unknown[]).length, 3, "the reads worker lists the three pinned tools");

		const removal = await request("/api/toolchain/tools/herdr/remove", {});
		strictEqual(removal.status, 202);
		const { operationId } = (await removal.json()) as { operationId: string };
		let operation: { status: string } | undefined;
		for (let attempt = 0; attempt < 100; attempt++) {
			operation = (await (await request(`/api/operations/${operationId}`)).json()) as { status: string };
			if (!["queued", "running"].includes(operation.status)) break;
			await delay(50);
		}
		strictEqual(operation?.status, "succeeded", `ops worker removal on empty state: ${JSON.stringify(operation)}`);

		const abort = new AbortController();
		const events = await fetch(`${origin}/api/events`, {
			headers: { Authorization: `Bearer ${WEB_TEST_TOKEN}` },
			signal: abort.signal,
		});
		strictEqual(events.status, 200);
		match(events.headers.get("content-type") ?? "", /text\/event-stream/u);
		ok(events.body, "event stream has a body");
		const reader = events.body.getReader();
		const first = await Promise.race([reader.read(), delay(10_000).then(() => "timeout" as const)]);
		ok(first !== "timeout", "the stream sends a hello event promptly");
		match(new TextDecoder().decode(first.value), /^event: hello$/mu);
		abort.abort();
		await reader.cancel().catch(() => undefined);

		const opened = await request("/api/workspaces", { path: foreign });
		const openedText = await opened.text();
		strictEqual(opened.status, 200, openedText);
		const workspace = JSON.parse(openedText) as { id: string; path: string };
		match(workspace.id, /^[a-f0-9]{32}$/u);
		strictEqual(workspace.path, realpathSync(foreign));
		const targets = await request(`/api/workspaces/${workspace.id}/targets`);
		strictEqual(targets.status, 200, `targets through the installed CLI: ${await targets.text()}`);

		const index = await request("/");
		strictEqual(index.status, 200);
		match(index.headers.get("content-type") ?? "", /^text\/html/u);
		ok(!(await index.text()).includes('rel="manifest"'), "foreground index links no manifest");
		const logo = await request("/clio-coder-logo.webp");
		strictEqual(logo.status, 200);
		strictEqual(logo.headers.get("content-type"), "image/webp");
		strictEqual((await request("/manifest.webmanifest")).status, 404, "installable assets require background mode");
	} finally {
		const exit = await server.close();
		deepStrictEqual(exit, { code: 0, signal: null }, `foreground server stops cleanly on SIGTERM:\n${server.stderr()}`);
	}

	// Service-configuration mode: the same file a background install would write,
	// consumed by the installed CLI directly. No systemd, no browser.
	const serviceDir = join(work, "web-service");
	const serviceHome = join(work, "web-service-home");
	mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
	const roots = Object.fromEntries(
		(["config", "data", "state", "cache"] as const).map((role) => {
			const path = join(serviceHome, role);
			mkdirSync(path, { recursive: true });
			return [role, path];
		}),
	) as Record<"config" | "data" | "state" | "cache", string>;
	const reserve = createTcpServer();
	await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
	const port = (reserve.address() as AddressInfo).port;
	await new Promise<void>((resolve) => reserve.close(() => resolve()));
	const configFile = join(serviceDir, "server.json");
	writeFileSync(
		configFile,
		JSON.stringify({
			v: 1,
			port,
			token: WEB_TEST_TOKEN,
			roots,
			packageRoot,
			path: process.env.PATH ?? "",
			launch: { node: process.execPath, entry },
			desktopPrefix: serviceDir,
		}),
		{ mode: 0o600 },
	);
	const service = await startInstalledWeb(
		bin,
		["--persistent", configFile, "--no-open"],
		foreign,
		{ ...isolatedEnv(home), NODE_ENV: "test", NODE_OPTIONS: "", NODE_PATH: "" },
		/Background app ready at http:\/\/127\.0\.0\.1:\d+/u,
	);
	try {
		const { origin } = service;
		strictEqual(origin, `http://127.0.0.1:${port}`, "the service listens on the configured port");
		const request = (path: string) => webRequest(origin, WEB_TEST_TOKEN, path);
		const meta = (await (await request("/api/meta")).json()) as { pwa: boolean };
		strictEqual(meta.pwa, true, "service configuration enables the installable app");
		const index = await request("/");
		strictEqual(index.status, 200);
		ok((await index.text()).includes('<link rel="manifest" href="/manifest.webmanifest">'));
		const assets: Array<[string, RegExp]> = [
			["/manifest.webmanifest", /^application\/manifest\+json/u],
			["/sw.js", /^text\/javascript/u],
			["/offline.html", /^text\/html/u],
			["/offline.js", /^text\/javascript/u],
			["/offline.css", /^text\/css/u],
			["/icon-192.png", /^image\/png$/u],
			["/icon-512.png", /^image\/png$/u],
		];
		for (const [path, type] of assets) {
			const response = await request(path);
			strictEqual(response.status, 200, `${path} is served in service mode`);
			match(response.headers.get("content-type") ?? "", type, `${path} content type`);
			if (!path.endsWith(".png")) ok(!(await response.text()).includes(WEB_TEST_TOKEN), `${path} carries no token`);
		}
		const manifest = (await (await request("/manifest.webmanifest")).json()) as {
			start_url: string;
			icons: Array<{ src: string }>;
		};
		strictEqual(manifest.start_url, "/");
		deepStrictEqual(
			manifest.icons.map((icon) => icon.src),
			["/icon-192.png", "/icon-512.png"],
		);
	} finally {
		const exit = await service.close();
		deepStrictEqual(exit, { code: 0, signal: null }, `service server stops cleanly on SIGTERM:\n${service.stderr()}`);
	}

	// Ordinary CLI invocations never evaluate the web server or its bundled Hono.
	const honoChunks = emittedFilesContaining(packageRoot, HONO_MARKER);
	ok(honoChunks.size > 0, "the packed dist bundles Hono somewhere");
	const coverage = join(work, "web-coverage");
	for (const args of [["--version"], ["--help"], ["web", "--help"]]) {
		const loaded = filesLoadedBy(bin, args, foreign, isolatedEnv(home), coverage);
		const webLoaded = [...loaded].filter((file) => file.startsWith(`${webDist}${sep}`) || honoChunks.has(file));
		deepStrictEqual(webLoaded, [], `${args.join(" ")} must not load the web server: ${webLoaded.join(", ")}`);
	}
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
	// The web checks below start two installed servers in turn and run three
	// coverage-traced CLI invocations, which is why the budget grew from 120s.
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
					"--ignore-scripts",
					"--package-lock=false",
					"--no-audit",
					"--no-fund",
					"--loglevel=error",
					join(work, filename),
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
			 assert.ok(existsSync(join(dirname(ordinary), "..", "native", "darwin", "prebuilds", "darwin-arm64", "darwin-modifiers.node")));
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

			// 2. Install all 34 bundled packages:
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
			strictEqual(authored.entries.length, 34, "bundled catalog must contain 34 packages");

			for (const entry of authored.entries) {
				const packedSource = resolve(packageRoot, "library", entry.sourceUrl);
				strictEqual(discovered.entries.find((item) => item.name === entry.name)?.sourceUrl, packedSource);
				strictEqual(
					relative(packageRoot, packedSource).split(sep)[0],
					"library",
					`package source ${packedSource} must resolve strictly beneath installed package library/`,
				);
				const installed = (await libraryJson(["library", "install", `${entry.kind}:${entry.name}`, "--project"])) as {
					path: string;
					sha256: string;
				};
				strictEqual(installed.path, join(libraryProject, ".clio-coder", "plugins", entry.name));
				strictEqual(installed.sha256, entry.sha256, `packed bytes must match the full-tree pin for ${entry.name}`);
			}

			// 3. Verify 39 skill resources, 20 agent recipes total, Materio's 17 prompts and fleet through actual loaders:
			const allAgents = (await libraryJson(["agents", "--all"])) as Array<{ id: string; skills: string[] }>;
			strictEqual(allAgents.length, 20, "must expose exactly 20 agent recipes total");

			withIsolatedState(libraryHome, () => {
				const loadedSkills = loadSkills({ cwd: libraryProject, home: libraryHome, configDir: join(libraryHome, "config") });
				deepStrictEqual(loadedSkills.diagnostics, []);
				strictEqual(loadedSkills.items.length, 39, "actual skill loader must return 39 skill resources");

				const availableSkills = new Set(loadedSkills.items.map((skill) => skill.name));
				for (const agent of allAgents) {
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
			const recipesAfterExtension = (await libraryJson(["library", "recipes", "materio"])) as { resources: unknown[] };
			// Observation timestamps vary; recipe identity, ownership and availability do not.
			deepStrictEqual(recipesAfterExtension.resources, recipesBeforeExtension.resources);
			const publicTypes = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).exports["./extensions"]
				.types;
			ok(existsSync(join(packageRoot, publicTypes)), "installed extension author types exist");
			await assertInstalledReasoningReplay(bin, libraryProject, join(work, "replay-home"));
			await assertInstalledWebApp(packageRoot, bin, prefix, work);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});
