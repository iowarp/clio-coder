/**
 * Remote-dispatch scaffold. v0.1 ships a single-node implementation; the real
 * cluster fan-out lands in v0.2 along with SSH/gRPC transports. listNodes()
 * returns an empty array so callers can code against the surface today.
 */

export interface ClusterNode {
	id: string;
	host: string;
	available: boolean;
	lastSeenAt: string | null;
}

export function listNodes(): ReadonlyArray<ClusterNode> {
	return [];
}
