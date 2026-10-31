import { bindPackageActivitySink } from "../core/package-activity.js";
import type { SessionContract } from "../domains/session/index.js";
import type { TelemetryContract } from "../domains/telemetry/index.js";

export function bindSessionPackageActivity(session: SessionContract, telemetry: TelemetryContract): () => void {
	return bindPackageActivitySink((activity) => {
		const current = session.current();
		if (!current) return false;
		const attributed = { ...activity, sessionId: activity.sessionId ?? current.id };
		session.appendEntry({
			kind: "custom",
			customType: activity.type,
			parentTurnId: activity.turnId ?? null,
			timestamp: activity.at,
			data: attributed,
			display: false,
		});
		telemetry.recordPackageActivity?.(attributed);
		return true;
	});
}
