/**
 * A run of tool calls and notices, collapsed to one line.
 *
 * This is the mechanism that keeps a forty-tool turn readable. Every decision behind it is in
 * `activity.ts`: the summary label and tone, the glyph, the disclosure policy and the agent tag.
 * Nothing here branches on anything it did not receive as a decision.
 *
 * The collapsed line names the running tool, which is what makes a silent five-minute run still
 * informative. Opening the group swaps that line for the per-tool cards, because the question an
 * operator opens a group to answer is "what did it actually do", and that answer is per tool kind.
 */

import { useState } from "react";
import type { SessionSnapshot, TimelineItem } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { formatDuration } from "../api/clock.js";
import { StatusMark, toneForOutcome } from "../design/status.js";
import { AnchoredApproval } from "./Approval.js";
import {
	activityGlyph,
	activityKindLabel,
	activityOpen,
	runningItem,
	showElapsed,
	summarizeActivity,
	toolStatusLabel,
	WORKER_LABEL_TITLE,
	workerLabel,
} from "./activity.js";
import { ELAPSED_TITLE, observeStart } from "./chat-turn.js";
import { ToolCard } from "./tool-cards.js";
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

function ActivityRow({ item, client, session, workspaceRoot, nowMs }: ActivityRowProps) {
	const agent = workerLabel(item.provenance);
	const startedAtMs = observeStart(item.id, nowMs);
	const elapsedMs = nowMs === 0 ? 0 : Math.max(0, nowMs - startedAtMs);
	return (
		<li className="activity__row" data-kind={item.kind}>
			<div className="activity__rowhead">
				<span className="activity__kind">{activityKindLabel(item)}</span>
				{agent === null ? null : (
					<span className="activity__agent" title={WORKER_LABEL_TITLE}>
						agent {agent}
					</span>
				)}
				<StatusMark tone={toneForOutcome(item.status)} label={toolStatusLabel(item.status)} />
				{showElapsed(item, elapsedMs) ? (
					<span className="activity__elapsed" title={ELAPSED_TITLE}>
						{formatDuration(elapsedMs)}
					</span>
				) : null}
			</div>
			{item.kind === "tool" ? (
				<ToolCard
					item={item}
					options={{
						...(workspaceRoot === undefined ? {} : { workspaceRoot }),
						nowMs,
						startedAtMs,
					}}
				/>
			) : (
				<p className="activity__notice">{item.text}</p>
			)}
			<AnchoredApproval client={client} session={session} item={item} />
		</li>
	);
}

interface ActivityRowProps {
	readonly item: TimelineItem;
	readonly client: Client;
	readonly session: SessionSnapshot;
	readonly workspaceRoot: string | undefined;
	readonly nowMs: number;
}

export function ActivityGroup({ items, settled, client, session, workspaceRoot, nowMs }: ActivityGroupProps) {
	// Null means "nobody has touched this". Once the operator toggles, their choice wins forever.
	const [userOpen, setUserOpen] = useState<boolean | null>(null);
	const summary = summarizeActivity(items);
	const open = activityOpen(userOpen, settled, summary);
	const running = runningItem(items);
	return (
		<details
			className={`activity activity--${summary.tone}`}
			open={open}
			onToggle={(event) => {
				if (event.currentTarget.open !== open) setUserOpen(event.currentTarget.open);
			}}
		>
			<summary className="activity__summary">
				<span className="activity__glyph" aria-hidden="true">
					{activityGlyph(summary)}
				</span>
				<span className="activity__label">{summary.label}</span>
				{running !== null && summary.waiting === 0 ? (
					<span className="activity__current">{running.title ?? running.text}</span>
				) : null}
				<span className="activity__count" aria-hidden="true">
					{summary.total}
				</span>
			</summary>
			<ul className="activity__rows">
				{items.map((item) => (
					<ActivityRow
						key={item.id}
						item={item}
						client={client}
						session={session}
						workspaceRoot={workspaceRoot}
						nowMs={nowMs}
					/>
				))}
			</ul>
		</details>
	);
}
