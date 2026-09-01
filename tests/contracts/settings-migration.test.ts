import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { parse as parseYaml } from "yaml";

import { readSettings, updateSettings, validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import namingMigration, {
	CLIO_CODER_NAMING_MIGRATION_ID,
	CLIO_CODER_NAMING_SETTINGS_BACKUP_SUFFIX,
} from "../../src/domains/lifecycle/migrations/2026-09-01-clio-coder-naming.js";
import settingsV2, {
	SETTINGS_V2_MIGRATION_ID,
	SettingsV2CollisionError,
} from "../../src/domains/lifecycle/migrations/2026-09-01-settings-v2.js";
import { listMigrations, runPending } from "../../src/domains/lifecycle/migrations/index.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("settings and migration boundary", () => {
	let scratch: IsolatedClioEnv;
	let settingsFile: string;
	let stateDir: string;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-settings-contract-");
		settingsFile = join(scratch.dir, "config", "settings.yaml");
		stateDir = join(scratch.dir, "state");
		mkdirSync(join(scratch.dir, "config"), { recursive: true });
		mkdirSync(stateDir, { recursive: true });
	});

	afterEach(() => scratch.restore());

	it("ships a strict current settings document", () => {
		const defaults = validateSettings(parseYaml(DEFAULT_SETTINGS_YAML));
		deepStrictEqual(defaults.issues, []);
		deepStrictEqual(defaults.settings, DEFAULT_SETTINGS);
		strictEqual(defaults.settings.version, 2);

		const invalid = validateSettings({ version: 2, orchestrator: { target: "legacy" }, mystery: true });
		ok(invalid.issues.some((issue) => issue.path === "orchestrator.target"));
		ok(invalid.issues.some((issue) => issue.path === "mystery"));
		strictEqual(invalid.settings.chat.target, null, "retired paths never execute as aliases");
	});

	it("migrates v1 atomically, keeps the original backup, and is idempotent", async () => {
		const original = `version: 1
orchestrator: { target: local, model: qwen }
workers:
  default: { target: local, model: worker-model, thinkingLevel: high }
targets:
  - { id: local, runtime: lmstudio, url: http://127.0.0.1:1234 }
`;
		writeFileSync(settingsFile, original, "utf8");

		await settingsV2.up(stateDir);
		strictEqual(readFileSync(`${settingsFile}.v1.bak`, "utf8"), original);
		const migrated = parseYaml(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
		strictEqual(migrated.version, 2);
		deepStrictEqual(migrated.chat, { target: "local", model: "qwen" });
		deepStrictEqual((migrated.fleet as { default: unknown }).default, {
			target: "local",
			model: "worker-model",
			thinkingLevel: "high",
		});
		const firstWrite = readFileSync(settingsFile, "utf8");
		await settingsV2.up(stateDir);
		strictEqual(readFileSync(settingsFile, "utf8"), firstWrite);
		strictEqual(readFileSync(`${settingsFile}.v1.bak`, "utf8"), original);
	});

	it("refuses a v1/v2 collision without replacing or backing up the file", async () => {
		const mixed = "version: 1\norchestrator: { target: old }\nchat: { target: new }\n";
		writeFileSync(settingsFile, mixed, "utf8");
		await rejects(settingsV2.up(stateDir), (error: unknown) => error instanceof SettingsV2CollisionError);
		strictEqual(readFileSync(settingsFile, "utf8"), mixed);
		strictEqual(existsSync(`${settingsFile}.v1.bak`), false);
	});

	it("migrates released naming aliases once, keeps canonical collisions, and records a backup", async () => {
		const original = `version: 2
targets:
  - { id: local, runtime: lmstudio, lifecycle: clio-managed }
interface:
  keybindings:
    clio.exit: ctrl+x
    clio.status.toggle: alt+u
    clio-coder.status.toggle: alt+s
integrations:
  externalAgents:
    defaults: { toolGovernance: clio-policy }
`;
		writeFileSync(settingsFile, original, "utf8");

		await namingMigration.up(stateDir);
		strictEqual(readFileSync(`${settingsFile}${CLIO_CODER_NAMING_SETTINGS_BACKUP_SUFFIX}`, "utf8"), original);
		const migrated = parseYaml(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
		strictEqual((migrated.targets as Array<{ lifecycle: string }>)[0]?.lifecycle, "clio-coder-managed");
		const keybindings = (migrated.interface as { keybindings: Record<string, string> }).keybindings;
		deepStrictEqual(keybindings, {
			"clio-coder.exit": "ctrl+x",
			"clio-coder.status.toggle": "alt+s",
		});
		strictEqual(
			(migrated.integrations as { externalAgents: { defaults: { toolGovernance: string } } }).externalAgents.defaults
				.toolGovernance,
			"clio-coder-policy",
		);

		const firstWrite = readFileSync(settingsFile, "utf8");
		await namingMigration.up(stateDir);
		strictEqual(readFileSync(settingsFile, "utf8"), firstWrite);
		strictEqual(readFileSync(`${settingsFile}${CLIO_CODER_NAMING_SETTINGS_BACKUP_SUFFIX}`, "utf8"), original);
	});

	it("normalizes legacy naming aliases at read time during the compatibility window", () => {
		const result = validateSettings({
			version: 2,
			targets: [{ id: "local", runtime: "lmstudio", lifecycle: "clio-managed" }],
			interface: {
				keybindings: {
					"clio.exit": "ctrl+x",
					"clio-coder.exit": "ctrl+d",
				},
			},
			integrations: { externalAgents: { defaults: { toolGovernance: "clio-policy" } } },
		});
		deepStrictEqual(result.issues, []);
		strictEqual(result.settings.targets[0]?.lifecycle, "clio-coder-managed");
		deepStrictEqual(result.settings.interface.keybindings, { "clio-coder.exit": "ctrl+d" });
		strictEqual(result.settings.integrations.externalAgents.defaults.toolGovernance, "clio-coder-policy");
	});

	it("orders migrations before strict readers and records each migration once", async () => {
		const ids = listMigrations().map((migration) => migration.id);
		const retiredPanes = "2026-09-01-retire-panes-knobs";
		const lmstudio = "2026-08-18-lmstudio-runtime-id";
		ok(ids.indexOf(SETTINGS_V2_MIGRATION_ID) < ids.indexOf(retiredPanes));
		ok(ids.indexOf(SETTINGS_V2_MIGRATION_ID) < ids.indexOf(CLIO_CODER_NAMING_MIGRATION_ID));
		ok(ids.indexOf(CLIO_CODER_NAMING_MIGRATION_ID) < ids.indexOf(retiredPanes));
		ok(ids.indexOf(retiredPanes) < ids.indexOf(lmstudio));

		writeFileSync(settingsFile, "version: 1\npanes: { agents: off, keepFailed: false }\n", "utf8");
		const first = await runPending(stateDir);
		ok(first.applied.includes(SETTINGS_V2_MIGRATION_ID));
		ok(first.applied.includes(retiredPanes));
		deepStrictEqual((await runPending(stateDir)).applied, []);
	});

	it("merges independent settings updates against the latest durable state", () => {
		writeFileSync(settingsFile, "version: 2\n", "utf8");
		updateSettings((settings) => {
			settings.chat.retry.maxRetries = 9;
		});
		updateSettings((settings) => {
			settings.safety.limits.sessionCostUsd = 7;
		});
		const saved = readSettings();
		strictEqual(saved.chat.retry.maxRetries, 9);
		strictEqual(saved.safety.limits.sessionCostUsd, 7);
	});
});
