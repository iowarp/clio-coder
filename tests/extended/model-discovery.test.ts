import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { chatPickerModels } from "../../src/cli/configure-target.js";
import type { TargetStatus } from "../../src/domains/providers/contract.js";
import {
	canonicalizeWireModelId,
	chatModelCandidatesForStatus,
	hasLiveModelCatalog,
	modelOfferForStatus,
} from "../../src/domains/providers/model-discovery.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";

function makeStatus(source?: TargetStatus["discoveredModelsSource"], models: string[] = ["model-a"]): TargetStatus {
	return {
		target: { id: "test-target", runtime: "test-runtime", defaultModel: "model-a" },
		runtime: null,
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: EMPTY_CAPABILITIES,
		discoveredModels: models,
		...(source !== undefined ? { discoveredModelsSource: source } : {}),
	};
}

describe("contracts/model-discovery", () => {
	it("treats only successful probe sources as live catalogs", () => {
		strictEqual(hasLiveModelCatalog(makeStatus("probe")), true);
		strictEqual(hasLiveModelCatalog(makeStatus("cache")), false);
	});

	it("does not treat an undefined source as a live catalog even with nonempty models", () => {
		strictEqual(hasLiveModelCatalog(makeStatus(undefined, ["model-a", "model-b"])), false);
	});

	it("does not treat none or runtime sources as live catalogs", () => {
		strictEqual(hasLiveModelCatalog(makeStatus("none")), false);
		strictEqual(hasLiveModelCatalog(makeStatus("runtime")), false);
	});

	it("keeps embedding models out of chat pickers but accepts one named explicitly", () => {
		const models = [
			"dynamo/qwen3.8-27b",
			"dynamo/text-embedding-nomic-embed-text-v2",
			"bge-m3",
			"zbook/nomic-embed-text-GGUF",
		];
		const modelCapabilities = { "bge-m3": { chat: false, embeddings: true }, "dynamo/qwen3.8-27b": { chat: true } };
		deepStrictEqual(chatPickerModels({ models, modelCapabilities }), ["dynamo/qwen3.8-27b"]);
		const status: TargetStatus = {
			...makeStatus("probe", models),
			target: { id: "gw", runtime: "litellm", defaultModel: "zbook/nomic-embed-text-GGUF" },
			probeModelCapabilities: modelCapabilities,
		};
		deepStrictEqual(
			chatModelCandidatesForStatus(status).map((candidate) => candidate.id),
			["dynamo/qwen3.8-27b", "zbook/nomic-embed-text-GGUF"],
		);
		strictEqual(canonicalizeWireModelId(status, "bge-m3"), "bge-m3");
	});

	it("refuses a model the live list lacks, naming the listed ids; a cached list or a local engine never refuses", () => {
		const seat = (tier: RuntimeDescriptor["tier"], source: TargetStatus["discoveredModelsSource"]): TargetStatus => ({
			...makeStatus(source, ["gpt-6.1-terra", "gpt-6.2-sol", "claude-opus-5.5", "claude-sonnet-4-20250514"]),
			runtime: {
				id: "copilot-sdk",
				kind: "http",
				tier,
				probe: async () => ({ ok: true }),
			} as unknown as RuntimeDescriptor,
		});
		deepStrictEqual(modelOfferForStatus(seat("subscription", "probe"), "gpt-6.2-terra"), {
			kind: "not-offered",
			available: ["gpt-6.1-terra", "gpt-6.2-sol", "claude-opus-5.5", "claude-sonnet-4-20250514"],
		});
		deepStrictEqual(modelOfferForStatus(seat("subscription", "probe"), "gpt-6.1-terra"), { kind: "offered" });
		deepStrictEqual(modelOfferForStatus(seat("cloud", "probe"), "claude-sonnet-4-0"), { kind: "offered" });
		deepStrictEqual(modelOfferForStatus(seat("subscription", "cache"), "gpt-6.2-terra"), { kind: "unknown" });
		deepStrictEqual(modelOfferForStatus(seat("local-native", "probe"), "gpt-6.2-terra"), { kind: "unknown" });
		// Only aliases of one model match: another version or another pinned snapshot is another model.
		const pinned = (id: string) =>
			modelOfferForStatus({ ...seat("cloud", "probe"), discoveredModels: ["gpt-5.1", "gpt-4o-2024-05-13"] }, id).kind;
		strictEqual(pinned("gpt-5"), "not-offered");
		strictEqual(pinned("gpt-4o-2024-08-06"), "not-offered");
		strictEqual(pinned("gpt-4o"), "offered");
		strictEqual(pinned("gpt-5.1-latest"), "offered");
	});
});
