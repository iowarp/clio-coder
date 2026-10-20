import type { Turn } from "../../contracts/sessions.js";
import { requestView, responseText } from "./chat-turn.js";
import type { ChatTurn } from "./turns.js";

/** Display projections only. The request and response used for copy or delivery stay verbatim. */
export function conversationExcerpt(text: string, query = "", limit = 180): string {
	const compact = text.replace(/\s+/g, " ").trim();
	const match = query ? compact.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
	const start = match > limit / 2 ? Math.max(0, match - Math.floor(limit / 3)) : 0;
	const part = compact.slice(start, start + limit);
	return `${start ? "…" : ""}${part}${start + part.length < compact.length ? "…" : ""}`;
}

export interface ConversationEntry {
	readonly id: string;
	readonly number: number;
	readonly request: string;
	readonly response: string;
	readonly title: string;
	readonly status: string;
	readonly startedAt: string | null;
}

export function conversationEntry(turn: ChatTurn, row: Turn | undefined, index: number): ConversationEntry {
	const request = requestView(turn);
	return {
		id: turn.turnId,
		number: index + 1,
		request: request.missing ? "" : request.text,
		response: responseText(turn),
		title: request.missing
			? turn.request === null
				? "Request not recorded"
				: "Empty request"
			: conversationExcerpt(request.text, "", 140),
		status: row
			? { running: "In progress", succeeded: "Done", failed: "Failed", cancelled: "Stopped" }[row.status]
			: turn.origin === "replay"
				? "Earlier record"
				: "Outcome unreported",
		startedAt: row?.startedAt ?? null,
	};
}

export function findConversation(entries: readonly ConversationEntry[], query: string) {
	const needle = query.replace(/\s+/g, " ").trim().toLocaleLowerCase();
	const matching = needle
		? entries.filter((entry) =>
				[entry.request, entry.response].some((text) => text.replace(/\s+/g, " ").toLocaleLowerCase().includes(needle)),
			)
		: entries;
	return { rows: matching.slice(0, 100), total: matching.length, query: needle };
}

export function longRequestPreview(text: string): string | null {
	if (text.length <= 900 && text.split("\n", 11).length <= 10) return null;
	return `${text.split("\n", 7).slice(0, 6).join("\n").slice(0, 600).trimEnd()}…`;
}
