import { ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type RouteCandidate,
	routeCandidateKey,
	routeCapabilityKey,
	routeDriftGuard,
	routeDriftInvalidates,
} from "../../src/domains/dispatch/route-decision.js";
import {
	createRouteHistoryStore,
	ROUTE_HISTORY_VERSION,
	type RouteHistoryRecord,
} from "../../src/domains/dispatch/route-history.js";

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

function record(candidate: RouteCandidate, digest: string): RouteHistoryRecord {
	return {
		version: ROUTE_HISTORY_VERSION,
		receiptDigest: hash(digest),
		assignmentId: `assignment-${digest}`,
		route: candidate,
		executionRole: candidate.executionRole,
		qualityLabel: "pass",
		reliability: "success",
		firstPass: true,
		completedCostUsd: 0.01,
		completedPhaseTiming: null,
		cacheRead: false,
		sourceDigests: [hash(digest)],
		settledAt: `2026-07-2${digest.length % 9}T00:00:00.000Z`,
	};
}

function store() {
	return createRouteHistoryStore({ stateDir: mkdtempSync(join(tmpdir(), "clio-route-identity-")) });
}

describe("contracts/route identity keying", () => {
	it("a prompt-wording edit preserves the quality denominator", () => {
		const history = store();
		// Six observations across three session-prompt revisions, which is exactly
		// the shape the 2026-07 prompt-composition commits produced live.
		for (const [index, prompt] of ["prompt-a", "prompt-b", "prompt-c"].entries()) {
			history.upsert(record(route({ promptCompositionHash: hash(prompt) }), `d${index}a`));
			history.upsert(record(route({ promptCompositionHash: hash(prompt) }), `d${index}b`));
		}
		// Estimating against the newest wording still sees all six, so the
		// six-labeled-outcome activation prerequisite stays reachable.
		strictEqual(history.recordsFor(route({ promptCompositionHash: hash("prompt-c") })).length, 6);
		// An unrelated settings edit is likewise not drift for this route.
		strictEqual(history.recordsFor(route({ settingsFingerprint: hash("settings-next") })).length, 6);
	});

	it("a model or target change starts a fresh bucket", () => {
		const history = store();
		history.upsert(record(route(), "base"));
		strictEqual(history.recordsFor(route()).length, 1);
		strictEqual(history.recordsFor(route({ modelId: "other-model" })).length, 0);
		strictEqual(history.recordsFor(route({ targetId: "dynamo" })).length, 0);
		strictEqual(history.recordsFor(route({ nodeId: "blade" })).length, 0);
		strictEqual(history.recordsFor(route({ runtimeId: "lmstudio" })).length, 0);
		strictEqual(history.recordsFor(route({ specFingerprint: hash("spec-next") })).length, 0);
		strictEqual(history.recordsFor(route({ executionRole: "verifier" })).length, 0);
		strictEqual(history.recordsFor(route({ thinkingLevel: "high" })).length, 0);
	});

	it("behavior-changing drift invalidates the bucket without sharding it", () => {
		const history = store();
		history.upsert(record(route(), "base"));
		// The tool surface and the physical endpoint change what the route does,
		// so prior evidence is stale rather than merely differently keyed.
		strictEqual(history.recordsFor(route({ toolSignature: hash("tools-next") })).length, 0);
		strictEqual(history.recordsFor(route({ endpointIdentityHash: hash("endpoint-next") })).length, 0);
		// Invalidation is not a new bucket: the capability key is unchanged, which
		// is what keeps a reverted tool surface reading its own history again.
		strictEqual(routeCapabilityKey(route({ toolSignature: hash("tools-next") })), routeCapabilityKey(route()));
		strictEqual(routeDriftInvalidates(routeDriftGuard(route()), routeDriftGuard(route())), false);
	});

	it("replay still resolves the exact sealed drift guard", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-route-identity-replay-"));
		const original = route({ promptCompositionHash: hash("prompt-sealed") });
		createRouteHistoryStore({ stateDir }).upsert(record(original, "sealed"));

		const reopened = createRouteHistoryStore({ stateDir });
		const [replayed] = reopened.all();
		ok(replayed !== undefined);
		// The full exact identity survives the round trip, so an offline replay
		// reconstructs which prompt and settings produced the observation even
		// though the estimator aggregated over the coarser capability key.
		strictEqual(routeCandidateKey(replayed.route), routeCandidateKey(original));
		strictEqual(routeDriftGuard(replayed.route).promptCompositionHash, hash("prompt-sealed"));
		strictEqual(routeDriftGuard(replayed.route).settingsFingerprint, hash("settings"));
	});

	it("a retired history version is rejected rather than read", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-route-identity-retire-"));
		const path = join(stateDir, "route-history.json");
		writeFileSync(path, JSON.stringify({ version: 2, records: [{ version: 2, receiptDigest: hash("old") }] }));

		const reopened = createRouteHistoryStore({ stateDir });
		strictEqual(reopened.all().length, 0);
		const retired = readdirSync(stateDir).filter((name) => name.endsWith(".retired"));
		strictEqual(retired.length, 1);
		const retiredName = retired[0];
		ok(retiredName !== undefined);
		// Retirement moves the file aside intact; nothing is migrated forward.
		strictEqual(JSON.parse(readFileSync(join(stateDir, retiredName), "utf8")).version, 2);
		// The live path is gone rather than rewritten, so the next write starts
		// the current format from empty with no trace of the retired semantics.
		strictEqual(existsSync(path), false);
		reopened.upsert(record(route(), "fresh"));
		strictEqual(JSON.parse(readFileSync(path, "utf8")).version, ROUTE_HISTORY_VERSION);
	});
});
