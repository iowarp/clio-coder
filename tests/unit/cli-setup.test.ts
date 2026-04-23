import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runSetupCommand } from "../../src/cli/setup.js";
import { readSettings } from "../../src/core/config.js";
import { resetXdgCache } from "../../src/core/xdg.js";

const ORIGINAL_ENV = { ...process.env };

describe("cli setup --runtime openai-codex", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-setup-"));
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

	it("persists an endpoint-first openai-codex configuration with known models", async () => {
		const code = await runSetupCommand([
			"--runtime",
			"openai-codex",
			"--id",
			"codex-pro",
			"--set-orchestrator",
			"--set-worker-default",
		]);
		strictEqual(code, 0);

		const settings = readSettings();
		const endpoint = settings.endpoints.find((entry) => entry.id === "codex-pro");
		ok(endpoint, "expected openai-codex endpoint");
		strictEqual(endpoint.runtime, "openai-codex");
		strictEqual(endpoint.auth?.oauthProfile, "openai-codex");
		strictEqual(endpoint.defaultModel, "gpt-5.4");
		ok(endpoint.wireModels?.includes("gpt-5.4"));
		ok(endpoint.wireModels?.includes("gpt-5.4-mini"));
		deepStrictEqual([settings.orchestrator.endpoint, settings.orchestrator.model], ["codex-pro", "gpt-5.4"]);
		deepStrictEqual([settings.workers.default.endpoint, settings.workers.default.model], ["codex-pro", "gpt-5.4"]);
	});
});
