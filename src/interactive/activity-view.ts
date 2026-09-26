import { visibleWidth } from "../engine/tui.js";
import type { ClioToken } from "./theme/index.js";
import { clioTheme, padAnsi } from "./theme/index.js";

/**
 * The activity heatmap: one cell per day, one column per week, the way a
 * contribution graph reads. Intensity is quantile-free on purpose: four fixed
 * steps over the busiest day, so a quiet workspace does not paint its one
 * session as the brightest cell.
 */

export const ACTIVITY_SPAN_DAYS = 182;
const DAY_MS = 86_400_000;
const CELL = "■";
const LEVEL_TOKENS: ReadonlyArray<ClioToken> = ["frame", "accentDeep", "accent", "editor"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `YYYY-MM-DD` in local time. */
function dayKey(time: number): string {
	const date = new Date(time);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

export interface ActivitySource {
	/** ISO instants; each adds `weight` to its local day. */
	at: string | undefined;
	weight: number;
}

export function bucketActivity(sources: ReadonlyArray<ActivitySource>, now: number): Map<string, number> {
	const days = new Map<string, number>();
	const floor = now - ACTIVITY_SPAN_DAYS * DAY_MS;
	for (const source of sources) {
		if (!source.at) continue;
		const time = Date.parse(source.at);
		if (!Number.isFinite(time) || time < floor || time > now + DAY_MS) continue;
		const key = dayKey(time);
		days.set(key, (days.get(key) ?? 0) + Math.max(1, source.weight));
	}
	return days;
}

function level(count: number, max: number): number {
	if (count <= 0 || max <= 0) return 0;
	return Math.min(3, Math.max(1, Math.ceil((count / max) * 3)));
}

/** Monday-first week columns ending on the week that holds `now`. */
export function renderActivityHeatmap(
	days: ReadonlyMap<string, number>,
	now: number,
	contentWidth: number,
	caption = "",
): string[] {
	const theme = clioTheme();
	const gutter = 4;
	const weeks = Math.max(4, Math.min(Math.ceil(ACTIVITY_SPAN_DAYS / 7), Math.floor((contentWidth - gutter) / 2)));
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const weekday = (today.getDay() + 6) % 7;
	const lastMonday = today.getTime() - weekday * DAY_MS;
	const firstMonday = lastMonday - (weeks - 1) * 7 * DAY_MS;
	const max = Math.max(0, ...days.values());

	const months = Array.from({ length: weeks * 2 }, () => " ");
	let lastMonth = -1;
	for (let week = 0; week < weeks; week += 1) {
		const monday = new Date(firstMonday + week * 7 * DAY_MS);
		const month = monday.getMonth();
		if (month === lastMonth) continue;
		lastMonth = month;
		// A label needs three cells; the first week is skipped when its month
		// began before the graph, so the row never opens on a partial month.
		if (week === 0 && monday.getDate() > 7) continue;
		const label = MONTHS[month] ?? "";
		for (let index = 0; index < label.length && week * 2 + index < months.length; index += 1)
			months[week * 2 + index] = label[index] ?? " ";
	}
	const lines = [`${" ".repeat(gutter)}${theme.fg("muted", months.join("").trimEnd())}`];
	const rowLabels = ["M", "", "W", "", "F", "", ""];
	for (let row = 0; row < 7; row += 1) {
		let cells = "";
		for (let week = 0; week < weeks; week += 1) {
			const time = firstMonday + (week * 7 + row) * DAY_MS;
			if (time > today.getTime()) {
				cells += "  ";
				continue;
			}
			const count = days.get(dayKey(time)) ?? 0;
			cells += `${theme.fg(LEVEL_TOKENS[level(count, max)] ?? "frame", CELL)} `;
		}
		lines.push(`${padAnsi(theme.fg("muted", rowLabels[row] ?? ""), gutter)}${cells.trimEnd()}`);
	}
	const legend = LEVEL_TOKENS.map((token) => theme.fg(token, CELL)).join(" ");
	const captionText = caption.length > 0 ? ` ${theme.fg("dim", `· ${caption}`)}` : "";
	lines.push(`${" ".repeat(gutter)}${theme.fg("muted", "Less")} ${legend} ${theme.fg("muted", "More")}${captionText}`);
	return lines.map((line) => (visibleWidth(line) > contentWidth ? padAnsi(line, contentWidth) : line));
}
