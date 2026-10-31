import { emitApproval } from "../core/telemetry/approvals.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { PermissionResolvedPayload } from "../core/telemetry/live-events.js";
import type { ActionClass } from "../domains/safety/action-classifier.js";
import { UNATTENDED_DECIDED_BY } from "../domains/safety/unattended.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface PermissionResolution {
	action: "grant" | "deny" | "stop" | "expire";
	payload: PermissionResolvedPayload;
	reason?: string;
	grantRequestedBy?: string;
	/** TUI approval-state projection must run after the audit event and before release. */
	beforeRelease?: () => void;
}

export function resolvePermission(
	ports: {
		bus?: Pick<TelemetryHub, "emit">;
		registry?: Pick<ToolRegistry, "resumeParkedCalls" | "cancelParkedCall" | "cancelParkedCalls">;
	},
	resolution: PermissionResolution,
): Promise<void> | void {
	emitApproval(ports.bus, "approval.resolved", resolution.payload);
	resolution.beforeRelease?.();
	const reason = resolution.reason ?? resolution.payload.reason ?? "permission denied";
	switch (resolution.action) {
		case "grant":
			if (resolution.payload.actionClass === undefined || resolution.grantRequestedBy === undefined)
				throw new Error("permission grant requires action class and issuer");
			return ports.registry?.resumeParkedCalls({
				actionClass: resolution.payload.actionClass as ActionClass,
				...(resolution.payload.requestId !== undefined ? { requestId: resolution.payload.requestId } : {}),
				requestedBy: resolution.grantRequestedBy,
			});
		case "deny": {
			// A deny that someone decided refuses the call. One settled by a
			// cancelled prompt or a request that could not be put only cancels it,
			// so the identical call is not refused as already denied. One nobody
			// answered in time is Clio's own refusal (#421).
			const decidedBy = resolution.payload.decidedBy;
			const options =
				decidedBy === "cancelled" || decidedBy === "error"
					? {}
					: decidedBy === UNATTENDED_DECIDED_BY
						? { denied: true, unattended: true }
						: { denied: true };
			if (resolution.payload.requestId !== undefined)
				ports.registry?.cancelParkedCall(resolution.payload.requestId, reason, options);
			else ports.registry?.cancelParkedCalls(reason, options);
			return;
		}
		case "stop":
		case "expire":
			ports.registry?.cancelParkedCalls(reason);
	}
}
