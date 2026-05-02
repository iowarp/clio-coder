import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	ensureResidentModel,
	type ResidentModelClient,
	type ResidentModelEntry,
	resetResidentCache,
} from "../../src/engine/apis/lmstudio-native.js";
import {
	type EvictGenerateRequest,
	type EvictResidentResponse,
	evictOtherOllamaModels,
	type OllamaEvictClient,
} from "../../src/engine/apis/ollama-native.js";

interface UnloadSpy {
	calls: number;
	unload(): Promise<void>;
}

function makeUnloadSpy(): UnloadSpy {
	const spy: UnloadSpy = {
		calls: 0,
		unload: async () => {
			spy.calls += 1;
		},
	};
	return spy;
}

interface FakeLmStudioClient extends ResidentModelClient {
	listLoadedCalls: number;
	entries: ReadonlyArray<ResidentModelEntry>;
}

function makeFakeLmStudio(entries: ReadonlyArray<ResidentModelEntry>): FakeLmStudioClient {
	const client = {
		listLoadedCalls: 0,
		entries,
		llm: {
			listLoaded: async (): Promise<ReadonlyArray<ResidentModelEntry>> => {
				client.listLoadedCalls += 1;
				return client.entries;
			},
		},
	};
	return client;
}

describe("engine/lmstudio-native ensureResidentModel", () => {
	beforeEach(() => {
		resetResidentCache();
	});

	it("leaves resident LM Studio models alone by default", async () => {
		const stale = makeUnloadSpy();
		const active = makeUnloadSpy();
		const entries: ResidentModelEntry[] = [
			{ modelKey: "stale", unload: stale.unload },
			{ modelKey: "active", unload: active.unload },
		];
		const client = makeFakeLmStudio(entries);

		await ensureResidentModel(client, "ws://test", "active");

		strictEqual(stale.calls, 0, "user-managed endpoints must not unload stale models");
		strictEqual(active.calls, 0, "active must never be unloaded");
		strictEqual(client.listLoadedCalls, 0, "user-managed endpoints should not inspect resident models");
	});

	it("evicts non-target loaded models when Clio owns lifecycle", async () => {
		const stale1 = makeUnloadSpy();
		const stale2 = makeUnloadSpy();
		const active = makeUnloadSpy();
		const entries: ResidentModelEntry[] = [
			{ modelKey: "stale-1", unload: stale1.unload },
			{ modelKey: "stale-2", unload: stale2.unload },
			{ modelKey: "active", unload: active.unload },
		];
		const client = makeFakeLmStudio(entries);

		await ensureResidentModel(client, "ws://test", "active", { lifecycle: "clio-managed" });

		strictEqual(stale1.calls, 1, "stale-1 must be unloaded once");
		strictEqual(stale2.calls, 1, "stale-2 must be unloaded once");
		strictEqual(active.calls, 0, "active must never be unloaded");
		strictEqual(client.listLoadedCalls, 1, "listLoaded must fire once on first call");
	});

	it("skips listLoaded inside the 60s TTL and refires after expiry", async () => {
		const active: ResidentModelEntry = { modelKey: "active", unload: async () => {} };
		const client = makeFakeLmStudio([active]);
		let nowMs = 1_000_000;
		const now = (): number => nowMs;

		await ensureResidentModel(client, "ws://cache", "active", { lifecycle: "clio-managed" }, now);
		strictEqual(client.listLoadedCalls, 1, "first call hits the server");

		nowMs += 30_000;
		await ensureResidentModel(client, "ws://cache", "active", { lifecycle: "clio-managed" }, now);
		strictEqual(client.listLoadedCalls, 1, "second call within TTL must skip listLoaded");

		nowMs += 31_000;
		await ensureResidentModel(client, "ws://cache", "active", { lifecycle: "clio-managed" }, now);
		strictEqual(client.listLoadedCalls, 2, "third call past TTL must refire listLoaded");
	});
});

interface FakeOllamaClient extends OllamaEvictClient {
	psCalls: number;
	generateCalls: EvictGenerateRequest[];
}

function makeFakeOllama(response: EvictResidentResponse): FakeOllamaClient {
	const client: FakeOllamaClient = {
		psCalls: 0,
		generateCalls: [],
		ps: async () => {
			client.psCalls += 1;
			return response;
		},
		generate: async (req) => {
			client.generateCalls.push(req);
			return undefined;
		},
	};
	return client;
}

describe("engine/ollama-native evictOtherOllamaModels", () => {
	it("fires keep_alive=0 against every non-target resident model", async () => {
		const client = makeFakeOllama({
			models: [
				{ model: "a", name: "a:7b" },
				{ model: "b", name: "b:7b" },
				{ model: "c", name: "c:7b" },
			],
		});

		await evictOtherOllamaModels("http://h", "b", undefined, client);

		strictEqual(client.psCalls, 1, "ps() must fire once");
		strictEqual(client.generateCalls.length, 2, "generate must fire for each non-target model");
		const evicted = client.generateCalls.map((req) => req.model).sort();
		deepStrictEqual(evicted, ["a", "c"], "only non-target models should be evicted");
		ok(
			client.generateCalls.every((req) => req.keep_alive === 0 && req.prompt === "" && req.stream === false),
			"every eviction must use keep_alive=0, empty prompt, and stream=false",
		);
		ok(
			client.generateCalls.every((req) => req.model !== "b"),
			"the keep target must never be evicted",
		);
	});
});
