// Decisions for the workbench shell, kept free of React so node:test can exercise every branch.
//
// The shell has two modes. Work mode shows tasks (conversations) grouped by project. Settings mode
// holds everything an operator inspects or configures, so the first thing a new person sees is a
// task list and a composer, not ten equally weighted destinations.

import type { SessionSnapshot, SessionSummary } from "../../contracts/sessions.js";
import { isAwaitingAnswer } from "../chat/approval-model.js";

export type TaskState = "starting" | "working" | "approval" | "failed" | "idle";

export interface TaskRow {
	readonly id: string;
	readonly workspaceId: string;
	readonly title: string;
	/** Supervised by this server right now. A saved task is loaded into a fresh session on click. */
	readonly open: boolean;
	readonly state: TaskState;
	/** ISO time of the latest activity, when one is known. */
	readonly at: string | undefined;
}

export const NEW_TASK_TITLE = "New task";

/** What the sidebar and the top bar call a task: its reported label, else the first request. */
export function taskTitle(
	snapshot: Pick<SessionSnapshot, "label" | "turns" | "timeline">,
	saved?: Pick<SessionSummary, "name" | "firstMessagePreview">,
): string {
	if (snapshot.label?.trim()) return snapshot.label.trim();
	const prompt =
		snapshot.turns.find((turn) => turn.prompt.trim() !== "")?.prompt ??
		snapshot.timeline.find((item) => item.kind === "user" && item.text.trim() !== "")?.text ??
		saved?.name ??
		saved?.firstMessagePreview;
	return prompt?.replace(/\s+/g, " ").trim() || NEW_TASK_TITLE;
}

export function taskState(session: Pick<SessionSnapshot, "state" | "turns" | "permissions">): TaskState {
	if (session.permissions.some(isAwaitingAnswer)) return "approval";
	if (session.state === "starting") return "starting";
	const last = session.turns.at(-1)?.status;
	if (last === "running") return "working";
	if (last === "failed") return "failed";
	return "idle";
}

/** True for an open session nobody has typed into. "New task" reuses it instead of spawning another child. */
export function isUntouched(session: Pick<SessionSnapshot, "state" | "turns" | "timeline">): boolean {
	return session.state === "open" && session.turns.length === 0 && session.timeline.length === 0;
}

function parsed(value: string | undefined): number {
	const time = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(time) ? time : 0;
}

/**
 * One workspace's tasks, newest first. Supervised sessions win over their saved history row so a
 * task never appears twice, and an untouched draft stays out of the list because the top of the
 * sidebar already offers "New task".
 */
export function taskRows(
	workspaceId: string,
	sessions: readonly SessionSnapshot[],
	history: readonly SessionSummary[],
): TaskRow[] {
	const saved = new Map(history.map((row) => [row.id, row]));
	const live = sessions.filter(
		(session) =>
			session.workspaceId === workspaceId &&
			(session.state === "open" || session.state === "starting") &&
			!isUntouched(session),
	);
	const liveIds = new Set(
		sessions.filter((session) => session.workspaceId === workspaceId).map((session) => session.id),
	);
	const rows: TaskRow[] = [
		...live.map((session): TaskRow => {
			const turn = session.turns.at(-1);
			const row = saved.get(session.id);
			return {
				id: session.id,
				workspaceId,
				title: taskTitle(session, row),
				open: true,
				state: taskState(session),
				at: turn?.finishedAt ?? turn?.startedAt ?? row?.lastActivityAt ?? row?.createdAt,
			};
		}),
		...history
			.filter((row) => !liveIds.has(row.id))
			.map(
				(row): TaskRow => ({
					id: row.id,
					workspaceId,
					title: row.name?.trim() || row.firstMessagePreview?.replace(/\s+/g, " ").trim() || "Saved task",
					open: false,
					state: "idle",
					at: row.lastActivityAt ?? row.createdAt,
				}),
			),
	];
	return rows.sort((a, b) => parsed(b.at) - parsed(a.at) || a.id.localeCompare(b.id));
}

/** Compact age for a sidebar row: "now", "5m", "3h", "2d", "6w". Empty when no time is known. */
export function shortAge(iso: string | undefined, nowMs: number): string {
	const then = parsed(iso);
	if (then === 0) return "";
	const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
	if (seconds < 45) return "now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${Math.max(1, minutes)}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.round(hours / 24);
	if (days < 14) return `${days}d`;
	return `${Math.round(days / 7)}w`;
}

export const STATE_LABELS: Readonly<Record<TaskState, string>> = {
	starting: "Starting",
	working: "Working",
	approval: "Needs your approval",
	failed: "Last turn failed",
	idle: "",
};

/** Settings mode owns every route that is not a task. */
const SETTINGS_SEGMENTS = new Set([
	"settings",
	"library",
	"toolchain",
	"usage",
	"system",
	"traces",
	"fleet",
	"evidence",
	"docs",
]);

export function isSettingsPath(pathname: string): boolean {
	const segment = pathname.split("/")[1];
	return segment !== undefined && SETTINGS_SEGMENTS.has(segment);
}

export interface SettingsSection {
	readonly id: string;
	readonly label: string;
	readonly path: string;
	readonly icon:
		| "gear"
		| "models"
		| "sliders"
		| "skills"
		| "toolchain"
		| "usage"
		| "traces"
		| "fleet"
		| "evidence"
		| "system"
		| "shield"
		| "layers";
	readonly group: "main" | "advanced";
	/** First path segments, or full-prefix matches, that keep this section highlighted. */
	readonly owns: readonly string[];
}

/**
 * A few calm pages first, built from the runtime registry (General is the app's own). Everything else
 * is under Advanced: every remaining setting with search, the raw views, and the inspection pages.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
	{
		id: "general",
		label: "General",
		path: "/settings/general",
		icon: "gear",
		group: "main",
		owns: ["/settings/general"],
	},
	{
		id: "models",
		label: "Models",
		path: "/settings/models",
		icon: "models",
		group: "main",
		owns: ["/settings/models", "/settings/targets", "/settings/routing"],
	},
	{
		id: "safety",
		label: "Safety",
		path: "/settings/safety",
		icon: "shield",
		group: "main",
		owns: ["/settings/safety"],
	},
	{
		id: "context",
		label: "Context and memory",
		path: "/settings/context",
		icon: "layers",
		group: "main",
		owns: ["/settings/context"],
	},
	{
		id: "all",
		label: "All settings",
		path: "/settings/advanced",
		icon: "sliders",
		group: "advanced",
		owns: ["/settings", "/settings/advanced", "/settings/effective", "/settings/why"],
	},
	{ id: "library", label: "Library", path: "/library", icon: "skills", group: "advanced", owns: ["/library"] },
	{
		id: "toolchain",
		label: "Toolchain",
		path: "/toolchain",
		icon: "toolchain",
		group: "advanced",
		owns: ["/toolchain"],
	},
	{ id: "usage", label: "Usage", path: "/usage", icon: "usage", group: "advanced", owns: ["/usage"] },
	{ id: "traces", label: "Traces", path: "/traces", icon: "traces", group: "advanced", owns: ["/traces"] },
	{ id: "fleet", label: "Fleet", path: "/fleet", icon: "fleet", group: "advanced", owns: ["/fleet"] },
	{ id: "evidence", label: "Evidence", path: "/evidence", icon: "evidence", group: "advanced", owns: ["/evidence"] },
	{ id: "system", label: "System", path: "/system", icon: "system", group: "advanced", owns: ["/system"] },
];

/** The section a pathname belongs to. The longest matching prefix wins so `/settings/targets` is Models, not Harness. */
export function settingsSectionFor(pathname: string): SettingsSection | undefined {
	let best: { section: SettingsSection; length: number } | undefined;
	for (const section of SETTINGS_SECTIONS)
		for (const owned of section.owns) {
			const hit = pathname === owned || pathname.startsWith(`${owned}/`);
			if (hit && (best === undefined || owned.length > best.length)) best = { section, length: owned.length };
		}
	return best?.section;
}

/** `/sessions/:id` and nothing else. */
export function sessionIdFromPath(pathname: string): string | null {
	return /^\/sessions\/([^/]+)$/.exec(pathname)?.[1] ?? null;
}
