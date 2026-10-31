import { ownerTelemetryContext } from "./context.js";
import type { TelemetryHub } from "./hub.js";
import type { PermissionRequestedPayload, PermissionResolvedPayload } from "./live-events.js";

/**
 * Approvals are the owning session's record, a worker's ask included (its run is `requestedBy`). An operator answers
 * outside the turn's async context, so the session the payload names is the scope (#434).
 */
export function emitApproval(
	hub: Pick<TelemetryHub, "emit"> | undefined,
	...[name, payload]:
		| ["approval.requested", PermissionRequestedPayload]
		| ["approval.resolved", PermissionResolvedPayload]
): boolean {
	const ctx = ownerTelemetryContext({ sessionId: payload.sessionId, turnId: payload.turnId });
	if (!hub) return false;
	return name === "approval.requested" ? hub.emit(name, payload, ctx) : hub.emit(name, payload, ctx);
}
