/**
 * One exchange: the request, the response, and whatever the model did in between.
 *
 * The memo boundary is the point of the file. `groupTurns` guarantees that a turn whose items did
 * not change keeps its object identity, and the comparator below turns that guarantee into render
 * savings: a settled turn does not re-render while a later turn streams, does not re-render on the
 * one-second clock, and does not re-render when a permission lands somewhere else in the
 * conversation. Anything added to these props that changes identity on every delta throws that away,
 * which is why `row` and `notices` are compared explicitly and permission changes are checked
 * only for tool calls in this turn.
 *
 * Two truthfulness rules are enforced here rather than in CSS. A replayed turn has no `startedAt`
 * because the host refuses to stamp history with the current wall clock, so the meta line says the
 * time is not recorded instead of showing one. A replayed turn whose user item was never written
 * still gets a request card that states the prompt is missing, because a response with no question
 * above it reads as the model having spoken unprompted.
 */

import { memo } from "react";
import type { Permission } from "../../contracts/permissions.js";
import type { SessionSnapshot, Turn } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { StatusMark } from "../design/status.js";
import { MarkdownContent } from "../render/Markdown.js";
import { ActivityGroup } from "./ActivityGroup.js";
import { isAwaitingAnswer } from "./approval.js";
import {
	REPLAY_CHIP,
	requestView,
	responseAuthor,
	responseText,
	segmentSettled,
	toolCount,
	turnAriaLabel,
	turnStartedAt,
} from "./chat-turn.js";
import { turnOutcome } from "./composer.js";
import type { HealthRow } from "./health.js";
import { isLive, LIVE_GLYPHS, LIVE_TONES, type LiveStatus, livePlaceholder, liveStatus } from "./live-status.js";
import { MessageActions, TurnOutcome } from "./message-actions.js";
import { ReasoningDisclosure } from "./Reasoning.js";
import { describeTool } from "./tool-presentation.js";
import { type ChatTurn, sameTurnView } from "./turns.js";
import "./chat-turn.css";

const NO_NOTICES: readonly HealthRow[] = [];

export interface ChatTurnProps {
	readonly turn: ChatTurn;
	/** The `Turn` row for this turn, which carries the outcome. Absent until the turn starts. */
	readonly row: Turn | undefined;
	readonly client: Client;
	readonly session: SessionSnapshot;
	readonly pending: Permission | null;
	/** `pending?.id ?? null`. The comparator reads the id, not the object, which is rebuilt per tick. */
	readonly pendingPermissionId: string | null;
	/** The shared second, or 0 for a settled turn so the tick cannot reach it. */
	readonly nowMs: number;
	/** The cancel mutation's in-flight flag; the contract has no session-level cancelling phase. */
	readonly stopping: boolean;
	/** Health facts that happened during this turn, rendered where they happened. */
	readonly notices: readonly HealthRow[];
	readonly workspaceRoot: string | undefined;
	/** Dispatched runs still in flight. Zero for a settled turn, so it never re-renders one. */
	readonly liveWorkers: number;
}

function sameChatTurn(previous: ChatTurnProps, next: ChatTurnProps): boolean {
	if (previous.row !== next.row) return false;
	if (previous.liveWorkers !== next.liveWorkers) return false;
	if (previous.notices !== next.notices) return false;
	if (previous.stopping !== next.stopping) return false;
	// The live chip reads the current request, including its status and escalation facts.
	if (!previous.turn.settled && previous.pending !== next.pending) return false;
	// An anchored approval only reads the pending request for its own tool call. A request in
	// another turn must not repaint every settled response in a long conversation.
	if (previous.session.permissions !== next.session.permissions) {
		for (const item of previous.turn.items) {
			if (item.toolCallId === undefined) continue;
			const before = previous.session.permissions.find(
				(permission) => isAwaitingAnswer(permission) && permission.toolCallId === item.toolCallId,
			);
			const after = next.session.permissions.find(
				(permission) => isAwaitingAnswer(permission) && permission.toolCallId === item.toolCallId,
			);
			if (before !== after) return false;
		}
	}
	return sameTurnView(previous, next);
}

function LiveChip({ status }: { status: LiveStatus }) {
	return (
		<span className="live-chip" data-state={status.state}>
			<StatusMark
				tone={LIVE_TONES[status.state]}
				label={status.label}
				{...(status.detail === null ? {} : { detail: status.detail })}
			/>
		</span>
	);
}

function HealthNotices({ rows }: { rows: readonly HealthRow[] }) {
	if (rows.length === 0) return null;
	return (
		<ul className="turn-health">
			{rows.map((row) => (
				<li key={row.id}>
					<StatusMark tone={row.tone} label={row.label} {...(row.detail === null ? {} : { detail: row.detail })} />
				</li>
			))}
		</ul>
	);
}

export const ChatTurnView = memo(function ChatTurnView({
	turn,
	row,
	client,
	session,
	pending,
	nowMs,
	stopping,
	notices,
	workspaceRoot,
	liveWorkers,
}: ChatTurnProps) {
	const reported = liveStatus(turn, row, pending, stopping, liveWorkers);
	const last = turn.items.at(-1);
	// The chip names the running call the way its row does ("Run python3 analyze.py"), not by tool id.
	const status =
		reported.state === "acting" && reported.detail !== null && last?.kind === "tool" && last.status === "in_progress"
			? { ...reported, detail: describeTool(last, workspaceRoot) }
			: reported;
	const live = isLive(status) && !turn.settled;
	const request = requestView(turn);
	const author = responseAuthor(turn);
	const startedAt = turnStartedAt(row);
	const prompt = request.missing ? null : request.text;
	return (
		<article
			className={`chat-turn${live ? " is-live" : " is-settled"}${turn.origin === "replay" ? " is-replay" : ""}`}
			data-turn-id={turn.turnId}
			aria-label={turnAriaLabel(turn)}
		>
			<div className="chat-request">
				<div className="chat-request__meta">
					<span className="chat-request__who">{request.heading}</span>
					{request.replay ? <span className="chat-request__replay">{REPLAY_CHIP}</span> : null}
					{startedAt === null ? (
						<span className="chat-request__time">{formatTime(null)}</span>
					) : (
						<time dateTime={startedAt}>{formatTime(startedAt)}</time>
					)}
					<MessageActions
						sessionId={session.id}
						row="request"
						requestText={prompt}
						responseText={responseText(turn)}
						status={row?.status ?? "running"}
					/>
				</div>
				{/* The operator's own text is never reinterpreted as Markdown. */}
				<p className={`chat-request__prompt${request.missing ? " is-missing" : ""}`}>{request.text}</p>
			</div>
			<div className="chat-response">
				<div className="chat-response__meta">
					<span className="chat-response__who">{author.name}</span>
					{/* A settled turn states its outcome once, in the footer. */}
					{live || row === undefined ? <LiveChip status={status} /> : null}
				</div>
				<div className="chat-response__body">
					{turn.segments.length === 0 && live ? (
						<p className="chat-response__placeholder">
							<span aria-hidden="true">{LIVE_GLYPHS[status.state]}</span> {livePlaceholder(status)}
						</p>
					) : null}
					{turn.segments.map((segment, index) => {
						const settled = segmentSettled(live, index, turn.segments.length);
						switch (segment.kind) {
							case "response":
								return (
									<MarkdownContent key={segment.item.id} source={segment.item.text} complete={settled} deferDiagrams={live} />
								);
							case "reasoning":
								return <ReasoningDisclosure key={segment.item.id} item={segment.item} />;
							default:
								return (
									<ActivityGroup
										key={segment.items[0]?.id ?? `activity-${index}`}
										items={segment.items}
										settled={settled}
										client={client}
										session={session}
										workspaceRoot={workspaceRoot}
										nowMs={nowMs}
									/>
								);
						}
					})}
				</div>
				<div className="chat-response__meta chat-response__footer">
					<MessageActions
						sessionId={session.id}
						row="response"
						requestText={prompt}
						responseText={responseText(turn)}
						status={row?.status ?? "running"}
					/>
				</div>
				{row !== undefined && row.status !== "running" ? (
					<TurnOutcome outcome={turnOutcome(row, toolCount(turn))} formatClock={formatTime} />
				) : null}
			</div>
			<HealthNotices rows={notices} />
		</article>
	);
}, sameChatTurn);

export { NO_NOTICES };
