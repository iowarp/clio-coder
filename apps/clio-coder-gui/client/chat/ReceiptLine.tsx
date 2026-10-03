import { useQuery } from "@tanstack/react-query";
import { memo } from "react";
import { Link } from "react-router";
import type { ReceiptFacts } from "../../contracts/receipt-facts.js";
import { routes } from "../../contracts/routes.js";
import type { TimelineItem } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { itemRunId, receiptLine } from "./receipt-model.js";
import "./artifacts.css";

export function ReceiptLine({ receipt }: { receipt: ReceiptFacts }) {
	return (
		<p className="worker-receipt">
			<span>{receiptLine(receipt)}</span>
			<Link to={`/fleet/dispatches/${encodeURIComponent(receipt.receiptId)}`}>Receipt</Link>
		</p>
	);
}

/** Its own session observer lets a late receipt update a settled worker without repainting the turn. */
export const WorkerReceipt = memo(function WorkerReceipt({
	client,
	sessionId,
	item,
}: {
	client: Client;
	sessionId: string;
	item: TimelineItem;
}) {
	const runId = itemRunId(item);
	return runId ? <ReceiptObserver client={client} sessionId={sessionId} runId={runId} /> : null;
});

function ReceiptObserver({ client, sessionId, runId }: { client: Client; sessionId: string; runId: string }) {
	const receipt = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select: (snapshot) =>
			runId ? (snapshot.fleet.filter((frame) => frame.receipt?.receiptId === runId).at(-1)?.receipt ?? null) : null,
	}).data;
	return receipt ? <ReceiptLine receipt={receipt} /> : null;
}
