import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { runConfigureCommand } from "../../src/cli/configure.js";
import { resetXdgCache } from "../../src/core/xdg.js";

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
