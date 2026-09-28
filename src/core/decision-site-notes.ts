import type { DecisionSite } from "./defaults.js";

/**
 * What each decision site does with an answer and what it sends to get one.
 *
 * Binding a site is how an operator consents to its evidence leaving the
 * machine when the bound target is hosted, so the settings surfaces show this
 * next to the binding rather than leaving it to be read from source.
 */
export interface DecisionSiteNote {
	/** `advises` hints or annotates; `shapes` reorders within a budget; `acts` starts harness work. */
	readonly authority: "advises" | "shapes" | "acts";
	readonly does: string;
	readonly sends: string;
}

export const DECISION_SITE_NOTES: Readonly<Record<DecisionSite, DecisionSiteNote>> = {
	skills: {
		authority: "shapes",
		does: "orders the skills listing by relevance to the turn",
		sends: "the turn's request and installed skill names and descriptions",
	},
	memory: {
		authority: "shapes",
		does: "orders memory records, which decides which fit the prompt budget",
		sends: "the turn's request and up to 24 memory lessons",
	},
	toolRisk: {
		authority: "advises",
		does: "adds a blast-radius line to approval cards; gates nothing",
		sends: "the tool name, action class and the redacted one-line call target",
	},
	drafts: {
		authority: "advises",
		does: "rates /draft candidates in the overlay",
		sends: "the /draft request and up to four candidate answers",
	},
	turnScope: {
		authority: "advises",
		does: "hints whether the turn needs the workspace",
		sends: "the turn's request and the tail of the previous reply",
	},
	harnessRouting: {
		authority: "advises",
		does: "hints an intent and a shortlist of tools, skills and agents",
		sends: "the turn's request and tool, MCP, agent and skill descriptions",
	},
	dispatchForecast: {
		authority: "advises",
		does: "hints whether workers fit; with speculative dispatch, prewarms one",
		sends: "the turn's request and, with speculative dispatch, agent descriptions",
	},
	capabilities: {
		authority: "shapes",
		does: "orders long gateway find listings and adds related entries",
		sends: "the gateway query, the turn's request and capability descriptions",
	},
	consult: {
		authority: "advises",
		does: "answers typed questions the main agent asks (bound at startup)",
		sends: "the evidence the main agent writes, at most 2 KB",
	},
	turnControl: {
		authority: "acts",
		does: "starts read-only orientation or git observations, only on a calibrated build",
		sends: "the turn's request and the tail of the previous reply",
	},
};
