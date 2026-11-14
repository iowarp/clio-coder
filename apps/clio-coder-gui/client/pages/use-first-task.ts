import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { routes } from "../../contracts/runtime-routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { sessionBuffer } from "../api/sessions.js";
import { touchFirst } from "../chat/composer-field.js";
import { rememberPrompt } from "../chat/composer-history.js";
import { focusComposerSoon } from "../interaction/focus-return.js";
import { ownDrafts, rememberOwnDraft } from "../shell/own-drafts.js";
import { reusableDraft } from "../shell/shell-model.js";
import { rememberWorkspace } from "../shell/tasks.js";
import {
	acquireFirstRequest,
	confirmFirstRequest,
	homeDraft,
	releaseFirstRequest,
	updateHomeDraft,
} from "./home-draft.js";
import { rememberStarted, settleStarted } from "./started-request.js";
import { setupStatusInput } from "./target-onboarding.js";

/** Every retry is explicit and uses the original body, workspace, session and command keys. */
export function useFirstTask(client: Client) {
	const queries = useQueryClient();
	const navigate = useNavigate();
	return useMutation({
		mutationFn: async () => {
			settleStarted();
			if (!acquireFirstRequest()) throw new Error("This tab is already starting a task.");
			let handedOff = false;
			// Warm the task route while the requests run, so navigating does not wait on its chunk.
			// Name the export: a bare import() keeps every export of the module alive and defeats tree-shaking.
			void import("./sessions.js").then(({ Session }) => Session);
			try {
				const draft = homeDraft();
				let request = draft.pending;
				const workspaceId = request?.workspaceId ?? draft.workspaceId;
				if (!workspaceId || (!request && !draft.text.trim()))
					throw new Error("Choose a workspace and describe the task first.");
				if (request) {
					const meta = await client.call(routes.meta, emptyInput);
					queries.setQueryData(["meta"], meta);
					if (request.epoch !== meta.epoch)
						throw new Error("CLIO Coder restarted. Review the earlier task before starting another request.");
				} else {
					// Setup resolves and validates this workspace; neither read needs to wait on the other.
					const [meta, status] = await Promise.all([
						client.call(routes.meta, emptyInput),
						client.call(routes.setupStatus, setupStatusInput(workspaceId)),
					]);
					queries.setQueryData(["meta"], meta);
					queries.setQueryData(["setup-status", workspaceId], status);
					if (status.state !== "ready") throw new Error(status.message || "Connect a model before starting a task.");
					const owned = ownDrafts();
					// No owned draft means there is nothing this tab may reuse; skip the full inventory read.
					const sessions = owned.length
						? await queries.fetchQuery({
								queryKey: ["sessions"],
								queryFn: () => client.call(routes.sessions, emptyInput),
								staleTime: 0,
							})
						: [];
					const sessionId = reusableDraft(sessions, workspaceId, owned)?.id ?? null;
					request = {
						workspaceId,
						exactTurnBody: { text: draft.text.trim() },
						epoch: meta.epoch,
						createKey: crypto.randomUUID(),
						turnKey: crypto.randomUUID(),
						sessionId,
						phase: sessionId ? "created" : "creating",
						draftRevision: draft.revision,
					};
					updateHomeDraft({ pending: request });
				}
				if (!request.sessionId) {
					const session = await client.call(
						routes.newSession,
						{ params: { id: workspaceId }, query: {}, body: {} },
						request.createKey,
						undefined,
						request.epoch,
					);
					rememberOwnDraft(session.id);
					request = { ...request, sessionId: session.id, phase: "created" };
					updateHomeDraft({ pending: request });
				}
				const sessionId = request.sessionId;
				if (!sessionId) throw new Error("The task has no confirmed session yet. Retry the original request.");
				request = { ...request, phase: "submitting" };
				updateHomeDraft({ pending: request });
				await client.call(
					routes.turn,
					{ params: { id: sessionId }, query: {}, body: request.exactTurnBody },
					request.turnKey,
					undefined,
					request.epoch,
				);
				rememberPrompt(request.exactTurnBody.text);
				rememberWorkspace(workspaceId);
				// The session creation snapshot predates the admitted turn; let the stream or a fresh read supply it.
				void queries.invalidateQueries({ queryKey: ["sessions"] });
				void queries.invalidateQueries({ queryKey: ["session", sessionId] });
				// Home stays busy with the words in its field until the task screen mounts and settles this.
				const sent = request;
				rememberStarted(sessionId, sent.exactTurnBody.text, () => {
					confirmFirstRequest(sent);
					releaseFirstRequest();
				});
				handedOff = true;
				// Sent from the keyboard, the next message is typed in the task's own box, not after a tab back
				// through the header the route change parks focus before.
				const typing = document.activeElement?.matches(".composer__field") === true && !touchFirst();
				void navigate(`/sessions/${sessionId}`);
				if (typing) focusComposerSoon();
			} finally {
				if (!handedOff) releaseFirstRequest();
			}
		},
		retry: false,
	});
}

/** Reconciliation is read-only. Matching text alone cannot prove admission of this command. */
export async function reconcileFirstTask(client: Client) {
	const request = homeDraft().pending;
	if (!request?.sessionId) return null;
	const session = await client.call(routes.session, { params: { id: request.sessionId }, query: {}, body: {} });
	return sessionBuffer(session.id).snapshot(session) ?? session;
}
