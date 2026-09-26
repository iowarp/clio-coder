import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { HealthSummary } from "./health.js";
import "./session-dashboard.css";

/** Compact orientation from received session facts; it does not probe providers or invent prices. */
export function SessionDashboard({
	session,
	health,
	workers,
	model,
}: {
	session: SessionSnapshot;
	health: HealthSummary;
	workers: number;
	model: string | null;
}) {
	const last = session.turns.at(-1);
	const usage = last?.usage;
	return (
		<dl className="session-dashboard" aria-label="Conversation dashboard">
			<div>
				<dt>Model</dt>
				<dd title={model ?? undefined}>{model ?? "Not selected"}</dd>
			</div>
			<div>
				<dt>Turns shown</dt>
				<dd>{session.turns.length.toLocaleString("en-US")}</dd>
			</div>
			{usage ? (
				<div>
					<dt>Last turn</dt>
					<dd>{(usage.input + usage.output).toLocaleString("en-US")} tokens</dd>
				</div>
			) : null}
			<div>
				<dt>Workers</dt>
				<dd>{workers ? `${workers} active recorded` : "None recorded"}</dd>
			</div>
			{health.contextWarning ? (
				<div data-attention="true">
					<dt>Context</dt>
					<dd>Needs attention</dd>
				</div>
			) : null}
			{session.timelineTruncated ? (
				<div>
					<dt>History</dt>
					<dd>Partial transcript</dd>
				</div>
			) : null}
		</dl>
	);
}
