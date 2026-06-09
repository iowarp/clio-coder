import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { parse as parseYaml } from "yaml";
import { normalizeSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import { expandConfigPath, expandConfigValue, resolveConfigValue } from "../../src/core/resolve-config-value.js";
import { diffSettings } from "../../src/domains/config/classify.js";
import { SettingsSchema } from "../../src/domains/config/schema.js";
import { advanceScopedTarget } from "../../src/entry/orchestrator.js";

describe("contracts/config", () => {
	it("keeps first-run default settings YAML generic and parseable", () => {
		const forbidden = [
			/\bmini\b/i,
			/\bdynamo\b/i,
			/\bzbook\b/i,
			/\b192\.168\./,
			/\bQwopus\b/i,
			/\bAgenticQwen\b/i,
			/\bQwen3\.6\b/i,
			/\bNemotron\b/i,
			/\bgemma-4\b/i,
			/\b262144\b/,
			/\b65536\b/,
			/\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/,
			/http:\/\/(?!localhost(?::|\/|$)|127\.0\.0\.1(?::|\/|$))[a-z0-9.-]+(?::\d+)?/i,
		];
		for (const pattern of forbidden) {
			strictEqual(pattern.test(DEFAULT_SETTINGS_YAML), false, `DEFAULT_SETTINGS_YAML leaked ${pattern}`);
		}

		const parsed = parseYaml(DEFAULT_SETTINGS_YAML) as unknown;
		const normalized = normalizeSettings(parsed);
		deepStrictEqual(normalized, DEFAULT_SETTINGS);
		strictEqual(Value.Check(SettingsSchema, normalized), true);
	});

	it("normalizes target config and default/fallback models", () => {
		const normalized = normalizeSettings({
			identity: "clio",
			targets: [
				{
					id: "hosted-target",
					runtime: "openai-codex",
					wireModels: ["primary-model", "worker-model", "primary-model"],
				},
			],
			orchestrator: {
				target: "missing-target",
				model: "stale-model",
				thinkingLevel: "xhigh",
			},
			workers: {
				default: {
					target: "hosted-target",
					model: "",
					thinkingLevel: "medium",
				},
			},
		});

		strictEqual(normalized.endpoints[0]?.defaultModel, "primary-model");
		deepStrictEqual(normalized.endpoints[0]?.wireModels, ["primary-model", "worker-model"]);
		strictEqual(normalized.orchestrator.endpoint, null);
		strictEqual(normalized.orchestrator.model, null);
		strictEqual(normalized.workers.default.endpoint, "hosted-target");
		strictEqual(normalized.workers.default.model, "primary-model");
		strictEqual(normalized.skills.trustProjectCompatRoots, false);
		strictEqual(Value.Check(SettingsSchema, normalized), true);
	});

	it("tolerates stale mode settings without preserving them", () => {
		const normalized = normalizeSettings({
			defaultMode: "super",
			state: {
				lastMode: "advise",
				recentModels: ["model-a"],
			},
		});
		const record = normalized as unknown as Record<string, unknown>;
		const state = normalized.state as unknown as Record<string, unknown>;

		strictEqual("defaultMode" in record, false);
		strictEqual("lastMode" in state, false);
		deepStrictEqual(normalized.state.recentModels, []);
		strictEqual(Value.Check(SettingsSchema, normalized), true);
	});

	it("normalizes skills trust settings and treats them as next-turn changes", () => {
		const normalized = normalizeSettings({
			skills: {
				trustProjectCompatRoots: true,
			},
		});
		strictEqual(normalized.skills.trustProjectCompatRoots, true);
		strictEqual(Value.Check(SettingsSchema, normalized), true);

		const prev = structuredClone(DEFAULT_SETTINGS);
		const next = structuredClone(DEFAULT_SETTINGS);
		next.skills.trustProjectCompatRoots = true;
		const diff = diffSettings(prev, next);
		deepStrictEqual(diff.hotReload, []);
		deepStrictEqual(diff.nextTurn, ["skills.trustProjectCompatRoots"]);
		deepStrictEqual(diff.restartRequired, []);
	});

	it("normalizes ACP delegation agents and treats them as next-turn settings", () => {
		const normalized = normalizeSettings({
			delegation: {
				defaults: {
					connectTimeoutMs: 7,
					turnTimeoutMs: 11,
					permissionTimeoutMs: 13,
					toolGovernance: "deny-all",
				},
				agents: [
					{
						id: "opencode",
						command: "opencode",
						args: ["acp", "--cwd", "."],
						toolGovernance: "clio-policy",
						labels: { specialty: "coding" },
					},
					{ id: "opencode", command: "ignored", args: [] },
					{ id: "missing-command" },
				],
			},
		});

		strictEqual(normalized.delegation.defaults.connectTimeoutMs, 7);
		strictEqual(normalized.delegation.defaults.toolGovernance, "deny-all");
		strictEqual(normalized.delegation.agents.length, 1);
		strictEqual(normalized.delegation.agents[0]?.id, "opencode");
		strictEqual(normalized.delegation.agents[0]?.turnTimeoutMs, 11);
		strictEqual(normalized.delegation.agents[0]?.toolGovernance, "clio-policy");
		deepStrictEqual(normalized.delegation.agents[0]?.args, ["acp", "--cwd", "."]);
		strictEqual(Value.Check(SettingsSchema, normalized), true);

		const prev = structuredClone(DEFAULT_SETTINGS);
		const next = structuredClone(DEFAULT_SETTINGS);
		next.delegation.agents = normalized.delegation.agents;
		const diff = diffSettings(prev, next);
		deepStrictEqual(diff.hotReload, []);
		deepStrictEqual(diff.nextTurn, ["delegation.agents.0"]);
		deepStrictEqual(diff.restartRequired, []);
	});

	it("classifies settings changes next-turn updates", () => {
		const prev = structuredClone(DEFAULT_SETTINGS);
		const next = structuredClone(DEFAULT_SETTINGS);
		next.compaction.auto = false;
		next.compaction.thresholds.llmSummary = 0.98;
		const diff = diffSettings(prev, next);
		deepStrictEqual(diff.hotReload, []);
		deepStrictEqual(diff.nextTurn.sort(), ["compaction.auto", "compaction.thresholds.llmSummary"]);
	});

	it("migrates legacy compaction threshold to the final LLM stage", () => {
		const normalized = normalizeSettings({
			compaction: {
				threshold: 0.92,
				auto: true,
			},
		});
		strictEqual(normalized.compaction.thresholds.llmSummary, 0.92);
		strictEqual(
			normalized.compaction.thresholds.maskObservations,
			DEFAULT_SETTINGS.compaction.thresholds.maskObservations,
		);
		strictEqual(Value.Check(SettingsSchema, normalized), true);
	});

	it("skips targets whose runtime is unregistered or non-http in scoped cycling", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.endpoints = [
			{ id: "chat", runtime: "openai-compat", defaultModel: "chat-model" },
			// codex-cli was removed from the registry; an unresolved runtime target
			// must be skipped rather than cycled into the orchestrator slot.
			{ id: "codex-worker", runtime: "codex-cli", defaultModel: "gpt-5.4" },
		];
		settings.orchestrator.endpoint = "chat";
		settings.orchestrator.model = "chat-model";
		settings.scope = ["codex-worker", "chat"];

		strictEqual(advanceScopedTarget(settings, "forward")?.endpoint, "chat");
		settings.scope = ["codex-worker"];
		strictEqual(advanceScopedTarget(settings, "forward"), null);
	});

	it("resolves environment variable references and literals", () => {
		const value = resolveConfigValue("CLIO_TOKEN", { env: { CLIO_TOKEN: "secret" } });
		strictEqual(value, "secret");

		strictEqual(
			resolveConfigValue("https://$CLIO_HOST/v1", { env: { CLIO_HOST: "example.test" } }),
			"https://example.test/v1",
		);

		strictEqual(expandConfigValue(`Bearer $${"{CLIO_TOKEN}"}`, { env: { CLIO_TOKEN: "secret" } }), "Bearer secret");
	});

	it("expands home-relative and env-bearing paths", () => {
		strictEqual(expandConfigPath("~/skills"), join(homedir(), "skills"));
		strictEqual(
			expandConfigPath("$PROJECT_DIR/skills", { cwd: "/tmp/repo", env: { PROJECT_DIR: "local" } }),
			"/tmp/repo/local/skills",
		);
	});
});
