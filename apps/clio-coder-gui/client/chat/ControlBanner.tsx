import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { controlState, VIEWER_RECHECK_MS, viewerBanner } from "./control-model.js";
import { ConversationBanner } from "./SessionStates.js";

/**
 * Who drives a live task, and the explicit take-over. The banner and the composer read the same query, so
 * a take from either updates both.
 */
export function useSessionControl(client: Client, sessionId: string, live: boolean) {
	const queries = useQueryClient();
	const input = { params: { id: sessionId }, query: {}, body: {} };
	const control = useQuery({
		queryKey: ["session-control", sessionId],
		queryFn: () => client.call(routes.sessionControl, input),
		enabled: live,
		// A holder whose window closed sends no event, so a viewer asks again until control frees up.
		refetchInterval: (query) => (controlState(query.state.data).kind === "viewing" ? VIEWER_RECHECK_MS : false),
	});
	const take = useMutation({
		mutationFn: () => client.call(routes.takeSessionControl, input),
		onSuccess: (taken) => queries.setQueryData(["session-control", sessionId], taken),
	});
	const state = controlState(control.data);
	return { viewing: live && state.kind === "viewing" ? state.controller : null, take };
}

/**
 * Says so when another window drives this task. That window is told through the event stream; this one
 * keeps following the conversation either way, and takes control from the composer.
 */
export function ControlBanner({ client, session }: { client: Client; session: SessionSnapshot }) {
	const live = session.state === "open" || session.state === "parked";
	const { viewing } = useSessionControl(client, session.id, live);
	if (viewing === null) return null;
	const banner = viewerBanner(viewing);
	return (
		<ConversationBanner tone="quiet" title={banner.title}>
			{banner.detail}
		</ConversationBanner>
	);
}
