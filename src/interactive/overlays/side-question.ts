/**
 * `/btw` overlay: the question, then the answer as it streams.
 *
 * The overlay is the whole surface for a side question. Nothing it shows is
 * appended to the transcript, so closing it is the end of the exchange: the
 * answer was for the operator, in the moment, and the session never saw it.
 */

import { type Component, type OverlayHandle, type TUI, wrapTextWithAnsi } from "../../engine/tui.js";
import { buildResponsiveHint, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, GLYPH, rule } from "../theme/index.js";

export const SIDE_QUESTION_OVERLAY_TITLE = "Side question";

/** What the overlay is showing right now. */
export type SideQuestionOverlayPhase =
	| { kind: "streaming"; text: string }
	| { kind: "answered"; text: string }
	| { kind: "aborted"; text: string }
	| { kind: "error"; reason: string };

export interface SideQuestionOverlaySession extends OverlayHandle {
	/** Replace the streamed answer text. */
	setAnswer(text: string): void;
	/** Settle the overlay on a final phase. */
	settle(phase: SideQuestionOverlayPhase): void;
}

export interface OpenSideQuestionOverlayOptions {
	question: string;
	/** Live terminal width, so the box tracks the window it opened in. */
	columns: number;
	/** Esc: abort a streaming round, then close. */
	onClose: () => void;
}

const SIDE_QUESTION_OVERLAY_MIN_WIDTH = 44;
const SIDE_QUESTION_OVERLAY_MAX_WIDTH = 100;

export function sideQuestionOverlayWidth(columns: number): number {
	return Math.max(SIDE_QUESTION_OVERLAY_MIN_WIDTH, Math.min(SIDE_QUESTION_OVERLAY_MAX_WIDTH, columns - 4));
}

/**
 * Render the overlay body. Pure so the layout is unit-testable without a TUI:
 * the question in dim above a rule, then the answer, then one status line that
 * says whether the round is still running, cancelled, or failed.
 */
export function formatSideQuestionBody(
	question: string,
	phase: SideQuestionOverlayPhase,
	width: number,
	spinner: string,
): string[] {
	const theme = clioTheme();
	const contentWidth = Math.max(1, Math.floor(width));
	const lines: string[] = [];
	for (const line of wrapTextWithAnsi(theme.fg("dim", `${GLYPH.user} ${question}`), contentWidth)) lines.push(line);
	lines.push(rule(theme, contentWidth));
	if (phase.kind === "error") {
		for (const line of wrapTextWithAnsi(theme.fg("error", phase.reason), contentWidth)) lines.push(line);
		return lines;
	}
	const body = phase.text.trim();
	if (body.length > 0) {
		for (const paragraph of body.split("\n")) {
			if (paragraph.length === 0) {
				lines.push("");
				continue;
			}
			for (const line of wrapTextWithAnsi(theme.fg("muted", paragraph), contentWidth)) lines.push(line);
		}
	}
	if (phase.kind === "streaming") {
		lines.push(theme.fg("dim", body.length > 0 ? spinner : `${spinner} asking…`));
	} else if (phase.kind === "aborted") {
		lines.push(theme.fg("warning", "cancelled"));
	} else if (body.length === 0) {
		lines.push(theme.fg("dim", "the model returned no text"));
	}
	return lines;
}

const SPINNER_FRAMES = ["·", "•", "●", "•"] as const;

class SideQuestionOverlayBody implements Component {
	private phase: SideQuestionOverlayPhase = { kind: "streaming", text: "" };
	private frame = 0;

	constructor(private readonly question: string) {}

	set(phase: SideQuestionOverlayPhase): void {
		this.phase = phase;
	}

	render(width: number): string[] {
		if (this.phase.kind === "streaming") this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
		return formatSideQuestionBody(this.question, this.phase, width, SPINNER_FRAMES[this.frame] ?? "·");
	}

	invalidate(): void {}
}

/**
 * Mount the overlay. `setAnswer` is called from the stream; `settle` closes the
 * round's live state without closing the overlay, so the operator reads the
 * answer and leaves with Esc.
 */
export function openSideQuestionOverlay(tui: TUI, options: OpenSideQuestionOverlayOptions): SideQuestionOverlaySession {
	const body = new SideQuestionOverlayBody(options.question);
	let settled = false;
	const handle = showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: sideQuestionOverlayWidth(options.columns),
		markerId: "side-question",
		title: SIDE_QUESTION_OVERLAY_TITLE,
		// Esc means two things here and the footer names the live one: it aborts a
		// round that is still streaming, and it closes one that has settled.
		footerHint: (innerWidth) => buildResponsiveHint([], { key: "Esc", verb: settled ? "close" : "cancel" })(innerWidth),
	});
	return {
		...handle,
		setAnswer(text: string): void {
			if (settled) return;
			body.set({ kind: "streaming", text });
			body.invalidate();
			tui.requestRender();
		},
		settle(phase: SideQuestionOverlayPhase): void {
			settled = true;
			body.set(phase);
			body.invalidate();
			tui.requestRender();
		},
		hide(): void {
			options.onClose();
			handle.hide();
		},
	};
}
