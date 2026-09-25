import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { parse as parseYaml } from "yaml";
import { namingHistoryFindings } from "../../src/cli/doctor-naming.js";
import { readSettings, updateSettings, validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import settingsV2, {
	SETTINGS_V2_MIGRATION_ID,
	SettingsV2CollisionError,
} from "../../src/domains/lifecycle/migrations/2026-09-01-settings-v2.js";
import { listMigrations, runPending } from "../../src/domains/lifecycle/migrations/index.js";
import { parseYaziEventLine, renderYaziKeymap } from "../../src/domains/mux/index.js";
import { parseSessionEntries } from "../../src/domains/session/archive-readers.js";
import { createShareArchive, planShareImport } from "../../src/domains/share/archive.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("settings and migration boundary", () => {
	let scratch: IsolatedClioEnv;
	let settingsFile: string;
	let stateDir: string;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-settings-contract-");
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
		strictEqual(defaults.settings.safety.autonomy, "default");
		strictEqual(defaults.settings.safety.limits.sessionCostUsd, 5);
		strictEqual(defaults.settings.chat.prewarm, false);
		strictEqual(defaults.settings.chat.maxOutputTokens, 0);
		strictEqual(defaults.settings.fleet.concurrency, "auto");
		strictEqual(defaults.settings.fleet.permissions.mode, "deny");
		strictEqual(defaults.settings.context.memory.target, null);
		strictEqual(defaults.settings.interface.mode, "regular");
		strictEqual(defaults.settings.interface.smoothStreaming, "auto");
		strictEqual(defaults.settings.interface.panes.enabled, "off");
		strictEqual(defaults.settings.interface.panes.layout, "off");
		strictEqual(defaults.settings.interface.panes.files.enabled, false);
		strictEqual(defaults.settings.context.toolResultMaxBytes, 65_536);

		const belowToolResultMinimum = validateSettings({ version: 2, context: { toolResultMaxBytes: 4_095 } });
		ok(belowToolResultMinimum.issues.some((issue) => issue.path === "context.toolResultMaxBytes"));

		const invalid = validateSettings({ version: 2, orchestrator: { target: "legacy" }, mystery: true });
		ok(invalid.issues.some((issue) => issue.path === "orchestrator.target"));
		ok(invalid.issues.some((issue) => issue.path === "mystery"));
		strictEqual(invalid.settings.chat.target, null, "retired paths never execute as aliases");
	});

	it("validates LiteLLM request controls without admitting arbitrary target keys", () => {
		const valid = validateSettings({
			version: 2,
			targets: [
				{
					id: "blade",
					runtime: "litellm",
					litellm: {
						request: {
							tags: ["homelab", "homelab", "interactive"],
							sendSessionId: true,
							timeoutSeconds: 90.5,
							streamTimeoutSeconds: 180,
							numRetries: 0,
						},
					},
				},
			],
		});
		deepStrictEqual(valid.issues, []);
		deepStrictEqual(valid.settings.targets[0]?.litellm?.request, {
			tags: ["homelab", "interactive"],
			sendSessionId: true,
			timeoutSeconds: 90.5,
			streamTimeoutSeconds: 180,
			numRetries: 0,
		});

		const invalid = validateSettings({
			version: 2,
			targets: [
				{
					id: "blade",
					runtime: "litellm",
					litellm: { request: { tags: ["bad,tag"], numRetries: -1, timeoutSeconds: 0 } },
				},
			],
		});
		ok(invalid.issues.some((issue) => issue.path === "targets[0].litellm.request.tags"));
		ok(invalid.issues.some((issue) => issue.path === "targets[0].litellm.request.numRetries"));
		ok(invalid.issues.some((issue) => issue.path === "targets[0].litellm.request.timeoutSeconds"));
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
		strictEqual(readSettings().interface.panes.enabled, "off");
		strictEqual(readSettings().interface.panes.layout, "off");
		strictEqual(readSettings().interface.panes.files.enabled, false);
		strictEqual(readSettings().context.toolResultMaxBytes, 65_536);
	});

	it("carries only explicit v1 pane choices into v2", async () => {
		writeFileSync(settingsFile, "version: 1\npanes:\n  enabled: auto\n  yazi:\n    enabled: true\n", "utf8");

		await settingsV2.up(stateDir);
		const migrated = readSettings().interface.panes;
		strictEqual(migrated.enabled, "auto");
		strictEqual(migrated.layout, "off");
		strictEqual(migrated.files.enabled, true);
	});

	it("refuses a v1/v2 collision without replacing or backing up the file", async () => {
		const mixed = "version: 1\norchestrator: { target: old }\nchat: { target: new }\n";
		writeFileSync(settingsFile, mixed, "utf8");
		await rejects(settingsV2.up(stateDir), (error: unknown) => error instanceof SettingsV2CollisionError);
		strictEqual(readFileSync(settingsFile, "utf8"), mixed);
		strictEqual(existsSync(`${settingsFile}.v1.bak`), false);
	});

	it("emits canonical Yazi names and parses only the canonical pick event", () => {
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
		strictEqual(parseYaziEventLine('clio-pick,receiver,sender,["legacy"]'), null);
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

	it("doctor counts legacy immutable history without rewriting it", () => {
		const sessionPath = join(stateDir, "sessions", "cwd", "session", "current.jsonl");
		const receiptPath = join(stateDir, "receipts", "legacy.json");
		mkdirSync(join(sessionPath, ".."), { recursive: true });
		mkdirSync(join(receiptPath, ".."), { recursive: true });
		writeFileSync(sessionPath, '{"type":"clio_tool_start"}\n', "utf8");
		writeFileSync(receiptPath, '{"clioVersion":"0.4.0","contract":"clio.runReceipt.integrity"}\n', "utf8");
		const snapshots = [sessionPath, receiptPath].map((path) => readFileSync(path, "utf8"));
		const finding = namingHistoryFindings({ cwd: scratch.dir }).find(
			(entry) => entry.name === "naming immutable history",
		);
		strictEqual(finding?.level, "warn");
		ok(finding?.detail.includes("sessions=1"));
		ok(finding?.detail.includes("receipts=2"));
		deepStrictEqual(
			[sessionPath, receiptPath].map((path) => readFileSync(path, "utf8")),
			snapshots,
		);
	});

	it("normalizes the released ACP routing-notice custom type only at session read", () => {
		const legacy = {
			kind: "custom",
			turnId: "turn-routing-notice",
			parentTurnId: null,
			timestamp: "2026-09-01T00:00:00.000Z",
			customType: "clio.routing-notice",
			data: { text: "legacy advisory" },
		};
		const raw = `${JSON.stringify(legacy)}\n`;
		const parsed = parseSessionEntries(raw, "legacy-routing.ndjson");
		deepStrictEqual(parsed.errors, []);
		strictEqual(parsed.entries[0]?.kind, "custom");
		if (parsed.entries[0]?.kind === "custom") {
			strictEqual(parsed.entries[0].customType, "clio-coder.routing-notice");
		}
		strictEqual(raw.includes("clio.routing-notice"), true, "read normalization does not rewrite history bytes");
	});

	it("doctor lists legacy git refs and active ownership markers without renaming or rewriting them", () => {
		const root = join(scratch.dir, "legacy-git-project");
		mkdirSync(root, { recursive: true });
		const git = (...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
		git("init", "-b", "main");
		git("config", "user.name", "Naming Doctor");
		git("config", "user.email", "naming-doctor@example.invalid");
		writeFileSync(join(root, "tracked.txt"), "baseline\n", "utf8");
		git("add", "tracked.txt");
		git("commit", "-m", "baseline");
		git("branch", "clio/task/released-task");
		git("branch", "clio/compete/released-group/1");

		const worktrees = join(root, ".clio-coder", "worktrees");
		const taskMarker = join(worktrees, "released-task.task-owner.json");
		const competeMarker = join(worktrees, "released-group", ".clio-coder-compete-owner.json");
		mkdirSync(join(worktrees, "released-group"), { recursive: true });
		writeFileSync(taskMarker, '{"version":1,"kind":"clio-task-worktree"}\n', "utf8");
		writeFileSync(competeMarker, '{"version":2,"kind":"clio-compete-group"}\n', "utf8");
		const markerBytes = [taskMarker, competeMarker].map((path) => readFileSync(path, "utf8"));
		const branches = git("branch", "--format=%(refname:short)");

		const findings = namingHistoryFindings({ cwd: root });
		const refs = findings.find((entry) => entry.name === "naming git refs");
		strictEqual(refs?.level, "warn");
		ok(refs?.detail.includes("clio/task/released-task"));
		ok(refs?.detail.includes("clio/compete/released-group/1"));
		const markers = findings.find((entry) => entry.name === "naming worktree markers");
		strictEqual(markers?.level, "warn");
		ok(markers?.detail.startsWith("2 active legacy worktree markers"));
		strictEqual(git("branch", "--format=%(refname:short)"), branches);
		deepStrictEqual(
			[taskMarker, competeMarker].map((path) => readFileSync(path, "utf8")),
			markerBytes,
		);
	});

	it("orders migrations before strict readers and records each migration once", async () => {
		const ids = listMigrations().map((migration) => migration.id);
		const retiredPanes = "2026-09-01-retire-panes-knobs";
		deepStrictEqual(ids, [SETTINGS_V2_MIGRATION_ID, retiredPanes]);

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
