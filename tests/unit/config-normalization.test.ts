import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { diffSettings } from "../../src/domains/config/classify.js";

describe("core/config normalizeSettings", () => {
	it("normalizes target config and repairs stale pointers", () => {
		const normalized = normalizeSettings({
			identity: "clio",
			targets: [
				{
					id: "codex-pro",
					runtime: "openai-codex",
					wireModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4"],
				},
			],
			runtimePlugins: ["example-runtime", "example-runtime", ""],
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
				profiles: {
					"codex-mini": {
						target: "codex-pro",
						model: "gpt-5.4-mini",
						thinkingLevel: "low",
					},
					stale: {
						target: "missing-target",
						model: "stale",
						thinkingLevel: "high",
					},
				},
			},
			scope: ["codex-pro", "missing-target", "codex-pro/gpt-5.4-mini", "codex-pro"],
		});

		strictEqual(normalized.endpoints[0]?.defaultModel, "gpt-5.4");
		deepStrictEqual(normalized.endpoints[0]?.wireModels, ["gpt-5.4", "gpt-5.4-mini"]);
		strictEqual(normalized.orchestrator.endpoint, null);
		strictEqual(normalized.orchestrator.model, null);
		strictEqual(normalized.workers.default.endpoint, "codex-pro");
		strictEqual(normalized.workers.default.model, "gpt-5.4");
		deepStrictEqual(normalized.workers.profiles, {
			"codex-mini": {
				endpoint: "codex-pro",
				model: "gpt-5.4-mini",
				thinkingLevel: "low",
			},
		});
		deepStrictEqual(normalized.runtimePlugins, ["example-runtime"]);
		deepStrictEqual(normalized.scope, ["codex-pro", "codex-pro/gpt-5.4-mini"]);
	});

	it("classifies compaction setting changes as next-turn updates", () => {
		const prev = structuredClone(DEFAULT_SETTINGS);
		const next = structuredClone(DEFAULT_SETTINGS);
		next.compaction.auto = false;
		next.compaction.threshold = 0.9;
		const diff = diffSettings(prev, next);
		deepStrictEqual(diff.hotReload, []);
		deepStrictEqual(diff.restartRequired, []);
		deepStrictEqual(diff.nextTurn.sort(), ["compaction.auto", "compaction.threshold"]);
	});

	it("normalizes retry settings and classifies them as next-turn updates", () => {
		const normalized = normalizeSettings({
			retry: {
				enabled: false,
				maxRetries: 2.8,
				baseDelayMs: 100,
				maxDelayMs: 1000,
			},
		});
		strictEqual(normalized.retry.enabled, false);
		strictEqual(normalized.retry.maxRetries, 2);
		strictEqual(normalized.retry.baseDelayMs, 100);
		strictEqual(normalized.retry.maxDelayMs, 1000);

		const prev = structuredClone(DEFAULT_SETTINGS);
		const next = structuredClone(DEFAULT_SETTINGS);
		next.retry.enabled = false;
		const diff = diffSettings(prev, next);
		deepStrictEqual(diff.hotReload, []);
		deepStrictEqual(diff.restartRequired, []);
		deepStrictEqual(diff.nextTurn, ["retry.enabled"]);
	});
});
