/**
 * The composer. Every decision it makes lives in `composer.ts`; this file is
 * the wiring and the markup.
 *
 * Two properties are load-bearing and easy to lose in a refactor:
 *
 * 1. It reads the draft from a store outside React, and its props are scalars
 *    or memoized facts behind `memo`, so a streamed timeline delta does not
 *    re-render the textarea. Passing the whole `SessionSnapshot` in would undo
 *    that, and so would a `route` object rebuilt on every render.
 * 2. The textarea is never disabled while a turn runs. Only the submit changes
 *    meaning, and a draft typed mid-turn survives the turn.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { StatusMark, TONE_GLYPHS } from "../design/status.js";
import { useLayersActive } from "../interaction/use-shortcut.js";
import { countRender } from "../render/render-probe.js";
import {
	capabilityRefusal,
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
import type { RouteFacts } from "./route.js";
import "./composer.css";

/** Focus handlers keyed by session, so a retry elsewhere in the turn can fill and focus this field. */
const focusHandlers = new Map<string, () => void>();
const ENTER_SENDS_KEY = "clio-coder-enter-sends";

function initialEnterSends(): boolean {
	try {
		const saved = localStorage.getItem(ENTER_SENDS_KEY);
		if (saved === "true" || saved === "false") return saved === "true";
	} catch {
		// The choice still works for this page when browser storage is unavailable.
	}
	return typeof matchMedia !== "function" || matchMedia("(pointer: fine)").matches;
}

/** Grow with the draft until CSS applies its cap; after that, keep scrolling inside the field. */
function fitComposerField(field: HTMLTextAreaElement | null): void {
	if (field === null) return;
	field.style.height = "auto";
	field.style.height = `${field.scrollHeight}px`;
	field.style.overflowY = field.scrollHeight > field.clientHeight ? "auto" : "hidden";
}

/** Fill the composer for this session and put the caret in it. Used by Try again and the starters. */
export function fillComposer(sessionId: string, text: string): void {
	draftStore(sessionId).write(text);
	focusHandlers.get(sessionId)?.();
}

export interface ComposerProps {
	readonly client: Client;
	readonly sessionId: string;
	readonly sessionState: SessionSnapshot["state"];
	readonly initialFocus: boolean;
	/** The id of the turn running right now, or null when none is. */
	readonly runningTurnId: string | null;
	/** Where the next request goes. Memoize it: a new object on every render re-renders the field. */
	readonly route: RouteFacts;
}

/** The target and model beside Send, with the target's reported health as its glyph. */
function RouteChip({ route }: { route: RouteFacts }) {
	return (
		<span className="route-chip" data-tone={route.tone} title={route.title}>
			<span className="route-chip__glyph" aria-hidden="true">
				{TONE_GLYPHS[route.tone]}
			</span>
			<span className="route-chip__text">{route.text}</span>
			<span className="sr-only">{route.spoken}</span>
		</span>
	);
}

export const Composer = memo(function Composer({
	client,
	sessionId,
	sessionState,
	initialFocus,
	runningTurnId,
	route,
}: ComposerProps) {
	countRender("composer");
	const queries = useQueryClient();
	const store = draftStore(sessionId);
	const draft = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
	const field = useRef<HTMLTextAreaElement | null>(null);
	const sending = useRef(false);
	const fieldId = useId();
	const hintId = useId();
	const [enterSends, setEnterSends] = useState(initialEnterSends);
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
	useEffect(() => {
		if (initialFocus && sessionState === "open" && window.matchMedia("(pointer: fine)").matches) field.current?.focus();
	}, [initialFocus, sessionState]);

	// This runs only with the isolated draft, never with incoming transcript frames.
	// biome-ignore lint/correctness/useExhaustiveDependencies: draft.text is the resize trigger; the DOM read happens in the callback.
	useLayoutEffect(() => fitComposerField(field.current), [draft.text]);
	useEffect(() => {
		const fit = () => fitComposerField(field.current);
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	}, []);
	useEffect(() => {
		try {
			localStorage.setItem(ENTER_SENDS_KEY, String(enterSends));
		} catch {
			// The in-memory choice remains usable.
		}
	}, [enterSends]);

	// Read once per session and keep. Every steering route answers 409 when the
	// agent announced nothing, so this decides what is rendered at all.
	const capabilities = useQuery({
		queryKey: ["session-capabilities", sessionId],
		queryFn: () => client.call(routes.sessionCapabilities, params),
		enabled: sessionState === "open",
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
		mutationFn: async ({ intent }: { intent: Exclude<SubmitIntent, { kind: "blocked" }>; draft: typeof draft }) => {
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
		onSuccess: (result, submitted) => {
			if (result !== null && !result.accepted) store.refuse(submitted.draft);
			else store.acknowledge(submitted.draft);
			// The event stream normally paints the turn. A snapshot also catches up if
			// this browser was reconnecting when the request was accepted.
			void queries.invalidateQueries({ queryKey: ["session", sessionId] });
			if (result !== null) void queries.invalidateQueries({ queryKey: ["session-queue", sessionId] });
		},
		onError: (error, submitted) => {
			// A 409 is a definite server refusal and is cached by its idempotency key.
			// Network failures are ambiguous, so they keep the key for a safe retry.
			if (capabilityRefusal(error) !== null) store.refuse(submitted.draft);
		},
		onSettled: () => {
			sending.current = false;
		},
	});

	const interrupt = useMutation({
		mutationFn: () => client.call(routes.interruptSession, { ...params, body: {} }),
		onSuccess: () => void queries.invalidateQueries({ queryKey: ["session", sessionId] }),
	});
	const stop = useMutation({
		mutationFn: () =>
			client.call(routes.cancelTurn, { params: { id: sessionId, turnId: runningTurnId ?? "" }, query: {}, body: {} }),
		onSuccess: () => void queries.invalidateQueries({ queryKey: ["session", sessionId] }),
	});
	const drain = useMutation({
		mutationFn: () => client.call(routes.clearSessionQueue, { ...params, body: {} }),
		onSuccess: (result) => {
			store.write(restoredDraft(store.snapshot().text, result.restored));
			void queries.invalidateQueries({ queryKey: ["session-queue", sessionId] });
			field.current?.focus();
		},
	});

	const steeringUnavailable: "checking" | "failed" | undefined = capabilities.data
		? undefined
		: capabilities.isFetching || capabilities.isPending
			? "checking"
			: capabilities.error
				? "failed"
				: "checking";
	const situation = {
		sessionState,
		turnRunning: running,
		sending: send.isPending,
		steering,
		...(steeringUnavailable === undefined ? {} : { steeringUnavailable }),
	} as const;
	const intent = submitIntent(draft, situation);
	// Recomputed from the store rather than closed over, so a keystroke that
	// lands between render and keydown still sends the text the operator sees.
	const submit = () => {
		if (sending.current) return;
		const current = store.snapshot();
		const next = submitIntent(current, situation);
		if (next.kind !== "blocked") {
			sending.current = true;
			store.markSubmitted(current);
			send.mutate({ intent: next, draft: current });
		}
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
			<label className="composer__label sr-only" htmlFor={fieldId}>
				Message Clio Coder
			</label>
			<textarea
				id={fieldId}
				ref={field}
				className="composer__field"
				aria-describedby={hintId}
				value={draft.text}
				rows={1}
				disabled={sessionState !== "open"}
				placeholder={
					sessionState !== "open"
						? "This conversation is not open"
						: running
							? steering.steer || steering.queue
								? "Add direction for Clio Coder while it works"
								: "Draft your next message while Clio Coder works"
							: "Ask Clio Coder to do something in this project"
				}
				onChange={(event) => {
					store.write(event.target.value);
					if (!send.isPending) send.reset();
				}}
				onKeyDown={(event) => {
					const action = composerKeyAction(
						{
							key: event.key,
							altKey: event.altKey,
							ctrlKey: event.ctrlKey,
							metaKey: event.metaKey,
							shiftKey: event.shiftKey,
						},
						{ layerOwned, composing: event.nativeEvent.isComposing, plainEnterSends: enterSends },
					);
					if (action !== "send") return;
					event.preventDefault();
					submit();
				}}
			/>
			{store.uncertainSubmission() && (
				<p className="composer__notice" role="status">
					<StatusMark tone="warn" label="Review draft" />A send may have finished before this page reloaded. Check the
					conversation above before sending this draft again.
					<button type="button" className="composer__secondary" onClick={() => store.clear()}>
						Discard draft
					</button>
				</p>
			)}
			{/* Delivery only matters once there is something to deliver mid-turn, so the choice appears with the draft. */}
			{running && modes.length > 1 && draft.text.trim() !== "" ? (
				<fieldset className="composer__modes">
					<legend>Deliver this</legend>
					{modes.map((offer) => (
						<label key={offer.mode} className="composer__mode" title={offer.lands}>
							<input
								type="radio"
								name={`${fieldId}-mode`}
								checked={draft.mode === offer.mode}
								onChange={() => {
									store.chooseMode(offer.mode);
									if (!send.isPending) send.reset();
								}}
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
				<label className="composer__enter-mode">
					<input type="checkbox" checked={enterSends} onChange={(event) => setEnterSends(event.target.checked)} />
					Enter sends
				</label>
				<p className="composer__hint" id={hintId}>
					{enterSends ? "Shift+Enter adds a line" : "Enter adds a line · Ctrl/⌘+Enter sends"}
				</p>
				<RouteChip route={route} />
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
							className="composer__secondary composer__stop"
							type="button"
							disabled={stop.isPending}
							onClick={() => stop.mutate()}
							title="End this turn now. Nothing further is run."
						>
							<span aria-hidden="true">■</span> {stop.isPending ? "Stopping…" : "Stop turn"}
						</button>
					</>
				) : null}
				<button
					className="composer__submit primary"
					type="submit"
					disabled={intent.kind === "blocked"}
					title={intent.kind === "blocked" ? intent.reason : undefined}
				>
					{send.isPending ? "Sending…" : submitLabel(intent, situation, draft.mode)}
				</button>
			</div>
			{intent.kind === "blocked" && draft.text.trim() !== "" ? (
				<p className="composer__blocked" role="status">
					{intent.reason}
					{running && steeringUnavailable === "failed" ? (
						<button
							type="button"
							className="composer__secondary"
							disabled={capabilities.isFetching}
							onClick={() => void capabilities.refetch()}
						>
							Retry control check
						</button>
					) : null}
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
