/**
 * Durable endpoint slot discovery (#261).
 *
 * A probe learns a fact about a server, not about the process that asked. These
 * tests read and write the store the way two processes would: one records what
 * it probed, the next resolves capacity with no in-process probe state at all.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { TargetStatus } from "../../src/domains/providers/contract.js";
import {
	endpointCapacitiesForStatuses,
	endpointCapacityFor,
	endpointCapacityForStatus,
	recordEndpointSlotsFromStatus,
} from "../../src/domains/providers/endpoint-capacity.js";
import {
	DEFAULT_ENDPOINT_SLOTS_TTL_MS,
	ENDPOINT_SLOTS_TTL_ENV_VAR,
	endpointSlotsPath,
	endpointSlotsTtlMs,
	readDiscoveredEndpointSlots,
	recordDiscoveredEndpointSlots,
} from "../../src/domains/providers/endpoint-slots-store.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

const ENDPOINT = "http://mini:8080";
const HOUR_MS = 60 * 60 * 1000;

function status(input: {
	id: string;
	runtime?: string;
	url: string;
	slots?: number;
	override?: number;
	tier?: string;
}): TargetStatus {
	return {
		target: {
			id: input.id,
			runtime: input.runtime ?? "llamacpp",
			url: input.url,
			...(input.override !== undefined ? { maxConcurrentRequests: input.override } : {}),
		},
		runtime: { id: input.runtime ?? "llamacpp", tier: input.tier ?? "local-native" },
		available: true,
		reason: "",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { contextWindow: 0 },
		discoveredModels: [],
		...(input.slots !== undefined ? { probeCapabilities: { parallelSlots: input.slots } } : {}),
	} as unknown as TargetStatus;
}

/** What a fresh process sees: a configured target, no in-process probe state. */
function coldStart(input: { runtime?: string; url?: string; override?: number; tier?: string }) {
	return endpointCapacityFor({
		target: {
			id: "mini",
			runtime: input.runtime ?? "llamacpp",
			url: input.url ?? ENDPOINT,
			...(input.override !== undefined ? { maxConcurrentRequests: input.override } : {}),
		},
		runtime: { id: input.runtime ?? "llamacpp", tier: (input.tier ?? "local-native") as "local-native" },
	});
}

describe("persisted endpoint slot counts", () => {
	let scratch = "";
	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-endpoint-slots-");
	});
	afterEach(() => clearScratchClioHome(scratch));

	it("carries a probed slot count into a process that never probed", async () => {
		// Nothing on disk: the conservative local-native default is all there is.
		strictEqual(coldStart({})?.limit, 1);
		strictEqual(coldStart({})?.source, "local-native-default");

		await recordEndpointSlotsFromStatus(status({ id: "mini", url: ENDPOINT, slots: 4 }));

		const resolved = coldStart({});
		strictEqual(resolved?.limit, 4);
		strictEqual(resolved.source, "discovered-prior");
		strictEqual(resolved.key, ENDPOINT);
	});

	it("writes one durable record per canonical endpoint, not per target id", async () => {
		await recordEndpointSlotsFromStatus(status({ id: "mini", url: "http://mini:8080/v1", slots: 4 }));
		await recordEndpointSlotsFromStatus(status({ id: "mini-alias", url: "http://mini:8080/", slots: 4 }));
		deepStrictEqual(Object.keys(readDiscoveredEndpointSlots()), [ENDPOINT]);
		ok(existsSync(endpointSlotsPath()));
	});

	it("keeps the explicit override above discovery and both above the prior", async () => {
		await recordDiscoveredEndpointSlots({ endpointKey: ENDPOINT, runtimeId: "llamacpp", slots: 4 });
		strictEqual(coldStart({ override: 2 })?.source, "override");
		strictEqual(coldStart({ override: 2 })?.limit, 2);
		// A probe in this process is newer evidence about the same server.
		const probed = endpointCapacityForStatus(status({ id: "mini", url: ENDPOINT, slots: 2 }));
		strictEqual(probed?.source, "discovered");
		strictEqual(probed.limit, 2);
	});

	it("lets a fresh probe lower the recorded count as well as raise it", async () => {
		await recordDiscoveredEndpointSlots({ endpointKey: ENDPOINT, runtimeId: "llamacpp", slots: 4 });
		strictEqual(coldStart({})?.limit, 4);
		await recordEndpointSlotsFromStatus(status({ id: "mini", url: ENDPOINT, slots: 1 }));
		strictEqual(coldStart({})?.limit, 1);
		strictEqual(coldStart({})?.source, "discovered-prior");
	});

	it("ignores a record older than its staleness bound rather than over-admitting", async () => {
		const nowMs = Date.now();
		await recordDiscoveredEndpointSlots(
			{ endpointKey: ENDPOINT, runtimeId: "llamacpp", slots: 4 },
			{ nowMs: nowMs - DEFAULT_ENDPOINT_SLOTS_TTL_MS - HOUR_MS },
		);
		// The row is on disk and still well-formed; it is simply too old to answer.
		ok(readFileSync(endpointSlotsPath(), "utf8").includes(ENDPOINT));
		deepStrictEqual(readDiscoveredEndpointSlots(), {});
		strictEqual(coldStart({})?.limit, 1);
		strictEqual(coldStart({})?.source, "local-native-default");
		// Inside the bound it answers.
		strictEqual(Object.keys(readDiscoveredEndpointSlots({ ttlMs: DEFAULT_ENDPOINT_SLOTS_TTL_MS * 4 })).length, 1);
	});

	it("ignores a record another runtime wrote for the same host and port", async () => {
		await recordDiscoveredEndpointSlots({ endpointKey: ENDPOINT, runtimeId: "ollama", slots: 4 });
		strictEqual(coldStart({})?.limit, 1, "an ollama server's slot count is not a llama.cpp server's");
		strictEqual(coldStart({ runtime: "ollama" })?.limit, 4);
	});

	it("prunes stale rows on the next write and keeps the fresh ones", async () => {
		const nowMs = Date.now();
		await recordDiscoveredEndpointSlots(
			{ endpointKey: "http://old:8080", runtimeId: "llamacpp", slots: 8 },
			{ nowMs: nowMs - DEFAULT_ENDPOINT_SLOTS_TTL_MS - HOUR_MS },
		);
		await recordDiscoveredEndpointSlots({ endpointKey: ENDPOINT, runtimeId: "llamacpp", slots: 4 }, { nowMs });
		deepStrictEqual(Object.keys(readDiscoveredEndpointSlots({ nowMs })), [ENDPOINT]);
		strictEqual(readFileSync(endpointSlotsPath(), "utf8").includes("http://old:8080"), false);
	});

	it("answers empty for a truncated, foreign-versioned, or malformed file", async () => {
		await recordDiscoveredEndpointSlots({ endpointKey: ENDPOINT, runtimeId: "llamacpp", slots: 4 });
		for (const contents of [
			"{ not json",
			JSON.stringify({ version: 2, endpoints: { [ENDPOINT]: { endpointKey: ENDPOINT, runtimeId: "l", slots: 4 } } }),
			JSON.stringify({ version: 1, endpoints: { [ENDPOINT]: { endpointKey: ENDPOINT, runtimeId: "llamacpp" } } }),
			JSON.stringify({
				version: 1,
				endpoints: { [ENDPOINT]: { endpointKey: ENDPOINT, runtimeId: "llamacpp", slots: 0, observedAt: "x" } },
			}),
		]) {
			writeFileSync(endpointSlotsPath(), contents);
			deepStrictEqual(readDiscoveredEndpointSlots(), {}, contents.slice(0, 40));
			strictEqual(coldStart({})?.limit, 1);
		}
	});

	it("never writes an observation it does not have", async () => {
		await recordEndpointSlotsFromStatus(status({ id: "mini", url: ENDPOINT }));
		strictEqual(existsSync(endpointSlotsPath()), false);
		// A target with no resolvable endpoint key has nothing to key a record on.
		await recordEndpointSlotsFromStatus(status({ id: "cli", url: "file:///tmp/model", slots: 4 }));
		strictEqual(existsSync(endpointSlotsPath()), false);
	});

	it("still leaves unbounded local runtimes unbounded", async () => {
		await recordDiscoveredEndpointSlots({ endpointKey: ENDPOINT, runtimeId: "vllm", slots: 4 });
		// vllm's own scheduler is not modeled as fixed slots, but a recorded count
		// for it is still evidence and outranks the fallback that would refuse it.
		strictEqual(coldStart({ runtime: "vllm" })?.limit, 4);
		strictEqual(coldStart({ runtime: "vllm", url: "http://other:8080" }), null);
	});

	it("folds two target descriptors on one scheduler to the strongest evidence", async () => {
		await recordDiscoveredEndpointSlots({ endpointKey: ENDPOINT, runtimeId: "llamacpp", slots: 4 });
		const capacities = endpointCapacitiesForStatuses([
			status({ id: "prior-only", url: "http://mini:8080/v1" }),
			status({ id: "probed", url: "http://mini:8080/", slots: 2 }),
		]);
		strictEqual(capacities[ENDPOINT]?.source, "discovered");
		strictEqual(capacities[ENDPOINT]?.limit, 2);
	});

	it("resolves the staleness bound from the environment over the built-in default", () => {
		strictEqual(endpointSlotsTtlMs({}), DEFAULT_ENDPOINT_SLOTS_TTL_MS);
		strictEqual(endpointSlotsTtlMs({ [ENDPOINT_SLOTS_TTL_ENV_VAR]: " 60000 " }), 60_000);
		strictEqual(endpointSlotsTtlMs({ [ENDPOINT_SLOTS_TTL_ENV_VAR]: "0" }), DEFAULT_ENDPOINT_SLOTS_TTL_MS);
		strictEqual(endpointSlotsTtlMs({ [ENDPOINT_SLOTS_TTL_ENV_VAR]: "-5" }), DEFAULT_ENDPOINT_SLOTS_TTL_MS);
	});
});
