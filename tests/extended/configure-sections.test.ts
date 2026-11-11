import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, it } from "node:test";
import { parse } from "yaml";
import type { SendChatTest } from "../../src/cli/chat-test.js";
import { runConfigureCommand } from "../../src/cli/configure.js";
import type { ConfigureWizardHost } from "../../src/cli/configure-host.js";
import { runOnboardingWizard } from "../../src/cli/configure-onboarding.js";
import { SETTINGS_SECTIONS } from "../../src/core/settings-navigation.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { COPILOT_SDK_VERSION } from "../../src/domains/lifecycle/copilot-sdk-install.js";
import { listProviderSupportEntries } from "../../src/domains/providers/index.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";

function isolatedEnv(): {
	root: string;
	configDir: string;
	settingsFile: string;
	env: Record<string, string>;
	cleanup: () => void;
} {
	const rand = Math.random().toString(36).slice(2, 8);
	const root = join(tmpdir(), `clio-coder-test-configure-${rand}`);
	const configDir = join(root, ".config", "clio-coder");
	const dataDir = join(root, ".local", "share", "clio-coder");
	const stateDir = join(root, ".local", "state", "clio-coder");
	const cacheDir = join(root, ".cache", "clio-coder");

	mkdirSync(configDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(cacheDir, { recursive: true });

	const settingsFile = join(configDir, "settings.yaml");
	const initialSettings = `version: 2
targets:
  - id: test-target
    runtime: openai-compat
    defaultModel: mock-model
    url: http://127.0.0.1:8000/v1
chat:
  target: test-target
  model: mock-model
  thinkingLevel: low
  maxOutputTokens: 0
  prewarm: true
fleet:
  default:
    target: test-target
    model: mock-model
    thinkingLevel: off
  concurrency: auto
  retry:
    maxRetries: 2
  limits:
    toolCallsPerRun: 30
    internalRunTimeoutMs: 600000
safety:
  autonomy: default
  limits:
    sessionCostUsd: 5
    chatToolCallsPerTurn: 30
  review:
    enabled: false
interface:
  smoothStreaming: off
  terminalProgress: false
  mode: regular
  outputDetail: default
  desktopNotifications: false
  panes:
    enabled: off
    layout: off
integrations:
  projectResources:
    trustProjectImports: false
  git:
    commitAttribution: true
  externalAgents:
    entries: []
  runtimePlugins: []
  library:
    sync: false
`;
	writeFileSync(settingsFile, initialSettings, "utf8");

	const env: Record<string, string> = {
		HOME: root,
		CLIO_CODER_HOME: "",
		CLIO_CODER_CONFIG_DIR: configDir,
		CLIO_CODER_DATA_DIR: dataDir,
		CLIO_CODER_STATE_DIR: stateDir,
		CLIO_CODER_CACHE_DIR: cacheDir,
		PATH: "",
	};

	return {
		root,
		configDir,
		settingsFile,
		env,
		cleanup: () => {
			resetXdgCache();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/**
 * Drive `configure` over a pair of pipes.
 *
 * Neither stream is a terminal, so the menus take the numbered readline path
 * rather than the arrow-key one; that is the contract this file covers, and the
 * keypress path has its own file. Answers are fed one per prompt: readline
 * writes the prompt, so a write ending in ": " is the cue that the next line is
 * wanted.
 */
async function captureConfigure(
	argv: ReadonlyArray<string>,
	extraEnv: Record<string, string> = {},
	inputLines: ReadonlyArray<string> = ["b\n"],
): Promise<{ code: number; stdout: string; stderr: string }> {
	const saved = new Map(Object.keys(extraEnv).map((key) => [key, process.env[key]]));
	const origStderrWrite = process.stderr.write;

	let stdout = "";
	let stderr = "";

	for (const [key, value] of Object.entries(extraEnv)) {
		if (value === "") delete process.env[key];
		else process.env[key] = value;
	}
	resetXdgCache();

	process.stderr.write = ((chunk: unknown) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;

	const inStream = new PassThrough();
	let inputIdx = 0;
	const outStream = new PassThrough();
	outStream.on("data", (chunk: Buffer | string) => {
		const str = String(chunk);
		stdout += str;
		if (str.trimEnd().endsWith(":") && inputIdx < inputLines.length) {
			const next = inputLines[inputIdx++];
			setImmediate(() => {
				inStream.write(next);
			});
		}
	});

	try {
		const code = await runConfigureCommand(argv, inStream, outStream);
		return { code, stdout, stderr };
	} finally {
		process.stderr.write = origStderrWrite;
		// Restored key by key: assigning to process.env detaches Node's env proxy
		// and freezes os.homedir() for every later test in this process.
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetXdgCache();
	}
}

/**
 * A home with no targets, which is what makes `configure` open the first-run
 * wizard rather than the settings menu.
 *
 * PATH controls interop detection, but Copilot route discovery also loads the
 * package-local SDK, which resolves its binary independently. Shadow that SDK
 * with a no-login fixture so discovery cannot start an installed Copilot.
 */
function unconfiguredEnv(): { root: string; settingsFile: string; env: Record<string, string>; cleanup: () => void } {
	const rand = Math.random().toString(36).slice(2, 8);
	const root = join(tmpdir(), `clio-coder-test-onboarding-${rand}`);
	const configDir = join(root, ".config", "clio-coder");
	const dataDir = join(root, ".local", "share", "clio-coder");
	const sdkDir = join(
		dataDir,
		"components",
		"copilot-sdk",
		COPILOT_SDK_VERSION,
		"node_modules",
		"@github",
		"copilot-sdk",
	);
	mkdirSync(configDir, { recursive: true });
	mkdirSync(sdkDir, { recursive: true });
	writeFileSync(
		join(sdkDir, "package.json"),
		JSON.stringify({ name: "@github/copilot-sdk", type: "module", exports: "./index.js" }),
	);
	writeFileSync(
		join(sdkDir, "index.js"),
		`import { writeFileSync } from "node:fs";
export class CopilotClient {
	constructor() {
		writeFileSync(${JSON.stringify(join(root, "copilot-probe"))}, "no login");
		throw new Error("Copilot is unavailable in this configure fixture");
	}
}
`,
	);
	return {
		root,
		settingsFile: join(configDir, "settings.yaml"),
		env: {
			HOME: root,
			CLIO_CODER_HOME: "",
			CLIO_CODER_CONFIG_DIR: configDir,
			CLIO_CODER_DATA_DIR: dataDir,
			CLIO_CODER_STATE_DIR: join(root, ".local", "state", "clio-coder"),
			CLIO_CODER_CACHE_DIR: join(root, ".cache", "clio-coder"),
			TERM: "xterm-256color",
			PATH: "",
		},
		cleanup: () => {
			resetXdgCache();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** An OpenAI-compatible endpoint with two models, so the model step has a real list. */
async function modelServer(
	models: ReadonlyArray<string> = ["alpha-1", "beta-2"],
): Promise<{ url: string; close: () => Promise<void> }> {
	const server: Server = createServer((req, res) => {
		if (req.url?.endsWith("/v1/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id })) }));
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** An Ollama server as far as configure reads one: `/api/tags`, and 404 for the rest. */
async function ollamaServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const server: Server = createServer((req, res) => {
		if (req.url === "/api/tags") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/**
 * A LiteLLM gateway: alive on the unauthenticated liveness check, but its
 * catalog endpoints (`/v1/model/info`, then the `/v1/models` fallback) answer
 * 401 without the bearer token and a 3-model catalog with it. This is the
 * shape the onboarding bug reproduces against: a gateway that is up, but
 * whose model list depends on a credential the wizard did not have yet when
 * it probed.
 */
async function litellmServer(token: string): Promise<{ url: string; close: () => Promise<void> }> {
	const server: Server = createServer((req, res) => {
		if (req.url?.endsWith("/health/liveliness")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "healthy" }));
			return;
		}
		const authorized = req.headers.authorization === `Bearer ${token}`;
		if (req.url?.endsWith("/v1/model/info")) {
			if (!authorized) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					data: [
						{ model_name: "gateway-a", litellm_params: { model: "upstream-a" }, model_info: {} },
						{ model_name: "gateway-b", litellm_params: { model: "upstream-b" }, model_info: {} },
						{ model_name: "gateway-c", litellm_params: { model: "upstream-c" }, model_info: {} },
					],
				}),
			);
			return;
		}
		if (req.url?.endsWith("/v1/models")) {
			if (!authorized) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "gateway-a" }, { id: "gateway-b" }, { id: "gateway-c" }] }));
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const ENTER = "\r";
const ESCAPE = ESC;
const CLEAR_LINE = String.fromCharCode(21);
const CTRL_C = String.fromCharCode(3);

function fakeTty(
	columns = 100,
	rows = 40,
): {
	input: NodeJS.ReadStream;
	output: NodeJS.WriteStream;
	transcript: () => string;
} {
	const input = new PassThrough() as unknown as NodeJS.ReadStream;
	const output = new PassThrough() as unknown as NodeJS.WriteStream;
	Object.assign(input, { isTTY: true, setRawMode: () => input });
	Object.assign(output, { isTTY: true, columns, rows });
	let raw = "";
	output.on("data", (chunk: Buffer) => {
		raw += chunk.toString("utf8");
	});
	return { input, output, transcript: () => raw };
}

/** One screen of the wizard: what to wait for, and what to press once it is up. */
interface ScriptStep {
	/**
	 * Words this screen puts up. Omit where the screen repeats one already seen,
	 * because every keypress redraws the frame and a second showing of the same
	 * heading is indistinguishable from the first in a flat transcript.
	 */
	waitFor?: string;
	/** Milliseconds to let a screen redraw when there is no new text to wait for. */
	settleMs?: number;
	keys: ReadonlyArray<string>;
	/** The step is allowed not to appear, and the keys are then not sent. */
	optional?: boolean;
}

/**
 * Drive the wizard by watching for each screen before answering it.
 *
 * Fixed delays cannot work here: the URL step probes over the network and the
 * model step reads a list back, so the moment a prompt is ready is not a moment
 * a timer knows. Every step waits for the words the screen puts up.
 */
async function runWizard(
	env: Record<string, string>,
	script: ReadonlyArray<ScriptStep>,
	options?: Parameters<typeof runOnboardingWizard>[1],
): Promise<{ code: number; transcript: () => string; stderr: string }> {
	const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
	const origStderrWrite = process.stderr.write;
	let stderr = "";
	for (const [key, value] of Object.entries(env)) {
		if (value === "") delete process.env[key];
		else process.env[key] = value;
	}
	resetXdgCache();
	process.stderr.write = ((chunk: unknown) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;

	const tty = fakeTty();
	registerBuiltinRuntimes(getRuntimeRegistry());
	const pending = runOnboardingWizard({ in: tty.input, out: tty.output }, options);
	let settled = false;
	let cueOffset = 0;
	void pending.then(() => {
		settled = true;
	});

	try {
		for (const step of script) {
			if (step.waitFor !== undefined) {
				const cue = step.waitFor;
				const deadline = Date.now() + (step.optional ? 2_000 : 20_000);
				while (tty.transcript().indexOf(cue, cueOffset) < 0 && !settled && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				if (tty.transcript().indexOf(cue, cueOffset) < 0) {
					if (step.optional) continue;
					throw new Error(`wizard never showed ${JSON.stringify(cue)}:\n${plainText(tty.transcript())}`);
				}
			} else {
				await new Promise((resolve) => setTimeout(resolve, step.settleMs ?? 100));
			}
			for (const key of step.keys) {
				cueOffset = tty.transcript().length;
				tty.input.push(key);
				await new Promise((resolve) => setImmediate(resolve));
			}
		}
		return { code: await pending, transcript: tty.transcript, stderr };
	} finally {
		process.stderr.write = origStderrWrite;
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetXdgCache();
	}
}

/** The LiteLLM runtime, for the tests that start the wizard on it the way `configure --runtime litellm` does. */
function litellmRuntime(): RuntimeDescriptor {
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const runtime = registry.get("litellm");
	ok(runtime);
	return runtime;
}

/** Everything the terminal drew, with the cursor and color escapes taken out. */
function plainText(transcript: string): string {
	return transcript.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "gu"), "");
}

/**
 * Put one detectable coding agent on PATH.
 *
 * Interop detection resolves binaries by name, so a stub that answers
 * `--version` is a real detection as far as the review is concerned, and it is
 * the only way to reach the delegation step without depending on what the
 * developer happens to have installed.
 */
function fakeAgentOnPath(root: string, binary: string): string {
	const binDir = join(root, "fake-bin");
	mkdirSync(binDir, { recursive: true });
	const file = join(binDir, binary);
	writeFileSync(file, "#!/bin/sh\necho '1.2.3'\n", { encoding: "utf8", mode: 0o755 });
	return binDir;
}

/** A signed-in Codex CLI fixture: it answers the version and login probes only. */
function fakeCodexOnPath(root: string): string {
	const binDir = join(root, "fake-codex-bin");
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, "codex"), "#!/bin/sh\necho 'codex-cli 1.2.3'\n", { encoding: "utf8", mode: 0o755 });
	return binDir;
}

describe("contracts/configure-onboarding", () => {
	it("takes a fresh home through the model-server path and writes what it says it wrote", async () => {
		const testEnv = unconfiguredEnv();
		const server = await modelServer();
		try {
			const result = await runWizard(testEnv.env, [
				{ waitFor: "What do you have?", keys: [DOWN, DOWN, ENTER] },
				{ waitFor: "What is the server's address?", keys: [...server.url.split(""), ENTER] },
				{ waitFor: "Which model?", keys: [DOWN, ENTER] },
				{ waitFor: "Review what Clio could verify", keys: [ENTER] },
			]);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);
			strictEqual(readFileSync(join(testEnv.root, "copilot-probe"), "utf8"), "no login");

			const screen = plainText(result.transcript());
			for (const expected of [
				"Welcome to Clio Coder",
				"What do you have?",
				"↑↓ move",
				"reachable, 2 models",
				"target openai-compat saved",
				"chat runs on openai-compat",
				"fleet default is openai-compat",
				"settings written to",
				"clio-coder configure",
				"Done",
			]) {
				ok(screen.includes(expected), `${JSON.stringify(expected)} missing from:\n${screen}`);
			}
			// The whole point: not one readline prompt survives on this path.
			ok(!/Selection \[/u.test(screen), `a numbered prompt is still here:\n${screen}`);
			ok(!/\[y\/N\]|\[Y\/n\]/u.test(screen), `a yes/no prompt is still here:\n${screen}`);
			// A server that answers without a key is not asked about one, and the source taxonomy is gone.
			ok(!screen.includes("How should Clio get the API key?"), screen);
			ok(!screen.includes("Where does your model come from?"), screen);
			ok(!screen.includes("Which provider or app do you use?"), screen);

			ok(existsSync(testEnv.settingsFile), "the wizard must write settings.yaml");
			const settings = readFileSync(testEnv.settingsFile, "utf8");
			match(settings, /id: openai-compat/u);
			match(settings, /runtime: openai-compat/u);
			match(settings, /defaultModel: beta-2/u, "the model the arrow keys landed on is the one saved");
			match(settings, /target: openai-compat/u);
			const saved = parse(settings);
			strictEqual(saved.chat.thinkingLevel ?? "low", "low");
			strictEqual(saved.fleet.default.thinkingLevel ?? "off", "off");
			ok(!/reasoning: true/u.test(settings), "first-run defaults cannot establish reasoning capability");
			ok(!screen.includes("Target id"));
			ok(!screen.includes("How hard should it think?"));
			ok(!screen.includes("Context window in tokens"));
		} finally {
			await server.close();
			testEnv.cleanup();
		}
		strictEqual(existsSync(testEnv.root), false, "the discovery fixture's home must be removed");
	});

	it("takes the only model a server lists, and offers no coding agent along the way", async () => {
		const testEnv = unconfiguredEnv();
		const server = await modelServer(["alpha-1"]);
		// Installed coding agents used to add a delegate list and a research-colleague offer to the first run.
		const env = {
			...testEnv.env,
			PATH: `${fakeAgentOnPath(testEnv.root, "opencode")}:${fakeCodexOnPath(testEnv.root)}`,
		};
		try {
			const result = await runWizard(env, [
				{ waitFor: "What do you have?", keys: [DOWN, DOWN, ENTER] },
				{ waitFor: "What is the server's address?", keys: [...server.url.split(""), ENTER] },
				{ waitFor: "Review what Clio could verify", keys: [ENTER] },
			]);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);
			const screen = plainText(result.transcript());
			ok(!screen.includes("Which model?"), `a single listed model is taken without a screen:\n${screen}`);
			ok(screen.includes("alpha-1  (the only one listed)"), screen);
			for (const absent of ["Delegate to any of these?", "research colleague", "coding agent", "OpenCode", "Codex"])
				ok(!screen.includes(absent), `${absent} is on a first-run screen:\n${screen}`);
			const settings = readFileSync(testEnv.settingsFile, "utf8");
			match(settings, /defaultModel: alpha-1/u);
			ok(!/opencode|codex-cli|world-knowledge-external/u.test(settings), settings);
		} finally {
			await server.close();
			testEnv.cleanup();
		}
	});

	it("names the provider from a known key prefix and uses its recommended model", async () => {
		const testEnv = unconfiguredEnv();
		const key = "sk-ant-api03-clio-test-key";
		try {
			const result = await runWizard(testEnv.env, [
				{ waitFor: "What do you have?", keys: [ENTER] },
				{ waitFor: "Paste your API key", keys: [...key.split(""), ENTER] },
				// "Choose a different model" opens the list the flow skipped, recommended row first.
				{ waitFor: "Review what Clio could verify", keys: [DOWN, ENTER] },
				{ waitFor: "Which model?", keys: [ESCAPE] },
				{ waitFor: "Review what Clio could verify", keys: [ENTER] },
			]);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);
			const screen = plainText(result.transcript());
			ok(!screen.includes(key), "the pasted key is masked");
			ok(screen.includes("Anthropic  (from the key)"), screen);
			ok(screen.includes("claude-sonnet-5-5 (recommended)"), screen);
			for (const absent of ["Which provider or app do you use?", "How should Clio get the API key?"])
				ok(!screen.includes(absent), `${absent} was asked:\n${screen}`);
			const settings = readFileSync(testEnv.settingsFile, "utf8");
			match(settings, /runtime: anthropic/u);
			match(settings, /defaultModel: claude-sonnet-5-5/u);
			match(readFileSync(join(testEnv.settingsFile, "..", "credentials.yaml"), "utf8"), new RegExp(key, "u"));
		} finally {
			testEnv.cleanup();
		}
	});

	it("lists automatic local workers in the review only for a target on this machine", async () => {
		const hosted = unconfiguredEnv();
		try {
			const result = await runWizard(hosted.env, [
				{ waitFor: "What do you have?", keys: [ENTER] },
				{ waitFor: "Paste your API key", keys: [..."sk-ant-api03-clio-test-key".split(""), ENTER] },
				{ waitFor: "Review what Clio could verify", keys: [ENTER] },
			]);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);
			const screen = plainText(result.transcript());
			ok(screen.includes("Review what Clio could verify"), screen);
			ok(!screen.includes("Automatic local workers"), `a remote target must not list local workers:\n${screen}`);
		} finally {
			hosted.cleanup();
		}

		const local = unconfiguredEnv();
		const server = await modelServer();
		try {
			const result = await runWizard(local.env, [
				{ waitFor: "What do you have?", keys: [DOWN, DOWN, ENTER] },
				{ waitFor: "What is the server's address?", keys: [...server.url.split(""), ENTER] },
				{ waitFor: "Which model?", keys: [ENTER] },
				{ waitFor: "Review what Clio could verify", keys: [ENTER] },
			]);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);
			const screen = plainText(result.transcript());
			ok(screen.includes("Automatic local workers:"), `a loopback server lists local workers:\n${screen}`);
		} finally {
			await server.close();
			local.cleanup();
		}
	});

	it("ends on the test request: a refused key saves nothing, a good key or Save anyway saves", async () => {
		const checks = (root: string) =>
			(readdirSync(root, { recursive: true }) as string[]).filter((file) => file.includes("provider-target-checks/"));
		const fixed = unconfiguredEnv();
		const sent: string[] = [];
		const refuseBad: SendChatTest = async ({ apiKey }) => {
			sent.push(apiKey ?? "");
			return apiKey === "sk-ant-good-key"
				? { ok: true, latencyMs: 1200 }
				: { ok: false, message: "401 invalid x-api-key", httpStatus: 401 };
		};
		try {
			const result = await runWizard(
				fixed.env,
				[
					{ waitFor: "What do you have?", keys: [ENTER] },
					{ waitFor: "Paste your API key", keys: [..."sk-ant-bad-key".split(""), ENTER] },
					{ waitFor: "The test request failed", keys: [DOWN, ENTER] },
					{ waitFor: "Paste your API key", keys: [..."sk-ant-good-key".split(""), ENTER] },
				],
				{ mode: "first", verify: refuseBad },
			);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);
			const screen = plainText(result.transcript());
			ok(screen.includes("one short test message"), screen);
			ok(screen.includes("Anthropic refused the key (401)"), screen);
			match(screen, /answered in 1\.2 s\./u);
			ok(screen.includes("Saved. Chat and workers use this model."), screen);
			ok(!screen.includes("Review what Clio could verify"), `the first run ends on the test, not a review:\n${screen}`);
			deepStrictEqual(sent, ["sk-ant-bad-key", "sk-ant-good-key"]);
			const credentials = readFileSync(join(fixed.settingsFile, "..", "credentials.yaml"), "utf8");
			ok(credentials.includes("sk-ant-good-key") && !credentials.includes("sk-ant-bad-key"), credentials);
			strictEqual(checks(fixed.root).length, 1, "the answered request marks the target checked");
		} finally {
			fixed.cleanup();
		}

		const anyway = unconfiguredEnv();
		try {
			const result = await runWizard(
				anyway.env,
				[
					{ waitFor: "What do you have?", keys: [ENTER] },
					{ waitFor: "Paste your API key", keys: [..."sk-ant-bad-key".split(""), ENTER] },
					{ waitFor: "The test request failed", keys: [DOWN, DOWN, ENTER] },
				],
				{ mode: "first", verify: refuseBad },
			);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);
			match(readFileSync(anyway.settingsFile, "utf8"), /runtime: anthropic/u);
			ok(plainText(result.transcript()).includes("saved without a passed test request"));
			strictEqual(checks(anyway.root).length, 0, "Save anyway leaves the target unchecked");
		} finally {
			anyway.cleanup();
		}

		const refused = unconfiguredEnv();
		try {
			const result = await runWizard(
				refused.env,
				[
					{ waitFor: "What do you have?", keys: [ENTER] },
					{ waitFor: "Paste your API key", keys: [..."sk-ant-bad-key".split(""), ENTER] },
					{ waitFor: "The test request failed", keys: [CTRL_C] },
				],
				{ mode: "first", verify: refuseBad },
			);
			strictEqual(result.code, 130);
			ok(
				!existsSync(refused.settingsFile) || !/runtime: anthropic/u.test(readFileSync(refused.settingsFile, "utf8")),
				"a refused key saves nothing",
			);
		} finally {
			refused.cleanup();
		}

		const reviewed = unconfiguredEnv();
		const before = sent.length;
		try {
			const result = await runWizard(
				reviewed.env,
				[
					{ waitFor: "What do you have?", keys: [ENTER] },
					{ waitFor: "Paste your API key", keys: [..."sk-ant-bad-key".split(""), ENTER] },
					// The old review sits behind "Connection and machine details"; its Save tests again.
					{ waitFor: "The test request failed", keys: [DOWN, DOWN, DOWN, ENTER] },
					{ waitFor: "Review what Clio could verify", keys: [ENTER] },
					{ waitFor: "The test request failed", keys: [DOWN, DOWN, ENTER] },
				],
				{ mode: "first", verify: refuseBad },
			);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);
			strictEqual(sent.length - before, 2, "Save on the review sends the test again");
			match(readFileSync(reviewed.settingsFile, "utf8"), /runtime: anthropic/u);
		} finally {
			reviewed.cleanup();
		}
	});

	it("shows the providers that take a key when the prefix names none", async () => {
		const testEnv = unconfiguredEnv();
		try {
			const result = await runWizard(testEnv.env, [
				{ waitFor: "What do you have?", keys: [ENTER] },
				{ waitFor: "Paste your API key", keys: [..."sk-shared-prefix-key".split(""), ENTER] },
				{ waitFor: "Which provider or app do you use?", keys: [CTRL_C] },
			]);
			strictEqual(result.code, 130);
			const screen = plainText(result.transcript());
			const list = screen.slice(screen.lastIndexOf("Which provider or app do you use?"));
			ok(list.includes("Anthropic"), list);
			for (const absent of ["LM Studio", "ChatGPT", "Copilot"])
				ok(!list.includes(absent), `${absent} takes no key:\n${list}`);
		} finally {
			testEnv.cleanup();
		}
	});

	it("proposes the key found in the environment, preselected, so setup is one decision", async () => {
		const testEnv = unconfiguredEnv();
		try {
			const result = await runWizard({ ...testEnv.env, ANTHROPIC_API_KEY: "sk-ant-env-key" }, [
				{ waitFor: "Clio found a way to reach a model:", keys: [ENTER] },
				{ waitFor: "Review what Clio could verify", keys: [ENTER] },
			]);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);
			const screen = plainText(result.transcript());
			match(screen, /❯ Anthropic, with the key in ANTHROPIC_API_KEY\s+model claude-sonnet-5-5 \(recommended\)/u);
			ok(screen.includes("Set up something else"), screen);
			const settings = readFileSync(testEnv.settingsFile, "utf8");
			match(settings, /apiKeyEnvVar: ANTHROPIC_API_KEY/u);
			match(settings, /defaultModel: claude-sonnet-5-5/u);
		} finally {
			testEnv.cleanup();
		}
	});

	it("offers to store an environment key for the desktop app only when the app is installed", async () => {
		const answered: SendChatTest = async () => ({ ok: true, latencyMs: 800 });
		const QUESTION = "Store it for the app too?";
		const run = async (withApp: boolean, keys: string[]) => {
			const testEnv = unconfiguredEnv();
			if (withApp) {
				const background = join(testEnv.env.CLIO_CODER_STATE_DIR ?? "", "gui", "background");
				mkdirSync(background, { recursive: true });
				writeFileSync(join(background, "server.json"), JSON.stringify({ packageRoot: join(testEnv.root, "pkg") }));
			}
			try {
				const result = await runWizard(
					{ ...testEnv.env, ANTHROPIC_API_KEY: "sk-ant-env-key" },
					[
						{ waitFor: "Clio found a way to reach a model:", keys: [ENTER] },
						...(keys.length > 0 ? [{ waitFor: QUESTION, keys }] : []),
					],
					{ mode: "first", verify: answered },
				);
				strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);
				const credentials = join(testEnv.settingsFile, "..", "credentials.yaml");
				return {
					screen: plainText(result.transcript()),
					settings: readFileSync(testEnv.settingsFile, "utf8"),
					credentials: existsSync(credentials) ? readFileSync(credentials, "utf8") : "",
				};
			} finally {
				testEnv.cleanup();
			}
		};

		const stored = await run(true, [DOWN, ENTER]);
		ok(stored.screen.includes("The desktop app cannot see this shell's key."), stored.screen);
		ok(stored.credentials.includes("sk-ant-env-key"), `the key is stored for the app:\n${stored.credentials}`);
		// The runtime's slot is shared by its other targets and by `auth login`; the copy is the variable's own.
		deepStrictEqual(Object.keys(parse(stored.credentials).entries), ["env:ANTHROPIC_API_KEY"]);
		match(stored.settings, /apiKeyEnvVar: ANTHROPIC_API_KEY/u, "the target still reads the variable first");

		const declined = await run(true, [ENTER]);
		ok(!declined.credentials.includes("sk-ant-env-key"), "No stores nothing");
		match(declined.settings, /apiKeyEnvVar: ANTHROPIC_API_KEY/u);

		const noApp = await run(false, []);
		ok(!noApp.screen.includes(QUESTION), `no desktop app, no question:\n${noApp.screen}`);
		ok(!noApp.credentials.includes("sk-ant-env-key"));
	});

	it("goes back from the third step without losing the first two", async () => {
		const testEnv = unconfiguredEnv();
		const server = await modelServer();
		try {
			const result = await runWizard(testEnv.env, [
				{ waitFor: "What do you have?", keys: [DOWN, DOWN, ENTER] },
				{ waitFor: "What is the server's address?", keys: [...server.url.split(""), ENTER] },
				{ waitFor: "Which model?", keys: [ESCAPE] },
				// The address screen is back, drawing the same words it drew before, so
				// these two wait on the redraw rather than on text. The wait is longer
				// than readline's 500ms escape-sequence timeout: a lone Escape is only
				// delivered once that has passed, and two sent inside one window arrive
				// together and are read as a meta prefix instead of two keys.
				{ settleMs: 800, keys: [ESCAPE] },
				{ settleMs: 800, keys: [ESCAPE] },
			]);
			strictEqual(result.code, 130, "backing out of the first step leaves Clio unconfigured");

			const screen = plainText(result.transcript());
			const modelAt = screen.lastIndexOf("Which model?");
			const reopened = screen.indexOf("What is the server's address?", modelAt);
			ok(reopened > 0, `escape on step 3 did not reopen step 2:\n${screen}`);
			ok(screen.slice(reopened).includes(server.url), `step 2 reopened without its answer:\n${screen.slice(reopened)}`);
			ok(screen.slice(0, reopened).includes("A model server or gateway"), `step 1's answer was lost:\n${screen}`);
			ok(/❯ A model server or gateway/u.test(screen.slice(reopened)), `step 1 reopened off its answer:\n${screen}`);
			ok(screen.includes("Cancelled; nothing was saved"), `no closing line:\n${screen}`);
			strictEqual(existsSync(testEnv.settingsFile), false, "a cancelled wizard creates no settings file");
		} finally {
			await server.close();
			testEnv.cleanup();
		}
	});

	it("imports a lab setup file from the first-run row after showing where prompts go", async () => {
		const testEnv = unconfiguredEnv();
		try {
			const file = join(testEnv.root, "lab.yaml");
			writeFileSync(
				file,
				"targets:\n  - id: lab\n    runtime: litellm\n    url: https://llm.lab.example.edu\n    defaultModel: qwen3-coder\n    auth:\n      apiKeyEnvVar: LAB_API_KEY\nchat:\n  target: lab\n",
			);
			const result = await runWizard({ ...testEnv.env, LAB_API_KEY: "" }, [
				{ waitFor: "What do you have?", keys: [DOWN, DOWN, DOWN, ENTER] },
				{ waitFor: "Where is the setup file?", keys: [file, ENTER] },
				{ waitFor: "prompts go to https://llm.lab.example.edu", keys: [ENTER] },
			]);
			const screen = plainText(result.transcript());
			strictEqual(result.code, 0, screen);
			ok(screen.includes("LAB_API_KEY"), `the missing key is not named:\n${screen}`);
			const saved = parse(readFileSync(testEnv.settingsFile, "utf8"));
			strictEqual(saved.chat.target, "lab");
			strictEqual(saved.targets[0].url, "https://llm.lab.example.edu");
		} finally {
			testEnv.cleanup();
		}
	});

	it("exits 130 when the very first step is cancelled, because nothing is configured", async () => {
		const testEnv = unconfiguredEnv();
		try {
			const result = await runWizard(testEnv.env, [{ waitFor: "What do you have?", keys: [ESCAPE] }]);
			strictEqual(result.code, 130);
			// A user cancel is said once, on the rail, and is not an error.
			strictEqual(result.stderr, "");
			ok(plainText(result.transcript()).includes("Cancelled; nothing was saved"));
			strictEqual(existsSync(testEnv.settingsFile), false);
		} finally {
			testEnv.cleanup();
		}
	});

	// #388: a localhost default looked usable for an ALCF target, let setup finish, and left it down.
	it("asks an ALCF target for its gateway URL by name, and keeps every local default", async () => {
		if (getRuntimeRegistry().list().length === 0) registerBuiltinRuntimes(getRuntimeRegistry());
		const testEnv = unconfiguredEnv();
		try {
			const alcf = getRuntimeRegistry().get("alcf");
			ok(alcf);
			const result = await runWizard(testEnv.env, [{ waitFor: "Sign in to", keys: [DOWN, ENTER] }], {
				mode: "first",
				runtime: alcf,
			});
			// S-78: "Later" ends setup with nothing saved and names the sign-in command.
			const screen = plainText(result.transcript());
			strictEqual(result.code, 130, screen);
			ok(screen.includes("clio-coder auth login alcf, then clio-coder"), screen);
			ok(!screen.includes("127.0.0.1"), `the ALCF prompt must offer no localhost default:\n${screen}`);
			strictEqual(existsSync(testEnv.settingsFile), false);

			// The numbered prompts a pipe falls back to ask the same way. Their guidance
			// goes to process.stdout and the prompts to the prompt stream, so read both.
			let printed = "";
			const origStdoutWrite = process.stdout.write;
			process.stdout.write = ((chunk: unknown) => {
				printed += String(chunk);
				return true;
			}) as typeof process.stdout.write;
			let numbered: Awaited<ReturnType<typeof captureConfigure>>;
			try {
				numbered = await captureConfigure([], testEnv.env, ["cloud-api\n", "alcf\n", "\n", "\n", "q\n"]);
			} finally {
				process.stdout.write = origStdoutWrite;
			}
			strictEqual(numbered.code, 130, `${numbered.stderr}\n${numbered.stdout}`);
			ok(numbered.stdout.includes("ALCF gateway URL: ALCF gateway URL:"), numbered.stdout);
			ok(printed.includes("ALCF gateway URL:\n  Required. For example https://"), printed);
			ok(printed.includes("the ALCF gateway URL is required."), printed);
			ok(!`${printed}${numbered.stdout}`.includes("127.0.0.1"), "the numbered prompt must offer no localhost default");

			const refused = await captureConfigure(["--id", "alcf", "--runtime", "alcf"], testEnv.env);
			strictEqual(refused.code, 2);
			match(refused.stderr, /--url is required for alcf: give the ALCF gateway URL/u);
			match(refused.stderr, /sophia\/vllm\/v1/u);
			const saved = existsSync(testEnv.settingsFile) ? readFileSync(testEnv.settingsFile, "utf8") : "";
			ok(!saved.includes("runtime: alcf"), `no ALCF target is saved without its gateway URL:\n${saved}`);
		} finally {
			testEnv.cleanup();
		}

		const localEnv = unconfiguredEnv();
		try {
			const llamacpp = getRuntimeRegistry().get("llamacpp");
			ok(llamacpp);
			const result = await runWizard(
				localEnv.env,
				[
					{ waitFor: "How should Clio get the API key?", keys: [ENTER] },
					{ waitFor: "Where is the server?", keys: [CTRL_C] },
				],
				{ mode: "first", runtime: llamacpp },
			);
			const screen = plainText(result.transcript());
			ok(screen.includes("❯ http://127.0.0.1:8080"), `the local default must stay:\n${screen}`);
			ok(screen.includes("host:port is enough; Clio fills in the scheme and the port it knows"), screen);
			ok(!screen.includes("gateway URL"), screen);
		} finally {
			localEnv.cleanup();
		}
	});

	it("degrades to the numbered prompts where no key can be read", async () => {
		const testEnv = unconfiguredEnv();
		try {
			// Pipes, not a terminal: the wizard cannot run, and the readline flow it
			// replaced is still the only way to answer, so it must still be there.
			const res = await captureConfigure([], testEnv.env, ["q\n"]);
			strictEqual(res.code, 130, res.stderr);
			match(res.stderr, /configuration cancelled/u);
			match(res.stdout, /Selection \[1\]/u);
			ok(!res.stdout.includes("Welcome to Clio Coder"), "the arrow-key wizard must not open on a pipe");
		} finally {
			testEnv.cleanup();
		}
	});
});

/**
 * The bug this covers: `litellm` needs a key to serve a catalog, and the URL
 * step used to probe reachability before the wizard had asked for one, so an
 * authenticated gateway read as unreachable and the model step had nothing to
 * offer. Both cases below drive the real keypress wizard against a mock
 * gateway that only answers its catalog endpoints with a bearer token.
 */
describe("contracts/configure-onboarding: credential before reachability", () => {
	it("asks for the key before probing, and the env-var path reaches the gateway's catalog", async () => {
		const testEnv = unconfiguredEnv();
		const token = "sk-test-litellm-token";
		const envVar = "CLIO_TEST_LITELLM_TOKEN";
		const server = await litellmServer(token);
		const env = { ...testEnv.env, [envVar]: token };
		try {
			const result = await runWizard(
				env,
				[
					// LiteLLM defaults to storing a key; UP selects an environment variable.
					{ waitFor: "How should Clio get the API key?", keys: ["\x1b[A", ENTER] },
					{ waitFor: "Which environment variable?", keys: [CLEAR_LINE, ...envVar.split(""), ENTER] },
					{ waitFor: "Where is the server?", keys: [CLEAR_LINE, ...server.url.split(""), ENTER] },
					{ waitFor: "Which model?", keys: [ENTER] },
					{ waitFor: "Review what Clio could verify", keys: [ENTER] },
				],
				{ mode: "first", runtime: litellmRuntime() },
			);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);

			const screen = plainText(result.transcript());
			const credAt = screen.indexOf("How should Clio get the API key?");
			const urlAt = screen.indexOf("Where is the server?");
			ok(credAt >= 0 && urlAt > credAt, `credential step must come before the URL step:\n${screen}`);
			ok(screen.includes("reachable, 3 models"), `the probe must succeed once it has the key:\n${screen}`);
			ok(screen.includes(`$${envVar}`), `the credential rail row must name the env var:\n${screen}`);
			ok(!screen.includes("served no model catalog"), `must not report the pre-credential failure:\n${screen}`);
			ok(!screen.includes("not reachable"), `an authenticated gateway must not read as unreachable:\n${screen}`);

			const settings = readFileSync(testEnv.settingsFile, "utf8");
			match(settings, /id: litellm/u);
			match(settings, /runtime: litellm/u);
			match(settings, /defaultModel: gateway-a/u, "the model picker must show the gateway's own catalog");
			match(settings, new RegExp(`apiKeyEnvVar: ${envVar}`, "u"));
		} finally {
			await server.close();
			testEnv.cleanup();
		}
	});

	it("returns missing authentication to credential entry before selecting a model", async () => {
		const testEnv = unconfiguredEnv();
		const server = await litellmServer("sk-a-key-this-run-never-sends");
		try {
			const result = await runWizard(
				testEnv.env,
				[
					// Deliberately skip the default stored-key choice.
					{ waitFor: "How should Clio get the API key?", keys: [DOWN, ENTER] },
					{ waitFor: "Where is the server?", keys: [CLEAR_LINE, ...server.url.split(""), ENTER] },
					{ waitFor: "How should Clio get the API key?", keys: [ENTER] },
					{ waitFor: "Paste the API key", keys: [..."sk-a-key-this-run-never-sends".split(""), ENTER] },
					{ waitFor: "Which model?", keys: [ENTER] },
					{ waitFor: "Review what Clio could verify", keys: [ENTER] },
				],
				{ mode: "first", runtime: litellmRuntime() },
			);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);

			const screen = plainText(result.transcript());
			ok(screen.includes("Authentication failed"), `an auth failure must say so plainly:\n${screen}`);
			ok(!screen.includes("served no model catalog"), `the generic message must not survive an auth failure:\n${screen}`);

			const settings = readFileSync(testEnv.settingsFile, "utf8");
			match(settings, /id: litellm/u);
			match(settings, /runtime: litellm/u);
			match(settings, /defaultModel: gateway-a/u, "the corrected credential retrieves the real catalog");
			ok(!screen.includes("answered no model list"));
		} finally {
			await server.close();
			testEnv.cleanup();
		}
	});

	it("takes the hosted refusal warning down once a new credential is chosen", async () => {
		const testEnv = unconfiguredEnv();
		const key = "sk-hosted-refusal-key";
		const server = await litellmServer(key);
		const saved = new Map(Object.keys(testEnv.env).map((name) => [name, process.env[name]]));
		for (const [name, value] of Object.entries(testEnv.env)) {
			if (value === "") delete process.env[name];
			else process.env[name] = value;
		}
		resetXdgCache();
		registerBuiltinRuntimes(getRuntimeRegistry());
		let messages: string[] = [];
		const seen: string[] = [];
		let credentialAsks = 0;
		let shownAtModel: string[] | null = null;
		const headingOf = (heading: unknown): string =>
			plainText(Array.isArray(heading) ? heading.join("\n") : String(heading ?? ""));
		const controller = new AbortController();
		const host: ConfigureWizardHost = {
			async select(options) {
				const heading = headingOf(options.heading);
				if (heading.includes("How should Clio get the API key?")) {
					credentialAsks += 1;
					const want = credentialAsks === 1 ? "skip" : "stored";
					const choice = options.choices.find((entry) => entry.value === (want as unknown));
					ok(choice, heading);
					return { kind: "selected", value: choice.value };
				}
				if (heading.includes("Which model?")) shownAtModel = [...messages];
				const choice = options.choices[options.initialIndex ?? 0] ?? options.choices[0];
				ok(choice, heading);
				return { kind: "selected", value: choice.value };
			},
			async text(options) {
				const heading = headingOf(options.heading);
				if (heading.includes("Paste the API key")) return { kind: "value", value: key };
				if (heading.includes("Where is the server?")) return { kind: "value", value: server.url };
				return { kind: "value", value: options.initial ?? "" };
			},
			report(line) {
				messages.push(line);
				seen.push(line);
			},
			clearMessages() {
				messages = [];
			},
			cancelled: () => false,
			signal: controller.signal,
			dismissPrompt() {},
		};
		try {
			const output = new Writable({
				write(chunk, _encoding, done) {
					for (const line of String(chunk).split("\n")) if (line.trim()) host.report(line.trim());
					done();
				},
			});
			Object.defineProperty(output, "columns", { value: 100_000 });
			const code = await runOnboardingWizard(
				{ in: new PassThrough(), out: output },
				{ mode: "first", runtime: litellmRuntime() },
				host,
			);
			strictEqual(code, 0, seen.join("\n"));
			ok(
				seen.some((line) => line.includes("Authentication failed")),
				`the refusal must be said:\n${seen.join("\n")}`,
			);
			ok(shownAtModel, `the model step never asked:\n${seen.join("\n")}`);
			ok(
				!(shownAtModel as string[]).some((line) => line.includes("Authentication failed")),
				`a refusal the new key fixed stayed up:\n${(shownAtModel as string[]).join("\n")}`,
			);
		} finally {
			for (const [name, value] of saved) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			resetXdgCache();
			await server.close();
			testEnv.cleanup();
		}
	});

	it("after a server asks for a key, offers to store one and does not ask for the address again", async () => {
		const testEnv = unconfiguredEnv();
		const key = "sk-server-path-key";
		const server = await litellmServer(key);
		try {
			const result = await runWizard(testEnv.env, [
				{ waitFor: "What do you have?", keys: [DOWN, DOWN, ENTER] },
				{ waitFor: "What is the server's address?", keys: [...server.url.split(""), ENTER] },
				{ waitFor: "How should Clio get the API key?", keys: [ENTER] },
				{ waitFor: "Paste the API key", keys: [...key.split(""), ENTER] },
				{ waitFor: "Which model?", keys: [ENTER] },
				{ waitFor: "Review what Clio could verify", keys: [ENTER] },
			]);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);
			const screen = plainText(result.transcript());
			const failed = screen.indexOf("Authentication failed");
			ok(failed >= 0, screen);
			const pasted = screen.indexOf("Paste the API key");
			match(screen.slice(failed, pasted), /❯ Store the key/u, "the refused request preselects a key, not No key");
			ok(!screen.slice(pasted).includes("What is the server's address?"), `the address was asked again:\n${screen}`);
			ok(screen.includes("reachable, 3 models"), screen);
		} finally {
			await server.close();
			testEnv.cleanup();
		}
	});
});

describe("contracts/configure-sections", () => {
	it("creates and binds an agent profile in the same noninteractive write", async () => {
		const testEnv = isolatedEnv();
		const server = await modelServer();
		try {
			const res = await captureConfigure(
				[
					"--id",
					"external-research",
					"--runtime",
					"openai-compat",
					"--url",
					server.url,
					"--model",
					"alpha-1",
					"--agent-profile",
					"world-knowledge-external",
					"--bind-agent",
					"world-knowledge",
				],
				testEnv.env,
			);
			strictEqual(res.code, 0, res.stderr);
			const settings = readFileSync(testEnv.settingsFile, "utf8");
			match(settings, /world-knowledge-external:/u);
			match(settings, /world-knowledge: world-knowledge-external/u);
			match(settings, /target: external-research/u);
			match(settings, /model: alpha-1/u);

			const refused = await captureConfigure(
				[
					"--id",
					"unbound",
					"--runtime",
					"openai-compat",
					"--url",
					server.url,
					"--model",
					"alpha-1",
					"--bind-agent",
					"world-knowledge",
				],
				testEnv.env,
			);
			strictEqual(refused.code, 2);
			match(refused.stderr, /--bind-agent requires --agent-profile/u);
		} finally {
			await server.close();
			testEnv.cleanup();
		}
	});

	it("emits the effective settings as JSON, unchanged by the flag", async () => {
		const testEnv = isolatedEnv();
		try {
			const before = readFileSync(testEnv.settingsFile, "utf8");
			const res = await captureConfigure(["--json"], testEnv.env);
			strictEqual(res.code, 0, res.stderr);
			const parsed = JSON.parse(res.stdout) as {
				version: number;
				targets: Array<{ id: string }>;
				chat: { target: string };
			};
			strictEqual(parsed.version, 2);
			strictEqual(parsed.targets[0]?.id, "test-target");
			strictEqual(parsed.chat.target, "test-target");
			strictEqual(readFileSync(testEnv.settingsFile, "utf8"), before, "--json is a read");
		} finally {
			testEnv.cleanup();
		}
	});

	it("prints a section and exits when there is no terminal to answer a prompt", async () => {
		const testEnv = isolatedEnv();
		try {
			// The previous build wrote `Action [b]: ` into the pipe and then exited
			// on EOF, which reads as a hang to anything scripting it.
			const res = await captureConfigure(["--section", "models"], testEnv.env, []);
			strictEqual(res.code, 0, res.stderr);
			match(res.stdout, /Chat/u);
			match(res.stdout, /Source: .*settings\.yaml/u);
			match(res.stdout, /Chat thinking\s+low/u);
			ok(!res.stdout.includes("Fleet thinking"), "fleet thinking belongs in Fleet");
			ok(!/Action \[/u.test(res.stdout), `no prompt belongs in a pipe:\n${res.stdout}`);
		} finally {
			testEnv.cleanup();
		}
	});

	it("renders every section's current values from settings.yaml", async () => {
		const expected: ReadonlyArray<readonly [string, RegExp]> = [
			["targets", /test-target\s+openai-compat/u],
			["models", /Chat model\s+mock-model/u],
			["chat", /Chat thinking\s+low/u],
			["fleet", /Concurrency limit\s+auto/u],
			["permissions", /Autonomy level\s+default/u],
			["panes", /TUI mode\s+regular/u],
			["skills", /Trust project imports\s+untrusted/u],
			["diagnostics", /Config dir\s+\S/u],
		];
		for (const [section, pattern] of expected) {
			const testEnv = isolatedEnv();
			try {
				const res = await captureConfigure(["--section", section], testEnv.env, []);
				strictEqual(res.code, 0, `${section}: ${res.stderr}`);
				match(res.stdout, pattern, `${section} must show its current values`);
				match(res.stdout, /Source: /u, `${section} must name the file its values live in`);
			} finally {
				testEnv.cleanup();
			}
		}
	});

	it("accepts a section by its canonical name or a listed alias, and nothing else", async () => {
		const testEnv = isolatedEnv();
		try {
			for (const name of ["permissions", "autonomy", "safety"]) {
				const res = await captureConfigure(["--section", name], testEnv.env, []);
				strictEqual(res.code, 0, `${name}: ${res.stderr}`);
				match(res.stdout, /Permissions & Limits/u);
			}
			// Substring matching used to accept anything containing "perm", so
			// `--section permanent` silently opened this screen.
			for (const name of ["permanent", "models,chat", "", "diagnostics-extra"]) {
				const res = await captureConfigure(["--section", name], testEnv.env, []);
				strictEqual(res.code, 2, `${name} must be rejected`);
				match(res.stderr, /unknown section/u);
				match(res.stderr, /targets, chat, fleet, context, safety, interface, integrations, advanced/u);
			}
		} finally {
			testEnv.cleanup();
		}
	});

	it("lists all eight sections on the top menu and leaves on q with exit 0", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureConfigure([], testEnv.env, ["q\n"]);
			// Quitting a settings menu you only looked at is not a cancellation.
			// This used to exit 130 with "error: configuration cancelled".
			strictEqual(res.code, 0, res.stderr);
			strictEqual(res.stderr, "", "leaving the menu is not an error");
			for (const title of [
				"Connections",
				"Chat",
				"Fleet",
				"Context & Memory",
				"Permissions & Limits",
				"Appearance",
				"Integrations",
				"Advanced",
			]) {
				ok(res.stdout.includes(title), `${title} missing from the top menu`);
			}
		} finally {
			testEnv.cleanup();
		}
	});

	it("writes an edited setting through to settings.yaml", async () => {
		const testEnv = isolatedEnv();
		try {
			// Top menu -> Chat -> chat thinking level -> high -> back -> quit.
			const res = await captureConfigure([], testEnv.env, ["2\n", "2\n", "high\n", "Save\n", "b\n", "q\n"]);
			strictEqual(res.code, 0, res.stderr);
			match(res.stdout, /Thinking level saved/u);
			match(readFileSync(testEnv.settingsFile, "utf8"), /thinkingLevel: high/u);
		} finally {
			testEnv.cleanup();
		}
	});

	it("leaves a setting alone, and says so, when the answer is not one of its values", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureConfigure([], testEnv.env, ["2\n", "2\n", "sideways\n", "b\n", "q\n"]);
			strictEqual(res.code, 0, res.stderr);
			match(res.stdout, /Choose one of/u);
			match(readFileSync(testEnv.settingsFile, "utf8"), /thinkingLevel: low/u);
		} finally {
			testEnv.cleanup();
		}
	});

	it("shares section names with the TUI and keeps unrelated controls out of each overview", async () => {
		const testEnv = isolatedEnv();
		try {
			for (const section of SETTINGS_SECTIONS) {
				const result = await captureConfigure(["--section", section.id], testEnv.env, []);
				strictEqual(result.code, 0, result.stderr);
				ok(result.stdout.includes(section.label), section.id);
			}
			for (const [section, absent] of [
				["chat", ["Smooth streaming", "Fleet thinking", "Auto-compaction"]],
				["fleet", ["Worker permissions", "Startup layout"]],
				["interface", ["Git commit attribution", "Worker profiles"]],
				["targets", ["Chat thinking", "Session cost limit"]],
			] as const) {
				const result = await captureConfigure(["--section", section], testEnv.env, []);
				for (const label of absent) ok(!result.stdout.includes(label), `${label} leaked into ${section}`);
			}
		} finally {
			testEnv.cleanup();
		}
	});

	it("moved controls save only their own setting from the new menu location", async () => {
		for (const [inputs, path, value] of [
			[["6\n", "7\n", "on\n", "b\n", "q\n"], ["interface", "smoothStreaming"], "on"],
			// Fleet thinking is item 4 behind Turn preparation (4c13e0757) and node preference (d045ba49f).
			[["3\n", "4\n", "high\n", "Save\n", "b\n", "q\n"], ["fleet", "default", "thinkingLevel"], "high"],
			[["7\n", "3\n", "b\n", "q\n"], ["integrations", "git", "commitAttribution"], false],
		] as const) {
			const testEnv = isolatedEnv();
			try {
				const expected = parse(readFileSync(testEnv.settingsFile, "utf8"));
				let cursor = expected;
				for (const key of path.slice(0, -1)) cursor = cursor[key];
				cursor[path.at(-1) as string] = value;
				const result = await captureConfigure([], testEnv.env, inputs);
				strictEqual(result.code, 0, result.stderr);
				deepStrictEqual(parse(readFileSync(testEnv.settingsFile, "utf8")), expected);
			} finally {
				testEnv.cleanup();
			}
		}
	});

	it("configures Ollama under its canonical runtime id and advertises it in --list", async () => {
		const testEnv = isolatedEnv();
		const server = await ollamaServer();
		try {
			const res = await captureConfigure(
				["--id", "local-ollama", "--runtime", "ollama", "--url", server.url, "--model", "qwen3:8b"],
				testEnv.env,
			);
			strictEqual(res.code, 0, res.stderr);
			const settings = readFileSync(testEnv.settingsFile, "utf8");
			match(settings, /id: local-ollama\n\s+runtime: ollama\n/u);

			// `--list` prints these entries, one per canonical runtime.
			const listed = listProviderSupportEntries(getRuntimeRegistry().list()).map((entry) => entry.runtimeId);
			ok(listed.includes("ollama"), listed.join(", "));
			ok(!listed.includes("ollama-native"), "the alias is not advertised");
		} finally {
			await server.close();
			testEnv.cleanup();
		}
	});

	it("refuses the released ollama-native and lmstudio-native runtime ids", async () => {
		const testEnv = isolatedEnv();
		try {
			for (const id of ["ollama-native", "lmstudio-native"]) {
				const res = await captureConfigure(["--runtime", id], testEnv.env, []);
				strictEqual(res.code, 2);
				match(res.stderr, new RegExp(`unknown runtime id: ${id}`, "u"));
			}
		} finally {
			testEnv.cleanup();
		}
	});

	it("suggests the closest registered runtime for an unknown id", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureConfigure(["--runtime", "olama"], testEnv.env, []);
			strictEqual(res.code, 2);
			match(res.stderr, /unknown runtime id: olama \(did you mean 'ollama'\?\)/u);

			const unrelated = await captureConfigure(["--runtime", "zzzzzzzz"], testEnv.env, []);
			strictEqual(unrelated.code, 2);
			match(unrelated.stderr, /unknown runtime id: zzzzzzzz/u);
			ok(!unrelated.stderr.includes("did you mean"), unrelated.stderr);
		} finally {
			testEnv.cleanup();
		}
	});
});
