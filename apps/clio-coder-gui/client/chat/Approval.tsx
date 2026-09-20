// The permission card, in its two surfaces. Every decision it makes lives in ./approval.ts; this
// file is the declarative half plus the four side effects that reach outside React: the tab title
// marker, the screen-reader announcement, the escalation announcement and the desktop notification.
//
// The banner is pinned above the transcript and is deliberately NOT focus-trapping. An approval is
// not a modal: the operator may keep reading, scrolling and typing while it waits, which is the
// only way to review the thing being approved.

import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Permission, PermissionDecision } from "../../contracts/permissions.js";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot, TimelineItem } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { clock } from "../api/clock.js";
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

/** The one mutation both surfaces answer through, exported so a tool card can reuse it. */
export function useAnswerApproval(client: Client, sessionId: string) {
	return useMutation({
		mutationFn: ({ id, decision }: { id: string; decision: PermissionDecision }) =>
			client.call(routes.permission, { params: { id: sessionId, permissionId: id }, query: {}, body: { decision } }),
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
					<code>{preview.kind === "path" ? preview.path : preview.url}</code>
				</p>
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

interface CardProps {
	readonly permission: Permission;
	readonly call: GatedCall | undefined;
	readonly answer: AnswerApproval;
	readonly eyebrow: string;
	readonly hint?: string;
	readonly variant: "banner" | "anchored";
}

function ApprovalCard({ permission, call, answer, eyebrow, hint, variant }: CardProps) {
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
				{approvalActions(permission).map((action) => (
					<button
						key={action.decision}
						type="button"
						className={action.variant === "primary" ? "primary" : ""}
						title={action.description}
						disabled={answer.isPending}
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
			</div>
			{hint === undefined ? null : <p className="approval-card__hint">{hint}</p>}
			{answer.error ? <p role="alert">{answer.error.message}</p> : null}
		</article>
	);
}

/**
 * The banner above the transcript. It owns the four out-of-band effects and the two keyboard chords,
 * so an anchored row rendered for the same permission never double-announces or double-binds.
 */
export function ApprovalBanner({ client, session }: { client: Client; session: SessionSnapshot }) {
	const answer = useAnswerApproval(client, session.id);
	const permission = pendingPermission(session);
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

	const enabled = permission !== undefined && !answer.isPending;
	useShortcut("allowOnce", () => permission && answer.mutate({ id: permission.id, decision: "allow-once" }), {
		enabled,
	});
	useShortcut("reject", () => permission && answer.mutate({ id: permission.id, decision: "reject" }), { enabled });

	if (!permission) return null;
	return (
		// A named `section` already exposes the region role, which is what the banner needs; spelling
		// the role out as well is the redundancy the linter rejects.
		<section className="approval-banner" aria-label="Approval needed">
			<ApprovalCard
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
	if (!permission) return null;
	return <ApprovalCard permission={permission} call={item} answer={answer} eyebrow={CARD_EYEBROW} variant="anchored" />;
}
