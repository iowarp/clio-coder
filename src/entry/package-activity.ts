import { bindPackageActivitySink } from "../core/package-activity.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import type { SessionContract } from "../domains/session/index.js";

export function bindSessionPackageActivity(session: SessionContract, observability: ObservabilityContract): () => void {
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
		observability.recordPackageActivity?.(attributed);
		return true;
	});
}
