// The line under a settled dispatch that follows its runs to their end.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { routes } from "../../contracts/runtime-routes.js";
import type { TimelineItem } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { StatusMark } from "../design/status.js";
import { dispatchOutcome, dispatchRunIds } from "./dispatch-outcome-model.js";
import { foldFleetRuns } from "./fleet-facts.js";

/** A settled dispatch follows its runs in the session's fleet feed, from its own observer like `WorkerRunRecord`. */
export function DispatchOutcome({
	client,
	sessionId,
	item,
}: {
	client: Client;
	sessionId: string;
	item: TimelineItem;
}) {
	const runIds = useMemo(() => dispatchRunIds(item), [item]);
	const outcome = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select: (snapshot) => (runIds.length === 0 ? null : dispatchOutcome(runIds, foldFleetRuns(snapshot.fleet))),
	}).data;
	return outcome ? (
		<p className="worker-run-result dispatch-outcome">
			<StatusMark tone={outcome.tone} label={outcome.text} />
		</p>
	) : null;
}
