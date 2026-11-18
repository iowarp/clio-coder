import type { SessionContract } from "./contract.js";

/**
 * Share selection and runtime markers so Codex sees each effort boundary once (#423). The session's first row records
 * `effectiveLevel`, the level the route clamped the selection to, so replay, `sessions` and fork never start the
 * session at a level its route does not support; the selection rides along so repeating it adds no row (bt-37).
 */
export function appendSessionThinkingLevel(
	session: SessionContract | undefined,
	thinkingLevel: string,
	effectiveEffort: string | undefined,
	parentTurnId: string | null,
	effectiveLevel?: string,
): void {
	if (!session?.current()) return;
	const previous = session
		.readEntries()
		.filter((entry) => entry.kind === "thinkingLevelChange")
		.at(-1);
	if (
		previous?.kind === "thinkingLevelChange" &&
		(previous.thinkingLevel === thinkingLevel || previous.requestedThinkingLevel === thinkingLevel)
	)
		return;
	const clamped = previous === undefined && effectiveLevel !== undefined && effectiveLevel !== thinkingLevel;
	session.appendEntry({
		kind: "thinkingLevelChange",
		parentTurnId,
		thinkingLevel: clamped ? effectiveLevel : thinkingLevel,
		...(effectiveEffort !== undefined ? { effectiveEffort } : {}),
		...(previous === undefined ? { configurationInitial: true } : {}),
		...(clamped ? { requestedThinkingLevel: thinkingLevel } : {}),
	});
	session.flushAppends?.();
}
