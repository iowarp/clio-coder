import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { parse as parseYaml } from "yaml";
import {
	SETTINGS_V1_PATH_MOVES,
	SETTINGS_V1_RETIRED_PATHS,
	updateSettings,
	validateSettings,
	validateSettingsFile,
} from "../../src/core/config.js";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import { isRoutingPath } from "../../src/core/session-routing.js";
import { diffSettings } from "../../src/domains/config/classify.js";
import settingsV2, {
	migrateSettingsV1Document,
	SETTINGS_V2_MIGRATION_ID,
	SettingsV2CollisionError,
} from "../../src/domains/lifecycle/migrations/2026-09-01-settings-v2.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const COMPLETE_V1 = `version: 1
identity: ignored-before-v031
autonomy: suggest
targets:
  - id: local
    runtime: lmstudio
    url: http://127.0.0.1:1234
    auth:
      apiKeyRef: lmstudio
      headers:
        X-Secret: exact-header-value
    defaultModel: qwen
runtimePlugins: [runtime-one]
orchestrator: { target: local, model: qwen, thinkingLevel: high }
background: { target: local, model: memory-model, thinkingLevel: low }
memory:
  intervention:
    enabled: false
    everyNTools: 12
    windowSteps: 9
    maxTokens: 1777
    timeoutMs: 45678
watchdog: { enabled: true, target: local, cadenceToolCalls: 7 }
workers:
  default: { target: local, model: qwen, thinkingLevel: medium, node: remote }
  profiles:
    quality: { target: local, model: qwen, thinkingLevel: high, node: remote }
  rosters:
    review:
      members:
        - { label: alpha, target: local, model: qwen, thinking: medium, color: accent }
        - { label: beta, target: local, thinking: low, color: '#112233' }
  agentBindings: { builder: quality }
  maxRetries: 4
  onPermission: escalate
  escalation: { timeoutMs: 54321, fallback: fail }
  resilienceCooldownMs: 9876
fleet:
  nodes:
    - id: remote
      host: example.test
      clioEntry: legacy-entry
      clioCoderEntry: canonical-entry
      maxWorkers: 3
routing:
  activeRoles: [researcher]
  activePostures: [quality]
  agentAutomation:
    activeAgentRoles: [{ agentId: builder, executionRole: builder }]
scope: [local/qwen]
modelSelector: { favorites: [local/qwen], recentLimit: 8 }
budget: { sessionCeilingUsd: 9.5, concurrency: 3 }
defaults: { maxTokens: 4096 }
theme: default
terminal:
  showTerminalProgress: true
  outputVerbosity: verbose
  tuiMode: fullscreen
  fullscreenScrollbar: always
  smoothStreaming: on
  notify: true
skills: { trustProjectCompatRoots: true }
library:
  catalog: custom
  remote: ssh://example.test/catalog
  confirmedRemote: |-
    ssh://example.test/catalog
    exact
  sync: true
attribution: { gitCommits: false }
delegation:
  defaults:
    connectTimeoutMs: 11111
    turnTimeoutMs: 22222
    permissionTimeoutMs: 33333
    toolGovernance: deny-all
  agents:
    - id: external
      command: external-agent
      args: [--stdio]
      cwd: /tmp/external-agent
      env: { SECRET_TOKEN: exact-env-value }
      connectTimeoutMs: 44444
      turnTimeoutMs: 55555
      permissionTimeoutMs: 66666
      stallTimeoutMs: 0
      toolGovernance: agent-managed
      projectContext: bounded
      labels: { tier: local }
keybindings: { submit: enter, cancel: [escape, ctrl+c] }
compaction:
  auto: false
  threshold: 0.7
  excludeLastTurns: 5
  model: local/summary
  systemPrompt: prompts/compact.md
context:
  workingSet:
    enabled: true
    policy: structural-v1
    target: 0.55
    protectLastTurns: 7
    minEvictableTokens: 321
prewarm: { enabled: false }
panes:
  enabled: auto
  notifications: all
  journal: false
  agents: off
  keepFailed: true
  yazi: { enabled: false, mode: chooser, profile: user, followCwd: false }
retry: { enabled: false, maxRetries: 6, baseDelayMs: 123, maxDelayMs: 456, streamStallMs: 0 }
guardrails:
  turnToolCallBudget: 71
  workerToolCallCap: 172
  maxDispatchRuns: 1173
  readMaxBytes: 5173
  observationTurnBudgetBytes: 6173
  internalDispatchTimeoutMs: 7173
`;

function asRecord(value: unknown, label: string): Record<string, unknown> {
	ok(typeof value === "object" && value !== null && !Array.isArray(value), `${label} is a map`);
	return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
	ok(Array.isArray(value), `${label} is a list`);
	return value;
}

describe("contracts/settings v2 paths", () => {
	let scratch: IsolatedClioEnv;
	let configDir: string;
	let stateDir: string;
	let path: string;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-settings-v2-");
		configDir = join(scratch.dir, "config");
		stateDir = join(scratch.dir, "state");
		path = join(configDir, "settings.yaml");
		mkdirSync(configDir, { recursive: true });
		mkdirSync(stateDir, { recursive: true });
	});

	afterEach(() => scratch.restore());

	it("ships a complete strict version-2 default document", () => {
		const parsed = parseYaml(DEFAULT_SETTINGS_YAML) as unknown;
		const result = validateSettings(parsed);
		deepStrictEqual(result.issues, []);
		deepStrictEqual(result.settings, DEFAULT_SETTINGS);
		strictEqual(result.settings.version, 2);
		ok("agentProfiles" in result.settings.fleet, "fleet.agentProfiles is part of the durable v2 shape");
		strictEqual("workers" in result.settings, false);
		strictEqual("orchestrator" in result.settings, false);
	});

	it("publishes the complete move and retirement manifest", () => {
		const moves = new Map<string, string>(SETTINGS_V1_PATH_MOVES);
		strictEqual(moves.size, 97, "the fixed v1-to-v2 move manifest stays complete");
		strictEqual(moves.get("orchestrator.target"), "chat.target");
		strictEqual(moves.get("retry.streamStallMs"), "chat.retry.streamStallMs");
		strictEqual(moves.get("workers.agentBindings.*"), "fleet.agentProfiles.*");
		strictEqual(moves.get("workers.rosters.*.members[].thinking"), "fleet.rosters.*.members[].thinkingLevel");
		strictEqual(
			moves.get("routing.agentAutomation.activeAgentRoles[].executionRole"),
			"fleet.adaptiveRouting.agentRoles[].executionRole",
		);
		strictEqual(moves.get("memory.intervention.windowSteps"), "context.memory.trajectorySteps");
		strictEqual(moves.get("watchdog.cadenceToolCalls"), "safety.review.cadenceToolCalls");
		strictEqual(moves.get("terminal.showTerminalProgress"), "interface.terminalProgress");
		strictEqual(moves.get("delegation.agents[].env.*"), "integrations.externalAgents.entries[].env.*");
		strictEqual(moves.get("guardrails.observationTurnBudgetBytes"), "safety.limits.observationBytesPerTurn");
		strictEqual(moves.get("fleet.nodes[].clioEntry"), "fleet.nodes[].clioCoderEntry");
		strictEqual(moves.get("panes.journal"), "fleet.history.journal");
		strictEqual(moves.get("panes.yazi.mode"), "interface.panes.files.mode");
		deepStrictEqual(Object.keys(SETTINGS_V1_RETIRED_PATHS).sort(), [
			"background.thinkingLevel",
			"compaction.excludeLastTurns",
			"identity",
			"theme",
		]);
	});

	it("treats old paths as non-executing targeted tombstones", () => {
		const result = validateSettings({
			version: 2,
			orchestrator: { target: "old" },
			workers: { agentBindings: { builder: "quality" } },
			background: { thinkingLevel: "high" },
			fleet: { nodes: [{ id: "remote", host: "example.test", clioEntry: "clio-coder worker" }] },
		});
		const byPath = new Map(result.issues.map((issue) => [issue.path, issue.message]));
		match(byPath.get("orchestrator.target") ?? "", /use chat\.target/u);
		match(byPath.get("workers.agentBindings.builder") ?? "", /fleet\.agentProfiles\.\*/u);
		match(byPath.get("background.thinkingLevel") ?? "", /retired without replacement/u);
		match(byPath.get("fleet.nodes[0].clioEntry") ?? "", /clioCoderEntry/u);
		strictEqual(result.settings.chat.target, null, "a tombstone never executes as an alias");
		deepStrictEqual(result.settings.fleet.agentProfiles, {}, "a tombstone never populates the replacement");

		const emptyContainer = validateSettings({ version: 2, runtimePlugins: [] });
		match(emptyContainer.issues.find((issue) => issue.path === "runtimePlugins")?.message ?? "", /use integrations/u);
	});

	it("classifies and recognizes only canonical version-2 paths", () => {
		const hot = structuredClone(DEFAULT_SETTINGS);
		hot.chat.modelPicker.favorites = ["local/model"];
		deepStrictEqual(diffSettings(DEFAULT_SETTINGS, hot), {
			hotReload: ["chat.modelPicker.favorites.0"],
			nextTurn: [],
			restartRequired: [],
		});

		const restart = structuredClone(DEFAULT_SETTINGS);
		restart.interface.panes.enabled = "auto";
		deepStrictEqual(diffSettings(DEFAULT_SETTINGS, restart), {
			hotReload: [],
			nextTurn: [],
			restartRequired: ["interface.panes.enabled"],
		});

		for (const path of [
			"chat.target",
			"chat.model",
			"chat.thinkingLevel",
			"context.memory.target",
			"context.memory.model",
			"fleet.default.target",
			"fleet.default.model",
			"fleet.default.thinkingLevel",
			"chat.modelPicker.cycleSet",
		]) {
			strictEqual(isRoutingPath(path), true, `${path} is session-owned routing`);
		}
		for (const path of ["chat.modelPicker.favorites", "fleet.default.node", "orchestrator.target", "scope"]) {
			strictEqual(isRoutingPath(path), false, `${path} is not session-owned v2 routing`);
		}
	});

	it("persists fleet.agentProfiles without materializing unrelated defaults", () => {
		writeFileSync(path, "version: 2\n", "utf8");
		updateSettings((settings) => {
			settings.fleet.agentProfiles.builder = "quality";
		});
		const saved = asRecord(parseYaml(readFileSync(path, "utf8")), "saved settings");
		const fleet = asRecord(saved.fleet, "saved fleet");
		deepStrictEqual(fleet.agentProfiles, { builder: "quality" });
		strictEqual("chat" in saved, false);
		deepStrictEqual(validateSettingsFile().settings.fleet.agentProfiles, { builder: "quality" });
	});

	it("migrates atomically, writes a sibling v1 backup, and preserves sensitive values", async () => {
		writeFileSync(path, COMPLETE_V1, "utf8");
		await settingsV2.up(stateDir);

		strictEqual(readFileSync(`${path}.v1.bak`, "utf8"), COMPLETE_V1);
		deepStrictEqual(validateSettingsFile().issues, []);
		const migrated = asRecord(parseYaml(readFileSync(path, "utf8")), "migrated settings");
		const chat = asRecord(migrated.chat, "chat");
		const fleet = asRecord(migrated.fleet, "fleet");
		const context = asRecord(migrated.context, "context");
		const safety = asRecord(migrated.safety, "safety");
		const ui = asRecord(migrated.interface, "interface");
		const integrations = asRecord(migrated.integrations, "integrations");
		const fleetDefault = asRecord(fleet.default, "fleet.default");
		const profiles = asRecord(fleet.profiles, "fleet.profiles");
		const rosters = asRecord(fleet.rosters, "fleet.rosters");
		const reviewRoster = asRecord(rosters.review, "fleet.rosters.review");
		const reviewMembers = asArray(reviewRoster.members, "fleet.rosters.review.members");
		const firstMember = asRecord(reviewMembers[0], "first roster member");
		const nodes = asArray(fleet.nodes, "fleet.nodes");
		const firstNode = asRecord(nodes[0], "first fleet node");
		const memory = asRecord(context.memory, "context.memory");
		const externalAgents = asRecord(integrations.externalAgents, "integrations.externalAgents");
		const externalEntries = asArray(externalAgents.entries, "integrations.externalAgents.entries");
		const firstExternal = asRecord(externalEntries[0], "first external agent");
		const env = asRecord(firstExternal.env, "external agent env");
		const targets = asArray(migrated.targets, "targets");
		const firstTarget = asRecord(targets[0], "first target");
		const auth = asRecord(firstTarget.auth, "target auth");
		const headers = asRecord(auth.headers, "target auth headers");
		const library = asRecord(integrations.library, "integrations.library");

		strictEqual(migrated.version, 2);
		strictEqual(chat.target, "local");
		strictEqual(chat.prewarm, false);
		strictEqual(chat.maxOutputTokens, 4096);
		strictEqual(asRecord(chat.retry, "chat.retry").streamStallMs, 0);
		strictEqual(fleetDefault.node, "remote");
		strictEqual(asRecord(profiles.quality, "fleet.profiles.quality").thinkingLevel, "high");
		strictEqual(asRecord(fleet.agentProfiles, "fleet.agentProfiles").builder, "quality");
		strictEqual(firstMember.thinkingLevel, "medium");
		strictEqual(firstNode.clioCoderEntry, "canonical-entry");
		strictEqual("clioEntry" in firstNode, false);
		strictEqual(Array.isArray(asRecord(fleet.adaptiveRouting, "fleet.adaptiveRouting").roles), true);
		strictEqual(fleet.concurrency, 3);
		strictEqual(asRecord(fleet.permissions, "fleet.permissions").mode, "escalate");
		strictEqual(asRecord(fleet.retry, "fleet.retry").routeCooldownMs, 9876);
		strictEqual(asRecord(fleet.limits, "fleet.limits").internalRunTimeoutMs, 7173);
		// The panes keys v0.4.0 shipped are carried to their direct v2 successors.
		strictEqual(asRecord(fleet.history, "fleet.history").journal, false);
		const uiPanes = asRecord(ui.panes, "interface.panes");
		strictEqual(uiPanes.enabled, "auto");
		strictEqual(uiPanes.notifications, "all");
		const uiFiles = asRecord(uiPanes.files, "interface.panes.files");
		strictEqual(uiFiles.enabled, false);
		strictEqual(uiFiles.mode, "chooser");
		strictEqual(uiFiles.profile, "user");
		strictEqual(uiFiles.followCwd, false);
		strictEqual(memory.maxOutputTokens, 1777);
		strictEqual(asRecord(context.compaction, "context.compaction").systemPrompt, "prompts/compact.md");
		strictEqual(asRecord(safety.limits, "safety.limits").sessionCostUsd, 9.5);
		strictEqual(asRecord(safety.review, "safety.review").cadenceToolCalls, 7);
		strictEqual(ui.outputDetail, "verbose");
		strictEqual(env.SECRET_TOKEN, "exact-env-value");
		strictEqual(firstExternal.cwd, "/tmp/external-agent");
		strictEqual(firstExternal.connectTimeoutMs, 44444);
		strictEqual(firstExternal.turnTimeoutMs, 55555);
		strictEqual(firstExternal.permissionTimeoutMs, 66666);
		strictEqual(firstExternal.stallTimeoutMs, 0);
		strictEqual(firstExternal.toolGovernance, "agent-managed");
		strictEqual(firstExternal.projectContext, "bounded");
		strictEqual(headers["X-Secret"], "exact-header-value");
		strictEqual(library.confirmedRemote, "ssh://example.test/catalog\nexact");
		strictEqual(asRecord(integrations.git, "integrations.git").commitAttribution, false);
		strictEqual("workers" in migrated, false);
		strictEqual("theme" in migrated, false);
		strictEqual("panes" in migrated, false, "the residual panes root (retired agents/keepFailed) is dropped");

		const reportFile = join(stateDir, "migration-reports", `${SETTINGS_V2_MIGRATION_ID}.json`);
		const reportText = readFileSync(reportFile, "utf8");
		for (const retired of Object.keys(SETTINGS_V1_RETIRED_PATHS))
			match(reportText, new RegExp(retired.replaceAll(".", "\\."), "u"));
		match(reportText, /canonical fleet\.nodes\[0\]\.clioCoderEntry/u);
		strictEqual(reportText.includes("exact-env-value"), false, "migration reports contain paths, never secret values");

		const migratedText = readFileSync(path, "utf8");
		await settingsV2.up(stateDir);
		strictEqual(readFileSync(path, "utf8"), migratedText, "a v2 document is a one-time no-op");
		strictEqual(readFileSync(`${path}.v1.bak`, "utf8"), COMPLETE_V1, "the original v1 backup is retained");
	});

	it("preserves explicit nulls while moving their paths", () => {
		const transformed = migrateSettingsV1Document({
			version: 1,
			orchestrator: { target: null, model: null },
			background: { target: null, model: null },
			library: { catalog: null, remote: null, confirmedRemote: null, sync: false },
		});
		const chat = asRecord(transformed.document.chat, "chat");
		const context = asRecord(transformed.document.context, "context");
		const memory = asRecord(context.memory, "context.memory");
		const integrations = asRecord(transformed.document.integrations, "integrations");
		const library = asRecord(integrations.library, "integrations.library");
		strictEqual(chat.target, null);
		strictEqual(chat.model, null);
		strictEqual(memory.target, null);
		strictEqual(memory.model, null);
		strictEqual(library.confirmedRemote, null);
	});

	it("migrates the fleet node alias when no canonical spelling exists", () => {
		const transformed = migrateSettingsV1Document({
			version: 1,
			fleet: { nodes: [{ id: "remote", host: "example.test", clioEntry: "custom-worker" }] },
		});
		const fleet = asRecord(transformed.document.fleet, "fleet");
		const node = asRecord(asArray(fleet.nodes, "fleet.nodes")[0], "fleet.nodes[0]");
		strictEqual(node.clioCoderEntry, "custom-worker");
		strictEqual("clioEntry" in node, false);
		ok(transformed.moved.includes("fleet.nodes[0].clioEntry -> fleet.nodes[0].clioCoderEntry"));
	});

	it("refuses every old/new collision without touching the file or creating a backup", async () => {
		const mixed = `version: 1
orchestrator: { target: old }
chat: { target: new }
workers: { agentBindings: { builder: quality } }
fleet: { agentProfiles: { builder: other } }
`;
		writeFileSync(path, mixed, "utf8");
		await rejects(
			settingsV2.up(stateDir),
			(error: unknown) =>
				error instanceof SettingsV2CollisionError &&
				error.collisions.some((entry) => entry.includes("orchestrator.target")) &&
				error.collisions.some((entry) => entry.includes("workers.agentBindings")),
		);
		strictEqual(readFileSync(path, "utf8"), mixed);
		strictEqual(existsSync(`${path}.v1.bak`), false);
	});

	it("refuses a non-map destination ancestor instead of overwriting it", async () => {
		const mixed = "version: 1\norchestrator: { target: old }\nchat: operator-owned-scalar\n";
		writeFileSync(path, mixed, "utf8");
		await rejects(
			settingsV2.up(stateDir),
			(error: unknown) =>
				error instanceof SettingsV2CollisionError &&
				error.collisions.some((entry) => entry === "orchestrator.target collides with chat"),
		);
		strictEqual(readFileSync(path, "utf8"), mixed);
		strictEqual(existsSync(`${path}.v1.bak`), false);
	});

	it("validates the complete candidate before backup or replacement", async () => {
		const invalid = "version: 1\norchestrator: { target: null }\nunknownOperatorKey: true\n";
		writeFileSync(path, invalid, "utf8");
		await rejects(settingsV2.up(stateDir), /unknownOperatorKey/u);
		strictEqual(readFileSync(path, "utf8"), invalid);
		strictEqual(existsSync(`${path}.v1.bak`), false);
	});
});
