import type { PermissionResolvedPayload } from "../core/bus-events.js";
import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { ActionClass } from "../domains/safety/action-classifier.js";
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
		bus?: Pick<SafeEventBus, "emit">;
		registry?: Pick<ToolRegistry, "resumeParkedCalls" | "cancelParkedCall" | "cancelParkedCalls">;
	},
	resolution: PermissionResolution,
): Promise<void> | void {
	ports.bus?.emit(BusChannels.PermissionResolved, resolution.payload);
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
		case "deny":
			if (resolution.payload.requestId !== undefined)
				ports.registry?.cancelParkedCall(resolution.payload.requestId, reason);
			else ports.registry?.cancelParkedCalls(reason);
			return;
		case "stop":
		case "expire":
			ports.registry?.cancelParkedCalls(reason);
	}
}
