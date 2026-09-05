import { ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { readEvalLedgerSnapshot } from "../../src/domains/eval/metrics/tracked.js";
import { startGatewayThinkingFixture } from "../harness/gateway-thinking-fixture.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const CLI = new URL("../../dist/cli/index.js", import.meta.url).pathname;

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{ cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error && typeof error.code !== "number") reject(error);
				else resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
			},
		);
	});
}

test("built Clio preserves declared gateway thinking controls through startup and native persistence", {
	timeout: 40_000,
}, async () => {
	const home = makeScratchHome("clio-gateway-thinking-");
	const fixture = await startGatewayThinkingFixture();
	try {
		const workspace = join(home.dir, "repo");
		mkdirSync(workspace);
		mkdirSync(join(home.dir, "config"), { recursive: true });
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{
				id: "gateway",
				runtime: "litellm",
				url: fixture.url,
				defaultModel: fixture.modelId,
				auth: { apiKeyEnvVar: "GATEWAY_THINKING_FIXTURE_KEY" },
			},
		];
		settings.chat.target = "gateway";
		settings.chat.model = fixture.modelId;
		settings.chat.thinkingLevel = "off";
		settings.context.memory.enabled = false;
		writeFileSync(join(home.dir, "config", "settings.yaml"), JSON.stringify(settings));
		const env = { ...process.env, ...home.env, GATEWAY_THINKING_FIXTURE_KEY: "fixture" };
		const result = await run(
			[
				"--no-context-files",
				"--no-skills",
				"run",
				"--json",
				"--autonomy",
				"read-only",
				"What is 17 times 19? Reply only with the decimal answer.",
			],
			workspace,
			env,
		);
		strictEqual(result.code, 0, result.stderr);
		const calls = fixture.requests.filter((request) => request.stream !== false);
		strictEqual(calls.length, 1);
		strictEqual(calls[0]?.reasoning_effort, "none");
		ok(Array.isArray(calls[0]?.allowed_openai_params) && calls[0].allowed_openai_params.includes("reasoning_effort"));
		ok(
			!fixture.paths.some((path) => path.startsWith("/api/")),
			"a gateway must not gain native LM Studio residency operations",
		);
		const snapshot = await readEvalLedgerSnapshot(join(home.dir, "state"));
		const assistant = snapshot.entries.flatMap((entry) =>
			entry.kind === "message" && entry.role === "assistant" ? [entry.payload] : [],
		);
		strictEqual(assistant.length, 1);
		const payload = assistant[0] as { text?: string; thinking?: string; usage?: { reasoning?: number } };
		strictEqual(payload.text, "323");
		strictEqual(payload.thinking ?? "", "");
		strictEqual(payload.usage?.reasoning ?? 0, 0);
	} finally {
		await fixture.close();
		home.cleanup();
	}
});
