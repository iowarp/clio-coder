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

import { useState } from "react";
import type { SessionSnapshot, TimelineItem } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { formatDuration } from "../api/clock.js";
import { AnchoredApproval } from "./Approval.js";
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
import { observeStart } from "./chat-turn.js";
import { ReasoningDisclosure } from "./Reasoning.js";
import { ToolCard } from "./tool-cards.js";
import { describeTool } from "./tool-presentation.js";
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
	const startedAtMs = observeStart(item.id, nowMs);
	const elapsedMs = nowMs === 0 ? 0 : Math.max(0, nowMs - startedAtMs);
	return (
		<li className="activity__row" data-kind={item.kind}>
			{item.kind === "thought" ? (
				<ReasoningDisclosure item={item} compact />
			) : item.kind === "tool" ? (
				<ToolCard
					item={item}
					options={{
						...(workspaceRoot === undefined ? {} : { workspaceRoot }),
						nowMs,
						startedAtMs,
					}}
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
	const detail =
		summary.waiting > 0 ? null : running !== null ? describeTool(running, workspaceRoot) : activityDigest(items);
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
				{detail ? <span className="activity__current">{detail}</span> : null}
			</summary>
			{open ? (
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
			) : null}
		</details>
	);
}
