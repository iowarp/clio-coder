import { acquireCapacityLease } from "../../src/domains/dispatch/capacity-lease.js";

const assignmentId = process.argv[2] ?? "child";
// Optional barrier: every child races for the same slot at the same instant, so
// the test exercises real lock contention instead of sequential visibility.
const startAtMs = Number.parseInt(process.argv[3] ?? "", 10);
if (Number.isFinite(startAtMs)) {
	while (Date.now() < startAtMs) {
		// spin: a timer would let the children drift apart
	}
}
try {
	const lease = acquireCapacityLease({
		assignmentId,
		nodeId: "local",
		limits: { global: 1, nodes: { local: 1 } },
		ttlMs: 60_000,
	});
	process.send?.({ ok: true, leaseId: lease.leaseId });
	setTimeout(() => process.exit(0), 30_000);
} catch (error) {
	process.send?.({ ok: false, message: error instanceof Error ? error.message : String(error) });
	process.exit(2);
}
