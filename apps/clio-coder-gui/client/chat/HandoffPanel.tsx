import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useId, useState } from "react";
import { useNavigate } from "react-router";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import type { HandoffRefused } from "../../contracts/handoff.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { notify } from "../design/notifications.js";
import { HANDOFF_MIN_GOAL, handoffDone, handoffRefusal } from "./handoff-model.js";
import "./session-board.css";

/** A draft awaiting review, with the reviewer's edit. Held in the query cache so closing Session tools keeps it. */
interface HeldDraft {
	handoffId: string;
	goal: string;
	document: string;
	edited: string;
}

/**
 * The terminal's /handoff. Clio Coder draws up a document from this conversation, a person reads and
 * edits it, and only then is a new conversation started from it. Nothing is written before that
 * press, discarding is free, and a request sent in the meantime makes the draft stale.
 */
export const HandoffPanel = memo(function HandoffPanel({
	client,
	sessionId,
	sessionOpen,
	capabilities,
	running,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
	running: boolean;
	/** Render without the disclosure frame, for a host that supplies its own heading. */
}) {
	const fieldId = useId();
	const navigate = useNavigate();
	const queries = useQueryClient();
	const [goal, setGoal] = useState("");
	const [refusal, setRefusal] = useState<HandoffRefused | null>(null);
	const draftKey = ["handoff-draft", sessionId];
	const held = useQuery<HeldDraft | null>({
		queryKey: draftKey,
		queryFn: () => null,
		enabled: false,
		initialData: null,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	}).data;
	const setHeld = (next: HeldDraft | null) => queries.setQueryData(draftKey, next);
	const params = { params: { id: sessionId }, query: {} };
	const supported = !!capabilities?.handoff;
	const drafting = useIsMutating({ mutationKey: ["handoff-prepare", sessionId] }) > 0;
	const prepare = useMutation({
		mutationKey: ["handoff-prepare", sessionId],
		mutationFn: (text: string) =>
			client.call(routes.prepareHandoff, { ...params, body: { goal: text } }, crypto.randomUUID()),
		onSuccess: (result) => {
			if (result.status === "refused") {
				setRefusal(result);
				return;
			}
			setRefusal(null);
			queries.setQueryData<HeldDraft>(draftKey, {
				handoffId: result.handoffId,
				goal: result.goal,
				document: result.document,
				edited: result.document,
			});
		},
	});
	const commit = useMutation({
		mutationFn: (draft: HeldDraft) =>
			client.call(
				routes.commitHandoff,
				{ ...params, body: { handoffId: draft.handoffId, document: draft.edited } },
				crypto.randomUUID(),
			),
		onSuccess: async (result) => {
			if (result.status === "refused") {
				setRefusal(result);
				// Only an empty review is the reviewer's to fix; any other refusal ended the draft.
				if (result.code !== "empty") setHeld(null);
				return;
			}
			setHeld(null);
			const done = handoffDone(result.warnings);
			notify({ tone: "success", title: done.title, detail: done.detail });
			if (done.warning) notify({ tone: "warning", title: done.warning.title, detail: done.warning.detail });
			await Promise.all([
				queries.invalidateQueries({ queryKey: ["sessions"] }),
				queries.invalidateQueries({ queryKey: ["session-history"] }),
			]);
			void navigate(`/sessions/${result.sessionId}`);
		},
	});
	const discard = useMutation({
		mutationFn: (draft: HeldDraft) =>
			client.call(routes.cancelHandoff, { ...params, body: { handoffId: draft.handoffId } }, crypto.randomUUID()),
		onSettled: () => {
			setHeld(null);
			notify({ tone: "info", title: "Handoff discarded", detail: "Nothing was written." });
		},
	});
	const shown = refusal ? handoffRefusal(refusal) : null;
	const body = (
		<>
			{!sessionOpen ? <p>This task is not open. Open it to hand it off.</p> : null}
			{sessionOpen && !supported ? <p>This task cannot be handed off: Clio does not offer it here.</p> : null}
			{sessionOpen && supported && !held ? (
				<form
					className="handoff-panel__goal"
					onSubmit={(event) => {
						event.preventDefault();
						setRefusal(null);
						prepare.mutate(goal.trim());
					}}
				>
					<p className="session-board__note">
						Clio Coder draws up a document from this conversation for you to read and edit. Nothing is written until you start
						the new conversation from it.
					</p>
					<label htmlFor={fieldId}>What should the next conversation accomplish?</label>
					<input
						id={fieldId}
						data-autofocus
						value={goal}
						maxLength={2000}
						onChange={(event) => setGoal(event.target.value.replace(/[\r\n]+/g, " "))}
						placeholder="Finish the survey report and its figures"
					/>
					<button
						type="submit"
						disabled={drafting || running || goal.trim().length < HANDOFF_MIN_GOAL}
						aria-describedby={`${fieldId}-hint`}
					>
						{drafting ? "Drawing it up…" : "Draw up the handoff"}
					</button>
					<small id={`${fieldId}-hint`} className="session-board__note">
						{running
							? "Wait for the current turn to finish; a handoff summarizes a conversation that has stopped."
							: `Say what to accomplish, in at least ${HANDOFF_MIN_GOAL} characters.`}
					</small>
				</form>
			) : null}
			{held ? (
				<section className="handoff-panel__review" aria-labelledby={`${fieldId}-review`}>
					<h3 id={`${fieldId}-review`}>Review the handoff</h3>
					<p className="session-board__note">
						Goal: {held.goal}. Edit anything; the new conversation receives this text as written. Files it names that this
						conversation never touched are listed as dropped.
					</p>
					<label htmlFor={`${fieldId}-document`}>Handoff document</label>
					<textarea
						id={`${fieldId}-document`}
						data-autofocus
						value={held.edited}
						rows={14}
						spellCheck={false}
						onChange={(event) => setHeld({ ...held, edited: event.target.value })}
					/>
					<span className="session-board__actions">
						<button
							type="button"
							className="handoff-panel__start"
							disabled={commit.isPending || discard.isPending || running}
							onClick={() => commit.mutate(held)}
						>
							{commit.isPending ? "Starting…" : "Start the new conversation"}
						</button>
						<button type="button" disabled={commit.isPending || discard.isPending} onClick={() => discard.mutate(held)}>
							Discard
						</button>
					</span>
				</section>
			) : null}
			{shown ? (
				<p role="alert" className={`handoff-panel__refusal handoff-panel__refusal--${shown.tone}`}>
					<strong>{shown.title}</strong> {shown.detail}
				</p>
			) : null}
			{prepare.error || commit.error ? <p role="alert">{(prepare.error ?? commit.error)?.message}</p> : null}
		</>
	);
	return <div className="session-board handoff-panel handoff-panel--bare">{body}</div>;
});
