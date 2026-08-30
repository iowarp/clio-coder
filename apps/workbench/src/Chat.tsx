/**
 * The conversational working surface.
 *
 * Turns are the visual rhythm: the operator's request, Clio Coder's response
 * rendered as Markdown, and the tools it ran folded into one compact activity
 * group per stretch of work. Everything shown here is projected from the same
 * timeline the Session Timeline view lists in full.
 */

import { memo, type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import {
	type ActivitySummary,
	type ChatTurn,
	type LiveStatus,
	liveStatus,
	SOURCE_LABELS,
	summarizeActivity,
	TOOL_STATUS_LABELS,
} from "./chat.ts";
import { elapsedSeconds, formatClock, formatDuration } from "./format.ts";
import { MarkdownContent } from "./Markdown.tsx";
import type { WireClioPhase, WirePendingPermission, WireTimelineItem, WireUsage } from "./protocol.ts";
import { formatProjectPath } from "./state.ts";

const STATUS_GLYPHS: Readonly<Record<WireTimelineItem["status"], string>> = {
	queued: "…",
	active: "◐",
	waiting: "!",
	complete: "✓",
	canceled: "–",
	failed: "✕",
	replayed: "○",
};

const LIVE_GLYPHS: Readonly<Record<LiveStatus["state"], string>> = {
	starting: "◌",
	thinking: "◔",
	writing: "◑",
	acting: "◐",
	waiting: "!",
	stopping: "–",
	done: "✓",
	failed: "✕",
	stopped: "–",
};

export function LiveChip({ status, elapsed }: { status: LiveStatus; elapsed: number | null }) {
	return (
		<span className={`live-chip live-chip--${status.state}`} role="status">
			<span className="live-chip__glyph" aria-hidden="true">{LIVE_GLYPHS[status.state]}</span>
			<span className="live-chip__label">{status.label}</span>
			{status.detail !== null && <span className="live-chip__detail">{status.detail}</span>}
			{elapsed !== null && <span className="live-chip__elapsed">{formatDuration(elapsed)}</span>}
		</span>
	);
}

function ActivityRow({ item, nowMs, pendingPermission, onResolve }: {
	item: WireTimelineItem;
	nowMs: number;
	pendingPermission: WirePendingPermission | null;
	onResolve?: (decision: "allow-once" | "reject") => void;
}) {
	const active = item.status === "active";
	const elapsed = active ? elapsedSeconds(item.startedAt, nowMs) : null;
	const isPendingApproval = item.kind === "approval" && item.status === "waiting" && pendingPermission !== null &&
		item.id.endsWith(`:${pendingPermission.permissionId}`);
	const kindLabel = item.kind === "tool"
		? item.detail?.split(" · ", 1)[0] ?? "tool"
		: item.kind === "approval"
		? "approval"
		: "safety";
	return (
		<li className={`activity-row activity-row--${item.kind} is-${item.status}`}>
			<span className="activity-row__glyph" aria-hidden="true">{STATUS_GLYPHS[item.status]}</span>
			<span className="activity-row__kind">{kindLabel}</span>
			<span className="activity-row__title">
				{item.kind === "tool" ? item.summary : item.title}
				{item.kind === "approval" && <span className="activity-row__note">{item.summary}</span>}
				{item.kind === "loop" && (
					<span className="activity-row__note">{SOURCE_LABELS[item.source]} · {item.summary}</span>
				)}
			</span>
			<span className="activity-row__state">
				<span className="sr-only">status</span>
				{TOOL_STATUS_LABELS[item.status]}
				{elapsed !== null && elapsed >= 2 && <span className="activity-row__elapsed">· {formatDuration(elapsed)}</span>}
			</span>
			{isPendingApproval && pendingPermission !== null && onResolve !== undefined && (
				<span className="activity-row__approval" id="permission-title">
					<span className="activity-row__approval-facts">
						{pendingPermission.kind} access to {pendingPermission.locations.length === 0
							? "this turn"
							: pendingPermission.locations.map((location) =>
								formatProjectPath(location)
							).join(", ")}. Nothing runs until you answer; the GUI never answers for you.
					</span>
					<span className="activity-row__approval-actions">
						<button
							type="button"
							className="button button--quiet"
							onClick={() =>
								onResolve("reject")}
						>
							Reject
						</button>
						<button
							type="button"
							className="button button--action"
							onClick={() => onResolve("allow-once")}
						>
							Allow once
						</button>
					</span>
				</span>
			)}
		</li>
	);
}

function ActivityGroup({ items, settled, nowMs, pendingPermission, onResolve }: {
	items: readonly WireTimelineItem[];
	settled: boolean;
	nowMs: number;
	pendingPermission: WirePendingPermission | null;
	onResolve?: (decision: "allow-once" | "reject") => void;
}) {
	const summary: ActivitySummary = summarizeActivity(items);
	const [userOpen, setUserOpen] = useState<boolean | null>(null);
	const open = userOpen ?? ((!settled && summary.attention) || summary.failed > 0 || summary.waiting > 0);
	const running = items.find((item) => item.status === "active");
	return (
		<details
			className={`activity activity--${summary.tone}${open ? " is-open" : ""}`}
			open={open}
			onToggle={(event) => {
				if (event.currentTarget.open !== open) setUserOpen(event.currentTarget.open);
			}}
		>
			<summary className="activity__summary">
				<span className="activity__glyph" aria-hidden="true">
					{summary.waiting > 0 ? "!" : summary.running > 0 ? "◐" : summary.failed > 0 ? "✕" : "✓"}
				</span>
				<span className="activity__label">{summary.label}</span>
				{running !== undefined && summary.waiting === 0 && <span className="activity__current">{running.summary}</span>}
				<span className="activity__count" aria-hidden="true">{summary.total}</span>
			</summary>
			<ul className="activity__rows">
				{items.map((item) => (
					<ActivityRow
						item={item}
						nowMs={nowMs}
						pendingPermission={pendingPermission}
						onResolve={onResolve}
						key={item.id}
					/>
				))}
			</ul>
		</details>
	);
}

function ReasoningDisclosure({ item }: { item: WireTimelineItem }) {
	const preview = item.summary.trim().split("\n", 1)[0] ?? "";
	return (
		<details className="reasoning">
			<summary className="reasoning__summary">
				<span className="reasoning__label">Reasoning</span>
				<span className="reasoning__preview">{preview.length > 140 ? `${preview.slice(0, 140)}…` : preview}</span>
				<span className="reasoning__source">reported by Clio Coder</span>
			</summary>
			<p className="reasoning__body">{item.summary}</p>
		</details>
	);
}

function usageSummary(usage: WireUsage): string {
	return `${usage.input.toLocaleString()} in · ${usage.output.toLocaleString()} out`;
}

function usageTitle(usage: WireUsage): string {
	return `input ${usage.input} · output ${usage.output} · cache read ${usage.cacheRead} · cache write ${usage.cacheWrite} · reasoning ${usage.reasoning}`;
}

function TurnOutcome({ item, toolCount }: { item: WireTimelineItem; toolCount: number }) {
	const failed = item.kind === "failure" || item.status === "failed";
	const stopped = item.status === "canceled";
	return (
		<footer className={`turn-outcome${failed ? " is-failed" : stopped ? " is-stopped" : ""}`}>
			<span className="turn-outcome__glyph" aria-hidden="true">{failed ? "✕" : stopped ? "–" : "✓"}</span>
			<span className="turn-outcome__label">{item.title}</span>
			{(failed || stopped) && item.summary.length > 0 && <span className="turn-outcome__detail">{item.summary}</span>}
			{failed && item.detail !== undefined && <code className="turn-outcome__code">{item.detail}</code>}
			{toolCount > 0 && (
				<span className="turn-outcome__fact">{toolCount} tool {toolCount === 1 ? "call" : "calls"}</span>
			)}
			{item.usage !== undefined && (
				<span className="turn-outcome__fact" title={usageTitle(item.usage)}>tokens {usageSummary(item.usage)}</span>
			)}
			{item.endedAt !== undefined && <time dateTime={item.endedAt}>{formatClock(item.endedAt)}</time>}
		</footer>
	);
}

interface ChatTurnViewProps {
	readonly turn: ChatTurn;
	readonly phase: WireClioPhase;
	readonly pendingPermission: WirePendingPermission | null;
	readonly nowMs: number;
	readonly onResolve?: (decision: "allow-once" | "reject") => void;
}

const ChatTurnView = memo(
	function ChatTurnView({ turn, phase, pendingPermission, nowMs, onResolve }: ChatTurnViewProps) {
		const status = liveStatus(turn, phase, pendingPermission);
		const live = !turn.settled;
		const elapsed = live && turn.request !== null ? elapsedSeconds(turn.request.startedAt, nowMs) : null;
		const toolCount = turn.items.filter((item) => item.kind === "tool").length;
		const hasResponse = turn.segments.length > 0 || turn.outcome !== null || live;
		return (
			<article
				className={`chat-turn${live ? " is-live" : " is-settled"}${turn.origin === "replay" ? " is-replay" : ""}`}
				data-turn-id={turn.turnId}
				aria-label={turn.request === null ? "Turn" : `Request: ${turn.request.summary.slice(0, 80)}`}
			>
				{turn.request !== null && (
					<div className="chat-request">
						<div className="chat-request__meta">
							<span className="chat-request__who">You</span>
							{turn.origin === "replay" && <span className="chat-request__replay">earlier record</span>}
							{turn.request.startedAt !== null && (
								<time dateTime={turn.request.startedAt}>{formatClock(turn.request.startedAt)}</time>
							)}
						</div>
						<p className="chat-request__prompt">{turn.request.summary}</p>
					</div>
				)}
				{hasResponse && (
					<div className="chat-response">
						<div className="chat-response__meta">
							<span className="chat-response__who">Clio Coder</span>
							<LiveChip status={status} elapsed={live ? elapsed : null} />
						</div>
						<div className="chat-response__body">
							{turn.segments.map((segment, index) => {
								const settledSegment = !live || index < turn.segments.length - 1;
								switch (segment.kind) {
									case "response":
										return (
											<MarkdownContent source={segment.item.summary} complete={settledSegment} key={segment.item.id} />
										);
									case "reasoning":
										return <ReasoningDisclosure item={segment.item} key={segment.item.id} />;
									case "activity":
										return (
											<ActivityGroup
												items={segment.items}
												settled={settledSegment}
												nowMs={nowMs}
												pendingPermission={pendingPermission}
												onResolve={onResolve}
												key={segment.items[0]?.id ?? index}
											/>
										);
								}
							})}
							{live && turn.segments.length === 0 && <p className="chat-response__placeholder">{status.label}…</p>}
						</div>
						{turn.outcome !== null && <TurnOutcome item={turn.outcome} toolCount={toolCount} />}
					</div>
				)}
			</article>
		);
	},
	(previous, next) => {
		if (previous.turn !== next.turn) return false;
		if (previous.turn.settled) return true;
		return previous.phase === next.phase && previous.pendingPermission === next.pendingPermission &&
			previous.nowMs === next.nowMs && previous.onResolve === next.onResolve;
	},
);

export interface ChatTranscriptProps {
	readonly turns: readonly ChatTurn[];
	readonly phase: WireClioPhase;
	readonly pendingPermission: WirePendingPermission | null;
	readonly nowMs: number;
	readonly onResolve?: (decision: "allow-once" | "reject") => void;
	readonly truncated: boolean;
	readonly children?: ReactNode;
}

export function ChatTranscript(
	{ turns, phase, pendingPermission, nowMs, onResolve, truncated, children }: ChatTranscriptProps,
) {
	return (
		<section className="chat" aria-label="Conversation with Clio Coder">
			{truncated && <p className="chat__note">Earlier turns are not shown; Clio Coder still has the full context.</p>}
			{turns.map((turn) => (
				<ChatTurnView
					turn={turn}
					phase={phase}
					pendingPermission={pendingPermission}
					nowMs={turn.settled ? 0 : nowMs}
					onResolve={onResolve}
					key={turn.turnId}
				/>
			))}
			{children}
		</section>
	);
}

/** Where a view was left: its scroll offset and whether it was following the latest output. */
export interface ScrollPosition {
	readonly top: number;
	readonly following: boolean;
}

export interface FollowLatest {
	readonly following: boolean;
	/** Timeline activity arrived while the operator was scrolled away. */
	readonly unseen: boolean;
	jumpToLatest(): void;
	/** The current position, for a view that is about to be replaced. */
	snapshot(): ScrollPosition;
	/**
	 * Restores a remembered position without reading the resulting scroll event
	 * as the operator's. A following view pins to the end; a non-following view
	 * returns to its offset and stays unpinned even if the new content fits.
	 */
	restore(position: ScrollPosition): void;
}

const BOTTOM_TOLERANCE_PX = 32;
const SETTLE_TIMEOUT_MS = 1_200;

/**
 * Keeps a scroll region pinned to its end while the operator is reading the
 * latest output, and stops the moment they scroll away. Growth is observed
 * with a ResizeObserver so no layout is read on the token path. A scroll event
 * counts as the operator's only when it moves above the last position this
 * hook wrote, so growth that lands between a write and its event never reads
 * as a scroll-away. `activityKey` changes whenever new timeline activity
 * arrives; that, not layout growth, is what marks activity as unseen.
 */
export function useFollowLatest(
	scrollRef: RefObject<HTMLElement | null>,
	enabled: boolean,
	activityKey: unknown,
): FollowLatest {
	const [following, setFollowing] = useState(true);
	const [unseen, setUnseen] = useState(false);
	const followingRef = useRef(true);
	const programmaticTop = useRef(0);
	const settling = useRef<{ lastTop: number; startedAt: number } | null>(null);

	const setFollow = useCallback((next: boolean) => {
		followingRef.current = next;
		setFollowing((current) => current === next ? current : next);
		if (next) setUnseen(false);
	}, []);

	useEffect(() => {
		if (!followingRef.current) setUnseen(true);
	}, [activityKey]);

	useEffect(() => {
		const element = scrollRef.current;
		if (element === null || !enabled) return;
		const atBottom = () => element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_TOLERANCE_PX;
		const pin = () => {
			element.scrollTop = element.scrollHeight;
			programmaticTop.current = element.scrollTop;
		};
		const onScroll = () => {
			const top = element.scrollTop;
			const settle = settling.current;
			if (settle !== null) {
				const movedUp = top < settle.lastTop - 1;
				const expired = Date.now() - settle.startedAt > SETTLE_TIMEOUT_MS;
				if (atBottom()) {
					settling.current = null;
					programmaticTop.current = top;
					setFollow(true);
					return;
				}
				if (!movedUp && !expired) {
					settle.lastTop = top;
					return;
				}
				settling.current = null;
			}
			if (atBottom()) {
				programmaticTop.current = top;
				setFollow(true);
				return;
			}
			if (top < programmaticTop.current - 1 || !followingRef.current) setFollow(false);
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
			if (followingRef.current) pin();
		});
		// The transcript element is replaced when a project opens or the view
		// changes, so the size observation follows whichever child is current.
		let observed: Element | null = null;
		const observeContent = () => {
			const content = element.firstElementChild;
			if (content === observed) return;
			if (observed !== null) observer?.unobserve(observed);
			observed = content;
			if (content !== null) observer?.observe(content);
		};
		observeContent();
		const children = typeof MutationObserver === "undefined" ? null : new MutationObserver(observeContent);
		children?.observe(element, { childList: true });
		return () => {
			element.removeEventListener("scroll", onScroll);
			observer?.disconnect();
			children?.disconnect();
		};
	}, [scrollRef, enabled, setFollow]);

	const snapshot = useCallback((): ScrollPosition => ({
		top: scrollRef.current?.scrollTop ?? 0,
		following: followingRef.current,
	}), [scrollRef]);

	const restore = useCallback((position: ScrollPosition) => {
		const element = scrollRef.current;
		if (element === null) return;
		settling.current = null;
		setFollow(position.following);
		element.scrollTop = position.following ? element.scrollHeight : position.top;
		programmaticTop.current = element.scrollTop;
	}, [scrollRef, setFollow]);

	const jumpToLatest = useCallback(() => {
		const element = scrollRef.current;
		if (element === null) return;
		const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
		setFollow(true);
		if (reduced) {
			element.scrollTop = element.scrollHeight;
			programmaticTop.current = element.scrollTop;
			return;
		}
		settling.current = { lastTop: element.scrollTop, startedAt: Date.now() };
		element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
	}, [scrollRef, setFollow]);

	return { following, unseen, jumpToLatest, snapshot, restore };
}

export function JumpToLatest({ follow }: { follow: FollowLatest }) {
	if (follow.following) return null;
	return (
		<button
			type="button"
			className={`jump-to-latest${follow.unseen ? " has-unseen" : ""}`}
			onClick={follow.jumpToLatest}
		>
			<span aria-hidden="true">↓</span>
			{follow.unseen ? "New activity below" : "Jump to latest"}
		</button>
	);
}
