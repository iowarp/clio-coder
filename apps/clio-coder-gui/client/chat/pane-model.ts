import type { SessionSnapshot, TimelineItem } from "../../contracts/sessions.js";

/**
 * The right-hand pane. Four views carry the everyday questions: how is it going, what changed, which
 * files, what ran. The rest is Clio's depth, reachable from the pane's menu and never in the way.
 */
export const PANE_VIEWS = [
	{ id: "progress", label: "Progress", icon: "listChecks", primary: true },
	{ id: "changes", label: "Changes", icon: "fileDiff", primary: true },
	{ id: "files", label: "Files", icon: "artifacts", primary: true },
	{ id: "terminal", label: "Terminal", icon: "terminal", primary: true },
	{ id: "agents", label: "Agents", icon: "fleet", primary: false },
	{ id: "session", label: "Session", icon: "sliders", primary: false },
	{ id: "tools", label: "Tools", icon: "toolchain", primary: false },
] as const;

export type PaneView = (typeof PANE_VIEWS)[number]["id"];

export function isPaneView(value: unknown): value is PaneView {
	return PANE_VIEWS.some((view) => view.id === value);
}

/** The previous panel stored "artifacts" for what is now "files". */
export function migratedPaneView(value: unknown): PaneView {
	if (value === "artifacts") return "files";
	return isPaneView(value) ? value : "progress";
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

export function selectPaneSession(session: SessionSnapshot): PaneSession {
	return {
		id: session.id,
		state: session.state,
		turns: session.turns,
		fleet: session.fleet,
		timelineTruncated: session.timelineTruncated,
		tools: session.timeline.filter((item) => item.kind === "tool"),
	};
}
