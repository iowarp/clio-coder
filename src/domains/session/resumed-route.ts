import { THINKING_LEVELS, type ThinkingLevel } from "../../core/defaults.js";
import type { ResumedRoute } from "../../core/session-routing.js";
import type { SessionEntry } from "./entries.js";

/**
 * The route a session last ran on, read from its own ledger: the header's
 * target and model, then every `modelChange` and `thinkingLevelChange` row in
 * file order, so the newest one wins. File order rather than the active path
 * because the question is which model the session most recently used, and a
 * `/tree` switch does not change that.
 *
 * A `modelChange` row without a target predates the field and names only a
 * runtime, which cannot say which target the model belonged to; it is skipped
 * rather than paired with a guess. The thinking level is present only when the
 * session recorded a change, because the level a session started at was never
 * written down.
 */
export function resumedSessionRoute(
	meta: { target: string | null; model: string | null },
	entries: ReadonlyArray<SessionEntry>,
): ResumedRoute {
	let target = meta.target ?? null;
	let model = meta.model ?? null;
	let thinkingLevel: ThinkingLevel | undefined;
	for (const entry of entries) {
		if (entry.kind === "modelChange") {
			if (typeof entry.target !== "string" || entry.target.length === 0) continue;
			if (typeof entry.modelId !== "string" || entry.modelId.length === 0) continue;
			target = entry.target;
			model = entry.modelId;
			continue;
		}
		if (entry.kind === "thinkingLevelChange") {
			const level = THINKING_LEVELS.find((candidate) => candidate === entry.thinkingLevel);
			if (level !== undefined) thinkingLevel = level;
		}
	}
	return thinkingLevel === undefined ? { target, model } : { target, model, thinkingLevel };
}
