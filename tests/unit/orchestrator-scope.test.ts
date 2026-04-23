import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { advanceScopedTarget, advanceThinkingLevel } from "../../src/entry/orchestrator.js";

describe("entry/orchestrator advanceScopedTarget", () => {
	it("cycles endpoint/model refs and preserves endpoint-level current model", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.endpoints = [
			{ id: "openai", runtime: "openai-codex", defaultModel: "gpt-5.4" },
			{ id: "local", runtime: "lmstudio-native", defaultModel: "qwq-local" },
		];
		settings.scope = ["openai/gpt-5.4-mini", "local", "openai"];
		settings.orchestrator.endpoint = "openai";
		settings.orchestrator.model = "gpt-5.4-mini";

		deepStrictEqual(advanceScopedTarget(settings, "forward"), {
			endpoint: "local",
			model: "qwq-local",
		});

		settings.orchestrator.endpoint = "openai";
		settings.orchestrator.model = "gpt-5.4";
		deepStrictEqual(advanceScopedTarget(settings, "forward"), {
			endpoint: "openai",
			model: "gpt-5.4-mini",
		});

		settings.orchestrator.endpoint = "local";
		settings.orchestrator.model = "qwq-local";
		deepStrictEqual(advanceScopedTarget(settings, "backward"), {
			endpoint: "openai",
			model: "gpt-5.4-mini",
		});
	});
});

describe("entry/orchestrator advanceThinkingLevel", () => {
	it("cycles within the runtime-supported subset", () => {
		deepStrictEqual(advanceThinkingLevel("high", ["off", "minimal", "low", "medium", "high"]), "off");
		deepStrictEqual(advanceThinkingLevel("high", ["off", "minimal", "low", "medium", "high", "xhigh"]), "xhigh");
		deepStrictEqual(advanceThinkingLevel("xhigh", ["off", "minimal", "low", "medium", "high"]), "off");
	});
});
