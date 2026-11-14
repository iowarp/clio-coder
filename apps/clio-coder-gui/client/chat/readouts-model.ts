// The top bar's readout strip, from the engine's last readouts frame. Every text is the engine's own display, shown
// verbatim: the strip maps tones and decides what to show, and never adds, rounds or rewords a figure.

import type { SessionReadouts } from "../../contracts/readouts.js";
import type { StatusTone } from "../design/status.js";

type RetryPhase = NonNullable<SessionReadouts["retry"]>["phase"];

export interface ReadoutChip {
	readonly key: "autonomy" | "window" | "throughput" | "skills" | "retry";
	readonly text: string;
	readonly tone: StatusTone;
	/** Words beyond the chip's own; the strip falls back to the chip text, which CSS may cut. */
	readonly title?: string;
	/** The rate is still being reported but nothing is flowing right now. */
	readonly dim?: boolean;
	/** A change worth announcing: a retry, or the window pausing yolo. The rate never is, as it ticks at 4 Hz. */
	readonly announce: boolean;
	/** Kept in a narrow bar, which shows only what says yolo is on and whether it stopped. */
	readonly essential: boolean;
}

const RETRY_TONES: Readonly<Partial<Record<RetryPhase, StatusTone>>> = {
	exhausted: "warn",
	cancelled: "warn",
	recovered: "success",
};

/**
 * The chips in bar order: yolo, its window, the rate, the skills, the retry. A missing or `null` readout gives no
 * chip. The rate and the retry belong to a running turn, so `turnRunning` (the page's own `running`) gates them: a
 * child that dies before its closing frame must not leave a stale rate or retry on screen.
 */
export function readoutChips(readouts: SessionReadouts | undefined, turnRunning: boolean): ReadoutChip[] {
	if (readouts === undefined) return [];
	const chips: ReadoutChip[] = [];
	const { autonomy, throughput, skills, retry } = readouts;
	if (autonomy !== null) {
		chips.push({
			key: "autonomy",
			text: autonomy.label,
			tone: autonomy.tone === "error" ? "fail" : "warn",
			announce: false,
			essential: true,
		});
		const window = autonomy.window;
		if (window?.halted)
			chips.push({
				key: "window",
				text: "yolo paused",
				tone: "warn",
				...(window.haltDetail !== undefined ? { title: window.haltDetail } : {}),
				announce: true,
				essential: true,
			});
		else if (window)
			chips.push({
				key: "window",
				text: window.display,
				tone: window.tone === "warning" ? "warn" : "neutral",
				announce: false,
				essential: false,
			});
	}
	if (throughput !== null && turnRunning)
		chips.push({
			key: "throughput",
			text: throughput.display,
			tone: "neutral",
			...(throughput.flowing ? {} : { dim: true }),
			announce: false,
			essential: false,
		});
	if (skills !== null)
		chips.push({
			key: "skills",
			text: skills.display,
			tone: "neutral",
			title: skills.names.join(", "),
			announce: false,
			essential: false,
		});
	if (retry !== null && turnRunning)
		chips.push({
			key: "retry",
			text: retry.display,
			tone: retry.active ? "running" : (RETRY_TONES[retry.phase] ?? "neutral"),
			announce: true,
			essential: false,
		});
	return chips;
}

/** What the strip's polite live region reads: the announced chips' words, so the rate never speaks. */
export const readoutAnnouncement = (chips: readonly ReadoutChip[]): string =>
	chips
		.filter((chip) => chip.announce)
		.map((chip) => chip.text)
		.join(". ");
