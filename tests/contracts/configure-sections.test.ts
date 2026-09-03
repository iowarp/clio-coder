import { match, strictEqual } from "node:assert";
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

async function captureConfigure(
	argv: ReadonlyArray<string>,
	extraEnv: Record<string, string> = {},
	inputLines: string[] = ["b\n"],
): Promise<{ code: number; stdout: string; stderr: string }> {
	const origEnv = { ...process.env };
	const origStderrWrite = process.stderr.write;

	let stdout = "";
	let stderr = "";

	Object.assign(process.env, extraEnv);
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
		if (str.includes(": ") && inputIdx < inputLines.length) {
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
		for (const key of Object.keys(extraEnv)) {
			if (origEnv[key] === undefined) delete process.env[key];
			else process.env[key] = origEnv[key];
		}
		resetXdgCache();
	}
}

describe("contracts/configure-sections", () => {
	it("emits machine-readable settings in JSON format via --json", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureConfigure(["--json"], testEnv.env);
			strictEqual(res.code, 0, res.stderr);
			const parsed = JSON.parse(res.stdout);
			strictEqual(parsed.version, 2);
			strictEqual(parsed.targets[0].id, "test-target");
			strictEqual(parsed.chat.target, "test-target");
		} finally {
			testEnv.cleanup();
		}
	});

	it("renders models section directly with source path and current values", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureConfigure(["--section", "models"], testEnv.env, ["b\n"]);
			strictEqual(res.code, 0, res.stderr);
			match(res.stdout, /Models & Thinking/u);
			match(res.stdout, /settings\.yaml/u);
			match(res.stdout, /Chat Thinking Level:\s+low/u);
			match(res.stdout, /Fleet Thinking Level:\s+off/u);
		} finally {
			testEnv.cleanup();
		}
	});

	it("renders fleet section directly with source path and current limits", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureConfigure(["--section", "fleet"], testEnv.env, ["b\n"]);
			strictEqual(res.code, 0, res.stderr);
			match(res.stdout, /Fleet/u);
			match(res.stdout, /settings\.yaml/u);
			match(res.stdout, /Concurrency Limit:\s+auto/u);
			match(res.stdout, /Max Retries:\s+2/u);
		} finally {
			testEnv.cleanup();
		}
	});

	it("renders permissions section with autonomy level and cost limits", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureConfigure(["--section", "permissions"], testEnv.env, ["b\n"]);
			strictEqual(res.code, 0, res.stderr);
			match(res.stdout, /Permissions & Autonomy/u);
			match(res.stdout, /Autonomy Level:\s+auto-edit/u);
			match(res.stdout, /Session Cost Limit:\s+\$5 USD/u);
		} finally {
			testEnv.cleanup();
		}
	});

	it("renders panes & layout section with capability and display mode", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureConfigure(["--section", "panes"], testEnv.env, ["b\n"]);
			strictEqual(res.code, 0, res.stderr);
			match(res.stdout, /Panes & Layout/u);
			match(res.stdout, /Panes Capability:\s+off/u);
			match(res.stdout, /TUI Mode:\s+regular/u);
		} finally {
			testEnv.cleanup();
		}
	});

	it("renders diagnostics section with system version and directories", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureConfigure(["--section", "diagnostics"], testEnv.env, ["b\n"]);
			strictEqual(res.code, 0, res.stderr);
			match(res.stdout, /Diagnostics/u);
			match(res.stdout, /Clio Coder Version:/u);
			match(res.stdout, /Node\.js Version:/u);
		} finally {
			testEnv.cleanup();
		}
	});

	it("presents all 8 runtime sections at the top-level configure menu and exits cleanly on quit", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureConfigure([], testEnv.env, ["q\n"]);
			strictEqual(res.code, 130);
			match(res.stdout, /Configure runtime sections:/u);
			match(res.stdout, /1\. Targets & Auth/u);
			match(res.stdout, /2\. Models & Thinking/u);
			match(res.stdout, /3\. Chat Defaults/u);
			match(res.stdout, /4\. Fleet/u);
			match(res.stdout, /5\. Permissions & Autonomy/u);
			match(res.stdout, /6\. Panes & Layout/u);
			match(res.stdout, /7\. Skills & Extensions/u);
			match(res.stdout, /8\. Diagnostics/u);
			match(res.stderr, /configuration cancelled/u);
		} finally {
			testEnv.cleanup();
		}
	});

	it("updates a setting in settings.yaml when edited in section menu", async () => {
		const testEnv = isolatedEnv();
		try {
			// In models section: choose '1' (thinking level), enter 'high', then 'b' to exit
			const res = await captureConfigure(["--section", "models"], testEnv.env, ["1\n", "high\n", "b\n"]);
			strictEqual(res.code, 0, res.stderr);
			match(res.stdout, /Chat thinking level set to high/u);

			const saved = readFileSync(testEnv.settingsFile, "utf8");
			match(saved, /thinkingLevel: high/u);
		} finally {
			testEnv.cleanup();
		}
	});
});
