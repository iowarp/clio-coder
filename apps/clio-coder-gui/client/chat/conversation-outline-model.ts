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

const sources = new WeakMap<ConversationEntry, { turn: ChatTurn; row: Turn | undefined }>();
const searchText = new WeakMap<ConversationEntry, readonly string[]>();

export function conversationEntry(turn: ChatTurn, row: Turn | undefined, index: number): ConversationEntry {
	const request = requestView(turn);
	const entry: ConversationEntry = {
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
	sources.set(entry, { turn, row });
	return entry;
}

/** A live answer changes its own entry; earlier exchanges keep their text and search index. */
export function conversationEntries(
	turns: readonly ChatTurn[],
	rows: ReadonlyMap<string, Turn>,
	previous: readonly ConversationEntry[] = [],
): readonly ConversationEntry[] {
	const byId = new Map(previous.map((entry) => [entry.id, entry]));
	let unchanged = previous.length === turns.length;
	const entries = turns.map((turn, index) => {
		const row = rows.get(turn.turnId);
		const prior = byId.get(turn.turnId);
		const source = prior ? sources.get(prior) : undefined;
		if (prior && source?.turn === turn && source.row === row && prior.number === index + 1) {
			if (previous[index] !== prior) unchanged = false;
			return prior;
		}
		unchanged = false;
		return conversationEntry(turn, row, index);
	});
	return unchanged ? previous : entries;
}

export function findConversation(entries: readonly ConversationEntry[], query: string) {
	const needle = query.replace(/\s+/g, " ").trim().toLocaleLowerCase();
	const matching = needle
		? entries.filter((entry) => {
				let text = searchText.get(entry);
				if (!text) {
					text = [entry.request, entry.response].map((value) => value.replace(/\s+/g, " ").toLocaleLowerCase());
					searchText.set(entry, text);
				}
				return text.some((value) => value.includes(needle));
			})
		: entries;
	return { rows: matching.slice(0, 100), total: matching.length, query: needle };
}

export function longRequestPreview(text: string): string | null {
	if (text.length <= 900 && text.split("\n", 11).length <= 10) return null;
	return `${text.split("\n", 7).slice(0, 6).join("\n").slice(0, 600).trimEnd()}…`;
}
