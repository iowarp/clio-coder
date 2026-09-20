/**
 * The composer. Every decision it makes lives in `composer.ts`; this file is
 * the wiring and the markup.
 *
 * Two properties are load-bearing and easy to lose in a refactor:
 *
 * 1. It reads the draft from a store outside React, and its props are scalars
 *    behind `memo`, so a streamed timeline delta does not re-render the
 *    textarea. Passing the whole `SessionSnapshot` in would undo that.
 * 2. The textarea is never disabled while a turn runs. Only the submit changes
 *    meaning, and a draft typed mid-turn survives the turn.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useId, useRef, useSyncExternalStore } from "react";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { StatusMark } from "../design/status.js";
import { useLayersActive } from "../interaction/use-shortcut.js";
import {
	composerKeyAction,
	draftStore,
	noticeForError,
	noticeForRefusal,
	projectQueue,
	queueSummary,
	restoredDraft,
	type SubmitIntent,
	steeringAffordances,
	steerModeOffers,
	submitIntent,
	submitLabel,
} from "./composer.js";
import "./composer.css";

/** Focus handlers keyed by session, so a retry elsewhere in the turn can fill and focus this field. */
const focusHandlers = new Map<string, () => void>();

/** Fill the composer for this session and put the caret in it. Used by Try again and the starters. */
export function fillComposer(sessionId: string, text: string): void {
	draftStore(sessionId).write(text);
	focusHandlers.get(sessionId)?.();
}

export interface ComposerProps {
	readonly client: Client;
	readonly sessionId: string;
	readonly sessionState: SessionSnapshot["state"];
	/** The id of the turn running right now, or null when none is. */
	readonly runningTurnId: string | null;
}

export const Composer = memo(function Composer({ client, sessionId, sessionState, runningTurnId }: ComposerProps) {
	const queries = useQueryClient();
	const store = draftStore(sessionId);
	const draft = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
	const field = useRef<HTMLTextAreaElement | null>(null);
	const fieldId = useId();
	const hintId = useId();
	const layerOwned = useLayersActive();
	const running = runningTurnId !== null;
	const params = { params: { id: sessionId }, query: {}, body: {} };

	useEffect(() => {
		const focus = () => field.current?.focus();
		focusHandlers.set(sessionId, focus);
		return () => {
			if (focusHandlers.get(sessionId) === focus) focusHandlers.delete(sessionId);
		};
	}, [sessionId]);

	// Read once per session and keep. Every steering route answers 409 when the
	// agent announced nothing, so this decides what is rendered at all.
	const capabilities = useQuery({
		queryKey: ["session-capabilities", sessionId],
		queryFn: () => client.call(routes.sessionCapabilities, params),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const steering = steeringAffordances(capabilities.data);
	const modes = steerModeOffers(steering);

	const queue = useQuery({
		queryKey: ["session-queue", sessionId],
		queryFn: () => client.call(routes.sessionQueue, params),
		enabled: steering.queue && running,
		retry: false,
		refetchInterval: running ? 3_000 : false,
	});
	const queued = projectQueue(queue.data);

	const send = useMutation({
		mutationFn: async (intent: Exclude<SubmitIntent, { kind: "blocked" }>) => {
			if (intent.kind === "prompt") {
				await client.call(routes.turn, { ...params, body: { text: intent.text } }, intent.idempotencyKey);
				return null;
			}
			return client.call(
				routes.steerSession,
				{ ...params, body: { text: intent.text, mode: intent.mode } },
				intent.idempotencyKey,
			);
		},
		onSuccess: (result) => {
			if (result !== null && !result.accepted) return;
			store.clear();
			if (result !== null) void queries.invalidateQueries({ queryKey: ["session-queue", sessionId] });
		},
	});

	const interrupt = useMutation({
		mutationFn: () => client.call(routes.interruptSession, { ...params, body: {} }),
	});
	const stop = useMutation({
		mutationFn: () =>
			client.call(routes.cancelTurn, { params: { id: sessionId, turnId: runningTurnId ?? "" }, query: {}, body: {} }),
	});
	const drain = useMutation({
		mutationFn: () => client.call(routes.clearSessionQueue, { ...params, body: {} }),
		onSuccess: (result) => {
			store.write(restoredDraft(store.snapshot().text, result.restored));
			void queries.invalidateQueries({ queryKey: ["session-queue", sessionId] });
			field.current?.focus();
		},
	});

	const situation = { sessionState, turnRunning: running, sending: send.isPending, steering };
	const intent = submitIntent(draft, situation);
	// Recomputed from the store rather than closed over, so a keystroke that
	// lands between render and keydown still sends the text the operator sees.
	const submit = () => {
		const next = submitIntent(store.snapshot(), situation);
		if (next.kind !== "blocked") send.mutate(next);
	};

	const notice =
		noticeForError(send.error ?? interrupt.error ?? stop.error ?? drain.error) ??
		noticeForRefusal(send.data) ??
		noticeForRefusal(interrupt.data);

	return (
		<form
			className="composer"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<label className="composer__label" htmlFor={fieldId}>
				Message Clio Coder
			</label>
			<textarea
				id={fieldId}
				ref={field}
				className="composer__field"
				aria-describedby={hintId}
				value={draft.text}
				rows={4}
				disabled={sessionState !== "open"}
				placeholder="Ask Clio Coder to do something in this project"
				onChange={(event) => store.write(event.target.value)}
				onKeyDown={(event) => {
					const action = composerKeyAction(
						{
							key: event.key,
							altKey: event.altKey,
							ctrlKey: event.ctrlKey,
							metaKey: event.metaKey,
							shiftKey: event.shiftKey,
						},
						{ layerOwned, composing: event.nativeEvent.isComposing },
					);
					if (action !== "send") return;
					event.preventDefault();
					submit();
				}}
			/>
			{running && modes.length > 1 ? (
				<fieldset className="composer__modes">
					<legend>Deliver this</legend>
					{modes.map((offer) => (
						<label key={offer.mode} className="composer__mode" title={offer.lands}>
							<input
								type="radio"
								name={`${fieldId}-mode`}
								checked={draft.mode === offer.mode}
								onChange={() => store.chooseMode(offer.mode)}
							/>
							{offer.label}
						</label>
					))}
					<span className="composer__mode-lands">
						{modes.find((offer) => offer.mode === draft.mode)?.lands ?? modes[0]?.lands}
					</span>
				</fieldset>
			) : null}
			<div className="composer__actions">
				<p className="composer__hint" id={hintId}>
					Enter sends. Shift and Enter start a new line. Prompts go only to the Clio Coder target you configured.
				</p>
				{running ? (
					<>
						{steering.interrupt ? (
							<button
								className="composer__secondary"
								type="button"
								disabled={interrupt.isPending}
								onClick={() => interrupt.mutate()}
								title="Ask Clio Coder to put down what it is doing and take new direction. The turn stays open."
							>
								{interrupt.isPending ? "Interrupting…" : "Interrupt"}
							</button>
						) : null}
						<button
							className="composer__secondary"
							type="button"
							disabled={stop.isPending}
							onClick={() => stop.mutate()}
							title="End this turn now. Nothing further is run."
						>
							{stop.isPending ? "Stopping…" : "Stop turn"}
						</button>
					</>
				) : null}
				<button
					className="composer__submit primary"
					type="submit"
					disabled={intent.kind === "blocked"}
					title={intent.kind === "blocked" ? intent.reason : undefined}
				>
					{send.isPending ? "Sending…" : submitLabel(intent, situation)}
				</button>
			</div>
			{intent.kind === "blocked" && draft.text.trim() !== "" ? (
				<p className="composer__blocked" role="status">
					{intent.reason}
				</p>
			) : null}
			{notice ? (
				<p className="composer__notice" role={notice.tone === "fail" ? "alert" : "status"}>
					<StatusMark tone={notice.tone} label={notice.tone === "fail" ? "Failed" : "Refused"} />
					{notice.message}
				</p>
			) : null}
			{/* Only while the turn runs: the query is disabled once it settles, and a
			    cached snapshot from a finished turn is a claim about the engine that
			    nothing observed. */}
			{running && steering.queue && queued.length > 0 ? (
				<section className="composer__queue" aria-label="Messages waiting on the engine">
					<p className="composer__queue-summary" role="status">
						{queueSummary(queued)}
					</p>
					<ol className="composer__queue-list">
						{queued.map((message) => (
							<li key={message.id} className="composer__queue-row">
								<StatusMark tone="warn" label={message.queue === "steer" ? "Now" : "After this turn"} />
								<span className="composer__queue-text">{message.text}</span>
							</li>
						))}
					</ol>
					<button
						className="composer__secondary"
						type="button"
						disabled={drain.isPending}
						onClick={() => drain.mutate()}
						title="Take every waiting message back out of the queue and into this field."
					>
						{drain.isPending ? "Taking them back…" : "Take them back"}
					</button>
				</section>
			) : null}
		</form>
	);
});
