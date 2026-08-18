import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";

import { readSettings } from "../../src/core/config.js";
import { runPending } from "../../src/domains/lifecycle/migrations/index.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("contracts/lmstudio lifecycle migration", () => {
	let scratch: IsolatedClioEnv;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-lmstudio-migration-");
		mkdirSync(join(scratch.dir, "config"), { recursive: true });
		mkdirSync(join(scratch.dir, "state"), { recursive: true });
	});

	afterEach(() => scratch.restore());

	it("rewrites the runtime and URL while preserving explicit legacy credential references", async () => {
		writeFileSync(
			join(scratch.dir, "config", "settings.yaml"),
			`targets:
  - id: studio
    runtime: lmstudio-native
    url: ws://127.0.0.1:1234
    defaultModel: qwen3.8-27b-zbook
    wireModels: [qwen3.8-27b, qwen3.8-27b-zbook]
    auth:
      apiKeyRef: lmstudio-native
    lmstudio:
      request:
        ttlSeconds: 600
orchestrator:
  target: studio
  model: qwen3.8-27b-zbook
  thinkingLevel: medium
`,
			"utf8",
		);
		writeFileSync(
			join(scratch.dir, "config", "credentials.yaml"),
			`version: 2
entries:
  lmstudio-native:
    type: api_key
    key: secret
    updatedAt: 2026-08-18T00:00:00.000Z
`,
			{ encoding: "utf8", mode: 0o600 },
		);

		const first = await runPending(join(scratch.dir, "state"));
		deepStrictEqual(first.applied, ["2026-08-18-lmstudio-runtime-id"]);
		const settings = readSettings();
		strictEqual(settings.targets[0]?.runtime, "lmstudio");
		strictEqual(settings.targets[0]?.url, "http://127.0.0.1:1234");
		strictEqual(settings.targets[0]?.auth?.apiKeyRef, "lmstudio-native");
		strictEqual(settings.targets[0]?.defaultModel, "qwen3.8-27b-zbook");
		deepStrictEqual(settings.targets[0]?.wireModels, ["qwen3.8-27b", "qwen3.8-27b-zbook"]);
		strictEqual(settings.targets[0]?.lmstudio?.request?.ttlSeconds, 600);

		const credentials = parseYaml(readFileSync(join(scratch.dir, "config", "credentials.yaml"), "utf8")) as {
			entries: Record<string, { key: string }>;
		};
		strictEqual(credentials.entries.lmstudio?.key, "secret");
		strictEqual(credentials.entries["lmstudio-native"]?.key, "secret");
		strictEqual(statSync(join(scratch.dir, "config", "credentials.yaml")).mode & 0o777, 0o600);

		const settingsAfterFirst = readFileSync(join(scratch.dir, "config", "settings.yaml"), "utf8");
		const credentialsAfterFirst = readFileSync(join(scratch.dir, "config", "credentials.yaml"), "utf8");
		const second = await runPending(join(scratch.dir, "state"));
		deepStrictEqual(second.applied, []);
		strictEqual(readFileSync(join(scratch.dir, "config", "settings.yaml"), "utf8"), settingsAfterFirst);
		strictEqual(readFileSync(join(scratch.dir, "config", "credentials.yaml"), "utf8"), credentialsAfterFirst);
	});

	it("preserves an existing canonical credential and removes an unreferenced legacy duplicate", async () => {
		writeFileSync(
			join(scratch.dir, "config", "settings.yaml"),
			"targets:\n  - id: studio\n    runtime: lmstudio-native\n    url: wss://studio.example:1234\n",
			"utf8",
		);
		writeFileSync(
			join(scratch.dir, "config", "credentials.yaml"),
			`version: 2
entries:
  lmstudio-native: {type: api_key, key: old, updatedAt: 2026-08-18T00:00:00.000Z}
  lmstudio: {type: api_key, key: canonical, updatedAt: 2026-08-18T00:00:00.000Z}
`,
			{ encoding: "utf8", mode: 0o600 },
		);
		await runPending(join(scratch.dir, "state"));
		strictEqual(readSettings().targets[0]?.url, "https://studio.example:1234");
		const credentials = parseYaml(readFileSync(join(scratch.dir, "config", "credentials.yaml"), "utf8")) as {
			entries: Record<string, { key: string }>;
		};
		strictEqual(credentials.entries.lmstudio?.key, "canonical");
		strictEqual(credentials.entries["lmstudio-native"], undefined);
		ok(readFileSync(join(scratch.dir, "state", "migrations.json"), "utf8").includes("lmstudio-runtime-id"));
	});
});
