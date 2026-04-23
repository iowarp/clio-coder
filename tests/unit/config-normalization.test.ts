import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeSettings } from "../../src/core/config.js";

describe("core/config normalizeSettings", () => {
	it("drops stale provider-era keys and repairs endpoint pointers", () => {
		const normalized = normalizeSettings({
			identity: "clio",
			endpoints: [
				{
					id: "codex-pro",
					runtime: "openai-codex",
					wireModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4"],
				},
			],
			runtimePlugins: ["example-runtime", "example-runtime", ""],
			orchestrator: {
				endpoint: "missing-endpoint",
				model: "stale-model",
				thinkingLevel: "xhigh",
			},
			workers: {
				default: {
					endpoint: "codex-pro",
					model: "",
					thinkingLevel: "medium",
				},
			},
			scope: ["codex-pro", "missing-endpoint", "codex-pro/gpt-5.4-mini", "codex-pro"],
			providers: [{ id: "legacy-provider" }],
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

	it("scrapes legacy provider yaml into endpoints and active targets", () => {
		const normalized = normalizeSettings({
			providers: {
				llamacpp: {
					endpoints: {
						mini: {
							url: "http://127.0.0.1:8080",
							default_model: "Qwen3.6-35B-A3B-UD-Q4_K_XL",
						},
					},
				},
				lmstudio: {
					endpoints: {
						dynamo: {
							url: "http://127.0.0.1:1234",
							default_model: "qwen3.6-35b-a3b",
						},
					},
				},
			},
			provider: {
				active: "llamacpp",
				model: "Qwen3.6-35B-A3B-UD-Q4_K_XL",
				scope: ["llamacpp", "lmstudio/qwen3.6-35b-a3b"],
			},
			orchestrator: {
				provider: "llamacpp",
				endpoint: "mini",
				model: "Qwen3.6-35B-A3B-UD-Q4_K_XL",
			},
			workers: {
				default: {
					provider: "llamacpp",
					endpoint: "mini",
					model: "Qwen3.6-35B-A3B-UD-Q4_K_XL",
					thinkingLevel: "medium",
				},
			},
		});

		deepStrictEqual(
			normalized.endpoints.map((endpoint) => [endpoint.id, endpoint.runtime, endpoint.defaultModel]),
			[
				["mini", "llamacpp", "Qwen3.6-35B-A3B-UD-Q4_K_XL"],
				["dynamo", "lmstudio", "qwen3.6-35b-a3b"],
			],
		);
		strictEqual(normalized.orchestrator.endpoint, "mini");
		strictEqual(normalized.orchestrator.model, "Qwen3.6-35B-A3B-UD-Q4_K_XL");
		strictEqual(normalized.workers.default.endpoint, "mini");
		strictEqual(normalized.workers.default.model, "Qwen3.6-35B-A3B-UD-Q4_K_XL");
		deepStrictEqual(normalized.scope, ["mini", "dynamo/qwen3.6-35b-a3b"]);
	});
});
