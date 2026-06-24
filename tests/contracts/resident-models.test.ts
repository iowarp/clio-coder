import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type EvictResidentResponse,
	listResidentOllamaModels,
	type OllamaEvictClient,
} from "../../src/engine/apis/ollama-native.js";
import { type ResidentModelInfo, residentMatchesKeep } from "../../src/engine/apis/resident-models.js";

function fakeOllamaClient(resident: EvictResidentResponse, calls: { unloaded: string[] }): OllamaEvictClient {
	return {
		ps: async () => resident,
		generate: async (req) => {
			if (req.keep_alive === 0) calls.unloaded.push(req.model);
			return {};
		},
	};
}

describe("ollama resident listing", () => {
	it("maps /api/ps entries to resident info and preserves VRAM and total size", async () => {
		const client = fakeOllamaClient(
			{
				models: [
					{ model: "qwen3.6:27b", name: "qwen3.6:27b", size_vram: 19_535_700_320, size: 20_000_000_000 },
					{ model: "", name: "gemma:4b", size_vram: 3_000_000_000 },
				],
			},
			{ unloaded: [] },
		);
		const resident = await listResidentOllamaModels(client);
		deepStrictEqual(resident, [
			{ modelId: "qwen3.6:27b", sizeVramBytes: 19_535_700_320, sizeBytes: 20_000_000_000 },
			{ modelId: "gemma:4b", sizeVramBytes: 3_000_000_000 },
		]);
	});

	it("omits sizes the server does not report rather than inventing zeros", async () => {
		const client = fakeOllamaClient({ models: [{ model: "m", name: "m" }] }, { unloaded: [] });
		const resident = await listResidentOllamaModels(client);
		deepStrictEqual(resident, [{ modelId: "m" }]);
	});

	it("records a divergent model/name pair as aliases", async () => {
		const client = fakeOllamaClient(
			{ models: [{ model: "registry/qwen:latest", name: "qwen:latest" }] },
			{ unloaded: [] },
		);
		const resident = await listResidentOllamaModels(client);
		deepStrictEqual(resident, [{ modelId: "registry/qwen:latest", aliasIds: ["qwen:latest"] }]);
	});
});

describe("resident keep matching", () => {
	it("keeps a model when the keep target matches modelId or any alias", () => {
		const entry: ResidentModelInfo = { modelId: "registry/qwen:latest", aliasIds: ["qwen:latest"] };
		strictEqual(residentMatchesKeep(entry, "registry/qwen:latest"), true);
		strictEqual(residentMatchesKeep(entry, "qwen:latest"), true, "matching the name alias must keep the model");
		strictEqual(residentMatchesKeep(entry, "something-else"), false);
	});
});
