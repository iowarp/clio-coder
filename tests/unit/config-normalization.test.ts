import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeSettings } from "../../src/core/config.js";

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
			},
			scope: ["codex-pro", "missing-target", "codex-pro/gpt-5.4-mini", "codex-pro"],
		});

		strictEqual(normalized.endpoints[0]?.defaultModel, "gpt-5.4");
		deepStrictEqual(normalized.endpoints[0]?.wireModels, ["gpt-5.4", "gpt-5.4-mini"]);
		strictEqual(normalized.orchestrator.endpoint, null);
		strictEqual(normalized.orchestrator.model, null);
		strictEqual(normalized.workers.default.endpoint, "codex-pro");
		strictEqual(normalized.workers.default.model, "gpt-5.4");
		deepStrictEqual(normalized.runtimePlugins, ["example-runtime"]);
		deepStrictEqual(normalized.scope, ["codex-pro", "codex-pro/gpt-5.4-mini"]);
	});
});
