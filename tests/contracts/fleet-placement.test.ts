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
	routeFactVerdict,
} from "../../src/domains/dispatch/fleet-preflight.js";
import {
	createFleetPlacementPreviewResolver,
	createFleetPlacementResolver,
} from "../../src/domains/dispatch/placement.js";
import { verifyReceiptIntegrity, withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { NodeTargetFact, RouteFactRequirement } from "../../src/domains/dispatch/route-facts.js";
import type { WorkerTransport } from "../../src/domains/dispatch/transport.js";
import type { RunNodeReroute } from "../../src/domains/dispatch/types.js";
import { endpointIdentityHash } from "../../src/domains/dispatch/worker-protocol.js";
import { createFleetRegistry } from "../../src/domains/scheduling/cluster.js";
import { isolateDispatchState, restoreDispatchState } from "../harness/dispatch.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

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
			clioCoderEntry: "/opt/clio/bin/clio worker",
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
	it("lists local first and projects durable lease usage", () => {
		const registry = createFleetRegistry(() => [NODE_MINI], {
			localMaxWorkers: () => 4,
			activeWorkers: (nodeId) => (nodeId === "mini" ? 1 : 0),
		});
		deepStrictEqual(
			registry.list().map((node) => node.id),
			["local", "mini"],
		);
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
		strictEqual(resolve({ agentId: "coder", executionRole: "builder", task: "t" }), null);
	});

	it("previews explicit, profile-bound, and automatic placement without taking capacity", () => {
		const automatic = resolver();
		strictEqual(automatic.preview({ agentId: "coder", executionRole: "builder", task: "t" }).node.id, "blade");
		strictEqual(automatic.registry.get("blade")?.activeWorkers, 0, "preview must not reserve capacity");
		strictEqual(
			automatic.preview({ agentId: "coder", executionRole: "builder", task: "t", node: "mini" }).node.id,
			"mini",
		);
		strictEqual(automatic.registry.get("mini")?.activeWorkers, 0);

		const profileBound = resolver({
			settings: settingsWithFleet({
				profiles: { pinned: { target: null, model: null, thinkingLevel: "off", node: "mini" } },
				agentBindings: { coder: "pinned" },
			}),
		});
		strictEqual(profileBound.preview({ agentId: "coder", executionRole: "builder", task: "t" }).node.id, "mini");
		strictEqual(profileBound.registry.get("mini")?.activeWorkers, 0);
	});

	it("pins a previewed automatic node so later state cannot drift execution", () => {
		const { preview, resolve } = resolver();
		const planned = preview({ agentId: "coder", executionRole: "builder", task: "t" }).node;
		strictEqual(planned.id, "blade");
		const launched = resolve({ agentId: "coder", executionRole: "builder", task: "t", node: planned.id });
		strictEqual(launched?.node.id, "blade", "execution honors the approved pin");
	});

	it("prefers the explicit node param over every other signal", () => {
		const { resolve } = resolver({
			settings: settingsWithFleet({
				profiles: { pinned: { target: null, model: null, thinkingLevel: "off", node: "blade" } },
				agentBindings: { coder: "pinned" },
			}),
		});
		const placement = resolve({ agentId: "coder", executionRole: "builder", task: "t", node: "mini" });
		strictEqual(placement?.node.id, "mini");
	});

	it("honors profile and agent-binding node pins before least-loaded", () => {
		const { resolve } = resolver({
			settings: settingsWithFleet({
				profiles: { pinned: { target: null, model: null, thinkingLevel: "off", node: "mini" } },
				agentBindings: { coder: "pinned" },
			}),
		});
		const placement = resolve({ agentId: "coder", executionRole: "builder", task: "t" });
		strictEqual(placement?.node.id, "mini");
	});

	it("spreads across nodes by durable lease usage, then declaration order", () => {
		const settings = settingsWithFleet();
		// blade caps at 2, mini at 1: exactly the usage a durable lease read reports.
		const usage: Record<string, number> = { blade: 0, mini: 0 };
		const registry = createFleetRegistry(() => settings.fleet.nodes);
		registry.bindActiveWorkers((nodeId) => usage[nodeId] ?? 0);
		const { resolve } = resolver({ settings, registry });
		const place = () => resolve({ agentId: "coder", executionRole: "builder", task: "t" })?.node.id;
		strictEqual(place(), "blade", "declaration order breaks the tie");
		usage.blade = 1;
		strictEqual(place(), "mini", "blade now carries load");
		usage.mini = 1;
		strictEqual(place(), "blade", "blade has spare capacity, mini is full");
		usage.blade = 2;
		strictEqual(place(), "local", "all remote capacity is taken");
	});

	it("still places a pinned node that is momentarily full so admission can queue it", () => {
		const settings = settingsWithFleet();
		const registry = createFleetRegistry(() => settings.fleet.nodes);
		registry.bindActiveWorkers((nodeId) => (nodeId === "mini" ? 1 : 0));
		const { resolve } = resolver({ settings, registry });
		const placement = resolve({ agentId: "coder", executionRole: "builder", task: "t", node: "mini" });
		strictEqual(placement?.node.id, "mini", "capacity is the lease's decision, not placement's");
	});

	it("rejects explicit pins on unknown offline or unpreflighted nodes", () => {
		const base = resolver();
		throws(
			() => base.resolve({ agentId: "coder", executionRole: "builder", task: "t", node: "ghost" }),
			/unknown fleet node 'ghost'/,
		);

		base.registry.recordChannelFailure("blade", "classified dead");
		base.registry.recordChannelFailure("blade", "classified dead");
		throws(
			() => base.resolve({ agentId: "coder", executionRole: "builder", task: "t", node: "blade" }),
			/offline.*classified dead/,
		);

		const unpreflighted = resolver({
			preflight: (node) => ({ ok: false, reason: `node '${node.id}' has not passed the fleet preflight` }),
		});
		throws(
			() => unpreflighted.resolve({ agentId: "coder", executionRole: "builder", task: "t", node: "mini" }),
			/has not passed the fleet preflight/,
		);
	});

	it("skips ineligible nodes on the least-loaded path instead of failing", () => {
		const { resolve, registry } = resolver();
		registry.recordChannelFailure("blade", "dead");
		registry.recordChannelFailure("blade", "dead");
		const placement = resolve({ agentId: "coder", executionRole: "builder", task: "t" });
		strictEqual(placement?.node.id, "mini");
	});

	it("fills open reroute hops with the resolved node", () => {
		const { resolve } = resolver();
		const reroutes: RunNodeReroute[] = [
			{ attempt: 1, fromNode: "mini", toNode: "", reason: "node mini classified dead" },
		];
		const placement = resolve({ agentId: "coder", executionRole: "builder", task: "t", node: "blade", reroutes });
		deepStrictEqual(placement?.reroutes, [
			{ attempt: 1, fromNode: "mini", toNode: "blade", reason: "node mini classified dead" },
		]);
	});
});

describe("fleet preflight store", () => {
	beforeEach(async () => {
		await isolateDispatchState();
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
			targets: [],
			resources: null,
			...overrides,
		};
	}

	function targetFact(overrides: Partial<NodeTargetFact> = {}): NodeTargetFact {
		return {
			nodeId: "blade",
			targetId: "mini",
			reachable: "true",
			runtimeCompatible: "true",
			modelAvailable: "true",
			modelResident: "unknown",
			endpointIdentityHash: endpointIdentityHash("http://localhost:8080"),
			wireModelId: "Qwopus-MoE-35B",
			probedAt: new Date().toISOString(),
			probeDurationMs: 12,
			...overrides,
		};
	}

	function requirement(overrides: Partial<RouteFactRequirement> = {}): RouteFactRequirement {
		return {
			nodeId: "blade",
			targetId: "mini",
			wireModelId: "Qwopus-MoE-35B",
			endpointIdentityHash: endpointIdentityHash("http://localhost:8080"),
			requireReachable: true,
			requireRuntimeCompatible: true,
			requireModelAvailable: true,
			requireGpuCount: null,
			requireVramBytes: null,
			mode: "active",
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
			/predates a local clio-coder upgrade/,
		);
		match(
			fleetPreflightVerdict(node, "/shared/app", [record({ ok: false, detail: "clio missing" })]).reason ?? "",
			/failed its last fleet preflight: clio missing/,
		);
		strictEqual(fleetPreflightVerdict(node, "/shared/app", [record()]).ok, true);
	});

	it("localhost target is probed on the selected remote node", () => {
		// The same URL string on two nodes is two different machines. Evidence
		// from 'blade' must not answer a question about 'mini'.
		const records = [record({ targets: [targetFact({ nodeId: "blade" })] })];
		strictEqual(routeFactVerdict(requirement({ nodeId: "blade" }), records).ok, true);
		const other = routeFactVerdict(requirement({ nodeId: "mini" }), records);
		strictEqual(other.ok, false);
		match(other.ok ? "" : other.reason, /no probe fact for target 'mini' on node 'mini'/);

		// A node that proved the endpoint unreachable from itself is refused even
		// though another node reached the identical URL.
		const mixed = [
			record({
				targets: [targetFact({ nodeId: "blade" }), targetFact({ nodeId: "mini", reachable: "false" })],
			}),
		];
		const refused = routeFactVerdict(requirement({ nodeId: "mini" }), mixed);
		strictEqual(refused.ok, false);
		match(refused.ok ? "" : refused.reason, /node 'mini' proved reachable=false/);
	});

	it("stale target facts cannot satisfy an active hard requirement", () => {
		const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		const records = [record({ targets: [targetFact({ probedAt: stale })] })];
		const active = routeFactVerdict(requirement({ mode: "active" }), records);
		strictEqual(active.ok, false);
		match(active.ok ? "" : active.reason, /evidence for target 'mini' is stale/);
		// Shadow evaluation may still rank a route on aged evidence; only active
		// admission treats staleness as disqualifying.
		strictEqual(routeFactVerdict(requirement({ mode: "shadow" }), records).ok, true);
	});

	it("unknown GPU or VRAM cannot satisfy a declared fit requirement", () => {
		const records = [
			record({
				targets: [targetFact()],
				resources: {
					nodeId: "blade",
					labels: [],
					cpuCount: 16,
					totalMemoryBytes: 68719476736,
					gpuCount: null,
					vramBytes: null,
					observedAt: new Date().toISOString(),
				},
			}),
		];
		const declared = requirement({ requireGpuCount: 1, requireVramBytes: 16 * 1024 * 1024 * 1024 });
		const active = routeFactVerdict(declared, records);
		strictEqual(active.ok, false);
		match(
			active.ok ? "" : active.reason,
			/reports unknown gpuCount; a declared fit requirement cannot be satisfied by unknown/,
		);

		// Unknown is reported, not silently treated as a pass, in shadow mode too.
		const shadow = routeFactVerdict({ ...declared, mode: "shadow" }, records);
		strictEqual(shadow.ok, true);
		deepStrictEqual([...shadow.unknowns], ["gpuCount", "vramBytes"]);

		// A proven value below the declared floor is a hard rejection in any mode.
		const small = [
			record({
				targets: [targetFact()],
				resources: {
					nodeId: "blade",
					labels: [],
					cpuCount: 16,
					totalMemoryBytes: 68719476736,
					gpuCount: 1,
					vramBytes: 8 * 1024 * 1024 * 1024,
					observedAt: new Date().toISOString(),
				},
			}),
		];
		const belowFloor = routeFactVerdict({ ...declared, mode: "shadow" }, small);
		strictEqual(belowFloor.ok, false);
		match(belowFloor.ok ? "" : belowFloor.reason, /vramBytes \d+ is below the declared requirement/);
	});

	it("attested host target model runtime and tool identity enter the receipt digest", () => {
		const envelope = fixtureEnvelope("run-attested");
		const attestation = {
			protocolVersion: 1,
			host: "mini.lan",
			pid: 991,
			processGroupId: 991,
			settingsFingerprint: "a".repeat(64),
			specDigest: "b".repeat(64),
			targetId: envelope.targetId,
			endpointIdentityHash: endpointIdentityHash("http://192.168.86.141:8080"),
			wireModelId: envelope.wireModelId,
			runtimeId: envelope.runtimeId,
			toolSignature: "c".repeat(64),
			resources: { labels: ["gpu"], cpuCount: 16, totalMemoryBytes: 1, gpuCount: null, vramBytes: null },
		};
		const sealed = withReceiptIntegrity({ ...fixtureReceiptDraft(envelope), attestation }, envelope);
		deepStrictEqual(verifyReceiptIntegrity(sealed, envelope), { ok: true });
		for (const mutation of [
			{ host: "someone-else.lan" },
			{ targetId: "other-target" },
			{ wireModelId: "other-model" },
			{ runtimeId: "other-runtime" },
			{ toolSignature: "d".repeat(64) },
			{ endpointIdentityHash: endpointIdentityHash("http://192.168.86.142:8080") },
			{ settingsFingerprint: "e".repeat(64) },
			{ specDigest: "f".repeat(64) },
		]) {
			const tampered = { ...sealed, attestation: { ...attestation, ...mutation } };
			strictEqual(
				verifyReceiptIntegrity(tampered, envelope).ok,
				false,
				`mutating ${Object.keys(mutation)[0]} must break the digest`,
			);
		}
		// An absent attestation is a distinct sealed state, not an empty one.
		const unattested = withReceiptIntegrity(fixtureReceiptDraft(envelope), envelope);
		strictEqual("attestation" in unattested, false);
		deepStrictEqual(verifyReceiptIntegrity(unattested, envelope), { ok: true });
	});
});
