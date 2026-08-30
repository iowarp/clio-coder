import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { formatNotes } from "../../src/cli/targets.js";
import type { TargetStatus } from "../../src/domains/providers/contract.js";
import {
	canonicalEndpointKey,
	endpointCapacitiesForStatuses,
	endpointCapacityForStatus,
} from "../../src/domains/providers/endpoint-capacity.js";

function status(input: { id: string; runtime?: string; url: string; slots?: number; override?: number }): TargetStatus {
	return {
		target: {
			id: input.id,
			runtime: input.runtime ?? "llamacpp",
			url: input.url,
			...(input.override !== undefined ? { maxConcurrentRequests: input.override } : {}),
		},
		runtime: {
			id: input.runtime ?? "llamacpp",
			tier: "local-native",
		},
		available: true,
		reason: "",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { contextWindow: 0 },
		discoveredModels: [],
		...(input.slots !== undefined ? { probeCapabilities: { parallelSlots: input.slots } } : {}),
	} as unknown as TargetStatus;
}

describe("inference endpoint capacity", () => {
	it("normalizes scheme host default port base path and the conventional v1 mount", () => {
		strictEqual(canonicalEndpointKey("HTTP://LOCALHOST:80//v1/"), "http://localhost");
		strictEqual(canonicalEndpointKey("http://localhost:8080/"), "http://localhost:8080");
		strictEqual(canonicalEndpointKey("http://localhost:8080/v1"), "http://localhost:8080");
		strictEqual(canonicalEndpointKey("ws://LOCALHOST:8080/team/v1/"), "http://localhost:8080/team");
		strictEqual(canonicalEndpointKey("http://name:secret@LOCALHOST:8080/v1?model=a#turn"), "http://localhost:8080");
		strictEqual(canonicalEndpointKey("file:///tmp/model"), null);
	});

	it("keeps localhost and its loopback address distinct because DNS aliases are not collapsed", () => {
		strictEqual(
			canonicalEndpointKey("http://localhost:8080/") === canonicalEndpointKey("http://127.0.0.1:8080/v1"),
			false,
		);
	});

	it("resolves override then discovery then the local-native single-slot fallback", () => {
		strictEqual(
			endpointCapacityForStatus(status({ id: "override", url: "http://host:8080", slots: 2, override: 3 }))?.limit,
			3,
		);
		strictEqual(endpointCapacityForStatus(status({ id: "discovered", url: "http://other:8080", slots: 2 }))?.limit, 2);
		strictEqual(endpointCapacityForStatus(status({ id: "fallback", url: "http://third:8080" }))?.limit, 1);
		strictEqual(endpointCapacityForStatus(status({ id: "vllm", runtime: "vllm", url: "http://fourth:8080" })), null);
	});

	it("uses the explicit override for two target descriptors sharing one scheduler", () => {
		const capacities = endpointCapacitiesForStatuses([
			status({ id: "discovered", url: "http://host:8080/v1", slots: 2 }),
			status({ id: "override", url: "http://host:8080/", slots: 2, override: 3 }),
		]);
		strictEqual(capacities["http://host:8080"]?.limit, 3);
		strictEqual(capacities["http://host:8080"]?.source, "override");
	});

	it("prints the resolved slot count in target probe notes", () => {
		strictEqual(formatNotes(status({ id: "mini", url: "http://mini:8080", slots: 2 })), "slots 2");
	});
});
