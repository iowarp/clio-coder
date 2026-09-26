// What a side question or a set of drafts says before any of it is drawn. Both are the terminal's
// /btw and /draft: rounds beside the conversation that answer the operator and never become a turn.

import type { AsideAnswer, AsideDrafts } from "../../contracts/aside.js";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import type { StatusTone } from "../design/status.js";

type AsideCapability = NonNullable<AgentCapabilities["aside"]>;

/** Why the aside cannot run right now, or null when it can. */
export function asideBlock(
	capability: AsideCapability | undefined,
	sessionOpen: boolean,
	running: boolean,
): string | null {
	if (!capability) return "This Clio Coder build cannot answer beside the conversation.";
	if (!sessionOpen) return "This session is not open. Load it to ask beside it.";
	if (running) return "Ask once the turn settles. A side question reads the conversation as it stands, not mid-turn.";
	return null;
}

/**
 * The draft counts offered. One draft is legal on the wire but leaves the judge nothing to compare,
 * so the control starts at two, as the terminal's usage line suggests.
 */
export function draftCounts(capability: AsideCapability): { counts: number[]; initial: number } {
	const min = Math.max(2, capability.draftCounts.min);
	const max = Math.max(min, capability.draftCounts.max);
	const counts = Array.from({ length: max - min + 1 }, (_, index) => min + index);
	const initial = Math.min(max, Math.max(min, capability.draftCounts.default));
	return { counts, initial };
}

export interface AnswerView {
	tone: StatusTone;
	word: string;
	text: string | null;
	note: string;
}

export function answerView(answer: AsideAnswer): AnswerView {
	if ("reason" in answer)
		return answer.status === "refused"
			? { tone: "warn", word: "Not asked", text: null, note: answer.reason }
			: { tone: "fail", word: "Failed", text: null, note: answer.reason };
	const cut = answer.truncated ? " The answer was shortened to fit." : "";
	return {
		tone: answer.status === "answered" ? "success" : "neutral",
		word: answer.status === "answered" ? "Answered" : "Stopped",
		text: answer.text,
		note: `Not added to the conversation.${cut}`,
	};
}

export interface DraftCard {
	label: string;
	picked: boolean;
	/** The judge's share for this draft, as a percentage; null when nothing was judged. */
	share: string | null;
	sound: "Sound" | "Not sound" | "Undecided" | null;
	text: string | null;
	failed: string | null;
	truncated: boolean;
}

const sentence = (text: string) => {
	const trimmed = text.trim();
	const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
	return /[.!?]$/u.test(capital) ? capital : `${capital}.`;
};

export function draftsView(drafts: AsideDrafts): { summary: string; cards: DraftCard[] } {
	if (drafts.status === "refused")
		return { summary: `Not drafted: ${drafts.reason.trim().replace(/[.]?$/u, ".")}`, cards: [] };
	const judged = drafts.judgment?.status === "judged" ? drafts.judgment : null;
	const cards = drafts.candidates.map((candidate): DraftCard => {
		const share = judged ? judged.probabilities[candidate.label] : undefined;
		const sound = judged ? judged.sound[candidate.label] : undefined;
		return {
			label: candidate.label,
			picked: judged?.picked === candidate.label,
			share: share === undefined ? null : `${Math.round(share * 100)}%`,
			sound: sound === undefined ? null : sound === true ? "Sound" : sound === false ? "Not sound" : "Undecided",
			text: candidate.status === "drafted" ? candidate.text : null,
			failed: candidate.status === "failed" ? candidate.reason : null,
			truncated: candidate.status === "drafted" && candidate.truncated,
		};
	});
	if (drafts.aborted) return { summary: "Stopped before a judgment.", cards };
	if (judged)
		return {
			summary: judged.picked
				? `${judged.source} picked ${judged.picked} in ${judged.elapsedMs} ms.`
				: `${judged.source} answered, but its pick was none of the drafts.`,
			cards,
		};
	const reason = drafts.judgment && "reason" in drafts.judgment ? drafts.judgment.reason : "not judged";
	return { summary: sentence(reason), cards };
}
