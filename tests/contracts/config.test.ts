import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import { expandConfigPath, expandConfigValue, resolveConfigValue } from "../../src/core/resolve-config-value.js";
import { diffSettings } from "../../src/domains/config/classify.js";
import { advanceScopedTarget } from "../../src/entry/orchestrator.js";

describe("contracts/config", () => {
	it("keeps first-run default settings YAML generic, parseable, and schema-clean", () => {
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
		const result = validateSettings(parsed);
		deepStrictEqual(result.issues, []);
		deepStrictEqual(result.settings, DEFAULT_SETTINGS);
	});

	it("validates target config and fills default/fallback models", () => {
		const result = validateSettings({
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
					model: null,
					thinkingLevel: "medium",
				},
			},
		});

		deepStrictEqual(result.issues, []);
		const settings = result.settings;
		strictEqual(settings.targets[0]?.defaultModel, "primary-model");
		deepStrictEqual(settings.targets[0]?.wireModels, ["primary-model", "worker-model"]);
		// Dangling routing references are normalized away, not aliased.
		strictEqual(settings.orchestrator.target, null);
		strictEqual(settings.orchestrator.model, null);
		strictEqual(settings.workers.default.target, "hosted-target");
		strictEqual(settings.workers.default.model, "primary-model");
		strictEqual(settings.skills.trustProjectCompatRoots, false);
	});

	it("reports unknown keys as validation errors with exact paths", () => {
		const result = validateSettings({
			defaultMode: "super",
			safetyLevel: "full-auto",
			state: {
				recentModels: ["model-a"],
			},
			compaction: {
				threshold: 0.92,
				thresholds: { llmSummary: 0.99 },
			},
		});
		const paths = result.issues.map((issue) => issue.path).sort();
		deepStrictEqual(paths, ["compaction.thresholds", "defaultMode", "safetyLevel", "state"]);
		for (const issue of result.issues) strictEqual(issue.message, "unknown key");
		// Valid fields still land on the built settings.
		strictEqual(result.settings.compaction.threshold, 0.92);
	});

	it("reports type and enum violations as validation errors with exact paths", () => {
		const result = validateSettings({
			autonomy: "bananas",
			budget: { concurrency: 0 },
			targets: [{ runtime: "openai-compat" }],
			retry: { maxRetries: 1.5 },
		});
		const paths = result.issues.map((issue) => issue.path).sort();
		deepStrictEqual(paths, ["autonomy", "budget.concurrency", "retry.maxRetries", "targets[0].id"]);
		// Invalid fields fall back to defaults on the built settings.
		strictEqual(result.settings.autonomy, DEFAULT_SETTINGS.autonomy);
		strictEqual(result.settings.budget.concurrency, "auto");
	});

	it("rejects duplicate target ids and duplicate delegation agent ids", () => {
		const result = validateSettings({
			targets: [
				{ id: "local", runtime: "openai-compat" },
				{ id: "local", runtime: "llamacpp" },
			],
			delegation: {
				agents: [
					{ id: "opencode", command: "opencode" },
					{ id: "opencode", command: "ignored" },
				],
			},
		});
		const paths = result.issues.map((issue) => issue.path).sort();
		deepStrictEqual(paths, ["delegation.agents[1].id", "targets[1].id"]);
		strictEqual(result.settings.targets.length, 1);
		strictEqual(result.settings.delegation.agents.length, 1);
	});

	it("validates skills trust settings and treats them as next-turn changes", () => {
		const result = validateSettings({
			skills: {
				trustProjectCompatRoots: true,
			},
		});
		deepStrictEqual(result.issues, []);
		strictEqual(result.settings.skills.trustProjectCompatRoots, true);

		const prev = structuredClone(DEFAULT_SETTINGS);
		const next = structuredClone(DEFAULT_SETTINGS);
		next.skills.trustProjectCompatRoots = true;
		const diff = diffSettings(prev, next);
		deepStrictEqual(diff.hotReload, []);
		deepStrictEqual(diff.nextTurn, ["skills.trustProjectCompatRoots"]);
		deepStrictEqual(diff.restartRequired, []);
	});

	it("validates ACP delegation agents and treats them as next-turn settings", () => {
		const result = validateSettings({
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
				],
			},
		});

		deepStrictEqual(result.issues, []);
		const settings = result.settings;
		strictEqual(settings.delegation.defaults.connectTimeoutMs, 7);
		strictEqual(settings.delegation.defaults.toolGovernance, "deny-all");
		strictEqual(settings.delegation.agents.length, 1);
		strictEqual(settings.delegation.agents[0]?.id, "opencode");
		strictEqual(settings.delegation.agents[0]?.turnTimeoutMs, 11);
		strictEqual(settings.delegation.agents[0]?.toolGovernance, "clio-policy");
		deepStrictEqual(settings.delegation.agents[0]?.args, ["acp", "--cwd", "."]);

		const prev = structuredClone(DEFAULT_SETTINGS);
		const next = structuredClone(DEFAULT_SETTINGS);
		next.delegation.agents = settings.delegation.agents;
		const diff = diffSettings(prev, next);
		deepStrictEqual(diff.hotReload, []);
		deepStrictEqual(diff.nextTurn, ["delegation.agents.0"]);
		deepStrictEqual(diff.restartRequired, []);
	});

	it("classifies settings changes next-turn updates", () => {
		const prev = structuredClone(DEFAULT_SETTINGS);
		const next = structuredClone(DEFAULT_SETTINGS);
		next.compaction.auto = false;
		next.compaction.threshold = 0.9;
		const diff = diffSettings(prev, next);
		deepStrictEqual(diff.hotReload, []);
		deepStrictEqual(diff.nextTurn.sort(), ["compaction.auto", "compaction.threshold"]);
	});

	it("skips targets whose runtime is unregistered or non-http in scoped cycling", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{ id: "chat", runtime: "openai-compat", defaultModel: "chat-model" },
			// codex-cli was removed from the registry; an unresolved runtime target
			// must be skipped rather than cycled into the orchestrator slot.
			{ id: "codex-worker", runtime: "codex-cli", defaultModel: "gpt-5.4" },
		];
		settings.orchestrator.target = "chat";
		settings.orchestrator.model = "chat-model";
		settings.scope = ["codex-worker", "chat"];

		strictEqual(advanceScopedTarget(settings, "forward")?.target, "chat");
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
