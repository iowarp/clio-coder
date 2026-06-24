import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	decideResidency,
	markClioLoaded,
	type ResidencyAdapter,
	type ResidencyNotice,
	reconcileResidency,
	resetResidencyState,
	residencyManaged,
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
		listResident: async () => [],
		unload: async () => {},
		...overrides,
	};
}

describe("contracts/model residency decision", () => {
	beforeEach(() => {
		resetResidencyState();
	});

	afterEach(() => {
		setResidencyNoticeSink(null);
		resetResidencyState();
	});

	it("backs off when another resident model was not loaded by Clio", () => {
		const plan = decideResidency({
			targetId: "local",
			runtimeId: "ollama-native",
			keepModelId: "new-model",
			managed: true,
			resident: [{ modelId: "foreign-model", loadedByClio: false }],
		});

		strictEqual(plan.decision, "observe");
		deepStrictEqual(plan.evict, []);
		strictEqual(plan.notices[0]?.kind, "foreign-backoff");
		strictEqual(plan.notices[0]?.level, "info");
	});

	it("evicts only Clio-loaded residents and counts their VRAM as reclaimable", () => {
		const plan = decideResidency({
			targetId: "local",
			runtimeId: "ollama-native",
			keepModelId: "new-model",
			managed: true,
			vram: { freeBytes: 4 * GIB },
			requestedFootprintBytes: 10 * GIB,
			resident: [{ modelId: "old-model", loadedByClio: true, sizeVramBytes: 8 * GIB }],
		});

		strictEqual(plan.decision, "reconcile");
		strictEqual(plan.fits, true);
		deepStrictEqual(
			plan.evict.map((entry) => entry.modelId),
			["old-model"],
		);
		strictEqual(plan.notices[0]?.kind, "about-to-evict");
		deepStrictEqual(plan.notices[0]?.detail, { freedVramBytes: 8 * GIB });
	});

	it("declines before evicting when the requested model still will not fit", () => {
		const plan = decideResidency({
			targetId: "local",
			runtimeId: "ollama-native",
			keepModelId: "too-large",
			managed: true,
			contextLength: 131_072,
			vram: { freeBytes: 1 * GIB },
			requestedFootprintBytes: 8 * GIB,
			resident: [{ modelId: "old-model", loadedByClio: true, sizeVramBytes: 2 * GIB }],
		});

		strictEqual(plan.decision, "decline");
		strictEqual(plan.fits, false);
		deepStrictEqual(plan.evict, []);
		strictEqual(plan.notices.at(-1)?.kind, "will-not-fit");
		deepStrictEqual(plan.notices.at(-1)?.detail, {
			requestedFootprintBytes: 8 * GIB,
			availableBytes: 3 * GIB,
			freeBytes: 1 * GIB,
			reclaimableBytes: 2 * GIB,
			contextLength: 131_072,
		});
	});

	it("emits stress notices for context overflow and CPU/GPU split residents", () => {
		const plan = decideResidency({
			targetId: "local",
			runtimeId: "ollama-native",
			keepModelId: "new-model",
			managed: false,
			contextLength: 262_144,
			modelMaxContext: 131_072,
			resident: [{ modelId: "split-model", loadedByClio: false, sizeVramBytes: 12 * GIB, sizeBytes: 20 * GIB }],
		});

		strictEqual(plan.decision, "observe");
		deepStrictEqual(
			plan.notices.map((notice) => notice.kind),
			["stress", "stress"],
		);
		deepStrictEqual(plan.notices[0]?.detail, { requestedContext: 262_144, modelMaxContext: 131_072 });
		deepStrictEqual(plan.notices[1]?.detail, { residentVramBytes: 12 * GIB, residentTotalBytes: 20 * GIB });
	});
});

describe("contracts/model residency reconciler", () => {
	beforeEach(() => {
		resetResidencyState();
	});

	afterEach(() => {
		setResidencyNoticeSink(null);
		resetResidencyState();
	});

	it("unloads Clio-loaded residents, emits notices, and TTL-skips repeat reconciles", async () => {
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
		strictEqual(second.decision, "skip");
		strictEqual(listCalls, 1, "TTL skip must avoid another resident-list probe");
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

	it("uses the CLIO_RESIDENCY opt-out as the single observe-only switch", () => {
		strictEqual(residencyManaged({}), true);
		strictEqual(residencyManaged({ CLIO_RESIDENCY: "observe" }), false);
		strictEqual(residencyManaged({ CLIO_RESIDENCY: "user-managed" }), false);
		strictEqual(residencyManaged({ CLIO_RESIDENCY: "clio-managed" }), true);
	});
});
