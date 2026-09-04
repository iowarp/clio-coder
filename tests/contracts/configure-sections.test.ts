import { match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { runConfigureCommand } from "../../src/cli/configure.js";
import { runtimesForCategory } from "../../src/cli/configure-target.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { listProviderSupportEntries } from "../../src/domains/providers/index.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";

function isolatedEnv(): {
	root: string;
	configDir: string;
	settingsFile: string;
	env: Record<string, string>;
	cleanup: () => void;
} {
	const rand = Math.random().toString(36).slice(2, 8);
	const root = join(tmpdir(), `clio-test-configure-${rand}`);
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
  autonomy: auto-edit
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
	};

	return {
		root,
		configDir,
		settingsFile,
		env,
		cleanup: () => {
			resetXdgCache();
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				// Ignore cleanup
			}
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
 * PATH is emptied so the interop detection at the end of the wizard resolves no
 * coding agents: it reads the real PATH, and whether the developer happens to
 * have Codex installed must not decide how many prompts this test answers.
 */
function unconfiguredEnv(): { root: string; settingsFile: string; env: Record<string, string>; cleanup: () => void } {
	const rand = Math.random().toString(36).slice(2, 8);
	const root = join(tmpdir(), `clio-test-onboarding-${rand}`);
	const configDir = join(root, ".config", "clio-coder");
	mkdirSync(configDir, { recursive: true });
	return {
		root,
		settingsFile: join(configDir, "settings.yaml"),
		env: {
			HOME: root,
			CLIO_CODER_HOME: "",
			CLIO_CODER_CONFIG_DIR: configDir,
			CLIO_CODER_DATA_DIR: join(root, ".local", "share", "clio-coder"),
			CLIO_CODER_STATE_DIR: join(root, ".local", "state", "clio-coder"),
			CLIO_CODER_CACHE_DIR: join(root, ".cache", "clio-coder"),
			TERM: "xterm-256color",
			PATH: "",
		},
		cleanup: () => {
			resetXdgCache();
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				// Ignore cleanup
			}
		},
	};
}

/** An OpenAI-compatible endpoint with two models, so the model step has a real list. */
async function modelServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const server: Server = createServer((req, res) => {
		if (req.url?.endsWith("/v1/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "alpha-1" }, { id: "beta-2" }] }));
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
	const pending = runConfigureCommand([], tty.input, tty.output);
	let settled = false;
	void pending.then(() => {
		settled = true;
	});

	try {
		for (const step of script) {
			if (step.waitFor !== undefined) {
				const cue = step.waitFor;
				const deadline = Date.now() + (step.optional ? 2_000 : 20_000);
				while (!tty.transcript().includes(cue) && !settled && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				if (!tty.transcript().includes(cue)) {
					if (step.optional) continue;
					throw new Error(`wizard never showed ${JSON.stringify(cue)}:\n${plainText(tty.transcript())}`);
				}
			} else {
				await new Promise((resolve) => setTimeout(resolve, step.settleMs ?? 100));
			}
			for (const key of step.keys) {
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

/** Arrow presses from the top of the runtime list to one runtime, by id. */
function stepsDownToRuntime(runtimeId: string): string[] {
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const entries = runtimesForCategory(listProviderSupportEntries(registry.list()), "local-http");
	const index = entries.findIndex((entry) => entry.runtimeId === runtimeId);
	ok(index >= 0, `${runtimeId} is not in the local HTTP category`);
	return Array.from({ length: index }, () => DOWN);
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

describe("contracts/configure-onboarding", () => {
	it("takes a fresh home through the wizard on arrow keys alone and writes what it says it wrote", async () => {
		const testEnv = unconfiguredEnv();
		const server = await modelServer();
		try {
			const result = await runWizard(testEnv.env, [
				{ waitFor: "How will you connect Clio to a model?", keys: [DOWN, ENTER] },
				{ waitFor: "Which runtime?", keys: [...stepsDownToRuntime("openai-compat"), ENTER] },
				{ waitFor: "Target id", keys: [CLEAR_LINE, ...`wizard-target`.split(""), ENTER] },
				{ waitFor: "How should Clio get the API key?", keys: [ENTER] },
				{ waitFor: "Where is the server?", keys: [CLEAR_LINE, ...server.url.split(""), ENTER] },
				{ waitFor: "Which model?", keys: [DOWN, ENTER] },
				{ waitFor: "How hard should it think?", keys: [DOWN, ENTER] },
				{ waitFor: "Delegate to any of these?", keys: [ENTER], optional: true },
			]);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);

			const screen = plainText(result.transcript());
			for (const expected of [
				"Welcome to Clio Coder",
				"How will you connect Clio to a model?",
				"↑/↓ move",
				"reachable, 2 models",
				"target wizard-target saved",
				"chat runs on wizard-target",
				"fleet default is wizard-target",
				"settings written to",
				"clio-coder configure",
				"Done",
			]) {
				ok(screen.includes(expected), `${JSON.stringify(expected)} missing from:\n${screen}`);
			}
			// The whole point: not one readline prompt survives on this path.
			ok(!/Selection \[/u.test(screen), `a numbered prompt is still here:\n${screen}`);
			ok(!/\[y\/N\]|\[Y\/n\]/u.test(screen), `a yes/no prompt is still here:\n${screen}`);
			ok(!/\[env\|stored\|keep\|skip\]/u.test(screen), `the credential paragraph is still here:\n${screen}`);

			ok(existsSync(testEnv.settingsFile), "the wizard must write settings.yaml");
			const settings = readFileSync(testEnv.settingsFile, "utf8");
			match(settings, /id: wizard-target/u);
			match(settings, /runtime: openai-compat/u);
			match(settings, /defaultModel: beta-2/u, "the model the arrow keys landed on is the one saved");
			match(settings, /target: wizard-target/u);
			// The level picker opens on `low`, so one press down is `medium`.
			match(settings, /thinkingLevel: medium/u);
			// openai-compat reports nothing about reasoning, so the thinking answer
			// is also what records whether the model has it.
			match(settings, /reasoning: true/u);
		} finally {
			await server.close();
			testEnv.cleanup();
		}
	});

	it("offers the detected delegation peers as one list instead of a y/N each", async () => {
		const testEnv = unconfiguredEnv();
		const server = await modelServer();
		const env = { ...testEnv.env, PATH: fakeAgentOnPath(testEnv.root, "opencode") };
		try {
			const result = await runWizard(env, [
				{ waitFor: "How will you connect Clio to a model?", keys: [DOWN, ENTER] },
				{ waitFor: "Which runtime?", keys: [...stepsDownToRuntime("openai-compat"), ENTER] },
				{ waitFor: "Target id", keys: [CLEAR_LINE, ...`peer-target`.split(""), ENTER] },
				{ waitFor: "How should Clio get the API key?", keys: [ENTER] },
				{ waitFor: "Where is the server?", keys: [CLEAR_LINE, ...server.url.split(""), ENTER] },
				{ waitFor: "Which model?", keys: [ENTER] },
				{ waitFor: "How hard should it think?", keys: [ENTER] },
				// Space ticks the row, enter confirms the whole list at once.
				{ waitFor: "Delegate to any of these?", keys: [" ", ENTER] },
			]);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);

			const screen = plainText(result.transcript());
			ok(screen.includes("space toggle"), `the list must say how to tick a row:\n${screen}`);
			ok(screen.includes("OpenCode"), `the detected agent is missing:\n${screen}`);
			ok(!/\[y\/N\]/u.test(screen), `a per-agent yes/no question survived:\n${screen}`);
			// The paragraph each proposal used to carry said the same two facts every
			// time. They are stated once above the list now, and the row carries what
			// actually differs.
			ok(
				!screen.includes("is installed and not configured as a delegation agent"),
				`the per-agent paragraph survived:\n${screen}`,
			);
			ok(screen.includes("delegation agent opencode added"), `the wired peer is not in the results:\n${screen}`);

			const settings = readFileSync(testEnv.settingsFile, "utf8");
			match(settings, /id: opencode/u);
			match(settings, /toolGovernance: clio-coder-policy/u);
		} finally {
			await server.close();
			testEnv.cleanup();
		}
	});

	it("goes back from the third step without losing the first two", async () => {
		const testEnv = unconfiguredEnv();
		try {
			const result = await runWizard(testEnv.env, [
				{ waitFor: "How will you connect Clio to a model?", keys: [DOWN, ENTER] },
				{ waitFor: "Which runtime?", keys: [...stepsDownToRuntime("llamacpp"), ENTER] },
				{ waitFor: "Target id", keys: [ESCAPE] },
				// The runtime list is back, drawing the same words it drew before, so
				// these two wait on the redraw rather than on text. The wait is longer
				// than readline's 500ms escape-sequence timeout: a lone Escape is only
				// delivered once that has passed, and two sent inside one window arrive
				// together and are read as a meta prefix instead of two keys.
				{ settleMs: 800, keys: [ESCAPE] },
				{ settleMs: 800, keys: [ESCAPE] },
			]);
			strictEqual(result.code, 130, "backing out of the first step leaves Clio unconfigured");

			const screen = plainText(result.transcript());
			const askedTargetId = screen.lastIndexOf("Target id");
			const reopened = screen.indexOf("Which runtime?", askedTargetId);
			ok(reopened > 0, `escape on step 3 did not reopen step 2:\n${screen}`);
			// Reopened on the runtime that was already chosen, which is what "without
			// losing the earlier answers" has to mean for a list step.
			ok(
				/❯ llamacpp/u.test(screen.slice(reopened)),
				`step 2 reopened at the top of the list instead of on its answer:\n${screen.slice(reopened)}`,
			);
			// Step 1's answer was on the rail the whole time, and step 3 left no row
			// behind when it was abandoned.
			ok(screen.slice(0, reopened).includes("Local HTTP server"), `step 1's answer was lost:\n${screen}`);
			ok(!/Target id\s{4,}\S/u.test(screen), "the abandoned step must not leave an answer row behind");
			ok(screen.includes("Cancelled, nothing written"), `no closing line:\n${screen}`);
			match(readFileSync(testEnv.settingsFile, "utf8"), /targets: \[\]/u, "a cancelled wizard registers no target");
		} finally {
			testEnv.cleanup();
		}
	});

	it("exits 130 when the very first step is cancelled, because nothing is configured", async () => {
		const testEnv = unconfiguredEnv();
		try {
			const result = await runWizard(testEnv.env, [{ waitFor: "How will you connect Clio to a model?", keys: [ESCAPE] }]);
			strictEqual(result.code, 130);
			match(result.stderr, /configuration cancelled/u);
			// The home is initialized before the wizard opens, so the file exists; a
			// cancel is the difference between a template and a configured target.
			match(readFileSync(testEnv.settingsFile, "utf8"), /targets: \[\]/u);
		} finally {
			testEnv.cleanup();
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
			const result = await runWizard(env, [
				{ waitFor: "How will you connect Clio to a model?", keys: [DOWN, ENTER] },
				{ waitFor: "Which runtime?", keys: [...stepsDownToRuntime("litellm"), ENTER] },
				{ waitFor: "Target id", keys: [CLEAR_LINE, ...`litellm-env-target`.split(""), ENTER] },
				// Skip's default highlight wraps one DOWN to "Environment variable".
				{ waitFor: "How should Clio get the API key?", keys: [DOWN, ENTER] },
				{ waitFor: "Which environment variable?", keys: [CLEAR_LINE, ...envVar.split(""), ENTER] },
				{ waitFor: "Where is the server?", keys: [CLEAR_LINE, ...server.url.split(""), ENTER] },
				{ waitFor: "Which model?", keys: [ENTER] },
				{ waitFor: "Delegate to any of these?", keys: [ENTER], optional: true },
			]);
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
			match(settings, /id: litellm-env-target/u);
			match(settings, /runtime: litellm/u);
			match(settings, /defaultModel: gateway-a/u, "the model picker must show the gateway's own catalog");
			match(settings, new RegExp(`apiKeyEnvVar: ${envVar}`, "u"));
		} finally {
			await server.close();
			testEnv.cleanup();
		}
	});

	it("reports a rejected key rather than an unreachable gateway, and still completes", async () => {
		const testEnv = unconfiguredEnv();
		const server = await litellmServer("sk-a-key-this-run-never-sends");
		try {
			const result = await runWizard(testEnv.env, [
				{ waitFor: "How will you connect Clio to a model?", keys: [DOWN, ENTER] },
				{ waitFor: "Which runtime?", keys: [...stepsDownToRuntime("litellm"), ENTER] },
				{ waitFor: "Target id", keys: [CLEAR_LINE, ...`litellm-nokey-target`.split(""), ENTER] },
				// "No key" is already the default highlight for a fresh target.
				{ waitFor: "How should Clio get the API key?", keys: [ENTER] },
				{ waitFor: "Where is the server?", keys: [CLEAR_LINE, ...server.url.split(""), ENTER] },
				{ waitFor: "Which model?", keys: [CLEAR_LINE, ...`manual-model`.split(""), ENTER] },
				{ waitFor: "Delegate to any of these?", keys: [ENTER], optional: true },
			]);
			strictEqual(result.code, 0, `${result.stderr}\n${plainText(result.transcript())}`);

			const screen = plainText(result.transcript());
			ok(screen.includes("rejected the key"), `an auth failure must say so plainly:\n${screen}`);
			ok(!screen.includes("served no model catalog"), `the generic message must not survive an auth failure:\n${screen}`);

			const settings = readFileSync(testEnv.settingsFile, "utf8");
			match(settings, /id: litellm-nokey-target/u);
			match(settings, /runtime: litellm/u);
			match(settings, /defaultModel: manual-model/u, "declining a key still lets the wizard finish");
		} finally {
			await server.close();
			testEnv.cleanup();
		}
	});
});

describe("contracts/configure-sections", () => {
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
			match(res.stdout, /Models & Thinking/u);
			match(res.stdout, /Source: .*settings\.yaml/u);
			match(res.stdout, /Chat thinking\s+low/u);
			match(res.stdout, /Fleet thinking\s+off/u);
			ok(!/Action \[/u.test(res.stdout), `no prompt belongs in a pipe:\n${res.stdout}`);
		} finally {
			testEnv.cleanup();
		}
	});

	it("renders every section's current values from settings.yaml", async () => {
		const expected: ReadonlyArray<readonly [string, RegExp]> = [
			["targets", /Chat target\s+test-target/u],
			["models", /Chat model\s+mock-model/u],
			["chat", /Smooth streaming\s+off/u],
			["fleet", /Concurrency limit\s+auto/u],
			["permissions", /Autonomy level\s+auto-edit/u],
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
				match(res.stdout, /Permissions & Autonomy/u);
			}
			// Substring matching used to accept anything containing "perm", so
			// `--section permanent` silently opened this screen.
			for (const name of ["permanent", "models,chat", "", "diagnostics-extra"]) {
				const res = await captureConfigure(["--section", name], testEnv.env, []);
				strictEqual(res.code, 2, `${name} must be rejected`);
				match(res.stderr, /unknown section/u);
				match(res.stderr, /targets, models, chat, fleet, permissions, panes, skills, diagnostics/u);
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
				"Targets & Auth",
				"Models & Thinking",
				"Chat Defaults",
				"Fleet",
				"Permissions & Autonomy",
				"Panes & Layout",
				"Skills & Extensions",
				"Diagnostics",
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
			// Top menu -> Models & Thinking -> chat thinking level -> high -> back -> quit.
			const res = await captureConfigure([], testEnv.env, ["2\n", "1\n", "high\n", "b\n", "q\n"]);
			strictEqual(res.code, 0, res.stderr);
			match(res.stdout, /Chat thinking level set to high/u);
			match(readFileSync(testEnv.settingsFile, "utf8"), /thinkingLevel: high/u);
		} finally {
			testEnv.cleanup();
		}
	});

	it("leaves a setting alone, and says so, when the answer is not one of its values", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureConfigure([], testEnv.env, ["2\n", "1\n", "sideways\n", "b\n", "q\n"]);
			strictEqual(res.code, 0, res.stderr);
			match(res.stdout, /must be one of/u);
			match(readFileSync(testEnv.settingsFile, "utf8"), /thinkingLevel: low/u);
		} finally {
			testEnv.cleanup();
		}
	});
});
