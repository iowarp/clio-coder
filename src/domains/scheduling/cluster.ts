/**
 * Fleet node registry: N machines become one addressable, pinnable capacity
 * pool. Node configuration comes from `fleet.nodes` in settings (read fresh
 * on every call so settings edits apply next dispatch); runtime state
 * (channel health and last-seen observations) lives here. Durable capacity
 * and admission draining are owned by the dispatch admission store.
 *
 * State semantics:
 *   - online   channel healthy as far as this registry knows. Nodes start
 *              online; dispatch eligibility additionally requires a passing
 *              doctor preflight (durable, checked at placement).
 *   - offline  classified dead after consecutive channel failures. Placement
 *              skips it; its in-flight runs are reaped for reroute by the
 *              dispatch domain. A later channel success restores it.
 *
 * Staleness is advisory: `lastSeenAt` records the last probe or worker
 * heartbeat, but an idle node is never auto-offlined for silence, because no
 * signal is expected from a node with no work.
 */

import type { FleetNodeSettings } from "../../core/defaults.js";

export type FleetNodeState = "online" | "offline";

export interface FleetNodeSnapshot {
	id: string;
	host: string;
	kind: "local" | "ssh";
	state: FleetNodeState;
	stateReason: string | null;
	activeWorkers: number;
	maxWorkers: number;
	labels: ReadonlyArray<string>;
	lastSeenAt: string | null;
}

export interface FleetRegistry {
	/** True when at least one remote node is configured. */
	hasRemoteNodes(): boolean;
	/** All nodes, implicit local first, then declaration order. */
	list(): FleetNodeSnapshot[];
	get(id: string): FleetNodeSnapshot | null;
	/** Raw settings entry for a remote node; null for local/unknown ids. */
	config(id: string): FleetNodeSettings | null;
	/** Record a probe or worker heartbeat for staleness display. */
	seen(id: string): void;
	/**
	 * Channel failure accounting. Consecutive failures at or beyond the death
	 * threshold classify the node offline. Returns the resulting state.
	 */
	recordChannelFailure(id: string, reason: string): FleetNodeState;
	recordChannelSuccess(id: string): void;
	/**
	 * Attach the durable per-node usage source. The dispatch domain owns the
	 * capacity leases, so it binds the reader once at bundle construction; until
	 * then a snapshot reports zero rather than inventing a process-local count.
	 */
	bindActiveWorkers(source: (nodeId: string) => number): void;
}

export const LOCAL_NODE_ID = "local";

/** Consecutive channel failures before a node is classified dead. */
const NODE_DEATH_FAILURE_THRESHOLD = 2;

interface NodeRuntimeState {
	state: FleetNodeState;
	stateReason: string | null;
	consecutiveFailures: number;
	lastSeenMs: number | null;
}

export interface FleetRegistryOptions {
	now?: () => number;
	/** Display-only cap for the implicit local node. */
	localMaxWorkers?: () => number;
	/** Durable lease-derived usage; never a process-local counter. */
	activeWorkers?: (nodeId: string) => number;
}

function freshState(): NodeRuntimeState {
	return { state: "online", stateReason: null, consecutiveFailures: 0, lastSeenMs: null };
}

export function createFleetRegistry(
	getNodes: () => ReadonlyArray<FleetNodeSettings>,
	options?: FleetRegistryOptions,
): FleetRegistry {
	const now = options?.now ?? (() => Date.now());
	const runtime = new Map<string, NodeRuntimeState>();
	let activeWorkers = options?.activeWorkers;

	function stateFor(id: string): NodeRuntimeState {
		let state = runtime.get(id);
		if (!state) {
			state = freshState();
			runtime.set(id, state);
		}
		return state;
	}

	function snapshotFor(id: string, config: FleetNodeSettings | null): FleetNodeSnapshot {
		const state = stateFor(id);
		if (config === null) {
			return {
				id: LOCAL_NODE_ID,
				host: "localhost",
				kind: "local",
				state: state.state,
				stateReason: state.stateReason,
				activeWorkers: activeWorkers?.(LOCAL_NODE_ID) ?? 0,
				maxWorkers: options?.localMaxWorkers?.() ?? Number.POSITIVE_INFINITY,
				labels: [],
				lastSeenAt: state.lastSeenMs !== null ? new Date(state.lastSeenMs).toISOString() : null,
			};
		}
		return {
			id: config.id,
			host: config.host,
			kind: "ssh",
			state: state.state,
			stateReason: state.stateReason,
			activeWorkers: activeWorkers?.(id) ?? 0,
			maxWorkers: config.maxWorkers,
			labels: [...(config.labels ?? [])],
			lastSeenAt: state.lastSeenMs !== null ? new Date(state.lastSeenMs).toISOString() : null,
		};
	}

	function findConfig(id: string): FleetNodeSettings | null {
		return getNodes().find((node) => node.id === id) ?? null;
	}

	return {
		hasRemoteNodes() {
			return getNodes().length > 0;
		},
		list() {
			return [snapshotFor(LOCAL_NODE_ID, null), ...getNodes().map((node) => snapshotFor(node.id, node))];
		},
		get(id) {
			if (id === LOCAL_NODE_ID) return snapshotFor(LOCAL_NODE_ID, null);
			const config = findConfig(id);
			return config ? snapshotFor(id, config) : null;
		},
		config(id) {
			return id === LOCAL_NODE_ID ? null : findConfig(id);
		},
		seen(id) {
			stateFor(id).lastSeenMs = now();
		},
		recordChannelFailure(id, reason) {
			const state = stateFor(id);
			state.consecutiveFailures += 1;
			if (state.state === "online" && state.consecutiveFailures >= NODE_DEATH_FAILURE_THRESHOLD) {
				state.state = "offline";
				state.stateReason = `classified dead after ${state.consecutiveFailures} consecutive channel failures (${reason})`;
			}
			return state.state;
		},
		bindActiveWorkers(source) {
			activeWorkers = source;
		},
		recordChannelSuccess(id) {
			const state = stateFor(id);
			state.consecutiveFailures = 0;
			state.lastSeenMs = now();
			if (state.state === "offline") {
				// A node that just completed a run over its channel is alive again.
				state.state = "online";
				state.stateReason = null;
			}
		},
	};
}
