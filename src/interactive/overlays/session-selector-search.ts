import type { SessionMeta } from "../../domains/session/contract.js";
import { fuzzyFilter } from "../../engine/tui.js";

/**
 * Compose the searchable text for a session. Includes every field a user
 * might recall: the id (for the rare "I remember the prefix" recall),
 * timestamps, cwd, endpoint/model pair, and any display name or turn labels
 * discovered from sessionInfo entries.
 */
function getSessionSearchText(meta: SessionMeta): string {
	const endpoint = meta.endpoint ?? "";
	const model = meta.model ?? "";
	const cwd = meta.cwd ?? "";
	const created = meta.createdAt ?? "";
	const ended = meta.endedAt ?? "";
	const lastActivity = meta.lastActivityAt ?? "";
	const name = meta.name ?? "";
	const labels = meta.labels?.join(" ") ?? "";
	const preview = meta.firstMessagePreview ?? "";
	return `${meta.id} ${created} ${ended} ${lastActivity} ${endpoint}/${model} ${cwd} ${name} ${labels} ${preview}`;
}

/**
 * Filter sessions by a fuzzy query, preserving the input order when the
 * query is empty. Tokenized: each whitespace-separated token must match.
 * Backed by pi-tui's fuzzy matcher so behavior tracks the rest of the TUI.
 */
export function filterSessions(sessions: ReadonlyArray<SessionMeta>, query: string): SessionMeta[] {
	if (!query.trim()) return [...sessions];
	return fuzzyFilter([...sessions], query, getSessionSearchText);
}
