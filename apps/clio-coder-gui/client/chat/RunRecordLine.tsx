import { useQuery } from "@tanstack/react-query";
import { memo } from "react";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { RunResultFacts } from "../../contracts/run-result-facts.js";
import type { TimelineItem } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { itemRunId, runRecordLine } from "./run-record-model.js";
import "./artifacts.css";

export function RunRecordLine({ record }: { record: RunResultFacts }) {
	return (
		<p className="worker-run-result">
			<span>{runRecordLine(record)}</span>
			<Link to={`/fleet/dispatches/${encodeURIComponent(record.runId)}`}>Run record</Link>
		</p>
	);
}

/** Its own session observer lets a late record update a settled worker without repainting the turn. */
export const WorkerRunRecord = memo(function WorkerRunRecord({
	client,
	sessionId,
	item,
}: {
	client: Client;
	sessionId: string;
	item: TimelineItem;
}) {
	const runId = itemRunId(item);
	return runId ? <RunRecordObserver client={client} sessionId={sessionId} runId={runId} /> : null;
});

function RunRecordObserver({ client, sessionId, runId }: { client: Client; sessionId: string; runId: string }) {
	const record = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select: (snapshot) =>
			runId ? (snapshot.fleet.filter((frame) => frame.record?.runId === runId).at(-1)?.record ?? null) : null,
	}).data;
	return record ? <RunRecordLine record={record} /> : null;
}
