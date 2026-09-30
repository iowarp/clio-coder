import type { SessionSnapshot } from "../../contracts/sessions.js";

export const SESSION_PANEL_VIEWS = [
	{ id: "session", label: "Session", icon: "settings" },
	{ id: "agents", label: "Agents", icon: "fleet" },
	{ id: "artifacts", label: "Artifacts", icon: "artifacts" },
	{ id: "tools", label: "Tools", icon: "toolchain" },
] as const;
export type SessionPanelView = (typeof SESSION_PANEL_VIEWS)[number]["id"];

export function isSessionPanelView(value: unknown): value is SessionPanelView {
	return SESSION_PANEL_VIEWS.some((view) => view.id === value);
}

/** Text streaming leaves this observer's projection unchanged through query structural sharing. */
export function selectSessionPanel(session: SessionSnapshot): SessionSnapshot {
	return {
		...session,
		// The transcript revision changes on every text delta; this view reads only session facts.
		revision: 0,
		timeline: [],
		permissions: [],
		health: [],
		turns: session.turns.map((turn) => ({ ...turn, prompt: "" })),
	};
}
