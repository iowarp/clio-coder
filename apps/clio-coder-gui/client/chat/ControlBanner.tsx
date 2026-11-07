import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { controlState, VIEWER_RECHECK_MS, viewerBanner } from "./control-model.js";
import { ConversationBanner } from "./SessionStates.js";

/**
 * Says so when another window drives this task, and offers the explicit take-over. That window is told
 * through the event stream; this one keeps following the conversation either way.
 */
export function ControlBanner({ client, session }: { client: Client; session: SessionSnapshot }) {
	const queries = useQueryClient();
	const input = { params: { id: session.id }, query: {}, body: {} };
	const live = session.state === "open" || session.state === "parked";
	const control = useQuery({
		queryKey: ["session-control", session.id],
		queryFn: () => client.call(routes.sessionControl, input),
		enabled: live,
		// A holder whose window closed sends no event, so a viewer asks again until control frees up.
		refetchInterval: (query) => (controlState(query.state.data).kind === "viewing" ? VIEWER_RECHECK_MS : false),
	});
	const take = useMutation({
		mutationFn: () => client.call(routes.takeSessionControl, input),
		onSuccess: (taken) => queries.setQueryData(["session-control", session.id], taken),
	});
	const state = controlState(control.data);
	if (!live || state.kind !== "viewing") return null;
	const banner = viewerBanner(state.controller);
	return (
		<ConversationBanner
			tone="quiet"
			title={banner.title}
			action={
				<button type="button" disabled={take.isPending} onClick={() => take.mutate()}>
					{take.isPending ? "Taking control…" : "Take control"}
				</button>
			}
		>
			{take.error ? take.error.message : banner.detail}
		</ConversationBanner>
	);
}
