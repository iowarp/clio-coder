/**
 * `/btw` overlay: the question, then the answer as it streams.
 *
 * The overlay is the whole surface for a side question. Nothing it shows is
 * appended to the transcript, so closing it is the end of the exchange: the
 * answer was for the operator, in the moment, and the session never saw it.
 */

import { AssistantProseProjection } from "../../core/assistant-prose.js";
import {
	redactFinalUrlCredentials,
	redactStreamingUrlCredentials,
	redactUrlCredentials,
} from "../../domains/safety/redaction.js";
import { type Component, type OverlayHandle, type TUI, truncateToWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { buildResponsiveHint, showClioOverlayFrame } from "../overlay-frame.js";
import { animationStep, clioTheme, GLYPH, rule, spinnerFrame } from "../theme/index.js";

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
	/** Name the route the round was sent on, or the one that answered. */
	setRoute(route: string): void;
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

function sideQuestionOverlayWidth(columns: number): number {
	return Math.max(SIDE_QUESTION_OVERLAY_MIN_WIDTH, Math.min(SIDE_QUESTION_OVERLAY_MAX_WIDTH, columns - 4));
}

/**
 * Render the overlay body. Pure so the layout is unit-testable without a TUI:
 * the question in dim above a rule, then the answer, then one status line that
 * says whether the round is still running, cancelled, or failed.
 */
function formatSideQuestionBody(
	question: string,
	phase: SideQuestionOverlayPhase,
	width: number,
	spinner: string,
	route: string | null = null,
): string[] {
	const theme = clioTheme();
	const contentWidth = Math.max(1, Math.floor(width));
	const lines: string[] = [];
	for (const line of wrapTextWithAnsi(theme.fg("userProse", `${GLYPH.user} ${question}`), contentWidth))
		lines.push(line);
	lines.push(rule(theme, contentWidth));
	if (phase.kind === "error") {
		for (const line of wrapTextWithAnsi(theme.fg("error", redactUrlCredentials(phase.reason)), contentWidth))
			lines.push(line);
		if (route !== null) lines.push(routeLine("asked", route, contentWidth));
		return lines;
	}
	const body = phase.text.trim();
	if (body.length > 0) {
		for (const paragraph of body.split("\n")) {
			if (paragraph.length === 0) {
				lines.push("");
				continue;
			}
			for (const line of wrapTextWithAnsi(theme.fg("assistantProse", paragraph), contentWidth)) lines.push(line);
		}
	}
	if (phase.kind === "streaming") {
		const asking = route === null ? `${spinner} asking…` : `${spinner} asking ${route}`;
		lines.push(
			truncateToWidth(
				theme.fg("activity", body.length > 0 && route === null ? spinner : asking),
				contentWidth,
				GLYPH.ellipsis,
				false,
			),
		);
	} else if (phase.kind === "aborted") {
		lines.push(theme.fg("menuDescription", "cancelled"));
		if (route !== null) lines.push(routeLine("asked", route, contentWidth));
	} else {
		if (body.length === 0) lines.push(theme.fg("annotation", "the model returned no text"));
		if (route !== null) lines.push(routeLine("answered by", route, contentWidth));
	}
	return lines;
}

/** State word first, so a narrow box cuts the route rather than what happened. */
function routeLine(word: string, route: string, width: number): string {
	return truncateToWidth(clioTheme().fg("annotation", `${word} ${route}`), width, GLYPH.ellipsis, false);
}

/**
 * The spinner steps on the shared animation clock. It used to advance once per
 * render, so it sped up with the frame rate and spent the running glyph `●` as
 * a spinner frame.
 */
export class SideQuestionOverlayBody implements Component {
	private phase: SideQuestionOverlayPhase = { kind: "streaming", text: "" };
	route: string | null = null;
	private readonly prose = new AssistantProseProjection();

	constructor(
		private readonly question: string,
		private readonly now: () => number = Date.now,
	) {}

	set(phase: SideQuestionOverlayPhase): void {
		if (phase.kind === "error") {
			this.phase = phase;
			return;
		}
		const prose = this.prose.project(phase.text, phase.kind !== "streaming");
		// Only an answered round releases a hold. After an abort no later text can resolve it, or bring an opaque name's `@` (#446).
		const text =
			phase.kind === "streaming"
				? redactStreamingUrlCredentials(prose)
				: redactFinalUrlCredentials(prose, phase.kind === "answered");
		this.phase = { ...phase, text };
	}

	render(width: number): string[] {
		return formatSideQuestionBody(this.question, this.phase, width, spinnerFrame(animationStep(this.now())), this.route);
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
		setRoute(route: string): void {
			body.route = route;
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
