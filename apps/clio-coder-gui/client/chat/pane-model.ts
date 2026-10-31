import type { AgentCapabilities } from "../../contracts/capabilities.js";
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
	{ id: "timeline", label: "Timeline", icon: "clock" },
	{ id: "board", label: "Tasks and decisions", icon: "listChecks" },
	{ id: "artifacts", label: "Artifacts", icon: "artifacts" },
	{ id: "changes", label: "Changes", icon: "fileDiff" },
	{ id: "branches", label: "Branches", icon: "branch" },
	{ id: "agents", label: "Agents", icon: "fleet" },
	{ id: "handoff", label: "Continue in a new task", icon: "branch" },
	{ id: "extensions", label: "Tools and add-ons", icon: "toolchain" },
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
	if (value === "files") return "changes";
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
	readonly telemetry: SessionSnapshot["telemetry"];
	readonly contextWork: SessionSnapshot["contextWork"];
	readonly health: SessionSnapshot["health"];
	readonly timelineTruncated: boolean;
	/** Tool calls in the order they were made. */
	readonly tools: readonly TimelineItem[];
	readonly notices: readonly TimelineItem[];
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
		telemetry: session.telemetry,
		contextWork: session.contextWork,
		health: session.health,
		timelineTruncated: session.timelineTruncated,
		tools: session.timeline.filter(readsPane),
		notices: session.timeline.filter((item) => item.kind === "notice"),
	};
}

export const PANE_GROUPS: readonly { label: string; views: readonly PaneView[] }[] = [
	{ label: "Overview", views: ["session"] },
	{ label: "Work", views: ["changes", "board", "agents"] },
	{ label: "Resources", views: ["artifacts", "context", "usage", "timeline", "extensions"] },
	{ label: "Continue", views: ["branches", "handoff"] },
];

export const PANE_DESCRIPTIONS: Record<PaneView, string> = {
	session: "Status, progress and the facts behind this task.",
	changes: "Edits and file paths reported by this conversation's tools.",
	board: "Your checklist, Clio's plan and recorded decisions.",
	agents: "Worker activity and results linked to this task.",
	artifacts: "Saved artifacts exposed by this task's connection.",
	context: "Recorded window use, instructions and context management.",
	usage: "This task's accounting and reported provider limits.",
	timeline: "Every call, turn, tool and setting this task's journal recorded, newest first.",
	branches: "Choose where the next request continues, or fork a conversation.",
	handoff: "Review a handoff before starting a new conversation.",
	extensions: "Tools and hooks loaded by this task's running session.",
};

export function paneGate(
	view: PaneView,
	sessionOpen: boolean,
	capabilities: AgentCapabilities | undefined,
): "ready" | "checking" | "closed" | "unsupported" {
	const required = {
		context: "context",
		usage: "usage",
		board: "board",
		artifacts: "artifacts",
		branches: "branches",
		handoff: "handoff",
		extensions: "extensions",
	} as const;
	if (!(view in required)) return "ready";
	if (!sessionOpen) return "closed";
	if (!capabilities) return "checking";
	return capabilities[required[view as keyof typeof required]] ? "ready" : "unsupported";
}
