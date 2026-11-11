import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { nextStepLines } from "../../src/cli/setup-next.js";
import { settingsPath, updateSettings } from "../../src/core/config.js";
import { initializeClioHome } from "../../src/core/init.js";
import { readClioVersion } from "../../src/core/package-root.js";
import { COPILOT_SDK_PACKAGE, COPILOT_SDK_VERSION } from "../../src/domains/lifecycle/copilot-sdk-install.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const noServers = { readJson: async () => Promise.reject(new Error("no loopback server in this test")) };

/** A Copilot SDK in the scratch home that reports no sign-in, so the machine's own Copilot login is not found. */
function signedOutCopilot(dir: string): void {
	const sdk = join(dir, "data", "components", "copilot-sdk", COPILOT_SDK_VERSION, "node_modules", COPILOT_SDK_PACKAGE);
	mkdirSync(sdk, { recursive: true });
	writeFileSync(join(sdk, "package.json"), JSON.stringify({ type: "module", main: "./index.js" }));
	writeFileSync(
		join(sdk, "index.js"),
		`import { EventEmitter } from "node:events";
export class CopilotClient {
	cliProcess = new EventEmitter();
	cliStartTimeout = null;
	state = "connected";
	async start() {}
	async getAuthStatus() { return { isAuthenticated: false }; }
}`,
	);
}

function clearProviderKeys(): void {
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	for (const runtime of registry.list()) if (runtime.credentialsEnvVar) delete process.env[runtime.credentialsEnvVar];
}

test("setup --next: nothing found, a key found, and a ready route; it writes nothing", async (t) => {
	const home = await isolateClioEnv("clio-setup-next-");
	t.after(() => home.restore());
	signedOutCopilot(home.dir);
	clearProviderKeys();
	const head = [`Clio Coder ${readClioVersion()} is installed.`, "Next:  cd <your project> && clio-coder"];

	assert.deepEqual(await nextStepLines(noServers), [...head, "       The first launch sets up a model."]);
	assert.equal(existsSync(settingsPath()), false, "setup --next must not create the home's settings");

	process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
	assert.deepEqual(await nextStepLines(noServers), [
		...head,
		"       The first launch sets up a model. Found: ANTHROPIC_API_KEY.",
	]);
	assert.equal(existsSync(settingsPath()), false);

	initializeClioHome();
	updateSettings((settings) => {
		settings.targets = [
			{ id: "claude", runtime: "anthropic", defaultModel: "claude-sonnet-5", auth: { apiKeyEnvVar: "ANTHROPIC_API_KEY" } },
		];
		settings.chat.target = "claude";
		settings.chat.model = "claude-sonnet-5";
	});
	assert.deepEqual(await nextStepLines(noServers), [...head, "       Chat uses claude / claude-sonnet-5."]);
});
