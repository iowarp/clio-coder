// The permission card, in its two surfaces. Every decision it makes lives in ./approval.ts; this
// file is the declarative half plus the four side effects that reach outside React: the tab title
// marker, the screen-reader announcement, the escalation announcement and the desktop notification.
//
// The banner is pinned above the transcript and is deliberately NOT focus-trapping. An approval is
// not a modal: the operator may keep reading, scrolling and typing while it waits, which is the
// only way to review the thing being approved.

import { useIsMutating, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useState, useSyncExternalStore } from "react";
import type { Permission, PermissionDecision } from "../../contracts/permissions.js";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot, TimelineItem } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { clock, formatDuration } from "../api/clock.js";
import { StatusMark } from "../design/status.js";
import {
	announce,
	announceEscalation,
	postApprovalNotification,
	setApprovalPending,
} from "../interaction/announcer.js";
import { KEYBINDINGS } from "../interaction/keybindings.js";
import { useShortcut } from "../interaction/use-shortcut.js";
import {
	approvalActions,
	approvalAnnouncement,
	bannerEyebrow,
	CARD_EYEBROW,
	clampText,
	decisionChips,
	decisionRows,
	decisionTone,
	deriveApprovalTimings,
	type GatedCall,
	type GatedPreview,
	gatedPreview,
	isAwaitingAnswer,
	KEYBOARD_HINT,
	NO_DECISION_FACTS,
	safetyFacts,
} from "./approval.js";
import "./approval.css";

/**
 * Which permissions currently have their anchored card on the page. The banner reads this to decide
 * whether it must carry the whole review or can stay one line that points at the card, because the
 * anchored card is not rendered when its call is missing from the timeline or its group is folded.
 */
const anchoredCards = new Map<string, number>();
const anchorListeners = new Set<() => void>();
function registerAnchor(id: string): () => void {
	anchoredCards.set(id, (anchoredCards.get(id) ?? 0) + 1);
	for (const listener of anchorListeners) listener();
	return () => {
		const count = (anchoredCards.get(id) ?? 1) - 1;
		if (count > 0) anchoredCards.set(id, count);
		else anchoredCards.delete(id);
		for (const listener of anchorListeners) listener();
	};
}
function subscribeAnchors(listener: () => void): () => void {
	anchorListeners.add(listener);
	return () => anchorListeners.delete(listener);
}
function useAnchored(id: string | null): boolean {
	return useSyncExternalStore(subscribeAnchors, () => id !== null && anchoredCards.has(id));
}
const anchorId = (permissionId: string) => `approval-${permissionId}`;

/** One shared second. A countdown phrased as a consequence still has to move. */
function useSecond(active: boolean): number {
	const [now, setNow] = useState(() => clock.now());
	useEffect(() => {
		if (!active) return;
		setNow(clock.now());
		const timer = setInterval(() => setNow(clock.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

export type AnswerApproval = ReturnType<typeof useAnswerApproval>;

const permissionMutationKey = (sessionId: string) => ["permission-answer", sessionId] as const;

/** A successful answer stays disabled until the session snapshot removes the request. */
function useAnswerSent(sessionId: string, permissionId: string | undefined): boolean {
	const answeredIds = useMutationState({
		filters: { mutationKey: permissionMutationKey(sessionId), status: "success" },
		select: (mutation) => (mutation.state.variables as { id?: string } | undefined)?.id,
	});
	return permissionId !== undefined && answeredIds.includes(permissionId);
}

/** The one mutation both surfaces answer through, exported so a tool card can reuse it. */
export function useAnswerApproval(client: Client, sessionId: string) {
	const queries = useQueryClient();
	return useMutation({
		mutationKey: permissionMutationKey(sessionId),
		mutationFn: ({ id, decision }: { id: string; decision: PermissionDecision }) =>
			client.call(routes.permission, { params: { id: sessionId, permissionId: id }, query: {}, body: { decision } }),
		onSuccess: () => {
			void queries.invalidateQueries({ queryKey: ["session", sessionId] });
			void queries.invalidateQueries({ queryKey: ["sessions"] });
		},
	});
}

export const pendingPermission = (session: SessionSnapshot): Permission | undefined =>
	session.permissions.find(isAwaitingAnswer);

/** The permission gating this exact call, matched on the contract's direct link. */
export const permissionForCall = (session: SessionSnapshot, item: TimelineItem): Permission | undefined =>
	item.toolCallId === undefined
		? undefined
		: session.permissions.find((permission) => isAwaitingAnswer(permission) && permission.toolCallId === item.toolCallId);

function Preview({ preview }: { preview: GatedPreview }) {
	if (preview.kind === "command")
		return (
			<div className="approval-preview">
				<p className="approval-preview__label">{preview.label}</p>
				<pre className="approval-preview__code">
					<code>{preview.command}</code>
				</pre>
				{preview.truncated ? <p className="approval-preview__note">Shortened for display.</p> : null}
			</div>
		);
	if (preview.kind === "edits")
		return (
			<div className="approval-preview">
				<p className="approval-preview__label">
					{preview.label} · {preview.path}
				</p>
				{preview.edits.map((edit, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: an edit list has no id and is positional.
					<div className="approval-proposed" key={index}>
						<pre className="approval-proposed__side" data-side="del">
							<code>{edit.oldText}</code>
						</pre>
						<pre className="approval-proposed__side" data-side="add">
							<code>{edit.newText}</code>
						</pre>
					</div>
				))}
				{preview.truncated ? <p className="approval-preview__note">Shortened for display.</p> : null}
			</div>
		);
	if (preview.kind === "contents")
		return (
			<div className="approval-preview">
				<p className="approval-preview__label">
					{preview.label} · {preview.path}
				</p>
				<pre className="approval-proposed__side" data-side="add">
					<code>{preview.contents}</code>
				</pre>
				{preview.truncated ? <p className="approval-preview__note">Shortened for display.</p> : null}
			</div>
		);
	if (preview.kind === "path" || preview.kind === "host")
		return (
			<div className="approval-preview">
				<p className="approval-preview__label">{preview.label}</p>
				<p className="approval-preview__value">
					<code>{preview.kind === "path" ? preview.path : preview.requestedUrl}</code>
				</p>
				{preview.kind === "host" && preview.truncated ? (
					<p className="approval-preview__note">Shortened for display. Open request details to inspect more.</p>
				) : null}
			</div>
		);
	if (preview.kind === "summary")
		return (
			<div className="approval-preview">
				<p className="approval-preview__label">{preview.label}</p>
				<p className="approval-preview__value">{preview.summary}</p>
			</div>
		);
	return (
		<div className="approval-preview">
			<p className="approval-preview__label">{preview.label}</p>
			<p className="approval-preview__note">{preview.note}</p>
		</div>
	);
}

/** Keep the exact tool arguments available without filling a compact approval with raw JSON. */
const RawRequest = memo(function RawRequest({ input }: { input: Readonly<Record<string, unknown>> | undefined }) {
	const [open, setOpen] = useState(false);
	if (!input || Object.keys(input).length === 0) return null;
	const full = open ? JSON.stringify(input, null, 2) : "";
	const display = open ? clampText(full, 800, 32_000) : null;
	return (
		<details className="approval-raw" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>Request details · tool arguments</summary>
			{display ? (
				<>
					<pre className="approval-raw__code">
						<code>{display.text}</code>
					</pre>
					{display.truncated ? <p className="approval-preview__note">Details shortened for display.</p> : null}
				</>
			) : null}
		</details>
	);
});

/** The decision itself. The banner and the anchored card render the same buttons into one mutation. */
function ApprovalButtons({
	sessionId,
	permission,
	answer,
}: {
	sessionId: string;
	permission: Permission;
	answer: AnswerApproval;
}) {
	const answering = useIsMutating({ mutationKey: permissionMutationKey(sessionId) }) > 0;
	const answerSent = useAnswerSent(sessionId, permission.id);
	return (
		<>
			{approvalActions(permission).map((action) => (
				<button
					key={action.decision}
					type="button"
					className={action.variant === "primary" ? "primary" : ""}
					title={action.description}
					disabled={answering || answerSent}
					onClick={() => answer.mutate({ id: permission.id, decision: action.decision })}
				>
					{action.label}
					{action.keybinding === null ? null : (
						<span className="approval-card__chord" aria-hidden="true">
							{KEYBINDINGS[action.keybinding].modifiers.includes("alt") ? "Alt+" : ""}
							{KEYBINDINGS[action.keybinding].key.toUpperCase()}
						</span>
					)}
				</button>
			))}
		</>
	);
}

interface CardProps {
	readonly sessionId: string;
	readonly permission: Permission;
	readonly call: GatedCall | undefined;
	readonly answer: AnswerApproval;
	readonly eyebrow: string;
	readonly hint?: string;
	readonly variant: "banner" | "anchored";
}

function ApprovalCard({ sessionId, permission, call, answer, eyebrow, hint, variant }: CardProps) {
	const now = useSecond(true);
	const timings = deriveApprovalTimings(permission, now);
	const facts = safetyFacts(permission, call?.locations, timings);
	const chips = decisionChips(permission.decision);
	const rows = decisionRows(permission.decision);
	return (
		<article
			className={`approval-card approval-card--${variant}`}
			data-escalated={timings.escalated}
			aria-label="Permission request"
			{...(variant === "anchored" ? { id: anchorId(permission.id), tabIndex: -1 } : {})}
		>
			<p className="approval-card__eyebrow">{eyebrow}</p>
			<h2 className="approval-card__title">{permission.title}</h2>
			{chips.length > 0 ? (
				<p className="approval-card__chips">
					<StatusMark tone={decisionTone(permission.decision)} label={chips[0] ?? ""} />
					{chips.slice(1).map((chip) => (
						<span className="approval-chip" key={chip}>
							{chip}
						</span>
					))}
				</p>
			) : (
				<p className="approval-card__chips">
					<StatusMark tone="warn" label="Unclassified" detail={NO_DECISION_FACTS} />
				</p>
			)}
			<Preview preview={gatedPreview(call)} />
			<RawRequest input={call?.rawInput} />
			{rows.length > 0 ? (
				<dl className="approval-decision">
					{rows.map((row) => (
						<div key={row.term}>
							<dt>{row.term}</dt>
							<dd>{row.value}</dd>
						</div>
					))}
				</dl>
			) : null}
			<ul className="approval-card__facts">
				{facts.map((fact) => (
					<li key={fact}>{fact}</li>
				))}
			</ul>
			<div className="approval-card__actions">
				<ApprovalButtons sessionId={sessionId} permission={permission} answer={answer} />
			</div>
			{hint === undefined ? null : <p className="approval-card__hint">{hint}</p>}
			{answer.error && answer.variables?.id === permission.id ? <p role="alert">{answer.error.message}</p> : null}
		</article>
	);
}

/**
 * The banner above the transcript. It owns the four out-of-band effects and the two keyboard chords,
 * so an anchored row rendered for the same permission never double-announces or double-binds.
 */
export function ApprovalBanner({ client, session }: { client: Client; session: SessionSnapshot }) {
	const answer = useAnswerApproval(client, session.id);
	const answering = useIsMutating({ mutationKey: permissionMutationKey(session.id) }) > 0;
	const permission = pendingPermission(session);
	const answerSent = useAnswerSent(session.id, permission?.id);
	const call = permission ? session.timeline.find((item) => item.toolCallId === permission.toolCallId) : undefined;
	const now = useSecond(permission !== undefined);
	const timings = permission ? deriveApprovalTimings(permission, now) : null;
	const escalated = timings?.escalated === true;
	const escalationWindow = timings?.declaredEscalationSeconds ?? null;
	const id = permission?.id ?? null,
		title = permission?.title ?? "",
		kind = permission?.kind ?? "";

	// The tab title has exactly one writer (client/interaction/announcer.ts), so this only raises the
	// flag it composes from; nothing here touches `document.title` directly.
	useEffect(() => {
		setApprovalPending(id !== null);
		return () => setApprovalPending(false);
	}, [id]);
	useEffect(() => {
		if (id === null) return;
		announce(approvalAnnouncement({ title, kind }), "assertive");
	}, [id, title, kind]);
	// The declared window, not the observed wait: say what the product promised.
	useEffect(() => {
		announceEscalation(escalated && escalationWindow !== null ? escalationWindow : null);
		return () => announceEscalation(null);
	}, [escalated, escalationWindow]);
	// One notification per card, never repeated, and only when the browser already granted it.
	useEffect(() => {
		if (id === null) return;
		return postApprovalNotification(id, title);
	}, [id, title]);

	const enabled = permission !== undefined && !answering && !answerSent;
	useShortcut("allowOnce", () => permission && answer.mutate({ id: permission.id, decision: "allow-once" }), {
		enabled,
	});
	useShortcut("reject", () => permission && answer.mutate({ id: permission.id, decision: "reject" }), { enabled });

	const anchored = useAnchored(id);
	if (!permission) return null;
	// The anchored card beside the call carries the review, so the pinned surface stays one line: what
	// is asked, how long is left, the decision, and a way back to the card if it has scrolled away.
	if (anchored)
		return (
			<section className="approval-banner approval-banner--strip" aria-label="Approval needed">
				<p className="approval-strip" data-escalated={escalated}>
					<span className="approval-strip__glyph" aria-hidden="true">
						!
					</span>
					<span className="approval-strip__eyebrow">{escalated ? "Approval waiting" : "Approval needed"}</span>
					<strong className="approval-strip__title">{permission.title}</strong>
					{timings?.budgetKnown ? (
						<span className="approval-strip__left">stops in {formatDuration(timings.remainingMs)}</span>
					) : null}
				</p>
				<div className="approval-strip__actions">
					<button
						type="button"
						className="approval-strip__review"
						onClick={() => {
							const card = document.getElementById(anchorId(permission.id));
							card?.scrollIntoView({ block: "center" });
							card?.focus({ preventScroll: true });
						}}
					>
						Review
					</button>
					<ApprovalButtons sessionId={session.id} permission={permission} answer={answer} />
				</div>
			</section>
		);
	return (
		// A named `section` already exposes the region role, which is what the banner needs; spelling
		// the role out as well is the redundancy the linter rejects.
		<section className="approval-banner" aria-label="Approval needed">
			<ApprovalCard
				sessionId={session.id}
				permission={permission}
				call={call}
				answer={answer}
				eyebrow={bannerEyebrow(escalated)}
				hint={KEYBOARD_HINT}
				variant="banner"
			/>
		</section>
	);
}

/**
 * The same decision, anchored to the exact tool call it gates. Both surfaces stay live and either
 * one answers; the card the operator missed in a recorded session was the one that was not here.
 */
export function AnchoredApproval({
	client,
	session,
	item,
}: {
	client: Client;
	session: SessionSnapshot;
	item: TimelineItem;
}) {
	const answer = useAnswerApproval(client, session.id);
	const permission = permissionForCall(session, item);
	const permissionId = permission?.id ?? null;
	useEffect(() => (permissionId === null ? undefined : registerAnchor(permissionId)), [permissionId]);
	if (!permission) return null;
	return (
		<ApprovalCard
			sessionId={session.id}
			permission={permission}
			call={item}
			answer={answer}
			eyebrow={CARD_EYEBROW}
			variant="anchored"
		/>
	);
}
