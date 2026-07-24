/**
 * Deterministic fleet placement. Resolution order:
 *
 *   1. explicit dispatch `node` param
 *   2. fleet profile / agent-binding node pin
 *   3. least-loaded eligible remote node (fewest active workers, then
 *      declaration order)
 *   4. the implicit local node
 *
 * Eligible means: registry state online, a passing durable doctor preflight
 * for this project root, and free per-node capacity. An explicit pin on an
 * ineligible node is an admission failure with the reason spelled out; the
 * least-loaded path silently skips ineligible nodes and falls back to local.
 * No scored or learned placement authority exists here by design.
 */

import type { ClioSettings } from "../../core/config.js";
import type { FleetNodeSettings } from "../../core/defaults.js";
import type { FleetRegistry } from "../scheduling/cluster.js";
import type { DispatchRequest } from "./contract.js";
import type { DispatchNodePlacement } from "./extension.js";
import { fleetPreflightVerdict, readFleetPreflightRecords } from "./fleet-preflight.js";
import { createSshWorkerTransport, LOCAL_NODE_ID, localNodeIdentity, type WorkerTransport } from "./transport.js";
import type { RunNodeIdentity, RunNodeReroute } from "./types.js";

export interface FleetPlacementDeps {
	getSettings: () => Readonly<ClioSettings> | undefined;
	fleet: FleetRegistry | undefined;
	/** Transport seam; contract tests substitute a fake ssh channel. */
	transportForNode?: (node: FleetNodeSettings) => WorkerTransport;
	/** Preflight seam; defaults to the durable doctor store. */
	preflightVerdict?: typeof fleetPreflightVerdict;
}

/** Side-effect-free placement used to build an immutable approval plan. */
export interface FleetPlacementPreview {
	node: RunNodeIdentity;
}

function admissionError(reason: string): Error {
	return new Error(`dispatch: admission denied: ${reason}`);
}

/**
 * Fill the placement target into reroute hops the retry path left open
 * (fromNode recorded at requeue time, toNode known only at placement).
 */
function completedReroutes(
	reroutes: ReadonlyArray<RunNodeReroute> | undefined,
	toNode: string,
): RunNodeReroute[] | undefined {
	if (!reroutes || reroutes.length === 0) return undefined;
	return reroutes.map((hop) => (hop.toNode.length === 0 ? { ...hop, toNode } : hop));
}

function requestedNodeId(req: DispatchRequest, settings: Readonly<ClioSettings> | undefined): string | null {
	if (req.node !== undefined && req.node.trim().length > 0) return req.node.trim();
	const workers = settings?.workers;
	if (!workers) return null;
	const profileName = req.workerProfile ?? workers.agentBindings?.[req.agentId];
	if (!profileName) return null;
	const pin = workers.profiles?.[profileName]?.node;
	return pin !== undefined && pin.trim().length > 0 ? pin.trim() : null;
}

export function createFleetPlacementResolver(
	deps: FleetPlacementDeps,
): (req: DispatchRequest) => DispatchNodePlacement | null {
	const transportForNode = deps.transportForNode ?? ((node: FleetNodeSettings) => createSshWorkerTransport(node));
	const verdictFor = deps.preflightVerdict ?? fleetPreflightVerdict;

	return (req: DispatchRequest): DispatchNodePlacement | null => {
		const settings = deps.getSettings();
		const nodes = settings?.fleet?.nodes ?? [];
		// Failover retries record each failed node as a reroute `fromNode`. Those
		// nodes are excluded from re-selection so a node-scoped failure moves to a
		// different eligible node instead of landing back on the failed one.
		const excludedNodeIds = new Set((req.reroutes ?? []).map((hop) => hop.fromNode).filter((id) => id.length > 0));
		// A profile/agent-binding pin that names an excluded node is overridden by
		// the exclusion (an explicit req.node pin is dropped by the retry path
		// before this runs, so any surviving request is a soft pin).
		let requested = requestedNodeId(req, settings);
		if (requested !== null && excludedNodeIds.has(requested)) requested = null;
		// No fleet configured and nothing requested: stay on the pre-fleet
		// local path with no node identity recorded at all.
		if (nodes.length === 0 && requested === null && !req.reroutes?.length) return null;
		const fleet = deps.fleet;

		const localPlacement = (): DispatchNodePlacement => {
			const reroutes = completedReroutes(req.reroutes, LOCAL_NODE_ID);
			fleet?.tryAcquire(LOCAL_NODE_ID);
			return {
				node: localNodeIdentity(),
				...(reroutes !== undefined ? { reroutes } : {}),
				...(fleet !== undefined ? { release: () => fleet.release(LOCAL_NODE_ID) } : {}),
			};
		};

		const sshPlacement = (node: FleetNodeSettings): DispatchNodePlacement => {
			if (fleet === undefined) throw admissionError(`fleet registry unavailable; cannot place on node '${node.id}'`);
			const transport = transportForNode(node);
			const reroutes = completedReroutes(req.reroutes, node.id);
			return {
				node: transport.node,
				spawn: (spec, opts) => transport.spawn(spec, opts),
				release: () => fleet.release(node.id),
				...(reroutes !== undefined ? { reroutes } : {}),
			};
		};

		const projectRoot = req.cwd ?? process.cwd();

		if (requested !== null) {
			if (requested === LOCAL_NODE_ID) return localPlacement();
			const node = nodes.find((entry) => entry.id === requested);
			if (!node) throw admissionError(`unknown fleet node '${requested}'`);
			if (fleet === undefined) throw admissionError(`fleet registry unavailable; cannot place on node '${requested}'`);
			const snapshot = fleet.get(node.id);
			if (snapshot && snapshot.state !== "online") {
				throw admissionError(
					`fleet node '${node.id}' is ${snapshot.state}${snapshot.stateReason ? ` (${snapshot.stateReason})` : ""}`,
				);
			}
			const preflight = verdictFor(node, projectRoot);
			if (!preflight.ok) throw admissionError(preflight.reason ?? `node '${node.id}' is not preflighted`);
			if (!fleet.tryAcquire(node.id)) {
				throw admissionError(
					`fleet node '${node.id}' is at capacity (${snapshot?.activeWorkers ?? "?"}/${node.maxWorkers} workers)`,
				);
			}
			return sshPlacement(node);
		}

		// Least-loaded eligible remote node; local is the fallback unless it too
		// has been excluded by a prior failure.
		if (fleet !== undefined && nodes.length > 0) {
			const preflightRecords = readFleetPreflightRecords();
			const eligible = nodes
				.map((node, order) => ({ node, order, snapshot: fleet.get(node.id) }))
				.filter((entry) => !excludedNodeIds.has(entry.node.id))
				.filter((entry) => entry.snapshot !== null && entry.snapshot.state === "online")
				.filter((entry) => (entry.snapshot?.activeWorkers ?? 0) < entry.node.maxWorkers)
				.filter((entry) => verdictFor(entry.node, projectRoot, preflightRecords).ok)
				.sort((a, b) => (a.snapshot?.activeWorkers ?? 0) - (b.snapshot?.activeWorkers ?? 0) || a.order - b.order);
			for (const entry of eligible) {
				if (fleet.tryAcquire(entry.node.id)) return sshPlacement(entry.node);
			}
		}
		// A node exclusion that also excludes local has no eligible node left:
		// fail closed rather than silently re-running on the excluded local node.
		if (excludedNodeIds.has(LOCAL_NODE_ID)) {
			throw admissionError(`no eligible fleet node remains after excluding ${[...excludedNodeIds].join(", ")}`);
		}
		return localPlacement();
	};
}

/**
 * Resolve the node that the normal placement policy would choose without
 * acquiring capacity. The approved request is subsequently pinned to this
 * node, so a capacity/state change fails launch instead of silently drifting
 * to a different node after approval.
 */
export function createFleetPlacementPreviewResolver(
	deps: FleetPlacementDeps,
): (req: DispatchRequest) => FleetPlacementPreview {
	const verdictFor = deps.preflightVerdict ?? fleetPreflightVerdict;
	return (req: DispatchRequest): FleetPlacementPreview => {
		const settings = deps.getSettings();
		const nodes = settings?.fleet?.nodes ?? [];
		const requested = requestedNodeId(req, settings);
		const fleet = deps.fleet;
		const local = (): FleetPlacementPreview => ({ node: localNodeIdentity() });
		const remote = (node: FleetNodeSettings): FleetPlacementPreview => ({
			node: { id: node.id, kind: "ssh", host: node.host },
		});
		const projectRoot = req.cwd ?? process.cwd();

		if (requested !== null) {
			if (requested === LOCAL_NODE_ID) return local();
			const node = nodes.find((entry) => entry.id === requested);
			if (!node) throw admissionError(`unknown fleet node '${requested}'`);
			if (fleet === undefined) throw admissionError(`fleet registry unavailable; cannot place on node '${requested}'`);
			const snapshot = fleet.get(node.id);
			if (snapshot && snapshot.state !== "online") {
				throw admissionError(
					`fleet node '${node.id}' is ${snapshot.state}${snapshot.stateReason ? ` (${snapshot.stateReason})` : ""}`,
				);
			}
			const preflight = verdictFor(node, projectRoot);
			if (!preflight.ok) throw admissionError(preflight.reason ?? `node '${node.id}' is not preflighted`);
			if ((snapshot?.activeWorkers ?? 0) >= node.maxWorkers) {
				throw admissionError(
					`fleet node '${node.id}' is at capacity (${snapshot?.activeWorkers ?? "?"}/${node.maxWorkers} workers)`,
				);
			}
			return remote(node);
		}

		if (fleet !== undefined && nodes.length > 0) {
			const preflightRecords = readFleetPreflightRecords();
			const eligible = nodes
				.map((node, order) => ({ node, order, snapshot: fleet.get(node.id) }))
				.filter((entry) => entry.snapshot !== null && entry.snapshot.state === "online")
				.filter((entry) => (entry.snapshot?.activeWorkers ?? 0) < entry.node.maxWorkers)
				.filter((entry) => verdictFor(entry.node, projectRoot, preflightRecords).ok)
				.sort((a, b) => (a.snapshot?.activeWorkers ?? 0) - (b.snapshot?.activeWorkers ?? 0) || a.order - b.order);
			const selected = eligible[0]?.node;
			if (selected !== undefined) return remote(selected);
		}
		return local();
	};
}
