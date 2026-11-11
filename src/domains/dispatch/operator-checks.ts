import { DISPATCH_INTENT_VERIFICATION_CAP } from "./intent.js";

/**
 * Checks the operator named in the turn that issued a dispatch. The host
 * attaches them to every request from that turn as intent verification, so
 * the merge gate enforces a "verify by running X" the coordinator did not
 * pass on. Only ids the project declares count; nothing is invented.
 *
 * A name counts in three spellings: a package-manager script run
 * (`pnpm run lint`, `npm test`), a backticked id (`` `check` ``), or a
 * verify call (`verify(check="lint")`). A script run followed by `--`
 * arguments is skipped: a verification entry seals the declared argv and
 * cannot carry the arguments, so attaching it would run a different command.
 */
export function operatorNamedChecks(text: string, declared: ReadonlySet<string>): string[] {
	if (text.length === 0 || declared.size === 0) return [];
	const found: Array<{ index: number; id: string }> = [];
	const script = /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9][\w:.-]*)(?![\w:.-])(\s+--(?:\s|$))?/gu;
	for (const match of text.matchAll(script)) {
		const id = match[1] as string;
		if (match[2] === undefined) found.push({ index: match.index, id });
	}
	for (const match of text.matchAll(/`([A-Za-z0-9][\w:./-]*)`/gu))
		found.push({ index: match.index, id: match[1] as string });
	for (const match of text.matchAll(/\bcheck\s*[=:]\s*["']([^"'\s]+)["']/gu))
		found.push({ index: match.index, id: match[1] as string });
	const ids: string[] = [];
	for (const { id } of found.sort((a, b) => a.index - b.index)) {
		if (declared.has(id) && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/**
 * Add operator-named checks to a raw intent, after what the coordinator
 * declared and without duplicates. A malformed raw intent is returned as is
 * so normalization reports the coordinator's own error.
 */
export function mergeOperatorNamedChecks(rawIntent: unknown, checks: ReadonlyArray<string>): unknown {
	if (checks.length === 0) return rawIntent;
	if (rawIntent !== undefined && (typeof rawIntent !== "object" || rawIntent === null || Array.isArray(rawIntent)))
		return rawIntent;
	const base = (rawIntent ?? {}) as Record<string, unknown>;
	const existing = base.verification;
	if (existing !== undefined && !Array.isArray(existing)) return rawIntent;
	const verification: unknown[] = [...(existing ?? [])];
	const present = new Set(
		verification.flatMap((entry) =>
			typeof entry === "object" && entry !== null && typeof (entry as { check?: unknown }).check === "string"
				? [((entry as { check: string }).check as string).trim()]
				: [],
		),
	);
	for (const check of checks) {
		if (verification.length >= DISPATCH_INTENT_VERIFICATION_CAP) break;
		if (present.has(check)) continue;
		present.add(check);
		verification.push({ check });
	}
	return { ...base, verification };
}
