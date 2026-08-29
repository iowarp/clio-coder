import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BusChannels, type ResidencyMutationPayload } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { protectedResidencyModelIds, protectedResidencyModels } from "../../src/core/residency-protection.js";
import { residencyTargetKey } from "../../src/core/residency-target-key.js";
import { getSharedBus } from "../../src/core/shared-bus.js";
import {
	decideResidency,
	markClioLoaded,
	type ResidencyAdapter,
	type ResidencyNotice,
	reconcileResidency,
	resetResidencyState,
	residencyManaged,
	residencyManagedFor,
	setProtectedModelsProvider,
	setResidencyNoticeSink,
} from "../../src/engine/apis/residency.js";

const GIB = 1024 ** 3;

function baseAdapter(overrides: Partial<ResidencyAdapter> = {}): ResidencyAdapter {
	return {
		targetKey: "ollama-native|http://127.0.0.1:11434",
		targetId: "local",
		runtimeId: "ollama-native",
		keepModelId: "new-model",
		managed: true,
		strategy: "scheduler",
		listResident: async () => [],
		unload: async () => {},
		withLock: async (_targetKey, fn) => fn(),
		...overrides,
	};
}

describe("contracts/model residency decision", () => {
	beforeEach(() => {
		resetResidencyState();
	});

	afterEach(() => {
		setResidencyNoticeSink(null);
		setProtectedModelsProvider(null);
		resetResidencyState();
	});

	it("co-hosts within known capacity: keep-not-resident loads without evicting anything", () => {
		const plan = decideResidency({
			targetId: "mini",
			runtimeId: "llamacpp",
			keepModelId: "coder",
			managed: true,
			strategy: "router",
			capacity: 2,
			resident: [
				{ modelId: "scout", loadedByClio: false, tags: ["role:scout", "pinned:true"] as string[], protection: "tag" },
			],
		});

		strictEqual(plan.decision, "reconcile");
		deepStrictEqual(plan.evict, []);
		strictEqual(plan.keepResident, false);
		strictEqual(plan.notices[0]?.kind, "co-resident");
		strictEqual(plan.notices[0]?.level, "info");
	});

	it("keep-resident never evicts co-residents, whoever loaded them", () => {
		const plan = decideResidency({
			targetId: "mini",
			runtimeId: "llamacpp",
			keepModelId: "scout",
			managed: true,
			strategy: "router",
			capacity: 2,
			resident: [
				{ modelId: "scout", loadedByClio: false, protection: "tag" },
				{ modelId: "coder", loadedByClio: false },
			],
		});

		strictEqual(plan.decision, "reconcile");
		strictEqual(plan.keepResident, true);
		deepStrictEqual(plan.evict, []);
		deepStrictEqual(plan.fallbackEvict, []);
		strictEqual(plan.notices[0]?.kind, "co-resident");
	});

	it("capacity-full eviction chooses a non-protected resident and spares protected ones", () => {
		const plan = decideResidency({
			targetId: "mini",
			runtimeId: "llamacpp",
			keepModelId: "third-model",
			managed: true,
			strategy: "router",
			capacity: 2,
			resident: [
				{ modelId: "scout", loadedByClio: false, protection: "tag" },
				{ modelId: "old-code", loadedByClio: false },
			],
		});

		strictEqual(plan.decision, "reconcile");
		deepStrictEqual(
			plan.evict.map((entry) => entry.modelId),
			["old-code"],
		);
		strictEqual(plan.notices.at(-1)?.kind, "swap");
	});

	it("capacity-full falls back to a config-protected resident only when nothing unprotected is left, with a warning", () => {
		const plan = decideResidency({
			targetId: "mini",
			runtimeId: "llamacpp",
			keepModelId: "third-model",
			managed: true,
			strategy: "router",
			capacity: 2,
			resident: [
				{ modelId: "scout", loadedByClio: false, protection: "tag" },
				{ modelId: "configured-coder", loadedByClio: false, protection: "config" },
			],
		});

		strictEqual(plan.decision, "reconcile");
		deepStrictEqual(
			plan.evict.map((entry) => entry.modelId),
			["configured-coder"],
		);
		strictEqual(plan.notices.at(-1)?.kind, "swap");
		strictEqual(plan.notices.at(-1)?.level, "warning");
		deepStrictEqual(plan.notices.at(-1)?.detail, { swappedOut: "configured-coder", configProtected: true });
	});

	it("declines when every slot holds a tag-pinned model", () => {
		const plan = decideResidency({
			targetId: "mini",
			runtimeId: "llamacpp",
			keepModelId: "third-model",
			managed: true,
			strategy: "router",
			capacity: 2,
			resident: [
				{ modelId: "scout", loadedByClio: false, protection: "tag" },
				{ modelId: "pinned-coder", loadedByClio: false, protection: "tag" },
			],
		});

		strictEqual(plan.decision, "decline");
		deepStrictEqual(plan.evict, []);
		strictEqual(plan.notices.at(-1)?.kind, "will-not-fit");
		strictEqual(plan.notices.at(-1)?.level, "error");
	});

	it("never evicts a config-protected resident for a keep model that will come back tag-pinned (#72)", () => {
		const plan = decideResidency({
			targetId: "mini",
			runtimeId: "llamacpp",
			keepModelId: "MiniCPM",
			managed: true,
			strategy: "router",
			capacity: 1,
			keepTagProtected: true,
			resident: [{ modelId: "Nemo-3.5-Lightning", loadedByClio: false, protection: "config", role: "worker" }],
		});

		strictEqual(plan.decision, "decline");
		deepStrictEqual(plan.evict, []);
		strictEqual(plan.notices.at(-1)?.kind, "will-not-fit");
		strictEqual(plan.notices.at(-1)?.level, "error");
		strictEqual(plan.notices.at(-1)?.detail?.configProtected, true);
		strictEqual(plan.notices.at(-1)?.detail?.role, "worker");
		strictEqual(
			plan.notices.at(-1)?.message.includes("'Nemo-3.5-Lightning' (a worker model)"),
			true,
			plan.notices.at(-1)?.message,
		);
	});

	it("a tag-pinned keep model may still take an unprotected slot", () => {
		const plan = decideResidency({
			targetId: "mini",
			runtimeId: "llamacpp",
			keepModelId: "MiniCPM",
			managed: true,
			strategy: "router",
			capacity: 2,
			keepTagProtected: true,
			resident: [
				{ modelId: "configured-coder", loadedByClio: false, protection: "config" },
				{ modelId: "scratch", loadedByClio: true },
			],
		});

		strictEqual(plan.decision, "reconcile");
		deepStrictEqual(
			plan.evict.map((entry) => entry.modelId),
			["scratch"],
		);
	});

	it("router without readable capacity conservatively swaps only unprotected residents", () => {
		const plan = decideResidency({
			targetId: "mini",
			runtimeId: "llamacpp",
			keepModelId: "new-code",
			managed: true,
			strategy: "router",
			resident: [
				{ modelId: "scout", loadedByClio: false, protection: "tag" },
				{ modelId: "old-code", loadedByClio: false },
				{ modelId: "configured", loadedByClio: false, protection: "config" },
			],
		});

		strictEqual(plan.decision, "reconcile");
		deepStrictEqual(
			plan.evict.map((entry) => entry.modelId),
			["old-code"],
		);
	});

	it("jit strategy evicts nothing up front and ranks fallback candidates unprotected-first", () => {
		const plan = decideResidency({
			targetId: "dynamo",
			runtimeId: "lmstudio",
			keepModelId: "worker-model",
			managed: true,
			strategy: "jit",
			resident: [
				{ modelId: "configured-orch", loadedByClio: false, protection: "config" },
				{ modelId: "operator-model", loadedByClio: false },
			],
		});

		strictEqual(plan.decision, "reconcile");
		deepStrictEqual(plan.evict, []);
		deepStrictEqual(
			plan.fallbackEvict.map((entry) => entry.modelId),
			["operator-model", "configured-orch"],
		);
	});

	it("scheduler strategy releases only Clio's own unprotected stragglers", () => {
		const plan = decideResidency({
			targetId: "local",
			runtimeId: "ollama-native",
			keepModelId: "new-model",
			managed: true,
			strategy: "scheduler",
			resident: [
				{ modelId: "clio-straggler", loadedByClio: true },
				{ modelId: "operator-model", loadedByClio: false },
				{ modelId: "configured", loadedByClio: true, protection: "config" },
			],
		});

		strictEqual(plan.decision, "reconcile");
		deepStrictEqual(
			plan.evict.map((entry) => entry.modelId),
			["clio-straggler"],
		);
		strictEqual(plan.notices.at(-1)?.kind, "about-to-evict");
	});

	it("observe-only opt-out never evicts and still reports", () => {
		const plan = decideResidency({
			targetId: "local",
			runtimeId: "lmstudio",
			keepModelId: "new-model",
			managed: false,
			strategy: "jit",
			resident: [{ modelId: "operator-model", loadedByClio: false }],
		});

		strictEqual(plan.decision, "observe");
		deepStrictEqual(plan.evict, []);
		deepStrictEqual(plan.fallbackEvict, []);
	});

	it("emits stress notices for context overflow, CPU/GPU split residents, and over-capacity stacks", () => {
		const plan = decideResidency({
			targetId: "local",
			runtimeId: "llamacpp",
			keepModelId: "coder",
			managed: true,
			strategy: "router",
			capacity: 2,
			contextLength: 262_144,
			modelMaxContext: 131_072,
			resident: [
				{ modelId: "coder", loadedByClio: false },
				{ modelId: "split-model", loadedByClio: false, sizeVramBytes: 12 * GIB, sizeBytes: 20 * GIB },
				{ modelId: "extra", loadedByClio: false },
			],
		});

		deepStrictEqual(
			plan.notices.map((notice) => notice.kind),
			["stress", "stress", "stress"],
		);
		deepStrictEqual(plan.notices[0]?.detail, { requestedContext: 262_144, modelMaxContext: 131_072 });
		deepStrictEqual(plan.notices[1]?.detail, { residentVramBytes: 12 * GIB, residentTotalBytes: 20 * GIB });
		deepStrictEqual(plan.notices[2]?.detail, { residentCount: 3, maxInstances: 2 });
	});
});

describe("contracts/model residency reconciler", () => {
	beforeEach(() => {
		resetResidencyState();
	});

	afterEach(() => {
		setResidencyNoticeSink(null);
		setProtectedModelsProvider(null);
		resetResidencyState();
	});

	it("unloads Clio-loaded stragglers, emits notices, and TTL-skips repeat reconciles", async () => {
		const notices: ResidencyNotice[] = [];
		const unloaded: string[] = [];
		let listCalls = 0;
		let now = 1_000;
		const targetKey = "ollama-native|http://127.0.0.1:11434";
		markClioLoaded(targetKey, "old-model");
		setResidencyNoticeSink((notice) => notices.push(notice));

		const adapter = baseAdapter({
			targetKey,
			now: () => now,
			ttlMs: 10_000,
			listResident: async () => {
				listCalls += 1;
				return [{ modelId: "old-model", sizeVramBytes: 4 * GIB }];
			},
			unload: async (modelId) => {
				unloaded.push(modelId);
			},
		});

		const first = await reconcileResidency(adapter);
		strictEqual(first.decision, "reconcile");
		deepStrictEqual(unloaded, ["old-model"]);
		strictEqual(notices[0]?.kind, "about-to-evict");
		strictEqual(listCalls, 1);

		now += 100;
		const second = await reconcileResidency(adapter);
		strictEqual(second.decision, "reconcile");
		strictEqual(second.keepResident, true);
		strictEqual(listCalls, 1, "TTL hit must avoid another resident-list probe");
	});

	it("publishes successful loads and evictions with the normalized endpoint key", async () => {
		const mutations: ResidencyMutationPayload[] = [];
		const unsubscribe = getSharedBus().on(BusChannels.ResidencyMutation, (payload) => {
			mutations.push(payload);
		});
		const targetKey = residencyTargetKey("llamacpp", "http://mini:8080/v1/");
		try {
			await reconcileResidency(
				baseAdapter({
					targetKey,
					targetId: "mini",
					runtimeId: "llamacpp",
					strategy: "router",
					capacity: async () => 1,
					listResident: async () => [{ modelId: "old-model" }],
					unload: async () => {},
					load: async () => {},
				}),
			);
		} finally {
			unsubscribe();
		}

		deepStrictEqual(
			mutations.map(({ at: _at, ...mutation }) => mutation),
			[
				{
					targetKey: "llamacpp|http://mini:8080",
					targetId: "mini",
					runtimeId: "llamacpp",
					model: "old-model",
					operation: "evict",
				},
				{
					targetKey: "llamacpp|http://mini:8080",
					targetId: "mini",
					runtimeId: "llamacpp",
					model: "new-model",
					operation: "load",
				},
			],
		);
		strictEqual(
			mutations.every((mutation) => Number.isFinite(mutation.at)),
			true,
		);
	});

	it("does not publish failed or no-op residency mutations", async () => {
		const mutations: ResidencyMutationPayload[] = [];
		const unsubscribe = getSharedBus().on(BusChannels.ResidencyMutation, (payload) => {
			mutations.push(payload);
		});
		try {
			await reconcileResidency(
				baseAdapter({
					targetKey: "failed-mutation",
					strategy: "router",
					capacity: async () => 1,
					listResident: async () => [{ modelId: "old-model" }],
					unload: async () => {
						throw new Error("busy");
					},
				}),
			);
			await reconcileResidency(
				baseAdapter({
					targetKey: "already-resident",
					listResident: async () => [{ modelId: "new-model" }],
					load: async () => {},
				}),
			);
		} finally {
			unsubscribe();
		}

		deepStrictEqual(mutations, []);
	});

	it("classifies configured models as protected via the provider, including worker processes' view", async () => {
		setProtectedModelsProvider(() => ["orchestrator-coder"]);
		const notices: ResidencyNotice[] = [];
		const unloaded: string[] = [];
		setResidencyNoticeSink((notice) => notices.push(notice));

		// A fresh process has an empty Clio-loaded registry, so the resident
		// coder looks foreign; config protection must still spare it.
		const plan = await reconcileResidency(
			baseAdapter({
				targetKey: "lmstudio|http://dynamo:1234",
				runtimeId: "lmstudio",
				strategy: "jit",
				keepModelId: "worker-model",
				listResident: async () => [{ modelId: "orchestrator-coder" }, { modelId: "operator-model" }],
				unload: async (modelId) => {
					unloaded.push(modelId);
				},
			}),
		);

		strictEqual(plan.decision, "reconcile");
		deepStrictEqual(unloaded, [], "jit strategy must not evict before a failed load");
		deepStrictEqual(
			plan.fallbackEvict.map((entry) => entry.modelId),
			["operator-model", "orchestrator-coder"],
			"config-protected resident ranks last among fallback candidates",
		);
	});

	it("serializes mutations through the adapter lock", async () => {
		const order: string[] = [];
		markClioLoaded("target", "old-model");
		await reconcileResidency(
			baseAdapter({
				targetKey: "target",
				listResident: async () => [{ modelId: "old-model" }],
				unload: async (modelId) => {
					order.push(`unload:${modelId}`);
				},
				withLock: async (targetKey, fn) => {
					order.push(`lock:${targetKey}`);
					const result = await fn();
					order.push("unlock");
					return result;
				},
			}),
		);
		deepStrictEqual(order, ["lock:target", "unload:old-model", "unlock"]);
	});

	it("degrades list and unload failures instead of throwing into the turn", async () => {
		const unreachable = await reconcileResidency(
			baseAdapter({
				listResident: async () => {
					throw new Error("offline");
				},
			}),
		);
		strictEqual(unreachable.decision, "observe");

		markClioLoaded("target", "old-model");
		const unloadFailure = await reconcileResidency(
			baseAdapter({
				targetKey: "target",
				listResident: async () => [{ modelId: "old-model" }],
				unload: async () => {
					throw new Error("busy");
				},
			}),
		);
		strictEqual(unloadFailure.decision, "reconcile");
		deepStrictEqual(
			unloadFailure.evict.map((entry) => entry.modelId),
			["old-model"],
		);
	});

	it("caches an opt-out observation so its notices dedupe per TTL", async () => {
		const notices: ResidencyNotice[] = [];
		setResidencyNoticeSink((notice) => notices.push(notice));
		let listCalls = 0;
		let now = 1_000;
		const adapter = baseAdapter({
			managed: false,
			now: () => now,
			ttlMs: 10_000,
			contextLength: 262_144,
			modelMaxContext: 131_072,
			listResident: async () => {
				listCalls += 1;
				return [{ modelId: "operator-model" }];
			},
		});

		const first = await reconcileResidency(adapter);
		strictEqual(first.decision, "observe");
		strictEqual(notices.length, 1);

		now += 100;
		const second = await reconcileResidency(adapter);
		strictEqual(second.decision, "observe");
		strictEqual(listCalls, 1);
		strictEqual(notices.length, 1);
	});

	it("uses the CLIO_CODER_RESIDENCY opt-out as the process-wide observe-only switch", () => {
		strictEqual(residencyManaged({}), true);
		strictEqual(residencyManaged({ CLIO_CODER_RESIDENCY: "observe" }), false);
		strictEqual(residencyManaged({ CLIO_CODER_RESIDENCY: "user-managed" }), false);
		strictEqual(residencyManaged({ CLIO_CODER_RESIDENCY: "clio-managed" }), true);
	});

	it("honors the explicit per-target lifecycle opt-out alongside the env switch", () => {
		strictEqual(residencyManagedFor(undefined, {}), true);
		strictEqual(residencyManagedFor("clio-managed", {}), true);
		strictEqual(residencyManagedFor("user-managed", {}), false);
		strictEqual(residencyManagedFor("clio-managed", { CLIO_CODER_RESIDENCY: "observe" }), false);
	});
});

describe("contracts/residency-protection settings extraction", () => {
	it("collects orchestrator, background, worker, and target default model ids", () => {
		const settings = {
			...DEFAULT_SETTINGS,
			targets: [
				{ id: "mini", runtime: "llamacpp", defaultModel: "Qwopus3.6-35B" },
				{ id: "dynamo", runtime: "lmstudio" },
			],
			orchestrator: { ...DEFAULT_SETTINGS.orchestrator, target: "mini", model: "Qwopus3.6-35B" },
			background: { ...DEFAULT_SETTINGS.background, target: "dynamo", model: "memory-small" },
			workers: {
				...DEFAULT_SETTINGS.workers,
				default: { target: "dynamo", model: "qwopus3.6-27b-coder-mtp", thinkingLevel: "off" as const },
				profiles: {
					scout: { target: "mini", model: "MiniCPM5-1B", thinkingLevel: "off" as const },
					empty: { target: null, model: null, thinkingLevel: "off" as const },
				},
			},
		};

		deepStrictEqual(protectedResidencyModelIds(settings), [
			"Qwopus3.6-35B",
			"memory-small",
			"qwopus3.6-27b-coder-mtp",
			"MiniCPM5-1B",
		]);
	});

	it("tags each configured id with the plane that references it", () => {
		const settings = {
			...DEFAULT_SETTINGS,
			targets: [{ id: "dynamo", runtime: "lmstudio", defaultModel: "target-default-model" }],
			orchestrator: { ...DEFAULT_SETTINGS.orchestrator, target: "dynamo", model: "chat-model" },
			background: { ...DEFAULT_SETTINGS.background, target: "dynamo", model: "memory-model" },
			workers: {
				...DEFAULT_SETTINGS.workers,
				default: { target: "dynamo", model: "worker-model", thinkingLevel: "off" as const },
			},
		};

		deepStrictEqual(protectedResidencyModels(settings), [
			{ modelId: "chat-model", role: "chat" },
			{ modelId: "memory-model", role: "memory" },
			{ modelId: "worker-model", role: "worker" },
			{ modelId: "target-default-model", role: "target-default" },
		]);
	});
});

describe("contracts/model residency role protection", () => {
	afterEach(() => {
		setResidencyNoticeSink(null);
		setProtectedModelsProvider(null);
		resetResidencyState();
	});

	/**
	 * The defect this pins: a chat-model switch that frees a slot used to read as
	 * an anonymous eviction, so unloading the model serving proactive memory was
	 * indistinguishable from unloading a spare. The role travels with the id and
	 * lands in both the message and the notice detail.
	 */
	it("names the role of a config-protected resident it is forced to evict", async () => {
		const notices: ResidencyNotice[] = [];
		setResidencyNoticeSink((notice) => notices.push(notice));
		setProtectedModelsProvider(() => [{ modelId: "memory-small", role: "memory" as const }]);

		const plan = await reconcileResidency(
			baseAdapter({
				targetKey: "roles",
				keepModelId: "coder",
				strategy: "router",
				capacity: async () => 1,
				listResident: async () => [{ modelId: "memory-small" }],
				unload: async () => {},
			}),
		);

		deepStrictEqual(
			plan.evict.map((entry) => entry.modelId),
			["memory-small"],
		);
		const swap = notices.find((notice) => notice.kind === "swap");
		strictEqual(swap?.detail?.role, "memory");
		strictEqual(swap?.message.includes("the memory model"), true, swap?.message);
	});

	it("still protects a bare configured id whose role the caller did not resolve", async () => {
		setProtectedModelsProvider(() => ["operator-model"]);

		const plan = await reconcileResidency(
			baseAdapter({
				targetKey: "roles-bare",
				keepModelId: "coder",
				strategy: "jit",
				listResident: async () => [{ modelId: "operator-model" }, { modelId: "spare" }],
			}),
		);

		deepStrictEqual(
			plan.fallbackEvict.map((entry) => entry.modelId),
			["spare", "operator-model"],
			"an unprotected resident is swapped before a configured one",
		);
	});
});
