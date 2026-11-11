import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { borrowHeadlessRoute } from "../../src/cli/run.js";
import { initializeClioHome } from "../../src/core/init.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
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
