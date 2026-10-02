/** Deterministic placement: explicit node, profile pin, session choice, standing preference, then local. Registration alone never moves work. Durable leases own capacity admission. */

import type { ClioSettings } from "../../core/config.js";
import type { FleetNodeSettings } from "../../core/defaults.js";
import type { FleetRegistry } from "../scheduling/cluster.js";
import type { DispatchRequest } from "./contract.js";
import type { DispatchNodePlacement } from "./extension.js";
import { sessionFleetNode } from "./fleet-placement-preference.js";
import { fleetPreflightVerdict } from "./fleet-preflight.js";
import { createSshWorkerTransport, LOCAL_NODE_ID, localNodeIdentity, type WorkerTransport } from "./transport.js";
import type { RunNodeIdentity, RunNodeReroute } from "./types.js";

export interface FleetPlacementDeps {
	getSettings: () => Readonly<ClioSettings> | undefined;
	/** Session identity is also available during plan preview, before requests are stamped. */
	getSessionId?: (() => string | null) | undefined;
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

function unknownNodeError(requested: string, settings: Readonly<ClioSettings> | undefined): Error {
	if (Object.hasOwn(settings?.fleet?.profiles ?? {}, requested)) {
		return admissionError(
			`unknown fleet node '${requested}'; '${requested}' is a fleet profile. ` +
				"The dispatch node field takes 'local' or a fleet.nodes id. Select the profile target/model in dispatch, or use --agent-profile in the CLI.",
		);
	}
	return admissionError(`unknown fleet node '${requested}'`);
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

function requestedNodeId(
	req: DispatchRequest,
	settings: Readonly<ClioSettings> | undefined,
	sessionId: string | null | undefined,
): string | null {
	if (req.node !== undefined && req.node.trim().length > 0) return req.node.trim();
	const workers = settings?.fleet;
	if (!workers) return null;
	const profileName = req.workerProfile ?? workers.agentProfiles?.[req.agentId];
	const pin = profileName ? workers.profiles?.[profileName]?.node : undefined;
	if (pin !== undefined && pin.trim().length > 0) return pin.trim();
	return sessionFleetNode(req.ownerSessionId ?? sessionId) ?? workers.defaultNode ?? null;
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
		let requested = requestedNodeId(req, settings, deps.getSessionId?.());
		if (requested !== null && excludedNodeIds.has(requested)) requested = null;
		// No fleet configured and nothing requested: stay on the pre-fleet
		// local path with no node identity recorded at all.
		if (nodes.length === 0 && requested === null && !req.reroutes?.length) return null;
		const fleet = deps.fleet;

		const localPlacement = (): DispatchNodePlacement => {
			const reroutes = completedReroutes(req.reroutes, LOCAL_NODE_ID);
			return { node: localNodeIdentity(), ...(reroutes !== undefined ? { reroutes } : {}) };
		};

		const sshPlacement = (node: FleetNodeSettings): DispatchNodePlacement => {
			if (fleet === undefined) throw admissionError(`fleet registry unavailable; cannot place on node '${node.id}'`);
			const transport = transportForNode(node);
			const reroutes = completedReroutes(req.reroutes, node.id);
			return {
				node: transport.node,
				spawn: (spec, opts) => transport.spawn(spec, opts),
				...(reroutes !== undefined ? { reroutes } : {}),
			};
		};

		const projectRoot = req.cwd ?? process.cwd();

		if (requested !== null) {
			if (requested === LOCAL_NODE_ID) return localPlacement();
			const node = nodes.find((entry) => entry.id === requested);
			if (!node) throw unknownNodeError(requested, settings);
			if (fleet === undefined) throw admissionError(`fleet registry unavailable; cannot place on node '${requested}'`);
			const snapshot = fleet.get(node.id);
			if (snapshot && snapshot.state !== "online") {
				throw admissionError(
					`fleet node '${node.id}' is ${snapshot.state}${snapshot.stateReason ? ` (${snapshot.stateReason})` : ""}`,
				);
			}
			const preflight = verdictFor(node, projectRoot);
			if (!preflight.ok) throw admissionError(preflight.reason ?? `node '${node.id}' is not preflighted`);
			return sshPlacement(node);
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
		const requested = requestedNodeId(req, settings, deps.getSessionId?.());
		const fleet = deps.fleet;
		const local = (): FleetPlacementPreview => ({ node: localNodeIdentity() });
		const remote = (node: FleetNodeSettings): FleetPlacementPreview => ({
			node: { id: node.id, kind: "ssh", host: node.host },
		});
		const projectRoot = req.cwd ?? process.cwd();

		if (requested !== null) {
			if (requested === LOCAL_NODE_ID) return local();
			const node = nodes.find((entry) => entry.id === requested);
			if (!node) throw unknownNodeError(requested, settings);
			if (fleet === undefined) throw admissionError(`fleet registry unavailable; cannot place on node '${requested}'`);
			const snapshot = fleet.get(node.id);
			if (snapshot && snapshot.state !== "online") {
				throw admissionError(
					`fleet node '${node.id}' is ${snapshot.state}${snapshot.stateReason ? ` (${snapshot.stateReason})` : ""}`,
				);
			}
			const preflight = verdictFor(node, projectRoot);
			if (!preflight.ok) throw admissionError(preflight.reason ?? `node '${node.id}' is not preflighted`);
			return remote(node);
		}

		return local();
	};
}
