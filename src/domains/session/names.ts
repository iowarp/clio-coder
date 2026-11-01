import type { SessionMeta } from "./contract.js";
import type { SessionEntry } from "./entries.js";
import { operatorTextOfUserPayload } from "./history.js";

/** ID lookups retain precedence over names, including ambiguous ID prefixes (#443). */
export function resolveSessionTarget(
	sessions: ReadonlyArray<Pick<SessionMeta, "id" | "name">>,
	target: string,
): { id: string } | { miss: string } {
	if (sessions.some((session) => session.id === target)) return { id: target };
	const prefixes = sessions.filter((session) => session.id.startsWith(target));
	const matches = prefixes.length > 0 ? prefixes : sessions.filter((session) => session.name === target);
	if (matches.length === 1 && matches[0]) return { id: matches[0].id };
	return {
		miss: matches.length === 0 ? `no session matches ${target}` : `${target} matches ${matches.length} sessions`,
	};
}

/** A bounded title from operator text only; no provider or model is involved (#443). */
export function suggestSessionName(entries: ReadonlyArray<SessionEntry>): string | null {
	for (const entry of entries) {
		if (entry.kind !== "message" || entry.role !== "user") continue;
		const text = operatorTextOfUserPayload(entry.payload);
		if (!text) continue;
		const words = text
			.replace(/[^\p{L}\p{N}\s._-]/gu, " ")
			.trim()
			.split(/\s+/u)
			.filter(Boolean);
		const name = Array.from(words.slice(0, 7).join(" ")).slice(0, 60).join("").trim();
		if (name) return name;
	}
	return null;
}
