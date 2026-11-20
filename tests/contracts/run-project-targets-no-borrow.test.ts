import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { borrowHeadlessRoute } from "../../src/cli/run.js";
import { settingsPath } from "../../src/core/config.js";
import { initializeClioHome } from "../../src/core/init.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import { runCli } from "../harness/headless-run.js";
import { closeServer, startOpenAICompatFixture } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("a project that defines targets borrows no route it did not choose", async (t) => {
	const home = await isolateClioEnv("clio-run-project-targets-");
	const cwd = process.cwd();
	t.after(() => {
		process.chdir(cwd);
		home.restore();
	});
	initializeClioHome();
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	for (const runtime of registry.list()) if (runtime.credentialsEnvVar) delete process.env[runtime.credentialsEnvVar];
	const keyed = registry.list().find((runtime) => runtime.credentialsEnvVar);
	assert.ok(keyed?.credentialsEnvVar);
	process.env[keyed.credentialsEnvVar] = "fake-key";
	const repo = join(home.dir, "repo");
	mkdirSync(join(repo, ".clio-coder"), { recursive: true });
	writeFileSync(
		join(repo, ".clio-coder", "settings.local.yaml"),
		"version: 2\ntargets:\n  - id: project-route\n    runtime: openai-compat\n    url: http://127.0.0.1:1/v1\n    defaultModel: fixture\n",
	);
	recordProjectSurfaceTrust(repo, "settings", captureProjectSurface(repo, "settings").contentHash as string);
	process.chdir(repo);
	assert.equal(await borrowHeadlessRoute(undefined, undefined), null);
});

test("headless run plans and preflights a trusted project's chat route, not the user one", async (t) => {
	const fixture = await startOpenAICompatFixture("ready");
	const home = await isolateClioEnv("clio-run-project-chat-route-");
	t.after(async () => {
		home.restore();
		await closeServer(fixture.server);
	});
	initializeClioHome();
	const targets = [
		"targets:",
		"  - { id: user-route, runtime: openai-compat, url: 'http://127.0.0.1:1/v1', defaultModel: user-model }",
		`  - { id: project-route, runtime: openai-compat, url: '${fixture.url}', defaultModel: mock-model, auth: { apiKeyEnvVar: CLIO_CODER_TEST_OPENAI_KEY } }`,
	].join("\n");
	writeFileSync(
		settingsPath(),
		`version: 2\n${targets}\nchat: { target: user-route, model: user-model, thinkingLevel: low }\n`,
	);
	const repo = join(home.dir, "repo");
	mkdirSync(join(repo, ".clio-coder"), { recursive: true });
	writeFileSync(
		join(repo, ".clio-coder", "settings.local.yaml"),
		"chat: { target: project-route, model: mock-model, thinkingLevel: high }\n",
	);
	recordProjectSurfaceTrust(repo, "settings", captureProjectSurface(repo, "settings").contentHash as string);
	const env = { ...process.env, NODE_ENV: "test", NO_COLOR: "1", CLIO_CODER_TEST_OPENAI_KEY: "fixture-key" };
	const cli = ["--no-context-files", "--no-skills", "run"];

	const preview = await runCli([...cli, "--dry-run", "x"], { env, cwd: repo });
	assert.equal(preview.code, 0, preview.stderr);
	assert.deepEqual(JSON.parse(preview.stdout).route, { target: "project-route", model: "mock-model", thinking: "high" });

	// Only the project names a chat route: the v2 not-configured preflight must see it too.
	writeFileSync(settingsPath(), `version: 2\n${targets}\n`);
	const run = await runCli([...cli, "--output-format", "json", "--no-delegate", "PROJECT_ROUTE_RUN"], {
		env,
		cwd: repo,
	});
	assert.equal(run.code, 0, run.stderr);
	assert.equal(JSON.parse(run.stdout).route?.target, "project-route");
});
