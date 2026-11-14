/**
 * A run of tool calls and notices, collapsed to one line.
 *
 * This is the mechanism that keeps a forty-tool turn readable. Every decision behind it is in
 * `activity.ts`: the summary label and tone, the glyph, the disclosure policy, the digest and the
 * agent tag. Nothing here branches on anything it did not receive as a decision.
 *
 * The collapsed line names the running call in plain words ("Run python3 analyze.py"), which is what
 * makes a silent five-minute run still informative, and a settled group says what it did ("read 2
 * files, ran 1 command"). Opening the group lists one line per call; each line opens to its evidence.
 */

import { useQuery } from "@tanstack/react-query";
import { lazy, memo, Suspense, useMemo, useState } from "react";
import { routes } from "../../contracts/runtime-routes.js";
import type { SessionSnapshot, TimelineItem } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { formatDuration } from "../api/clock.js";
import { AnchoredApproval, permissionForCall } from "./Approval.js";
import {
	activityDigest,
	activityGlyph,
	activityKindLabel,
	activityOpen,
	runningItem,
	showElapsed,
	statusGlyph,
	summarizeActivity,
	toolStatusLabel,
	workerLabel,
} from "./activity.js";
import { callDecisions, isAwaitingAnswer } from "./approval-model.js";
import { observeStart } from "./chat-turn.js";
import { type ProposalBaseline, wholeFileWritePath } from "./diff-model.js";
import { ReasoningDisclosure } from "./Reasoning.js";
import { WorkerRunRecord } from "./RunRecordLine.js";
import { ToolCard } from "./tool-cards.js";
import { describeTool, presentTool } from "./tool-presentation.js";
import "./chat-turn.css";

export interface ActivityGroupProps {
	readonly items: readonly TimelineItem[];
	/** False only for the last group of a live turn; everything earlier can no longer change. */
	readonly settled: boolean;
	readonly client: Client;
	readonly session: SessionSnapshot;
	readonly workspaceRoot: string | undefined;
	/** The shared second. Zero for a settled turn, so the clock cannot invalidate it. */
	readonly nowMs: number;
}

/**
 * A row reads only the session's id, the request gating its own call and the decision its call last
 * got, so a delta that touches none of those leaves it alone; the comparators below check exactly those.
 * A decision is compared by value: an answered request leaves the awaiting set, and its record and the
 * group's tallies follow what it was answered with.
 */
function sameSessionFor(previous: SessionSnapshot, next: SessionSnapshot, items: readonly TimelineItem[]) {
	if (previous.id !== next.id) return false;
	if (previous.permissions === next.permissions) return true;
	const before = callDecisions(previous.permissions);
	const after = callDecisions(next.permissions);
	return items.every(
		(item) =>
			permissionForCall(previous, item) === permissionForCall(next, item) &&
			(item.toolCallId === undefined || before.get(item.toolCallId) === after.get(item.toolCallId)),
	);
}

/**
 * A whole-file write's proposal is compared with the file as it stands before the write lands, so its +/− counts
 * match the applied result. Read once per call while it is undecided; the answer is kept for the settled card. The
 * comparison code is its own chunk, fetched with the file.
 */
function useProposalBaseline(client: Client, workspaceId: string, item: TimelineItem): ProposalBaseline {
	const path = item.kind === "tool" ? wholeFileWritePath(item.rawInput) : null;
	const read = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["proposal-baseline", workspaceId, item.id],
		queryFn: async (): Promise<{ baseline: ProposalBaseline }> => {
			const [file, { baselineRows }] = await Promise.all([
				client.call(routes.workspaceFile, { params: { id: workspaceId }, query: { path: path ?? "" }, body: {} }),
				import("./baseline-diff.js"),
			]);
			if (file.status === "missing") return { baseline: null };
			const content = item.rawInput?.content;
			if (file.status !== "text" || file.truncated || typeof content !== "string") return { baseline: undefined };
			return { baseline: baselineRows(file.text, content) ?? undefined };
		},
		enabled: path !== null && (item.status === "pending" || item.status === "in_progress"),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	return read.data?.baseline;
}

// A settled dispatch's outcome line loads with the first dispatch row, not with the session route.
const DispatchOutcome = lazy(() =>
	import("./DispatchOutcome.js").then((module) => ({ default: module.DispatchOutcome })),
);

const ActivityRow = memo(function ActivityRow({
	item,
	client,
	session,
	workspaceRoot,
	nowMs,
	decision,
}: ActivityRowProps) {
	const turnStartedAt = session.turns.find((turn) => turn.id === item.turnId)?.startedAt;
	const startedAtMs = observeStart(item.id, nowMs, turnStartedAt ? Date.parse(turnStartedAt) : Number.NaN);
	const elapsedMs = nowMs === 0 ? 0 : Math.max(0, nowMs - startedAtMs);
	const baseline = useProposalBaseline(client, session.workspaceId, item);
	// A fresh object per render would defeat ToolCard's memo on every streamed delta.
	const options = useMemo(
		() => ({ ...(workspaceRoot === undefined ? {} : { workspaceRoot }), nowMs, startedAtMs, decision, baseline }),
		[workspaceRoot, nowMs, startedAtMs, decision, baseline],
	);
	return (
		<li className="activity__row" data-kind={item.kind}>
			{item.kind === "thought" ? (
				<ReasoningDisclosure item={item} compact />
			) : item.kind === "tool" ? (
				<ToolCard
					item={item}
					options={options}
					agent={workerLabel(item.provenance)}
					elapsed={showElapsed(item, elapsedMs) ? formatDuration(elapsedMs) : null}
				/>
			) : (
				<p className="activity__notice">
					<span className="activity__notice-glyph" aria-hidden="true">
						{statusGlyph(item.status)}
					</span>
					<span className="activity__kind">{activityKindLabel(item)}</span>
					<span className="activity__notice-text">{item.text}</span>
					<span className="sr-only">{toolStatusLabel(item.status)}</span>
				</p>
			)}
			<WorkerRunRecord client={client} sessionId={session.id} item={item} />
			{item.kind === "tool" && item.status === "completed" && item.title === "dispatch" ? (
				<Suspense fallback={null}>
					<DispatchOutcome client={client} sessionId={session.id} item={item} />
				</Suspense>
			) : null}
			<AnchoredApproval client={client} session={session} item={item} />
		</li>
	);
}, sameActivityRow);

function sameActivityRow(previous: ActivityRowProps, next: ActivityRowProps): boolean {
	return (
		previous.item === next.item &&
		previous.client === next.client &&
		previous.workspaceRoot === next.workspaceRoot &&
		previous.nowMs === next.nowMs &&
		previous.decision === next.decision &&
		sameSessionFor(previous.session, next.session, [next.item])
	);
}

interface ActivityRowProps {
	readonly item: TimelineItem;
	readonly client: Client;
	readonly session: SessionSnapshot;
	readonly workspaceRoot: string | undefined;
	readonly nowMs: number;
	/** The status of the newest approval request for this call, which names a declined change. */
	readonly decision: string | undefined;
}

function sameActivityGroup(previous: ActivityGroupProps, next: ActivityGroupProps): boolean {
	return (
		// A live turn regroups its items on every delta; the rows, not the array, are what this renders.
		previous.items.length === next.items.length &&
		previous.items.every((item, index) => item === next.items[index]) &&
		previous.settled === next.settled &&
		previous.client === next.client &&
		previous.workspaceRoot === next.workspaceRoot &&
		previous.nowMs === next.nowMs &&
		// The group hides pending notices while any request in the session waits for an answer.
		previous.session.permissions.some(isAwaitingAnswer) === next.session.permissions.some(isAwaitingAnswer) &&
		sameSessionFor(previous.session, next.session, next.items)
	);
}

export const ActivityGroup = memo(function ActivityGroup({
	items,
	settled,
	client,
	session,
	workspaceRoot,
	nowMs,
}: ActivityGroupProps) {
	// Null means "nobody has touched this". Once the operator toggles, their choice wins forever.
	const [userOpen, setUserOpen] = useState<boolean | null>(null);
	const decisions = useMemo(() => callDecisions(session.permissions), [session.permissions]);
	const summary = summarizeActivity(items, decisions);
	const running = runningItem(items);
	// While a request is waiting, its card is the statement; the engine's "pending" notice beside it
	// says the same thing twice. Once answered, the notice is the record.
	const waiting = session.permissions.some(isAwaitingAnswer);
	const rows = waiting ? items.filter((item) => item.kind !== "notice" || item.toolKind === "safety") : items;
	// One settled call needs no group around it: "1 tool completed" over a single row is two clicks to
	// read one line. The row stands in the transcript by itself. A change is left grouped, because its
	// row opens to a diff and the turn already lists its changes at the end. The markup stays the same
	// either way, so a row the operator opened while it ran keeps its state when the group settles.
	const only = rows.length === 1 && items.length === 1 ? rows[0] : undefined;
	const solo =
		settled &&
		only?.kind === "tool" &&
		presentTool(only, workspaceRoot === undefined ? {} : { workspaceRoot }).body !== "diff";
	const open = solo || activityOpen(userOpen, settled, summary);
	const detail =
		summary.waiting > 0
			? null
			: running !== null
				? describeTool(running, workspaceRoot)
				: activityDigest(items, decisions);
	return (
		<details
			className={`activity activity--${summary.tone}${solo ? " activity--solo" : ""}`}
			open={open}
			onToggle={(event) => {
				if (!solo && event.currentTarget.open !== open) setUserOpen(event.currentTarget.open);
			}}
		>
			<summary className="activity__summary">
				{/* A static glyph: the turn's status line above is the one moving mark in the transcript. */}
				<span className="activity__glyph" aria-hidden="true">
					{activityGlyph(summary)}
				</span>
				<span className="activity__label">{summary.label}</span>
				{detail ? <span className="activity__current">{detail}</span> : null}
			</summary>
			{open ? (
				<ul className="activity__rows">
					{rows.map((item) => (
						<ActivityRow
							key={item.id}
							item={item}
							client={client}
							session={session}
							workspaceRoot={workspaceRoot}
							nowMs={item.status === "in_progress" ? nowMs : 0}
							decision={item.toolCallId === undefined ? undefined : decisions.get(item.toolCallId)}
						/>
					))}
				</ul>
			) : null}
		</details>
	);
}, sameActivityGroup);
