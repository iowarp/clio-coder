import type { SessionMeta } from "../../domains/session/contract.js";
import { fuzzyFilter } from "../../engine/tui.js";

/**
 * Compose the searchable text for a session. Includes every field a user
 * might recall: the id (for the rare "I remember the prefix" recall),
 * the cwd path, and the endpoint/model pair so model-name searches work.
 * Names are not present in `SessionMeta` today; if/when sessions grow a
 * `name` field, append it here.
 */
function getSessionSearchText(meta: SessionMeta): string {
	const endpoint = meta.endpoint ?? "";
	const model = meta.model ?? "";
	const cwd = meta.cwd ?? "";
	return `${meta.id} ${endpoint}/${model} ${cwd}`;
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
