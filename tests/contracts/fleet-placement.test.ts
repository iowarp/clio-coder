import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { readClioVersion } from "../../src/core/package-root.js";
import {
	type FleetPreflightRecord,
	fleetPreflightVerdict,
	readFleetPreflightRecords,
	recordFleetPreflight,
} from "../../src/domains/dispatch/fleet-preflight.js";
import {
	createFleetPlacementPreviewResolver,
	createFleetPlacementResolver,
} from "../../src/domains/dispatch/placement.js";
import type { WorkerTransport } from "../../src/domains/dispatch/transport.js";
import type { RunNodeReroute } from "../../src/domains/dispatch/types.js";
import { createFleetRegistry } from "../../src/domains/scheduling/cluster.js";
import { isolateDispatchState, restoreDispatchState } from "../harness/dispatch.js";

const NODE_BLADE = { id: "blade", host: "blade.lan", maxWorkers: 2 };
const NODE_MINI = { id: "mini", host: "mini.lan", maxWorkers: 1 };

function passingPreflight(): ReturnType<typeof fleetPreflightVerdict> {
	return { ok: true, reason: null };
}

function fakeTransport(nodeId: string, host: string): WorkerTransport {
	return {
		kind: "ssh",
		node: { id: nodeId, kind: "ssh", host },
		spawn: () => {
			throw new Error("placement tests never launch the transport");
		},
	};
}

function settingsWithFleet(overrides?: {
	profiles?: Record<string, { target: string | null; model: string | null; thinkingLevel: "off"; node?: string }>;
	agentBindings?: Record<string, string>;
}): typeof DEFAULT_SETTINGS {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.nodes = [structuredClone(NODE_BLADE), structuredClone(NODE_MINI)];
	if (overrides?.profiles) settings.workers.profiles = overrides.profiles;
	if (overrides?.agentBindings) settings.workers.agentBindings = overrides.agentBindings;
	return settings;
}

describe("fleet settings validation", () => {
	it("parses fleet.nodes with defaults and full fields", () => {
		const result = validateSettings({
			version: 1,
			fleet: {
				nodes: [
					{ id: "blade", host: "blade.lan" },
					{
						id: "mini",
						host: "mini.lan",
						user: "ops",
						port: 2222,
						identityFile: "~/.ssh/id_fleet",
						clioEntry: "/opt/clio/bin/clio worker",
						labels: ["gpu"],
						maxWorkers: 1,
						residency: "observe",
					},
				],
			},
		});
		strictEqual(result.issues.length, 0);
		deepStrictEqual(result.settings.fleet.nodes[0], { id: "blade", host: "blade.lan", maxWorkers: 2 });
		deepStrictEqual(result.settings.fleet.nodes[1], {
			id: "mini",
			host: "mini.lan",
			user: "ops",
			port: 2222,
			identityFile: "~/.ssh/id_fleet",
			clioEntry: "/opt/clio/bin/clio worker",
			labels: ["gpu"],
			maxWorkers: 1,
			residency: "observe",
		});
	});

	it("rejects the reserved local id, duplicates, and bad shapes", () => {
		const result = validateSettings({
			version: 1,
			fleet: {
				nodes: [
					{ id: "local", host: "h" },
					{ id: "a", host: "h" },
					{ id: "a", host: "h2" },
					{ id: "b", host: "h3", residency: "evict-all", maxWorkers: 0 },
					{ host: "no-id" },
				],
			},
		});
		const paths = result.issues.map((issue) => issue.path);
		ok(paths.includes("fleet.nodes[0].id"), "reserved local id flagged");
		ok(paths.includes("fleet.nodes[2].id"), "duplicate id flagged");
		ok(paths.includes("fleet.nodes[3].residency"), "bad residency flagged");
		ok(paths.includes("fleet.nodes[3].maxWorkers"), "bad maxWorkers flagged");
		ok(paths.includes("fleet.nodes[4].id"), "missing id flagged");
		deepStrictEqual(
			result.settings.fleet.nodes.map((node) => node.id),
			["a", "b"],
		);
	});

	it("keeps profile node pins that name configured nodes and drops unknown pins", () => {
		const result = validateSettings({
			version: 1,
			targets: [{ id: "t1", runtime: "openai", defaultModel: "m" }],
			fleet: { nodes: [{ id: "blade", host: "blade.lan" }] },
			workers: {
				profiles: {
					pinned: { target: "t1", node: "blade" },
					localPin: { target: "t1", node: "local" },
					stale: { target: "t1", node: "ghost" },
				},
			},
		});
		strictEqual(result.settings.workers.profiles.pinned?.node, "blade");
		strictEqual(result.settings.workers.profiles.localPin?.node, "local");
		strictEqual(result.settings.workers.profiles.stale?.node, undefined);
	});
});

describe("fleet registry", () => {
	it("lists local first, enforces per-node capacity, and frees on release", () => {
		const registry = createFleetRegistry(() => [NODE_MINI], { localMaxWorkers: () => 4 });
		deepStrictEqual(
			registry.list().map((node) => node.id),
			["local", "mini"],
		);
		strictEqual(registry.tryAcquire("mini"), true);
		strictEqual(registry.tryAcquire("mini"), false, "mini caps at 1 worker");
		registry.release("mini");
		strictEqual(registry.tryAcquire("mini"), true);
		strictEqual(registry.tryAcquire("local"), true, "local has no per-node cap");
		strictEqual(registry.get("mini")?.activeWorkers, 1);
	});

	it("classifies a node dead after consecutive channel failures and recovers on success", () => {
		const registry = createFleetRegistry(() => [NODE_BLADE]);
		strictEqual(registry.recordChannelFailure("blade", "stalled"), "online");
		strictEqual(registry.recordChannelFailure("blade", "stalled"), "offline");
		match(registry.get("blade")?.stateReason ?? "", /consecutive channel failures/);
		registry.recordChannelSuccess("blade");
		strictEqual(registry.get("blade")?.state, "online");
	});

	it("supports operator draining and explicit offline marks", () => {
		const registry = createFleetRegistry(() => [NODE_BLADE]);
		registry.markDraining("blade");
		strictEqual(registry.get("blade")?.state, "draining");
		registry.markOffline("blade", "preflight failed");
		strictEqual(registry.get("blade")?.stateReason, "preflight failed");
		registry.markOnline("blade");
		strictEqual(registry.get("blade")?.state, "online");
	});
});

describe("fleet placement resolution order", () => {
	function resolver(options?: {
		settings?: typeof DEFAULT_SETTINGS;
		registry?: ReturnType<typeof createFleetRegistry>;
		preflight?: typeof fleetPreflightVerdict;
	}) {
		const settings = options?.settings ?? settingsWithFleet();
		const registry = options?.registry ?? createFleetRegistry(() => settings.fleet.nodes);
		return {
			registry,
			preview: createFleetPlacementPreviewResolver({
				getSettings: () => settings,
				fleet: registry,
				preflightVerdict: options?.preflight ?? passingPreflight,
			}),
			resolve: createFleetPlacementResolver({
				getSettings: () => settings,
				fleet: registry,
				transportForNode: (node) => fakeTransport(node.id, node.host),
				preflightVerdict: options?.preflight ?? passingPreflight,
			}),
		};
	}

	it("returns null (pre-fleet behavior) when no nodes are configured and nothing is requested", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		const { resolve } = resolver({ settings, registry: createFleetRegistry(() => []) });
		strictEqual(resolve({ agentId: "coder", task: "t" }), null);
	});

	it("previews explicit, profile-bound, and automatic placement without taking capacity", () => {
		const automatic = resolver();
		strictEqual(automatic.preview({ agentId: "coder", task: "t" }).node.id, "blade");
		strictEqual(automatic.registry.get("blade")?.activeWorkers, 0, "preview must not reserve capacity");
		strictEqual(automatic.preview({ agentId: "coder", task: "t", node: "mini" }).node.id, "mini");
		strictEqual(automatic.registry.get("mini")?.activeWorkers, 0);

		const profileBound = resolver({
			settings: settingsWithFleet({
				profiles: { pinned: { target: null, model: null, thinkingLevel: "off", node: "mini" } },
				agentBindings: { coder: "pinned" },
			}),
		});
		strictEqual(profileBound.preview({ agentId: "coder", task: "t" }).node.id, "mini");
		strictEqual(profileBound.registry.get("mini")?.activeWorkers, 0);
	});

	it("pins a previewed automatic node so later load cannot drift execution", () => {
		const { preview, resolve, registry } = resolver();
		const planned = preview({ agentId: "coder", task: "t" }).node;
		strictEqual(planned.id, "blade");
		strictEqual(registry.tryAcquire("mini"), true, "unrelated load changes after approval");
		const launched = resolve({ agentId: "coder", task: "t", node: planned.id });
		strictEqual(launched?.node.id, "blade", "execution honors the approved pin");
	});

	it("prefers the explicit node param over every other signal", () => {
		const { resolve } = resolver({
			settings: settingsWithFleet({
				profiles: { pinned: { target: null, model: null, thinkingLevel: "off", node: "blade" } },
				agentBindings: { coder: "pinned" },
			}),
		});
		const placement = resolve({ agentId: "coder", task: "t", node: "mini" });
		strictEqual(placement?.node.id, "mini");
	});

	it("honors profile and agent-binding node pins before least-loaded", () => {
		const { resolve } = resolver({
			settings: settingsWithFleet({
				profiles: { pinned: { target: null, model: null, thinkingLevel: "off", node: "mini" } },
				agentBindings: { coder: "pinned" },
			}),
		});
		const placement = resolve({ agentId: "coder", task: "t" });
		strictEqual(placement?.node.id, "mini");
	});

	it("places on the least-loaded eligible node, then declaration order, then local", () => {
		const { resolve, registry } = resolver();
		const first = resolve({ agentId: "coder", task: "t" });
		strictEqual(first?.node.id, "blade", "declaration order breaks the tie");
		const second = resolve({ agentId: "coder", task: "t" });
		strictEqual(second?.node.id, "mini", "blade now carries load");
		const third = resolve({ agentId: "coder", task: "t" });
		strictEqual(third?.node.id, "blade", "blade has spare capacity, mini is full");
		const fourth = resolve({ agentId: "coder", task: "t" });
		strictEqual(fourth?.node.id, "local", "all remote capacity consumed");
		strictEqual(registry.get("blade")?.activeWorkers, 2);
	});

	it("rejects explicit pins on unknown, offline, unpreflighted, or full nodes", () => {
		const base = resolver();
		throws(() => base.resolve({ agentId: "coder", task: "t", node: "ghost" }), /unknown fleet node 'ghost'/);

		base.registry.markOffline("blade", "classified dead");
		throws(() => base.resolve({ agentId: "coder", task: "t", node: "blade" }), /offline.*classified dead/);

		const unpreflighted = resolver({
			preflight: (node) => ({ ok: false, reason: `node '${node.id}' has not passed the fleet preflight` }),
		});
		throws(
			() => unpreflighted.resolve({ agentId: "coder", task: "t", node: "mini" }),
			/has not passed the fleet preflight/,
		);

		const full = resolver();
		strictEqual(full.registry.tryAcquire("mini"), true);
		throws(() => full.resolve({ agentId: "coder", task: "t", node: "mini" }), /at capacity/);
	});

	it("skips ineligible nodes on the least-loaded path instead of failing", () => {
		const { resolve, registry } = resolver();
		registry.markOffline("blade", "dead");
		const placement = resolve({ agentId: "coder", task: "t" });
		strictEqual(placement?.node.id, "mini");
	});

	it("fills open reroute hops with the resolved node", () => {
		const { resolve } = resolver();
		const reroutes: RunNodeReroute[] = [
			{ attempt: 1, fromNode: "mini", toNode: "", reason: "node mini classified dead" },
		];
		const placement = resolve({ agentId: "coder", task: "t", node: "blade", reroutes });
		deepStrictEqual(placement?.reroutes, [
			{ attempt: 1, fromNode: "mini", toNode: "blade", reason: "node mini classified dead" },
		]);
	});
});

describe("fleet preflight store", () => {
	beforeEach(() => {
		isolateDispatchState();
	});
	after(() => {
		restoreDispatchState();
	});

	function record(overrides: Partial<FleetPreflightRecord> = {}): FleetPreflightRecord {
		return {
			nodeId: "blade",
			host: "blade.lan",
			projectRoot: "/shared/app",
			ok: true,
			checkedAt: new Date().toISOString(),
			localVersion: readClioVersion(),
			remoteVersion: readClioVersion(),
			detail: null,
			checks: { reachable: true, clioPresent: true, versionMatch: true, pathParity: true, stateDirWritable: true },
			...overrides,
		};
	}

	it("persists records and upserts by node and project root", () => {
		recordFleetPreflight([record()]);
		recordFleetPreflight([record({ projectRoot: "/shared/other" })]);
		recordFleetPreflight([record({ ok: false, detail: "path parity failed" })]);
		const records = readFleetPreflightRecords();
		strictEqual(records.length, 2);
		strictEqual(records.find((entry) => entry.projectRoot === "/shared/app")?.ok, false);
	});

	it("fails closed: missing record, host mismatch, version drift, failed check", () => {
		const node = { id: "blade", host: "blade.lan" };
		match(fleetPreflightVerdict(node, "/shared/app", []).reason ?? "", /has not passed the fleet preflight/);
		match(
			fleetPreflightVerdict(node, "/shared/app", [record({ host: "old.lan" })]).reason ?? "",
			/recorded for host 'old.lan'/,
		);
		match(
			fleetPreflightVerdict(node, "/shared/app", [record({ localVersion: "0.0.1" })]).reason ?? "",
			/predates a local clio upgrade/,
		);
		match(
			fleetPreflightVerdict(node, "/shared/app", [record({ ok: false, detail: "clio missing" })]).reason ?? "",
			/failed its last fleet preflight: clio missing/,
		);
		strictEqual(fleetPreflightVerdict(node, "/shared/app", [record()]).ok, true);
	});
});
