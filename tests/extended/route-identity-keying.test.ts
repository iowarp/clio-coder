import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
		pricedCoverage: "complete",
		sourceDigests: [hash(digest)],
		settledAt: `2026-07-2${digest.length % 9}T00:00:00.000Z`,
	};
}

function store() {
	return createRouteHistoryStore({ stateDir: mkdtempSync(join(tmpdir(), "clio-coder-route-identity-")) });
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
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-route-identity-replay-"));
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

	it("reads v3 without changing it, preserves unknown coverage and writes nullable cache facts in v4", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-route-versions-"));
		const path = join(stateDir, "route-history.json");
		const legacy = { ...record(route(), "legacy"), version: 3, completedCostUsd: 0 };
		const bytes = JSON.stringify({ version: 3, records: [legacy] });
		writeFileSync(path, bytes);
		const history = createRouteHistoryStore({ stateDir });
		strictEqual(history.all()[0]?.cacheRead, null);
		strictEqual(history.all()[0]?.completedCostUsd, null);
		strictEqual(history.all()[0]?.pricedCoverage, "unknown");
		strictEqual(readFileSync(path, "utf8"), bytes);
		history.upsert({ ...record(route(), "known"), cacheRead: false });
		history.upsert({
			...record(route(), "unpriced"),
			cacheRead: null,
			completedCostUsd: null,
			pricedCoverage: "unknown",
		});
		const reopened = createRouteHistoryStore({ stateDir });
		strictEqual(reopened.all().find((row) => row.receiptDigest === hash("known"))?.cacheRead, false);
		strictEqual(reopened.all().find((row) => row.receiptDigest === hash("unpriced"))?.cacheRead, null);
		strictEqual(JSON.parse(readFileSync(path, "utf8")).version, 4);
	});

	it("future files and unreadable records are counted and never retired or overwritten", () => {
		for (const version of [2, 5]) {
			const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-route-preserve-"));
			const path = join(stateDir, "route-history.json");
			for (const outer of version === 5 ? [5, 4] : [4]) {
				const bytes = JSON.stringify({ version: outer, records: [{ version, receiptDigest: hash("future") }] });
				writeFileSync(path, bytes);
				const history = createRouteHistoryStore({ stateDir });
				strictEqual(history.all().length, 0);
				deepStrictEqual(history.health(), { skipped: 1, writable: false });
				throws(() => history.upsert(record(route(), "fresh")), /preserving existing file/);
				strictEqual(readFileSync(path, "utf8"), bytes);
				deepStrictEqual(readdirSync(stateDir), ["route-history.json"]);
			}
		}
	});

	it("a retired v2 file is set aside, as 0.6.5 did, and learning continues (#434)", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-route-retire-"));
		const path = join(stateDir, "route-history.json");
		const bytes = JSON.stringify({ version: 2, records: [{ version: 2, receiptDigest: hash("old") }] });
		writeFileSync(path, bytes);
		const history = createRouteHistoryStore({ stateDir });
		deepStrictEqual(history.health(), { skipped: 0, writable: true });
		const retired = readdirSync(stateDir).filter((name) =>
			/^route-history\.json\.v2\.\d{8}T\d{6}Z\.retired$/u.test(name),
		);
		strictEqual(retired.length, 1);
		strictEqual(readFileSync(join(stateDir, retired[0] ?? ""), "utf8"), bytes);
		history.upsert(record(route(), "fresh"));
		strictEqual(JSON.parse(readFileSync(path, "utf8")).version, 4);
	});
});
