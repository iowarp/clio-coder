import type { SessionOverviewItem } from "../../contracts/session-overview.js";
import type { Workspace } from "../../contracts/sessions.js";
import type { StatusTone } from "../design/status.js";

export const SESSION_FILTERS = ["all", "attention", "working", "ready", "closed"] as const;
export type SessionFilter = (typeof SESSION_FILTERS)[number];
export const ACTIVITY: Readonly<
	Record<SessionOverviewItem["activity"], { label: string; tone: StatusTone; group: SessionFilter; order: number }>
> = {
	approval: { label: "Approval needed", tone: "warn", group: "attention", order: 0 },
	question: { label: "Answer needed", tone: "warn", group: "attention", order: 0 },
	unknown: { label: "Needs recovery", tone: "unverified", group: "attention", order: 1 },
	failed: { label: "Needs review", tone: "fail", group: "attention", order: 2 },
	working: { label: "Working", tone: "running", group: "working", order: 3 },
	starting: { label: "Starting", tone: "running", group: "working", order: 4 },
	queued: { label: "Queued", tone: "neutral", group: "working", order: 5 },
	ready: { label: "Ready", tone: "neutral", group: "ready", order: 6 },
	parked: { label: "Paused", tone: "neutral", group: "ready", order: 7 },
	closed: { label: "Closed", tone: "neutral", group: "closed", order: 8 },
};

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
