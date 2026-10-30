import type { SessionOverviewItem } from "../../contracts/session-overview.js";
import type { SessionSummary } from "../../contracts/sessions.js";
import type { TaskRow } from "../shell/shell-model.js";

export const PROJECT_TASK_FILTERS = ["all", "open", "attention", "saved"] as const;
export type ProjectTaskFilter = (typeof PROJECT_TASK_FILTERS)[number];
export const PROJECT_TASK_SORTS = ["recent", "oldest", "name"] as const;
export type ProjectTaskSort = (typeof PROJECT_TASK_SORTS)[number];
const needsAttention = (row: TaskRow) =>
	row.state === "approval" || row.state === "question" || row.state === "unknown" || row.state === "failed";

export function projectTaskInventory(
	rows: readonly TaskRow[],
	history: readonly SessionSummary[],
	sessions: readonly SessionOverviewItem[],
	query: string,
	filter: ProjectTaskFilter,
	sort: ProjectTaskSort,
) {
	const saved = new Map(history.map((row) => [row.id, row]));
	const held = new Map(sessions.map((row) => [row.id, row]));
	const counts = { all: rows.length, open: 0, attention: 0, saved: 0 };
	for (const row of rows) {
		if (row.open) counts.open++;
		else counts.saved++;
		if (needsAttention(row)) counts.attention++;
	}
	const words = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
	const shown = rows.filter((row) => {
		if (filter === "open" && !row.open) return false;
		if (filter === "saved" && row.open) return false;
		if (filter === "attention" && !needsAttention(row)) return false;
		const summary = saved.get(row.id);
		const session = held.get(row.id);
		const text = [
			row.title,
			row.id,
			summary?.model,
			summary?.target,
			summary?.firstMessagePreview,
			session?.model,
			session?.target,
		]
			.join(" ")
			.toLocaleLowerCase();
		return words.every((word) => text.includes(word));
	});
	shown.sort((a, b) => {
		if (sort === "name") return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
		const difference = (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0);
		return (sort === "oldest" ? -difference : difference) || a.id.localeCompare(b.id);
	});
	return { counts, shown };
}
