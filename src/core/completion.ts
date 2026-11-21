/**
 * The one typed completion declaration every role hands back (fleet design 4.3). The main agent declares it through
 * the `finish` tool's arguments; a builder worker declares it as the `completion` field of its mutation or artifact
 * report. It is never read from reply text. A leaf: no imports, so the result contracts and the finish tool share it.
 */

export const COMPLETION_STATES = ["done", "partly_done", "not_done"] as const;
export type CompletionState = (typeof COMPLETION_STATES)[number];

export const COMPLETION_LIMITATION_REASONS = [
	"blocked_by_policy",
	"missing_access",
	"needs_decision",
	"out_of_scope",
	"out_of_budget",
	"not_reproducible",
	"tool_unavailable",
	"other",
] as const;
export type CompletionLimitationReason = (typeof COMPLETION_LIMITATION_REASONS)[number];

export interface CompletionDeclaration {
	state: CompletionState;
	limitations: Array<{ what: string; why: CompletionLimitationReason }>;
	unverified: string[];
	remaining?: string[];
}

function isMember<T extends string>(list: ReadonlyArray<T>, value: unknown): value is T {
	return typeof value === "string" && (list as ReadonlyArray<string>).includes(value);
}

function strings(value: unknown): string[] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return null;
		const trimmed = item.trim();
		if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
	}
	return out;
}

/**
 * A declaration, or why the value is not one, worded for a repair round. `closed` refuses fields beyond the four, as a
 * worker report's contract does; the finish tool's arguments are already shaped by its schema.
 */
export function parseCompletionDeclaration(
	value: unknown,
	options: { closed: boolean } = { closed: true },
): { ok: true; completion: CompletionDeclaration } | { ok: false; reason: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { ok: false, reason: "completion must be an object with state, limitations and unverified" };
	const record = value as Record<string, unknown>;
	const unknown = Object.keys(record).filter(
		(key) => key !== "state" && key !== "limitations" && key !== "unverified" && key !== "remaining",
	);
	if (options.closed && unknown.length > 0)
		return {
			ok: false,
			reason: `completion field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not legal; legal fields are state, limitations, unverified and remaining`,
		};
	if (!isMember(COMPLETION_STATES, record.state))
		return { ok: false, reason: `completion.state must be one of ${COMPLETION_STATES.join(" | ")}` };
	const raw = record.limitations ?? [];
	if (!Array.isArray(raw)) return { ok: false, reason: "completion.limitations must be an array" };
	const limitations: CompletionDeclaration["limitations"] = [];
	for (const item of raw) {
		const entry = item as { what?: unknown; why?: unknown } | null;
		const what = typeof entry?.what === "string" ? entry.what.trim() : "";
		if (what.length === 0 || !isMember(COMPLETION_LIMITATION_REASONS, entry?.why))
			return {
				ok: false,
				reason: `each completion.limitations entry needs a non-empty what and a why of ${COMPLETION_LIMITATION_REASONS.join(" | ")}`,
			};
		limitations.push({ what, why: entry.why });
	}
	const unverified = strings(record.unverified);
	if (unverified === null) return { ok: false, reason: "completion.unverified must be an array of strings" };
	const remaining = strings(record.remaining);
	if (remaining === null) return { ok: false, reason: "completion.remaining must be an array of strings" };
	return {
		ok: true,
		completion: { state: record.state, limitations, unverified, ...(remaining.length > 0 ? { remaining } : {}) },
	};
}
