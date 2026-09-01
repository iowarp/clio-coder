import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { parse as parseYaml } from "yaml";
import { namingFootprintFindings } from "../../src/cli/doctor-naming.js";
import { runResetCommand } from "../../src/cli/reset.js";
import { readSettings, updateSettings, validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import { namingCompatibilityEnvironment, readNamingEnvironment } from "../../src/core/naming-compat.js";
import namingMigration, {
	CLIO_CODER_NAMING_MIGRATION_ID,
	CLIO_CODER_NAMING_SETTINGS_BACKUP_SUFFIX,
} from "../../src/domains/lifecycle/migrations/2026-09-01-clio-coder-naming.js";
import settingsV2, {
	SETTINGS_V2_MIGRATION_ID,
	SettingsV2CollisionError,
} from "../../src/domains/lifecycle/migrations/2026-09-01-settings-v2.js";
import { listMigrations, runPending } from "../../src/domains/lifecycle/migrations/index.js";
import {
	MUTABLE_NAMING_BACKUP_SUFFIX,
	migrateMutableNamingState,
} from "../../src/domains/lifecycle/naming-mutable-state.js";
import {
	CANONICAL_TOOL_MARKER,
	inspectToolMarkerNaming,
	LEGACY_TOOL_MARKER,
} from "../../src/domains/lifecycle/naming-tool-markers.js";
import { regenerateYaziNamingProfile } from "../../src/domains/lifecycle/naming-yazi.js";
import { parseYaziEventLine, renderYaziKeymap } from "../../src/domains/mux/index.js";
import { createShareArchive, planShareImport } from "../../src/domains/share/archive.js";
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

	it("prefers canonical environment names and bridges child launches during the compatibility window", () => {
		strictEqual(
			readNamingEnvironment(
				{ CLIO_CODER_YAZI_PICK_TOKEN: "canonical", CLIO_YAZI_PICK_TOKEN: "legacy" },
				"CLIO_CODER_YAZI_PICK_TOKEN",
				"CLIO_YAZI_PICK_TOKEN",
			),
			"canonical",
		);
		strictEqual(
			readNamingEnvironment({ CLIO_YAZI_PICK_TOKEN: "legacy" }, "CLIO_CODER_YAZI_PICK_TOKEN", "CLIO_YAZI_PICK_TOKEN"),
			"legacy",
		);
		deepStrictEqual(namingCompatibilityEnvironment("CLIO_CODER_YAZI_PICK_TOKEN", "CLIO_YAZI_PICK_TOKEN", "token"), {
			CLIO_CODER_YAZI_PICK_TOKEN: "token",
			CLIO_YAZI_PICK_TOKEN: "token",
		});
	});

	it("emits canonical Yazi names, accepts both event spellings, and normalizes legacy events", () => {
		const keymap = renderYaziKeymap("/opt/yazi/ya");
		ok(keymap.includes("clio-coder-pick"));
		ok(keymap.includes("CLIO_CODER_YAZI_PICK_TOKEN"));
		strictEqual(keymap.includes(" clio-pick "), false);
		strictEqual(keymap.includes("$CLIO_YAZI_PICK_TOKEN"), false);

		deepStrictEqual(parseYaziEventLine('clio-coder-pick,receiver,sender,["a"]'), {
			kind: "clio-coder-pick",
			receiver: "receiver",
			sender: "sender",
			values: ["a"],
		});
		deepStrictEqual(parseYaziEventLine('clio-pick,receiver,sender,["legacy"]'), {
			kind: "clio-coder-pick",
			receiver: "receiver",
			sender: "sender",
			values: ["legacy"],
		});
	});

	it("reports legacy cached Yazi names read-only and deterministically resets both spellings", () => {
		const profileDir = join(scratch.dir, "cache", "yazi", "profile");
		mkdirSync(profileDir, { recursive: true });
		const legacy = 'run = "clio-pick $CLIO_YAZI_PICK_TOKEN clio-coder-pick $CLIO_CODER_YAZI_PICK_TOKEN"\n';
		writeFileSync(join(profileDir, "keymap.toml"), legacy, "utf8");

		const finding = namingFootprintFindings({ cwd: scratch.dir }).find((entry) => entry.name === "naming yazi profile");
		strictEqual(finding?.level, "warn");
		strictEqual(readFileSync(join(profileDir, "keymap.toml"), "utf8"), legacy, "doctor inspection is read-only");

		const first = regenerateYaziNamingProfile({ cacheDir: join(scratch.dir, "cache"), yaziPath: null, yaPath: null });
		strictEqual(first.status, "removed-unresolved");
		strictEqual(existsSync(profileDir), false);
		strictEqual(
			regenerateYaziNamingProfile({ cacheDir: join(scratch.dir, "cache"), yaziPath: null, yaPath: null }).status,
			"absent",
		);
	});

	it("validates and migrates tool markers while preserving conflicting facts", () => {
		const versionDir = join(scratch.dir, "data", "tools", "yazi", "1.0.0");
		mkdirSync(versionDir, { recursive: true });
		const marker = { id: "yazi", version: "1.0.0", sha256: "a".repeat(64) };
		writeFileSync(join(versionDir, LEGACY_TOOL_MARKER), `${JSON.stringify(marker)}\n`, "utf8");

		strictEqual(inspectToolMarkerNaming({ dataDir: join(scratch.dir, "data") })[0]?.status, "renamable");
		strictEqual(existsSync(join(versionDir, LEGACY_TOOL_MARKER)), true, "inspection is read-only");
		const doctor = namingFootprintFindings({ cwd: scratch.dir, fix: true }).find(
			(entry) => entry.name === "naming tool markers",
		);
		strictEqual(doctor?.level, "ok");
		strictEqual(existsSync(join(versionDir, LEGACY_TOOL_MARKER)), false);
		strictEqual(existsSync(join(versionDir, CANONICAL_TOOL_MARKER)), true);

		writeFileSync(
			join(versionDir, LEGACY_TOOL_MARKER),
			`${JSON.stringify({ ...marker, sha256: "b".repeat(64) })}\n`,
			"utf8",
		);
		strictEqual(
			inspectToolMarkerNaming({ dataDir: join(scratch.dir, "data"), fix: true })[0]?.status,
			"canonical-conflict",
		);
		strictEqual(existsSync(join(versionDir, LEGACY_TOOL_MARKER)), true, "disagreeing legacy facts are retained");
	});

	it("rewrites only allowlisted mutable state fields with deterministic per-file counts", () => {
		const state = join(scratch.dir, "state");
		const mutablePath = join(state, "interop.json");
		const sealedPath = join(state, "receipts", "sealed.json");
		mkdirSync(join(state, "receipts"), { recursive: true });
		const mutable = {
			version: 1,
			nested: {
				lifecycle: "clio-managed",
				toolGovernance: "clio-policy",
				source: "clio",
				message: "clio-policy",
			},
		};
		const sealed = JSON.stringify(mutable);
		writeFileSync(mutablePath, `${JSON.stringify(mutable)}\n`, "utf8");
		writeFileSync(sealedPath, sealed, "utf8");

		const [report] = migrateMutableNamingState(state);
		deepStrictEqual(report?.counts, { lifecycle: 1, toolGovernance: 1, source: 1 });
		strictEqual(report?.changed, true);
		strictEqual(existsSync(`${mutablePath}${MUTABLE_NAMING_BACKUP_SUFFIX}`), true);
		deepStrictEqual((JSON.parse(readFileSync(mutablePath, "utf8")) as { nested: unknown }).nested, {
			lifecycle: "clio-coder-managed",
			toolGovernance: "clio-coder-policy",
			source: "clio-coder",
			message: "clio-policy",
		});
		strictEqual(readFileSync(sealedPath, "utf8"), sealed, "sealed/history roots are outside the allowlist");
		strictEqual(migrateMutableNamingState(state)[0]?.changed, false);
	});

	it("writes canonical share archives and normalizes released archives indefinitely at read", () => {
		const canonical = createShareArchive({
			cwd: scratch.dir,
			scope: "project",
			includeContext: false,
			includePrompts: false,
			includeSkills: false,
			includeAgents: false,
			includeFleets: false,
			includeSettings: false,
			includeExtensions: false,
		});
		strictEqual(canonical.kind, "clio-coder-share-archive");
		strictEqual(canonical.manifest.format, "clio-coder.share.v1");
		const legacyPath = join(scratch.dir, "legacy-share.json");
		const legacy = {
			...canonical,
			kind: "clio-share-archive",
			manifest: {
				...canonical.manifest,
				format: "clio.share.v1",
				clioVersion: canonical.manifest.clioCoderVersion,
			},
		};
		Reflect.deleteProperty(legacy.manifest, "clioCoderVersion");
		writeFileSync(legacyPath, `${JSON.stringify(legacy)}\n`, "utf8");
		const before = readFileSync(legacyPath, "utf8");
		const plan = planShareImport(legacyPath, { cwd: scratch.dir, dryRun: true });
		strictEqual(plan.archive?.kind, "clio-coder-share-archive");
		strictEqual(plan.archive?.manifest.format, "clio-coder.share.v1");
		strictEqual(plan.archive?.manifest.clioCoderVersion, canonical.manifest.clioCoderVersion);
		strictEqual(readFileSync(legacyPath, "utf8"), before);
	});

	it("doctor counts legacy immutable history without rewriting it, including under --fix", () => {
		const sessionPath = join(stateDir, "sessions", "cwd", "session", "current.jsonl");
		const evalPath = join(scratch.dir, "data", "evals", "legacy.json");
		const receiptPath = join(stateDir, "receipts", "legacy.json");
		mkdirSync(join(sessionPath, ".."), { recursive: true });
		mkdirSync(join(evalPath, ".."), { recursive: true });
		mkdirSync(join(receiptPath, ".."), { recursive: true });
		writeFileSync(sessionPath, '{"type":"clio_tool_start"}\n', "utf8");
		writeFileSync(evalPath, '{"schema":"clio.eval.verdict.v1","clio":{"version":"0.4.0"}}\n', "utf8");
		writeFileSync(receiptPath, '{"clioVersion":"0.4.0","contract":"clio.runReceipt.integrity"}\n', "utf8");
		const snapshots = [sessionPath, evalPath, receiptPath].map((path) => readFileSync(path, "utf8"));
		for (const fix of [false, true]) {
			const finding = namingFootprintFindings({ cwd: scratch.dir, fix }).find(
				(entry) => entry.name === "naming immutable history",
			);
			strictEqual(finding?.level, "warn");
			ok(finding?.detail.includes("sessions=1"));
			ok(finding?.detail.includes("evals=2"));
			ok(finding?.detail.includes("receipts=2"));
			deepStrictEqual(
				[sessionPath, evalPath, receiptPath].map((path) => readFileSync(path, "utf8")),
				snapshots,
			);
		}
	});

	it("data reset removes both tool marker spellings only with their selected root", () => {
		const versionDir = join(scratch.dir, "data", "tools", "yazi", "1.0.0");
		mkdirSync(versionDir, { recursive: true });
		writeFileSync(join(versionDir, LEGACY_TOOL_MARKER), "legacy", "utf8");
		writeFileSync(join(versionDir, CANONICAL_TOOL_MARKER), "canonical", "utf8");
		strictEqual(runResetCommand(["--data", "--force"]), 0);
		strictEqual(existsSync(join(versionDir, LEGACY_TOOL_MARKER)), false);
		strictEqual(existsSync(join(versionDir, CANONICAL_TOOL_MARKER)), false);
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
