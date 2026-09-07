import { strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { explicitTargetMissing } from "../../src/cli/run.js";
import { settingsPath } from "../../src/core/config.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("explicit run target uses project layers and leaves malformed user settings to the strict boot gate", async () => {
	const scratch = await isolateClioEnv("clio-run-target-layers-");
	const originalCwd = process.cwd();
	try {
		const repo = join(scratch.dir, "repo");
		mkdirSync(join(repo, ".clio-coder"), { recursive: true });
		mkdirSync(join(scratch.dir, "config"), { recursive: true });
		writeFileSync(settingsPath(), "version: 2\n");
		process.chdir(repo);
		strictEqual(explicitTargetMissing("project-route"), true);
		writeFileSync(
			join(repo, ".clio-coder", "settings.local.yaml"),
			"version: 2\ntargets:\n  - id: project-route\n    runtime: openai-compat\n    url: http://127.0.0.1:1/v1\n    defaultModel: fixture\n",
		);
		strictEqual(explicitTargetMissing("project-route"), false);
		strictEqual(explicitTargetMissing("typo-route"), true);
		writeFileSync(settingsPath(), "version: [unterminated\n");
		strictEqual(explicitTargetMissing("typo-route"), false, "invalid settings must not become a misleading target error");
	} finally {
		process.chdir(originalCwd);
		scratch.restore();
	}
});
