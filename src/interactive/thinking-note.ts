import { thinkingEffectNote } from "../domains/providers/index.js";

/**
 * Why the rail's thinking word differs from the level asked for, in the operator's terms (TY05). `medium runs as on`
 * made the reader decode a mapping; a toggle model has no levels at all, which is the fact that explains the word.
 */
export function thinkingNoteWords(thinking: Parameters<typeof thinkingEffectNote>[0]): string | null {
	const note = thinkingEffectNote(thinking);
	if (note === null) return null;
	if (thinking.mechanism === "on-off") return "this model has no levels";
	if (thinking.mechanism === "always-on") return "this model always thinks";
	if (thinking.mechanism === "none") return note;
	return `${thinking.configuredLevel} not offered`;
}
