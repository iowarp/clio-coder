import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { buildDescriptor, DEFAULT_PORTS } from "../../src/cli/configure-target.js";
import { classifyDefaultTarget } from "../../src/cli/default-target.js";
import { detectChatRoutes, useDetectedChatRoute } from "../../src/cli/detect-chat-routes.js";
import { readSettings, settingsPath, updateSettings } from "../../src/core/config.js";
import { initializeClioHome } from "../../src/core/init.js";
import { openAuthStorage } from "../../src/domains/providers/auth/index.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("discovery orders settings, descriptor env keys, Clio logins, then bounded loopback models", async (t) => {
	const home = await isolateClioEnv("clio-route-detect-");
	t.after(() => home.restore());
	initializeClioHome();
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	for (const runtime of registry.list()) if (runtime.credentialsEnvVar) delete process.env[runtime.credentialsEnvVar];
	process.env.OPENAI_API_KEY = "fake-key";
	process.env.ANTHROPIC_API_KEY = "fake-key";
	openAuthStorage().setApiKey("openai", "fake-stored-key");
	openAuthStorage().set("openai-codex", {
		type: "oauth",
		access: "fake-access",
		refresh: "fake-refresh",
		expires: Date.now() + 60_000,
		updatedAt: new Date().toISOString(),
	});
	updateSettings((settings) => {
		settings.targets = [{ id: "mine", runtime: "openai", defaultModel: "gpt-6-luna" }];
	});
	const signals: AbortSignal[] = [];
	const routes = await detectChatRoutes(readSettings(), async (input, signal) => {
		const url = new URL(input);
		assert.equal(url.hostname, "127.0.0.1");
		assert.ok(Object.values(DEFAULT_PORTS).includes(Number(url.port)));
		signals.push(signal);
		if (url.port === "1234") return { data: [{ id: "first-served" }, { id: "second-served" }] };
		return new Promise<unknown>(() => {});
	});
	assert.deepEqual(
		routes.map((route) => route.source),
		[
			"settings (mine)",
			"ANTHROPIC_API_KEY",
			"OPENAI_API_KEY",
			"Clio stored API key (openai)",
			"Clio stored login (openai-codex)",
			"http://127.0.0.1:1234",
		],
	);
	assert.equal(routes.find((route) => route.runtime.id === "anthropic")?.model, undefined);
	assert.equal(routes.at(-1)?.model, "first-served");
	assert.equal(routes.find((route) => route.source === "OPENAI_API_KEY")?.model, "gpt-6-luna");
	assert.ok(signals.length > 1 && signals.every((signal) => signal.aborted));
});

test("a detected chat route saves configure's descriptor only when no chat choice is saved", async (t) => {
	const home = await isolateClioEnv("clio-route-preserve-");
	t.after(() => home.restore());
	initializeClioHome();
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	const runtime = registry.get("openai");
	assert.ok(runtime);
	const target = buildDescriptor(runtime, "openai", { model: "gpt-6-luna", apiKeyEnv: "OPENAI_API_KEY" });
	const route = { source: "OPENAI_API_KEY", runtime, target, model: "gpt-6-luna" };
	const first = useDetectedChatRoute(readSettings(), route);
	assert.equal(first.persisted, true);
	assert.deepEqual(readSettings().targets, [target]);
	assert.equal(readSettings().chat.model, route.model);
	delete process.env.ANTHROPIC_API_KEY;
	writeFileSync(
		settingsPath(),
		"version: 2\ntargets:\n  - { id: broken, runtime: anthropic, defaultModel: saved-model, auth: { apiKeyRef: missing } }\nchat: { target: broken, model: saved-model }\n",
	);
	assert.equal(classifyDefaultTarget(readSettings()).kind, "missing-credential");
	for (const dangling of [false, true]) {
		if (dangling) writeFileSync(settingsPath(), "version: 2\nchat: { target: deleted, model: saved-model }\n");
		const before = readFileSync(settingsPath(), "utf8");
		const fallback = useDetectedChatRoute(readSettings(), route);
		assert.equal(fallback.persisted, false);
		assert.equal(fallback.settings.chat.target, "openai");
		assert.equal(readFileSync(settingsPath(), "utf8"), before);
	}
});
