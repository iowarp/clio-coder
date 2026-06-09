#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

if (process.env.CLIO_LIVE_SMOKE !== "1") {
	console.log("CLIO_LIVE_SMOKE environment variable is not set to '1'. Skipping live LLM smoke validation.");
	process.exit(0);
}

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");

if (!existsSync(CLI_ENTRY)) {
	console.error(`Error: Built CLI entry not found at ${CLI_ENTRY}. Please run npm run build first.`);
	process.exit(1);
}

// Extract live model targets and variables
const targetId = process.env.CLIO_LIVE_TARGET || "live-target";
const runtimeId = process.env.CLIO_LIVE_RUNTIME || (process.env.CLIO_LIVE_BASE_URL ? "openai-compat" : "openai");
const model = process.env.CLIO_LIVE_MODEL || (runtimeId === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4o-mini");
const url = process.env.CLIO_LIVE_BASE_URL || undefined;

let envVarName = "CLIO_LIVE_API_KEY";
let apiKey = process.env.CLIO_LIVE_API_KEY || "";

if (!apiKey) {
	if (runtimeId === "openai" && process.env.OPENAI_API_KEY) {
		envVarName = "OPENAI_API_KEY";
		apiKey = process.env.OPENAI_API_KEY;
	} else if (runtimeId === "anthropic" && process.env.ANTHROPIC_API_KEY) {
		envVarName = "ANTHROPIC_API_KEY";
		apiKey = process.env.ANTHROPIC_API_KEY;
	}
}

if (!apiKey && runtimeId !== "openai-compat") {
	console.error(
		"Error: CLIO_LIVE_SMOKE=1 is active, but no API key was found in CLIO_LIVE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.",
	);
	process.exit(1);
}

// Helper to redact secrets from output
function redact(str) {
	if (!str) return "";
	let redacted = str;
	const secrets = [
		process.env.CLIO_LIVE_API_KEY,
		process.env.OPENAI_API_KEY,
		process.env.ANTHROPIC_API_KEY,
		apiKey,
	].filter(Boolean);
	for (const secret of secrets) {
		if (secret.length > 4) {
			redacted = redacted.split(secret).join("[REDACTED]");
		}
	}
	return redacted;
}

// Create sandbox directories
const scratchDir = mkdtempSync(join(tmpdir(), "clio-live-smoke-"));
const clioHome = scratchDir;
const clioDataDir = join(scratchDir, "data");
const clioConfigDir = join(scratchDir, "config");
const clioCacheDir = join(scratchDir, "cache");

mkdirSync(clioDataDir, { recursive: true });
mkdirSync(clioConfigDir, { recursive: true });
mkdirSync(clioCacheDir, { recursive: true });

// Setup settings.yaml
const settings = {
	version: 1,
	identity: "clio",
	defaultMode: "super",
	safetyLevel: "full-auto",
	state: {
		lastMode: "super",
	},
	targets: [
		{
			id: targetId,
			runtime: runtimeId,
			defaultModel: model,
			wireModels: [model],
			url,
			auth: apiKey ? { apiKeyEnvVar: envVarName } : undefined,
		},
	],
	orchestrator: {
		endpoint: targetId,
		model: model,
		thinkingLevel: "off",
	},
	workers: {
		default: {
			endpoint: targetId,
			model: model,
			thinkingLevel: "off",
		},
		profiles: {},
	},
	delegation: {
		defaults: {
			connectTimeoutMs: 30000,
			turnTimeoutMs: 300000,
			permissionTimeoutMs: 120000,
			toolGovernance: "clio-policy",
		},
		agents: [
			{
				id: "opencode",
				command: "opencode",
				args: ["acp", "--cwd", "."],
				toolGovernance: "clio-policy",
				labels: { specialty: "coding" },
			},
			{
				id: "copilot",
				command: "copilot",
				args: ["--acp"],
				toolGovernance: "clio-policy",
				labels: { specialty: "coding" },
			},
		],
	},
};

const settingsPath = join(clioConfigDir, "settings.yaml");
writeFileSync(settingsPath, stringify(settings), "utf8");

const childEnv = {
	...process.env,
	CLIO_HOME: clioHome,
	CLIO_DATA_DIR: clioDataDir,
	CLIO_CONFIG_DIR: clioConfigDir,
	CLIO_CACHE_DIR: clioCacheDir,
	CLIO_REQUIRE_HOME_PREFIX: "1",
};
if (apiKey) {
	childEnv[envVarName] = apiKey;
}

function runCommand(args, timeoutMs = 120_000) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
			env: childEnv,
			cwd: REPO_ROOT,
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Command timed out after ${timeoutMs}ms: clio ${args.join(" ")}`));
		}, timeoutMs);

		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

async function main() {
	console.log(`Setting up live smoke test with target=${targetId}, runtime=${runtimeId}, model=${model}`);
	console.log(`Scratch config path: ${settingsPath}`);

	try {
		// 1. clio --version
		console.log("Running: clio --version");
		const r1 = await runCommand(["--version"], 15_000);
		console.log(`Exit code: ${r1.code}`);
		console.log(redact(r1.stdout).trim());
		if (r1.code !== 0) throw new Error("clio --version failed");

		// 2. clio doctor --fix
		console.log("Running: clio doctor --fix");
		const r2 = await runCommand(["doctor", "--fix"], 30_000);
		console.log(`Exit code: ${r2.code}`);
		if (r2.code !== 0) {
			console.error("Stderr:", redact(r2.stderr));
			throw new Error("clio doctor --fix failed");
		}

		// 3. clio run --no-context-files "Reply with exactly: clio-live-ok"
		console.log("Running live validation prompt...");
		const r3 = await runCommand(["--no-context-files", "run", "Reply with exactly: clio-live-ok"], 120_000);
		console.log(`Exit code: ${r3.code}`);
		const cleanStdout = redact(r3.stdout);
		const cleanStderr = redact(r3.stderr);

		console.log("Stdout:\n", cleanStdout);
		if (cleanStderr.trim()) {
			console.log("Stderr:\n", cleanStderr);
		}

		if (r3.code !== 0) {
			throw new Error(`clio run failed with code ${r3.code}`);
		}

		if (!cleanStdout.toLowerCase().includes("clio-live-ok")) {
			throw new Error("Validation prompt response did not contain 'clio-live-ok'");
		}

		// 4. clio run --agent opencode "Reply with exactly: clio-opencode-ok"
		console.log("Running opencode delegation live validation...");
		const r4 = await runCommand(["run", "--agent", "opencode", "Reply with exactly: clio-opencode-ok"], 120_000);
		console.log(`Exit code: ${r4.code}`);
		const cleanStdout4 = redact(r4.stdout);
		console.log("Stdout:\n", cleanStdout4);
		if (r4.code !== 0) {
			throw new Error(`clio run --agent opencode failed with code ${r4.code}`);
		}
		if (!cleanStdout4.toLowerCase().includes("clio-opencode-ok")) {
			throw new Error("Validation prompt response did not contain 'clio-opencode-ok'");
		}

		// 5. clio run --agent opencode "Create a file named scratch/live-smoke-opencode.txt containing 'opencode-tool-ok', then read it back and print it."
		console.log("Running opencode complex delegation live validation...");
		const r5 = await runCommand(["run", "--agent", "opencode", "Create a file named scratch/live-smoke-opencode.txt containing 'opencode-tool-ok', then read it back and print it."], 120_000);
		console.log(`Exit code: ${r5.code}`);
		const cleanStdout5 = redact(r5.stdout);
		console.log("Stdout:\n", cleanStdout5);
		if (r5.code !== 0) {
			throw new Error(`clio run --agent opencode (complex) failed with code ${r5.code}`);
		}

		// 6. clio run --agent copilot "Reply with exactly: clio-copilot-ok"
		console.log("Running copilot delegation live validation...");
		const r6 = await runCommand(["run", "--agent", "copilot", "Reply with exactly: clio-copilot-ok"], 120_000);
		console.log(`Exit code: ${r6.code}`);
		const cleanStdout6 = redact(r6.stdout);
		console.log("Stdout:\n", cleanStdout6);
		if (r6.code !== 0) {
			throw new Error(`clio run --agent copilot failed with code ${r6.code}`);
		}
		if (!cleanStdout6.toLowerCase().includes("clio-copilot-ok")) {
			throw new Error("Validation prompt response did not contain 'clio-copilot-ok'");
		}

		// 7. clio run --agent copilot "Create a file named scratch/live-smoke-copilot.txt containing 'copilot-tool-ok', then read it back and print it."
		console.log("Running copilot complex delegation live validation...");
		const r7 = await runCommand(["run", "--agent", "copilot", "Create a file named scratch/live-smoke-copilot.txt containing 'copilot-tool-ok', then read it back and print it."], 120_000);
		console.log(`Exit code: ${r7.code}`);
		const cleanStdout7 = redact(r7.stdout);
		console.log("Stdout:\n", cleanStdout7);
		if (r7.code !== 0) {
			throw new Error(`clio run --agent copilot (complex) failed with code ${r7.code}`);
		}

		console.log("Live smoke validation: SUCCESS");
	} catch (err) {
		console.error("Live smoke validation failed:", err.message);
		process.exitCode = 1;
	} finally {
		if (process.env.CLIO_LIVE_KEEP === "1") {
			console.log(`CLIO_LIVE_KEEP=1. Keeping scratch directory at: ${scratchDir}`);
		} else {
			console.log(`Cleaning up scratch directory: ${scratchDir}`);
			try {
				rmSync(scratchDir, { recursive: true, force: true });
			} catch (e) {
				console.warn("Failed to clean up scratch directory:", e.message);
			}
		}
	}
}

main();
