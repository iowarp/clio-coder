/**
 * v0.1 ships a single-node scheduler. Remote fan-out lands in v0.2 along with
 * SSH/gRPC transports.
 */

export interface ClusterNode {
	id: string;
	host: string;
	available: boolean;
	lastSeenAt: string | null;
}

export function listNodes(): ReadonlyArray<ClusterNode> {
	return [
		{
			id: "local",
			host: "localhost",
			available: true,
			lastSeenAt: null,
		},
	];
}
