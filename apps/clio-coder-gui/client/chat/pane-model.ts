import type { SessionSnapshot, TimelineItem } from "../../contracts/sessions.js";

/**
 * The right-hand pane is one Session column: everything about the open chat as calm sections, read
 * top to bottom. A section with more to say opens a drill-in with a way back. There are no tabs; the
 * transcript and the composer are where things are done, the pane is where they are reported.
 */
export const PANE_VIEWS = [
	{ id: "session", label: "Session", icon: "sessions" },
	{ id: "context", label: "Context window", icon: "layers" },
	{ id: "usage", label: "Usage and quota", icon: "usage" },
	{ id: "board", label: "Tasks and decisions", icon: "listChecks" },
	{ id: "changes", label: "Changes", icon: "fileDiff" },
	{ id: "agents", label: "Agents", icon: "fleet" },
] as const;

export type PaneView = (typeof PANE_VIEWS)[number]["id"];

export const ROOT_VIEW: PaneView = "session";

export function isPaneView(value: unknown): value is PaneView {
	return PANE_VIEWS.some((view) => view.id === value);
}

export function paneViewLabel(view: PaneView): string {
	return PANE_VIEWS.find((entry) => entry.id === view)?.label ?? "Session";
}

/** Views earlier builds stored: Progress and Details are the Session column now, Files is Changes. */
export function migratedPaneView(value: unknown): PaneView {
	// Session tools moved to the composer's slash palette.
	if (value === "progress" || value === "details" || value === "tools") return "session";
	if (value === "artifacts" || value === "files") return "changes";
	return isPaneView(value) ? value : ROOT_VIEW;
}

/**
 * The slice of a session the pane reads. Text deltas leave it unchanged through query structural
 * sharing, so a streaming answer does not re-render the pane.
 */
export interface PaneSession {
	readonly id: string;
	readonly state: SessionSnapshot["state"];
	readonly turns: SessionSnapshot["turns"];
	readonly fleet: SessionSnapshot["fleet"];
	readonly timelineTruncated: boolean;
	/** Tool calls in the order they were made. */
	readonly tools: readonly TimelineItem[];
}

/**
 * The pane lists changed files and the paths tools touched. A call that edits or names a path can
 * matter to it; a shell command that only streams output cannot, so its updates leave the pane alone.
 */
const readsPane = (item: TimelineItem): boolean =>
	item.kind === "tool" && (item.toolKind === "edit" || (item.locations?.length ?? 0) > 0);

export function selectPaneSession(session: SessionSnapshot): PaneSession {
	return {
		id: session.id,
		state: session.state,
		turns: session.turns,
		fleet: session.fleet,
		timelineTruncated: session.timelineTruncated,
		tools: session.timeline.filter(readsPane),
	};
}
