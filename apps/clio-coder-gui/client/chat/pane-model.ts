import type { SessionSnapshot, TimelineItem } from "../../contracts/sessions.js";

/**
 * The right-hand pane. Two views carry the everyday questions: how is it going and what changed. The
 * rest is Clio's depth, reachable from the pane's menu and never in the way. The pane has no command
 * view: what Clio ran is in the transcript, and nothing typed in the browser reaches a process.
 */
export const PANE_VIEWS = [
	{ id: "progress", label: "Progress", icon: "listChecks", primary: true },
	{ id: "changes", label: "Changes", icon: "fileDiff", primary: true },
	{ id: "agents", label: "Agents", icon: "fleet", primary: false },
	{ id: "session", label: "Details", icon: "sliders", primary: false },
	{ id: "tools", label: "Tools", icon: "toolchain", primary: false },
] as const;

export type PaneView = (typeof PANE_VIEWS)[number]["id"];

export function isPaneView(value: unknown): value is PaneView {
	return PANE_VIEWS.some((view) => view.id === value);
}

/** Earlier builds stored "artifacts" and "files" (now part of Changes) and "terminal" (removed). */
export function migratedPaneView(value: unknown): PaneView {
	if (value === "artifacts" || value === "files") return "changes";
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
