import type { SessionOverviewItem } from "../../contracts/session-overview.js";
import type { Workspace } from "../../contracts/sessions.js";
import type { StatusTone } from "../design/status.js";
import { READY_LABEL, STATE_LABELS } from "../shell/shell-model.js";

export const SESSION_FILTERS = ["all", "attention", "working", "ready", "closed"] as const;
export type SessionFilter = (typeof SESSION_FILTERS)[number];
export const ACTIVITY: Readonly<
	Record<SessionOverviewItem["activity"], { label: string; tone: StatusTone; group: SessionFilter; order: number }>
> = {
	approval: { label: STATE_LABELS.approval, tone: "warn", group: "attention", order: 0 },
	question: { label: STATE_LABELS.question, tone: "warn", group: "attention", order: 0 },
	unknown: { label: STATE_LABELS.unknown, tone: "unverified", group: "attention", order: 1 },
	failed: { label: STATE_LABELS.failed, tone: "fail", group: "attention", order: 2 },
	working: { label: STATE_LABELS.working, tone: "running", group: "working", order: 3 },
	starting: { label: STATE_LABELS.starting, tone: "running", group: "working", order: 4 },
	queued: { label: STATE_LABELS.waiting, tone: "neutral", group: "working", order: 5 },
	ready: { label: READY_LABEL, tone: "neutral", group: "ready", order: 6 },
	parked: { label: STATE_LABELS.paused, tone: "neutral", group: "ready", order: 7 },
	closed: { label: "Closed", tone: "neutral", group: "closed", order: 8 },
};

/** The card's state word: the sidebar's, except that a failed agent is not a failed turn. */
export function activityLabel(item: Pick<SessionOverviewItem, "activity" | "state">): string {
	return item.activity === "failed" && item.state === "failed" ? "Session failed" : ACTIVITY[item.activity].label;
}

export function sessionInventory(
	items: readonly SessionOverviewItem[],
	workspaces: readonly Workspace[],
	query: string,
	project: string,
	filter: SessionFilter,
) {
	const projects = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
	const words = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
	return items
		.filter((item) => {
			if (project && item.workspaceId !== project) return false;
			if (filter !== "all" && ACTIVITY[item.activity].group !== filter) return false;
			const workspace = projects.get(item.workspaceId);
			const text = [item.title, item.id, item.model, item.target, workspace?.name, workspace?.path, ...item.nodes]
				.join(" ")
				.toLocaleLowerCase();
			return words.every((word) => text.includes(word));
		})
		.sort(
			(left, right) =>
				ACTIVITY[left.activity].order - ACTIVITY[right.activity].order ||
				(Date.parse(right.updatedAt ?? "") || 0) - (Date.parse(left.updatedAt ?? "") || 0) ||
				left.id.localeCompare(right.id),
		);
}
