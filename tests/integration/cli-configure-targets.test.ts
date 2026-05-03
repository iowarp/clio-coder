import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runConfigureCommand } from "../../src/cli/configure.js";
import { runTargetsCommand } from "../../src/cli/targets.js";
import { readSettings, settingsPath } from "../../src/core/config.js";
import { resetXdgCache } from "../../src/core/xdg.js";

const ORIGINAL_ENV = { ...process.env };

async function captureOutput<T>(fn: () => Promise<T> | T): Promise<{ result: T; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const realStdout = process.stdout.write.bind(process.stdout);
	const realStderr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		const result = await fn();
		return { result, stdout, stderr };
	} finally {
		process.stdout.write = realStdout;
		process.stderr.write = realStderr;
	}
}

describe("cli configure and targets", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-configure-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, key);
		}
		for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
			if (value !== undefined) process.env[key] = value;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("persists an openai-codex target with known models", async () => {
		const code = await runConfigureCommand([
			"--runtime",
			"openai-codex",
			"--id",
			"codex-pro",
			"--model",
			"gpt-5.4",
			"--set-orchestrator",
			"--set-worker-default",
			"--worker-model",
			"gpt-5.4-mini",
		]);
		strictEqual(code, 0);

		const settings = readSettings();
		const target = settings.endpoints.find((entry) => entry.id === "codex-pro");
		ok(target, "expected openai-codex target");
		strictEqual(target.runtime, "openai-codex");
		strictEqual(target.auth?.oauthProfile, "openai-codex");
		strictEqual(target.defaultModel, "gpt-5.4");
		ok(target.wireModels?.includes("gpt-5.4"));
		ok(target.wireModels?.includes("gpt-5.4-mini"));
		deepStrictEqual([settings.orchestrator.endpoint, settings.orchestrator.model], ["codex-pro", "gpt-5.4"]);
		deepStrictEqual([settings.workers.default.endpoint, settings.workers.default.model], ["codex-pro", "gpt-5.4-mini"]);

		const raw = readFileSync(settingsPath(), "utf8");
		ok(raw.includes("targets:"));
		ok(raw.includes("target: codex-pro"));
		ok(!raw.includes("endpoints:"));
		ok(!raw.includes("endpoint: codex-pro"));
	});

	it("persists context and output caps for local self-dev targets", async () => {
		const code = await runTargetsCommand([
			"add",
			"--runtime",
			"openai-compat",
			"--id",
			"mini",
			"--url",
			"http://mini:8080",
			"--model",
			"Qwen3.6-35B-A3B-UD-Q4_K_XL",
			"--context-window",
			"262144",
			"--max-tokens",
			"65536",
			"--reasoning",
			"true",
			"--lifecycle",
			"clio-managed",
		]);
		strictEqual(code, 0);

		const settings = readSettings();
		const target = settings.endpoints.find((entry) => entry.id === "mini");
		ok(target, "expected mini target");
		strictEqual(target.runtime, "openai-compat");
		strictEqual(target.url, "http://mini:8080");
		strictEqual(target.defaultModel, "Qwen3.6-35B-A3B-UD-Q4_K_XL");
		strictEqual(target.capabilities?.contextWindow, 262144);
		strictEqual(target.capabilities?.maxTokens, 65536);
		strictEqual(target.capabilities?.reasoning, true);
		strictEqual(target.lifecycle, "clio-managed");
	});

	it("targets use sets chat and worker defaults", async () => {
		await runConfigureCommand(["--runtime", "openai-codex", "--id", "codex-pro", "--model", "gpt-5.4"]);
		const code = await runTargetsCommand(["use", "codex-pro", "--worker-model", "gpt-5.4-mini"]);
		strictEqual(code, 0);
		const settings = readSettings();
		deepStrictEqual([settings.orchestrator.endpoint, settings.orchestrator.model], ["codex-pro", "gpt-5.4"]);
		deepStrictEqual([settings.workers.default.endpoint, settings.workers.default.model], ["codex-pro", "gpt-5.4-mini"]);
	});

	it("targets worker sets a named worker profile", async () => {
		await runConfigureCommand(["--runtime", "openai-codex", "--id", "codex-pro", "--model", "gpt-5.4"]);
		const code = await runTargetsCommand([
			"worker",
			"codex-mini",
			"codex-pro",
			"--model",
			"gpt-5.4-mini",
			"--thinking",
			"low",
		]);
		strictEqual(code, 0);
		const settings = readSettings();
		deepStrictEqual(settings.workers.profiles["codex-mini"], {
			endpoint: "codex-pro",
			model: "gpt-5.4-mini",
			thinkingLevel: "low",
		});
	});

	it("configures the interactive multi-worker profile pool", async () => {
		strictEqual(
			await runConfigureCommand([
				"--runtime",
				"openai-codex",
				"--id",
				"codex-pro",
				"--model",
				"gpt-5.4",
				"--set-orchestrator",
				"--set-worker-default",
				"--worker-profile",
				"codex-mini",
				"--worker-profile-model",
				"gpt-5.4-mini",
			]),
			0,
		);
		strictEqual(
			await runConfigureCommand([
				"--runtime",
				"claude-code-sdk",
				"--id",
				"claude-sdk-opus",
				"--model",
				"claude-opus-4-7",
				"--worker-profile",
				"claude-opus",
			]),
			0,
		);
		strictEqual(
			await runConfigureCommand([
				"--runtime",
				"copilot-cli",
				"--id",
				"copilot-sonnet",
				"--model",
				"claude-sonnet-4.6",
				"--worker-profile",
				"copilot-sonnet",
			]),
			0,
		);
		strictEqual(
			await runConfigureCommand([
				"--runtime",
				"gemini-cli",
				"--id",
				"gemini-flash",
				"--model",
				"gemini-3-flash-preview",
				"--worker-profile",
				"gemini-flash",
			]),
			0,
		);

		const settings = readSettings();
		deepStrictEqual([settings.orchestrator.endpoint, settings.orchestrator.model], ["codex-pro", "gpt-5.4"]);
		deepStrictEqual([settings.workers.default.endpoint, settings.workers.default.model], ["codex-pro", "gpt-5.4"]);
		deepStrictEqual(settings.workers.profiles["codex-mini"], {
			endpoint: "codex-pro",
			model: "gpt-5.4-mini",
			thinkingLevel: "off",
		});
		deepStrictEqual(settings.workers.profiles["claude-opus"], {
			endpoint: "claude-sdk-opus",
			model: "claude-opus-4-7",
			thinkingLevel: "off",
		});
		deepStrictEqual(settings.workers.profiles["copilot-sonnet"], {
			endpoint: "copilot-sonnet",
			model: "claude-sonnet-4.6",
			thinkingLevel: "off",
		});
		deepStrictEqual(settings.workers.profiles["gemini-flash"], {
			endpoint: "gemini-flash",
			model: "gemini-3-flash-preview",
			thinkingLevel: "off",
		});

		const out = await captureOutput(() => runTargetsCommand(["workers", "--json"]));
		strictEqual(out.result, 0);
		const rows = JSON.parse(out.stdout) as Array<{ name: string; target: string; model: string }>;
		deepStrictEqual(
			rows.map((row) => [row.name, row.target, row.model]),
			[
				["codex-mini", "codex-pro", "gpt-5.4-mini"],
				["claude-opus", "claude-sdk-opus", "claude-opus-4-7"],
				["copilot-sonnet", "copilot-sonnet", "claude-sonnet-4.6"],
				["gemini-flash", "gemini-flash", "gemini-3-flash-preview"],
			],
		);
	});

	it("keeps the selected OpenRouter model as the worker default", async () => {
		const model = "nvidia/nemotron-3-super-120b-a12b:free";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ data: [{ id: model }] }), { status: 200 })) as typeof fetch;
		try {
			const code = await runConfigureCommand([
				"--runtime",
				"openrouter",
				"--id",
				"openrouter-live",
				"--model",
				model,
				"--api-key-env",
				"OPENROUTER_API_KEY",
				"--set-orchestrator",
				"--set-worker-default",
			]);
			strictEqual(code, 0);
		} finally {
			globalThis.fetch = originalFetch;
		}

		const settings = readSettings();
		const target = settings.endpoints.find((entry) => entry.id === "openrouter-live");
		ok(target, "expected openrouter target");
		strictEqual(target.defaultModel, model);
		deepStrictEqual([settings.orchestrator.endpoint, settings.orchestrator.model], ["openrouter-live", model]);
		deepStrictEqual([settings.workers.default.endpoint, settings.workers.default.model], ["openrouter-live", model]);
	});

	it("CLI-backed targets do not get Clio-managed auth profiles", async () => {
		const code = await runConfigureCommand([
			"--runtime",
			"claude-code-cli",
			"--id",
			"claude-worker",
			"--model",
			"sonnet",
			"--set-worker-default",
		]);
		strictEqual(code, 0);

		const settings = readSettings();
		const target = settings.endpoints.find((entry) => entry.id === "claude-worker");
		ok(target, "expected claude-worker target");
		strictEqual(target.runtime, "claude-code-cli");
		strictEqual(target.auth, undefined);
		deepStrictEqual([settings.workers.default.endpoint, settings.workers.default.model], ["claude-worker", "sonnet"]);
	});

	it("configure --list shows SDK and CLI runtimes with native CLI auth", async () => {
		const out = await captureOutput(() => runConfigureCommand(["--list"]));
		strictEqual(out.result, 0);
		ok(out.stdout.includes("claude-code-sdk"));
		ok(out.stdout.includes("claude-code-cli"));
		ok(out.stdout.includes("copilot-cli"));
		for (const line of out.stdout.split(/\r?\n/)) {
			if (line.includes("claude-code-sdk") || line.includes("claude-code-cli") || line.includes("copilot-cli")) {
				ok(line.includes(" cli "), `expected native cli auth label in line: ${line}`);
			}
		}
	});

	it("persists a Claude SDK target without Clio-managed credentials", async () => {
		const code = await runConfigureCommand([
			"--runtime",
			"claude-code-sdk",
			"--id",
			"claude-sdk",
			"--model",
			"claude-sonnet-4-6",
			"--set-worker-default",
			"--worker-model",
			"claude-opus-4-7",
		]);
		strictEqual(code, 0);

		const settings = readSettings();
		const target = settings.endpoints.find((entry) => entry.id === "claude-sdk");
		ok(target, "expected claude-sdk target");
		strictEqual(target.runtime, "claude-code-sdk");
		strictEqual(target.auth, undefined);
		ok(target.wireModels?.includes("claude-opus-4-7"));
		deepStrictEqual(
			[settings.workers.default.endpoint, settings.workers.default.model],
			["claude-sdk", "claude-opus-4-7"],
		);
	});
});
