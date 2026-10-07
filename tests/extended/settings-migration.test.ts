import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { parse as parseYaml } from "yaml";
import { namingHistoryFindings } from "../../src/cli/doctor-naming.js";
import { readSettings, updateSettings, validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import { readLifecycleReceipts } from "../../src/core/library-receipts.js";
import { extensionContentDigest } from "../../src/domains/extensions/integrity.js";
import { convertWorkspaceOnce } from "../../src/domains/lifecycle/canonical-names.js";
import { runDoctor } from "../../src/domains/lifecycle/doctor.js";
import settingsV2, {
	SETTINGS_V2_MIGRATION_ID,
	SettingsV2CollisionError,
} from "../../src/domains/lifecycle/migrations/2026-09-01-settings-v2.js";
import {
	listMigrations,
	readMigrationManifestResult,
	runPending,
} from "../../src/domains/lifecycle/migrations/index.js";
import { parseYaziEventLine, renderYaziKeymap } from "../../src/domains/mux/index.js";
import { pluginContentDigest } from "../../src/domains/plugins/integrity.js";
import { parseSessionEntries } from "../../src/domains/session/archive-readers.js";
import { createShareArchive, planShareImport } from "../../src/domains/share/archive.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const PLAYBOOKS_MIGRATION_ID = "2026-10-06-playbooks-and-packages";
const ACP_ADAPTERS_MIGRATION_ID = "2026-10-07-acp-adapters";
const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

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
		strictEqual(defaults.settings.interface.panes.enabled, "embedded");
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
		strictEqual(readSettings().interface.panes.enabled, "embedded");
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
			includePlaybooks: false,
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
		deepStrictEqual(ids, [SETTINGS_V2_MIGRATION_ID, retiredPanes, PLAYBOOKS_MIGRATION_ID, ACP_ADAPTERS_MIGRATION_ID]);

		writeFileSync(settingsFile, "version: 1\npanes: { agents: off, keepFailed: false }\n", "utf8");
		const first = await runPending(stateDir);
		ok(first.applied.includes(SETTINGS_V2_MIGRATION_ID));
		ok(first.applied.includes(retiredPanes));
		ok(first.applied.includes(PLAYBOOKS_MIGRATION_ID));
		deepStrictEqual((await runPending(stateDir)).applied, []);
	});

	it("doctor distinguishes satisfied settings migrations from pending work without writing receipts", () => {
		const manifest = join(stateDir, "migrations.json");
		const recorded = `{"applied":["${PLAYBOOKS_MIGRATION_ID}","${ACP_ADAPTERS_MIGRATION_ID}"]}\n`;
		writeFileSync(manifest, recorded, "utf8");
		writeFileSync(settingsFile, "version: 2\n", "utf8");
		const current = runDoctor().find((finding) => finding.name === "lifecycle migrations");
		strictEqual(current?.ok, true);
		strictEqual(current?.level, undefined);
		ok(current?.detail.includes("already satisfy 2 unrecorded"));
		strictEqual(readFileSync(manifest, "utf8"), recorded);
		strictEqual(readFileSync(settingsFile, "utf8"), "version: 2\n");
		for (const settings of ["version: 1\n", "version: 2\npanes: { agents: off }\n", "version: [\n"]) {
			writeFileSync(settingsFile, settings, "utf8");
			const pending = runDoctor().find((finding) => finding.name === "lifecycle migrations");
			strictEqual(pending?.level, "warn");
			ok(pending?.detail.includes("pending"));
		}
	});

	it("refuses a corrupt migration manifest instead of replaying user-data changes", async () => {
		const manifest = join(stateDir, "migrations.json");
		writeFileSync(manifest, '{"applied":["once","once"]}\n', "utf8");
		let calls = 0;
		const migrations = [
			{
				id: "once",
				description: "must not replay",
				up: async () => {
					calls += 1;
				},
			},
		];
		ok(readMigrationManifestResult(stateDir).problem?.includes("duplicate"));
		const doctor = runDoctor().find((finding) => finding.name === "lifecycle migrations");
		strictEqual(doctor?.ok, false);
		ok(doctor?.detail.includes("duplicate"));
		await rejects(() => runPending(stateDir, migrations), /cannot be trusted.*duplicate/u);
		strictEqual(calls, 0);
		strictEqual(readFileSync(manifest, "utf8"), '{"applied":["once","once"]}\n');
	});

	it("serializes concurrent migration runners and records a migration once", async () => {
		let calls = 0;
		const migrations = [
			{
				id: "serialized",
				description: "one writer",
				up: async () => {
					calls += 1;
					await new Promise<void>((resolve) => setTimeout(resolve, 20));
				},
			},
		];
		const [first, second] = await Promise.all([runPending(stateDir, migrations), runPending(stateDir, migrations)]);
		strictEqual(calls, 1);
		deepStrictEqual([...first.applied, ...second.applied], ["serialized"]);
		const manifest = join(stateDir, "migrations.json");
		deepStrictEqual(JSON.parse(readFileSync(manifest, "utf8")), { applied: ["serialized"] });
		if (process.platform !== "win32") strictEqual(statSync(manifest).mode & 0o777, 0o600);
	});

	it("converts a legacy home once: playbooks and the old Materio bundle, never installing an extension", async () => {
		const config = join(scratch.dir, "config");
		const write = (file: string, text: string): void => {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, text, "utf8");
		};
		const playbook = (name: string) =>
			`---\nversion: 1\nname: ${name}\ndescription: fixture\nsteps:\n  - id: review\n    agent: verifier\n    scope: readonly\n    dependencies: []\nmaxWorkers: 1\nonFailure: stop\n---\nReview.\n`;
		write(join(config, "fleets", "legacy-review.md"), playbook("legacy-review"));
		write(join(config, "fleets", "dup.md"), playbook("dup-old"));
		write(join(config, "playbooks", "dup.md"), playbook("dup-new"));

		// The old Materio bundle: the plugin tree with the extension manifest and runtime at its root, as one install.
		const bundle = join(config, "plugins", "materio");
		cpSync(join(REPO, "library", "plugins", "materio"), bundle, { recursive: true });
		cpSync(join(REPO, "library", "extensions", "materio"), bundle, { recursive: true });
		const manifestFile = join(bundle, "plugin.json");
		const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
		const namespace = manifest.extensions["ai.iowarp.clio"];
		namespace.resources = { fleets: "ai.iowarp.clio/fleets", skills: namespace.resources.skills };
		writeFileSync(manifestFile, JSON.stringify(manifest, null, "\t"), "utf8");
		// A third-party plugin that still declares fleets.
		const thirdParty = join(config, "plugins", "lab-pack");
		write(join(thirdParty, "fleets", "x.md"), playbook("x"));
		write(
			join(thirdParty, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "lab-pack",
				version: "1.0.0",
				description: "built for an older Clio",
				extensions: { "ai.iowarp.clio": { manifestVersion: 1, resources: { fleets: "fleets" }, components: [] } },
			}),
		);
		const materioSource = join(REPO, "library", "plugins", "materio");
		write(
			join(config, "plugins", "state.json"),
			JSON.stringify({
				version: 1,
				disabled: [],
				installed: {
					materio: {
						kind: "plugin",
						installedAt: "2026-10-01T00:00:00.000Z",
						source: materioSource,
						origin: { kind: "catalog", source: materioSource },
						contentDigest: pluginContentDigest(bundle),
						trust: "trusted",
					},
					"lab-pack": {
						installedAt: "2026-10-01T00:00:00.000Z",
						source: thirdParty,
						origin: { kind: "local", source: thirdParty },
						contentDigest: pluginContentDigest(thirdParty),
						trust: "trusted",
					},
				},
			}),
		);
		// An api 2 extension installed before the envelope binding: no recorded envelope digest.
		const status = join(config, "extensions", "local-status");
		const statusSource = join(REPO, "library", "extensions", "local-status");
		cpSync(statusSource, status, { recursive: true });
		write(
			join(config, "extensions", "state.json"),
			JSON.stringify({
				version: 1,
				disabled: [],
				installed: {
					"local-status": {
						installedAt: "2026-10-01T00:00:00.000Z",
						source: statusSource,
						origin: { kind: "catalog", source: statusSource },
						contentDigest: extensionContentDigest(status),
					},
				},
			}),
		);

		const first = await runPending(stateDir);
		ok(first.applied.includes(PLAYBOOKS_MIGRATION_ID));
		const report = first.reports?.[PLAYBOOKS_MIGRATION_ID];
		ok(report);
		const text = [...report.changed, ...report.attention].join("\n");
		ok(readFileSync(join(config, "playbooks", "legacy-review.md"), "utf8").includes("legacy-review"));
		ok(readFileSync(join(config, "playbooks", "dup.md"), "utf8").includes("dup-new"), "a collision never overwrites");
		ok(!existsSync(join(config, "fleets")), "the old directory is gone");
		ok(
			readdirSync(config).some((name) => name.startsWith("fleets.")),
			"the colliding copy is moved aside, not deleted",
		);
		ok(text.includes("dup"), text);
		// The bundle is now the plugin alone. No extension is installed or reinstalled; each is named with the reviewed install.
		ok(!existsSync(join(config, "plugins", "materio", "clio-coder-extension.yaml")));
		ok(existsSync(join(config, "plugins", "materio", "ai.iowarp.clio", "playbooks")));
		ok(!existsSync(join(config, "extensions", "materio")), "extension:materio is not installed by the upgrade");
		const extensionState = JSON.parse(readFileSync(join(config, "extensions", "state.json"), "utf8"));
		strictEqual(extensionState.installed.materio, undefined);
		strictEqual(
			extensionState.installed["local-status"].envelopeDigest,
			undefined,
			"an unbound extension is not reinstalled",
		);
		ok(
			report.attention.some((line) => line.includes("clio-coder library install extension:materio --user")),
			text,
		);
		ok(
			report.attention.some((line) => line.includes("clio-coder library install extension:local-status --user --force")),
			text,
		);
		// The third-party plugin stays in place and is named with the fix.
		ok(existsSync(join(thirdParty, "fleets", "x.md")));
		ok(
			report.attention.some((line) => line.includes("lab-pack") && line.includes("older Clio")),
			text,
		);
		// The plugin replacement is an upgrade receipt; no extension receipt is written.
		const upgraded = readLifecycleReceipts().filter((row) => row.actor === "upgrade");
		ok(upgraded.some((row) => row.kind === "plugin" && row.id === "materio" && row.operation === "update"));
		strictEqual(readLifecycleReceipts(undefined, undefined, "extension").length, 0, "no extension receipt");
		// A second run does nothing: the migration is recorded, and converting again changes nothing.
		const snapshot = readFileSync(join(config, "plugins", "state.json"), "utf8");
		deepStrictEqual((await runPending(stateDir)).applied, []);
		const { convertUserHome } = await import("../../src/domains/lifecycle/canonical-names.js");
		deepStrictEqual(convertUserHome().changed, []);
		strictEqual(readFileSync(join(config, "plugins", "state.json"), "utf8"), snapshot);
	});

	it("converts a workspace's .clio-coder once on first open", () => {
		const workspace = join(scratch.dir, "workspace");
		const project = join(workspace, ".clio-coder");
		mkdirSync(join(project, "fleets"), { recursive: true });
		writeFileSync(join(project, "fleets", "review.md"), "---\nversion: 1\nname: review\n---\nReview.\n", "utf8");
		writeFileSync(join(project, "fleets", "commands.yaml"), "version: 1\ncommands: {}\n", "utf8");
		mkdirSync(join(project, "plugins"), { recursive: true });
		writeFileSync(
			join(project, "plugins", "state.json"),
			JSON.stringify({
				version: 1,
				disabled: [],
				installed: {
					"review-pack": {
						kind: "fleet",
						installedAt: "2026-10-01T00:00:00.000Z",
						source: "/x",
						contentDigest: "0".repeat(64),
					},
				},
			}),
			"utf8",
		);
		const first = convertWorkspaceOnce(workspace);
		ok(first, "the first open converts");
		ok(existsSync(join(project, "playbooks", "review.md")));
		ok(existsSync(join(project, "playbooks", "commands.yaml")));
		ok(!existsSync(join(project, "fleets")));
		strictEqual(
			JSON.parse(readFileSync(join(project, "plugins", "state.json"), "utf8")).installed["review-pack"].kind,
			"playbook",
		);
		ok(first.changed.some((line) => line.includes("playbooks")));
		strictEqual(convertWorkspaceOnce(workspace), null, "a converted workspace is not converted again");
		mkdirSync(join(project, "fleets"), { recursive: true });
		strictEqual(convertWorkspaceOnce(workspace), null, "the conversion runs once per workspace");
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
