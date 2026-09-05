import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { TargetStatus } from "../../src/domains/providers/contract.js";
import { hasLiveModelCatalog } from "../../src/domains/providers/model-discovery.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";

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
	it("treats probe and cache sources as live catalogs", () => {
		strictEqual(hasLiveModelCatalog(makeStatus("probe")), true);
		strictEqual(hasLiveModelCatalog(makeStatus("cache")), true);
	});

	it("does not treat an undefined source as a live catalog even with nonempty models", () => {
		strictEqual(hasLiveModelCatalog(makeStatus(undefined, ["model-a", "model-b"])), false);
	});

	it("does not treat none or runtime sources as live catalogs", () => {
		strictEqual(hasLiveModelCatalog(makeStatus("none")), false);
		strictEqual(hasLiveModelCatalog(makeStatus("runtime")), false);
	});
});
