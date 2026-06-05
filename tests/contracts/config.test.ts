import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { normalizeSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { expandConfigPath, expandConfigValue, resolveConfigValue } from "../../src/core/resolve-config-value.js";
import { diffSettings } from "../../src/domains/config/classify.js";
import { SettingsSchema } from "../../src/domains/config/schema.js";

describe("contracts/config", () => {
	it("normalizes target config and default/fallback models", () => {
		const normalized = normalizeSettings({
			identity: "clio",
			targets: [
				{
					id: "codex-pro",
					runtime: "openai-codex",
					wireModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4"],
				},
			],
			orchestrator: {
				target: "missing-target",
				model: "stale-model",
				thinkingLevel: "xhigh",
			},
			workers: {
				default: {
					target: "codex-pro",
					model: "",
					thinkingLevel: "medium",
				},
			},
		});

		strictEqual(normalized.endpoints[0]?.defaultModel, "gpt-5.4");
		deepStrictEqual(normalized.endpoints[0]?.wireModels, ["gpt-5.4", "gpt-5.4-mini"]);
		strictEqual(normalized.orchestrator.endpoint, null);
		strictEqual(normalized.orchestrator.model, null);
		strictEqual(normalized.workers.default.endpoint, "codex-pro");
		strictEqual(normalized.workers.default.model, "gpt-5.4");
		strictEqual(Value.Check(SettingsSchema, normalized), true);
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
