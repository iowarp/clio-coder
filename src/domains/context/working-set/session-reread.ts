import { sessionTelemetryContext } from "../../../core/telemetry/context.js";
import type { TelemetryHub } from "../../../core/telemetry/hub.js";
import type { SessionContract } from "../../session/contract.js";
import type { ReadRecallPort } from "./reread.js";
import { createRereadRecallPort } from "./reread.js";

/**
 * The read tool's reread port over the live session. The hash index it keeps
 * is rebuilt only when an eviction event lands (`ContextPruned`) or the
 * session changes, so an ordinary read never re-parses the ledger.
 */
export function createSessionRereadPort(session: SessionContract, bus: TelemetryHub): ReadRecallPort {
	const port = createRereadRecallPort({
		sessionId: () => session.current()?.id ?? null,
		readEntries: () => {
			const meta = session.current();
			return meta ? session.readEntries() : [];
		},
		activeLeafTurnId: () => {
			const meta = session.current();
			return meta ? (session.leafId(meta.id) ?? undefined) : undefined;
		},
		cwd: () => session.current()?.cwd ?? null,
		appendEntry: (entry) => session.appendEntry(entry),
		onRecalled: (payload) => bus.emit("context.recalled", payload, sessionTelemetryContext(session.current()?.id)),
	});
	bus.subscribe("context.pruned", () => port.invalidate());
	return port;
}
