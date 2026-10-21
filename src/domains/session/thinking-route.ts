import type { SessionContract } from "./contract.js";

/** Share selection and runtime markers so Codex sees each effort boundary once (#423). */
export function appendSessionThinkingLevel(
	session: SessionContract | undefined,
	thinkingLevel: string,
	effectiveEffort: string | undefined,
	parentTurnId: string | null,
): void {
	if (!session?.current()) return;
	const previous = session
		.readEntries()
		.filter((entry) => entry.kind === "thinkingLevelChange")
		.at(-1);
	if (previous?.kind === "thinkingLevelChange" && previous.thinkingLevel === thinkingLevel) return;
	session.appendEntry({
		kind: "thinkingLevelChange",
		parentTurnId,
		thinkingLevel,
		...(effectiveEffort !== undefined ? { effectiveEffort } : {}),
		...(previous === undefined ? { configurationInitial: true } : {}),
	});
	session.flushAppends?.();
}
