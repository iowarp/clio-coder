import { strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runConfigureCommand } from "../../src/cli/configure.js";
import { readSettings } from "../../src/core/config.js";
import { type FakeLmStudioFixture, startFakeLmStudioServer } from "../harness/fake-lmstudio-server.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("contracts/lmstudio configure", () => {
	let scratch: IsolatedClioEnv;
	let server: FakeLmStudioFixture;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-lmstudio-configure-");
		server = await startFakeLmStudioServer();
	});

	afterEach(async () => {
		await server.close();
		scratch.restore();
	});

	it("saves one canonical target after the greeting succeeds", async () => {
		const code = await runConfigureCommand([
			"--id",
			"studio",
			"--runtime",
			"lmstudio",
			"--url",
			server.url,
			"--model",
			"qwen3.8-27b-zbook",
			"--set-orchestrator",
		]);
		strictEqual(code, 0);
		const settings = readSettings();
		strictEqual(settings.targets.length, 1);
		strictEqual(settings.targets[0]?.runtime, "lmstudio");
		strictEqual(settings.targets[0]?.url, server.url);
		strictEqual(settings.chat.target, "studio");
	});

	it("normalizes the legacy runtime alias and persists the canonical id", async () => {
		const wsUrl = server.url.replace(/^http:/u, "ws:");
		const code = await runConfigureCommand([
			"--id",
			"studio",
			"--runtime",
			"lmstudio-native",
			"--url",
			wsUrl,
			"--model",
			"qwen3.8-27b-zbook",
		]);
		strictEqual(code, 0);
		strictEqual(readSettings().targets[0]?.runtime, "lmstudio");
		strictEqual(readSettings().targets[0]?.url, server.url);
	});

	it("refuses a URL that does not return the LM Studio greeting", async () => {
		await server.close();
		server = await startFakeLmStudioServer({ greeting: false });
		const code = await runConfigureCommand([
			"--id",
			"not-studio",
			"--runtime",
			"lmstudio",
			"--url",
			server.url,
			"--model",
			"qwen3.8-27b",
		]);
		strictEqual(code, 2);
		strictEqual(readSettings().targets.length, 0);
	});
});
