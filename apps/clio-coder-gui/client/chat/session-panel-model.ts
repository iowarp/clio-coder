import type { SessionSnapshot } from "../../contracts/sessions.js";

/** Text streaming leaves this observer's projection unchanged through query structural sharing. */
export function selectSessionPanel(session: SessionSnapshot): SessionSnapshot {
	return {
		...session,
		// The transcript revision changes on every text delta; this view reads only session facts.
		revision: 0,
		timeline: session.timeline.filter((item) => item.kind === "notice"),
		permissions: [],
		health: [],
		turns: session.turns.map((turn) => ({ ...turn, prompt: "" })),
	};
}
