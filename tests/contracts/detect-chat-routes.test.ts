import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildDescriptor, DEFAULT_PORTS } from "../../src/cli/configure-target.js";
import { classifyDefaultTarget } from "../../src/cli/default-target.js";
import {
	collectSetupCandidates,
	detectChatRoutes,
	headlessChatRoute,
	readLoopbackJson,
	useDetectedChatRoute,
} from "../../src/cli/detect-chat-routes.js";
import { readSettings, settingsPath, updateSettings } from "../../src/core/config.js";
import { initializeClioHome } from "../../src/core/init.js";
import { COPILOT_SDK_PACKAGE, COPILOT_SDK_VERSION } from "../../src/domains/lifecycle/copilot-sdk-install.js";
import { openAuthStorage } from "../../src/domains/providers/auth/index.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("discovery orders settings, descriptor env keys, Clio logins, then bounded loopback models", async (t) => {
	const home = await isolateClioEnv("clio-route-detect-");
	t.after(() => home.restore());
	const sdk = join(
		home.dir,
		"data",
		"components",
		"copilot-sdk",
		COPILOT_SDK_VERSION,
		"node_modules",
		COPILOT_SDK_PACKAGE,
	);
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
	const readJson = async (input: string, signal: AbortSignal) => {
		const url = new URL(input);
		assert.equal(url.hostname, "127.0.0.1");
		assert.ok(Object.values(DEFAULT_PORTS).includes(Number(url.port)));
		signals.push(signal);
		if (url.port === "1234") return { data: [{ id: "first-served" }, { id: "second-served" }] };
		return new Promise<unknown>(() => {});
	};
	const routes = await detectChatRoutes(readSettings(), readJson);
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
	assert.equal(routes.find((route) => route.runtime.id === "anthropic")?.model, "claude-sonnet-5-5");
	assert.equal(routes.at(-1)?.model, "first-served");
	assert.equal(routes.find((route) => route.source === "OPENAI_API_KEY")?.model, "gpt-6-luna");
	assert.ok(signals.length > 1 && signals.every((signal) => signal.aborted));
	// One entry per endpoint, best source first: the configured target absorbs the OpenAI key and stored key.
	const candidates = await collectSetupCandidates(readSettings(), { readJson });
	assert.deepEqual(
		candidates.map((candidate) => [candidate.source, candidate.label]),
		[
			["configured-target", "settings (mine)"],
			["stored-login", "Clio stored login (openai-codex)"],
			["env-key", "ANTHROPIC_API_KEY"],
			["local-server", "http://127.0.0.1:1234"],
		],
	);
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

test("headless borrowing counts model-less keys and takes --model for the only one", async (t) => {
	const home = await isolateClioEnv("clio-route-headless-");
	t.after(() => home.restore());
	initializeClioHome();
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	for (const runtime of registry.list()) if (runtime.credentialsEnvVar) delete process.env[runtime.credentialsEnvVar];
	// Every built-in key provider has a curated model, so the model-less one is a copy of anthropic without one.
	const anthropic = registry.get("anthropic");
	assert.ok(anthropic);
	registry.register({ ...anthropic, id: "modelless", displayName: "Modelless", credentialsEnvVar: "MODELLESS_API_KEY" });
	t.after(() => {
		registry.clear();
		registerBuiltinRuntimes(registry);
	});
	const before = readFileSync(settingsPath(), "utf8");
	process.env.OPENAI_API_KEY = "fake-key";
	process.env.MODELLESS_API_KEY = "fake-key";
	t.after(() => {
		delete process.env.MODELLESS_API_KEY;
	});
	const several = await headlessChatRoute(readSettings());
	assert.equal(several.kind, "several");
	assert.deepEqual(several.kind === "several" ? several.routes.map((route) => route.target.id).sort() : [], [
		"modelless",
		"openai",
	]);
	const picked = await headlessChatRoute(readSettings(), "openai");
	assert.equal(picked.kind === "one" ? picked.route.model : picked.kind, "gpt-6-luna");
	delete process.env.OPENAI_API_KEY;
	assert.equal((await headlessChatRoute(readSettings())).kind, "needs-model");
	const withModel = await headlessChatRoute(readSettings(), undefined, { model: "claude-haiku-5-5" });
	assert.equal(withModel.kind === "one" ? withModel.settings.chat.model : withModel.kind, "claude-haiku-5-5");
	assert.equal(readFileSync(settingsPath(), "utf8"), before);
});

test("a local server's first chat model is adopted, never an embedding model listed before it", async (t) => {
	const home = await isolateClioEnv("clio-route-embed-");
	t.after(() => home.restore());
	initializeClioHome();
	const readJson = async (input: string) => {
		const url = new URL(input);
		if (url.pathname === "/api/tags") return { models: [{ name: "nomic-embed-text:latest" }, { name: "qwen3:8b" }] };
		throw new Error("absent");
	};
	const routes = await detectChatRoutes(readSettings(), readJson);
	assert.equal(routes.find((route) => route.runtime.id === "ollama")?.model, "qwen3:8b");
});

test("a probed listener's model id with terminal control or format characters is never offered, nor an oversized answer", async (t) => {
	const home = await isolateClioEnv("clio-route-control-");
	t.after(() => home.restore());
	initializeClioHome();
	const readJson = async (input: string) => {
		const url = new URL(input);
		if (url.port === String(DEFAULT_PORTS.lmstudio))
			return { data: [{ id: "qwen\x1b[8m hidden" }, { id: "evil\u202egnp" }, { id: "zero\u200bwidth" }] };
		if (url.port === String(DEFAULT_PORTS.vllm)) return { data: [{ id: "bad\x9bname" }, { id: "org/Qwen 3:8b@q4.é" }] };
		throw new Error("absent");
	};
	const routes = await detectChatRoutes(readSettings(), readJson);
	assert.equal(
		routes.some((route) => route.source === `http://127.0.0.1:${DEFAULT_PORTS.lmstudio}`),
		false,
	);
	assert.equal(
		routes.find((route) => route.source === `http://127.0.0.1:${DEFAULT_PORTS.vllm}`)?.model,
		"org/Qwen 3:8b@q4.é",
	);

	const { createServer } = await import("node:http");
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(`{"data":[{"id":"m"}],"pad":"${"x".repeat(2 * 1024 * 1024)}"}`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const { port } = server.address() as { port: number };
	await assert.rejects(readLoopbackJson(`http://127.0.0.1:${port}/v1/models`, new AbortController().signal));
});

test("headless borrowing never takes a saved copilot target, whatever memory points at", async (t) => {
	const home = await isolateClioEnv("clio-route-headless-copilot-");
	t.after(() => home.restore());
	initializeClioHome();
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	for (const runtime of registry.list()) if (runtime.credentialsEnvVar) delete process.env[runtime.credentialsEnvVar];
	process.env.ROUTEFIX_LITELLM_KEY = "fake-key";
	t.after(() => {
		delete process.env.ROUTEFIX_LITELLM_KEY;
	});
	for (const memory of ["copilot", "litellm", "none"]) {
		writeFileSync(
			settingsPath(),
			`version: 2\ntargets:\n  - { id: copilot, runtime: copilot-sdk, defaultModel: claude-opus-5.5 }\n  - { id: litellm, runtime: litellm, url: "http://127.0.0.1:9", defaultModel: m1, auth: { apiKeyEnvVar: ROUTEFIX_LITELLM_KEY } }\ncontext:\n  memory: { target: ${memory}, model: m1 }\n`,
		);
		const found = await headlessChatRoute(readSettings(), undefined, { model: "dynamo/x" });
		const ids =
			found.kind === "one"
				? [found.route.target.id]
				: found.kind === "several"
					? found.routes.map((r) => r.target.id)
					: [];
		assert.ok(!ids.includes("copilot"), `memory ${memory}: ${found.kind} ${ids.join(",")}`);
		if (memory !== "litellm") assert.equal(found.kind === "one" ? found.route.target.id : found.kind, "litellm");
	}
});

test("headless borrowing names the memory target when it was the only usable one", async (t) => {
	const home = await isolateClioEnv("clio-route-headless-memory-");
	t.after(() => home.restore());
	initializeClioHome();
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	for (const runtime of registry.list()) if (runtime.credentialsEnvVar) delete process.env[runtime.credentialsEnvVar];
	process.env.ROUTEFIX_LITELLM_KEY = "fake-key";
	t.after(() => {
		delete process.env.ROUTEFIX_LITELLM_KEY;
	});
	writeFileSync(
		settingsPath(),
		'version: 2\ntargets:\n  - { id: litellm, runtime: litellm, url: "http://127.0.0.1:9", defaultModel: m1, auth: { apiKeyEnvVar: ROUTEFIX_LITELLM_KEY } }\ncontext:\n  memory: { target: litellm, model: m1 }\n',
	);
	assert.deepEqual(await headlessChatRoute(readSettings()), { kind: "none", reservedForMemory: "litellm" });
});
