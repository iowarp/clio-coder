import { strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	type RouteCandidate,
	routeCapabilityKey,
	routeDriftGuard,
	routeDriftInvalidates,
} from "../../src/domains/dispatch/route-decision.js";

function hash(seed: string): string {
	return createHash("sha256").update(seed, "utf8").digest("hex");
}

function route(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
	return {
		agentId: "scout",
		specFingerprint: hash("spec"),
		executionRole: "researcher",
		targetId: "mini",
		modelId: "kat-coder",
		runtimeId: "llamacpp",
		nodeId: "mini",
		thinkingLevel: "off",
		toolSignature: hash("tools"),
		promptCompositionHash: hash("prompt"),
		endpointIdentityHash: hash("endpoint"),
		settingsFingerprint: hash("settings"),
		...overrides,
	};
}

/** Whether a history entry settled under `observed` counts toward estimating `current`, as the route observer filters. */
function counts(observed: RouteCandidate, current: RouteCandidate): boolean {
	return (
		routeCapabilityKey(observed) === routeCapabilityKey(current) &&
		!routeDriftInvalidates(routeDriftGuard(observed), routeDriftGuard(current))
	);
}

describe("contracts/route identity keying", () => {
	it("a prompt-wording edit preserves the quality denominator", () => {
		// Observations across three session-prompt revisions, which is exactly
		// the shape the 2026-07 prompt-composition commits produced live.
		for (const prompt of ["prompt-a", "prompt-b", "prompt-c"]) {
			const observed = route({ promptCompositionHash: hash(prompt) });
			// Estimating against the newest wording still sees all of them, so the
			// six-labeled-outcome activation prerequisite stays reachable.
			strictEqual(counts(observed, route({ promptCompositionHash: hash("prompt-c") })), true);
			// An unrelated settings edit is likewise not drift for this route.
			strictEqual(counts(observed, route({ settingsFingerprint: hash("settings-next") })), true);
		}
	});

	it("a model or target change starts a fresh bucket", () => {
		strictEqual(counts(route(), route()), true);
		strictEqual(counts(route(), route({ modelId: "other-model" })), false);
		strictEqual(counts(route(), route({ targetId: "dynamo" })), false);
		strictEqual(counts(route(), route({ nodeId: "blade" })), false);
		strictEqual(counts(route(), route({ runtimeId: "lmstudio" })), false);
		strictEqual(counts(route(), route({ specFingerprint: hash("spec-next") })), false);
		strictEqual(counts(route(), route({ executionRole: "verifier" })), false);
		strictEqual(counts(route(), route({ thinkingLevel: "high" })), false);
	});

	it("behavior-changing drift invalidates the bucket without sharding it", () => {
		// The tool surface and the physical endpoint change what the route does,
		// so prior evidence is stale rather than merely differently keyed.
		strictEqual(counts(route(), route({ toolSignature: hash("tools-next") })), false);
		strictEqual(counts(route(), route({ endpointIdentityHash: hash("endpoint-next") })), false);
		// Invalidation is not a new bucket: the capability key is unchanged, which
		// is what keeps a reverted tool surface reading its own history again.
		strictEqual(routeCapabilityKey(route({ toolSignature: hash("tools-next") })), routeCapabilityKey(route()));
		strictEqual(routeDriftInvalidates(routeDriftGuard(route()), routeDriftGuard(route())), false);
	});
});
