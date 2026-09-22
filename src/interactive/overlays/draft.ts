/**
 * `/draft` overlay: the candidates as they denoise, then the judge's pick.
 *
 * One row per candidate carries its state and, once the judge answers, a bar
 * for the probability mass it gave that candidate, so the operator sees how
 * decisive the pick was and not only which candidate won. Below the rows is
 * the selected candidate's text; the arrows and the number keys move the
 * selection. Like `/btw`, nothing here reaches the session.
 */

import {
	type Component,
	isKeyRelease,
	Markdown,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { DRAFT_LABELS, type DraftVerdict } from "../drafts.js";
import { buildResponsiveHint, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { codeInk } from "../renderers/code-ink.js";
import { clioTheme, GLYPH, markdownTheme, rule } from "../theme/index.js";

export const DRAFT_OVERLAY_TITLE = "Drafts";

export type DraftCandidatePhase =
	| { kind: "streaming"; text: string }
	| { kind: "drafted"; text: string }
	| { kind: "failed"; reason: string };

export type DraftJudgePhase =
	| { kind: "waiting" }
	| { kind: "judging" }
	| { kind: "judged"; verdict: DraftVerdict }
	/** No judgment, with the sentence that says why. */
	| { kind: "unjudged"; reason: string };

export interface DraftOverlayState {
	request: string;
	candidates: DraftCandidatePhase[];
	judge: DraftJudgePhase;
	selected: number;
	scroll: number;
	/** The whole round was cancelled or refused before any candidate ran. */
	refused?: string;
}

export interface DraftOverlaySession extends OverlayHandle {
	setCandidate(index: number, phase: DraftCandidatePhase): void;
	setJudge(phase: DraftJudgePhase): void;
	refuse(reason: string): void;
}

export interface OpenDraftOverlayOptions {
	request: string;
	count: number;
	columns: number;
	/** Live terminal height, which bounds how much of the selected draft shows. */
	rows: number;
	/** Esc: ask the host to close the overlay, which hides it through its own transition. */
	onEscape: () => void;
	/** Hidden by any path: abort whatever is still running. */
	onClose: () => void;
}

const BAR_CELLS = 16;
const MIN_WIDTH = 50;
const MAX_WIDTH = 110;

function overlayWidth(columns: number): number {
	return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns - 4));
}

function bar(mass: number): string {
	const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(mass * BAR_CELLS)));
	return `${GLYPH.barFull.repeat(filled)}${GLYPH.barEmpty.repeat(BAR_CELLS - filled)}`;
}

function candidateStatus(phase: DraftCandidatePhase): string {
	if (phase.kind === "streaming") return phase.text.length > 0 ? "denoising…" : "starting…";
	if (phase.kind === "failed") return "failed";
	const lines = phase.text.split("\n").length;
	return `${phase.text.length} chars · ${lines} ${lines === 1 ? "line" : "lines"}`;
}

/** One row per candidate: label, bar or status, and the pick marker. */
function candidateRows(state: DraftOverlayState, width: number): string[] {
	const theme = clioTheme();
	const verdict = state.judge.kind === "judged" ? state.judge.verdict : null;
	return state.candidates.map((phase, index) => {
		const label = DRAFT_LABELS[index] ?? String(index + 1);
		const cursor = index === state.selected ? theme.fg("accent", GLYPH.cursor) : " ";
		const head = `${cursor} ${index === state.selected ? theme.fg("accent", label) : label}  `;
		let body: string;
		if (verdict && phase.kind === "drafted") {
			const mass = verdict.probabilities[label as keyof DraftVerdict["probabilities"]] ?? 0;
			const picked = verdict.picked === label;
			const sound = verdict.sound[label as keyof DraftVerdict["sound"]];
			const soundNote = sound === false ? theme.fg("warning", "  judged unsound") : "";
			body = `${theme.fg(picked ? "success" : "dim", bar(mass))} ${mass.toFixed(2)}${picked ? theme.fg("success", `  ${GLYPH.ok} picked`) : ""}${soundNote}  ${theme.fg("dim", candidateStatus(phase))}`;
		} else if (phase.kind === "failed") {
			body = theme.fg("error", `${GLYPH.error} ${phase.reason}`);
		} else {
			body = theme.fg(phase.kind === "streaming" ? "dim" : "muted", candidateStatus(phase));
		}
		return truncateToWidth(`${head}${body}`, width);
	});
}

function judgeLine(state: DraftOverlayState): string {
	const theme = clioTheme();
	const judge = state.judge;
	if (judge.kind === "waiting") return theme.fg("dim", "judge waits for every draft");
	if (judge.kind === "judging") return theme.fg("dim", "judging…");
	if (judge.kind === "unjudged") return theme.fg("warning", judge.reason);
	return theme.fg("dim", `judged by ${judge.verdict.source} in ${judge.verdict.elapsedMs}ms`);
}

function dimLines(text: string, width: number): string[] {
	const theme = clioTheme();
	const wrapped: string[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) {
			wrapped.push("");
			continue;
		}
		for (const part of wrapTextWithAnsi(theme.fg("dim", line), width)) wrapped.push(part);
	}
	return wrapped;
}

/**
 * Rendered Markdown per settled candidate and width. Scrolling re-renders the
 * overlay on every key, and parsing and highlighting a long draft each time
 * would make the arrows lag.
 */
const renderedDrafts = new WeakMap<DraftCandidatePhase, { width: number; lines: string[] }>();

function markdownLines(phase: Extract<DraftCandidatePhase, { kind: "drafted" }>, width: number): string[] {
	const cached = renderedDrafts.get(phase);
	if (cached && cached.width === width) return cached.lines;
	const theme = markdownTheme(clioTheme(), (code, lang) => codeInk(lang, code.split("\n")));
	const lines = new Markdown(phase.text.trim(), 0, 0, theme).render(width).map((line) => line.trimEnd());
	renderedDrafts.set(phase, { width, lines });
	return lines;
}

/** The selected candidate's text, windowed to `maxLines` from `scroll`. */
function selectedText(state: DraftOverlayState, width: number, maxLines: number): string[] {
	const theme = clioTheme();
	const phase = state.candidates[state.selected];
	if (!phase) return [];
	if (phase.kind === "failed") return wrapTextWithAnsi(theme.fg("error", phase.reason), width);
	const text = phase.text.trim();
	if (text.length === 0) return [theme.fg("dim", "…")];
	// A streaming candidate is a diffusion frame: noise until it settles, so it
	// reads dim until its round completes. A settled one renders as the
	// transcript would render the same answer.
	const wrapped = phase.kind === "drafted" ? markdownLines(phase, width) : dimLines(text, width);
	const start = Math.min(state.scroll, Math.max(0, wrapped.length - maxLines));
	const window = wrapped.slice(start, start + maxLines);
	const below = wrapped.length - (start + window.length);
	if (below > 0) window.push(theme.fg("dim", `${GLYPH.down} ${below} more ${below === 1 ? "line" : "lines"}`));
	return window;
}

/** Pure so the layout is testable without a TUI. */
export function formatDraftOverlayBody(state: DraftOverlayState, width: number, maxTextLines: number): string[] {
	const theme = clioTheme();
	const contentWidth = Math.max(1, Math.floor(width));
	const lines: string[] = [];
	for (const line of wrapTextWithAnsi(theme.fg("dim", `${GLYPH.user} ${state.request}`), contentWidth)) {
		lines.push(line);
	}
	lines.push(rule(theme, contentWidth));
	if (state.refused !== undefined) {
		for (const line of wrapTextWithAnsi(theme.fg("error", state.refused), contentWidth)) lines.push(line);
		return lines;
	}
	lines.push(...candidateRows(state, contentWidth));
	lines.push(truncateToWidth(judgeLine(state), contentWidth));
	lines.push(rule(theme, contentWidth));
	lines.push(...selectedText(state, contentWidth, maxTextLines));
	return lines;
}

class DraftOverlayBody implements Component {
	constructor(
		readonly state: DraftOverlayState,
		private readonly maxTextLines: number,
	) {}

	render(width: number): string[] {
		return formatDraftOverlayBody(this.state, width, this.maxTextLines);
	}

	invalidate(): void {}
}

/** Every candidate has settled one way or the other. */
function allSettled(state: DraftOverlayState): boolean {
	return state.candidates.every((phase) => phase.kind !== "streaming");
}

export function openDraftOverlay(tui: TUI, options: OpenDraftOverlayOptions): DraftOverlaySession {
	const state: DraftOverlayState = {
		request: options.request,
		candidates: Array.from({ length: options.count }, () => ({ kind: "streaming", text: "" }) as DraftCandidatePhase),
		judge: { kind: "waiting" },
		selected: 0,
		scroll: 0,
	};
	// The frame, the request, the rows, the judge line and two rules take about
	// a dozen rows; the selected draft gets what is left of the screen.
	const maxTextLines = Math.max(6, options.rows - options.count - 14);
	const body = new DraftOverlayBody(state, maxTextLines);
	let closed = false;

	const select = (index: number): void => {
		if (index < 0 || index >= state.candidates.length || index === state.selected) return;
		state.selected = index;
		state.scroll = 0;
		tui.requestRender();
	};

	const focus = new FocusBox(body, {
		// Matched by name, never by raw bytes, for the kitty keyboard protocol.
		onInput: (data: string): void => {
			if (isKeyRelease(data)) return;
			if (matchesKey(data, "escape")) {
				options.onEscape();
				return;
			}
			if (matchesKey(data, "left")) {
				select(state.selected - 1);
				return;
			}
			if (matchesKey(data, "right") || matchesKey(data, "tab")) {
				select((state.selected + 1) % state.candidates.length);
				return;
			}
			if (matchesKey(data, "up")) {
				state.scroll = Math.max(0, state.scroll - 1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "down")) {
				state.scroll += 1;
				tui.requestRender();
				return;
			}
			const digit = /^[1-4]$/u.exec(data);
			if (digit) select(Number(digit[0]) - 1);
		},
	});

	const handle = showClioOverlayFrame(tui, focus, {
		anchor: "center",
		width: overlayWidth(options.columns),
		markerId: "draft",
		title: DRAFT_OVERLAY_TITLE,
		footerHint: (innerWidth) =>
			buildResponsiveHint(
				[
					{ key: "←→", verb: "draft" },
					{ key: "↑↓", verb: "scroll" },
				],
				{ key: "Esc", verb: allSettled(state) && state.judge.kind !== "judging" ? "close" : "cancel" },
			)(innerWidth),
	});

	const session: DraftOverlaySession = {
		...handle,
		setCandidate(index, phase) {
			if (closed || index < 0 || index >= state.candidates.length) return;
			state.candidates[index] = phase;
			tui.requestRender();
		},
		setJudge(phase) {
			if (closed) return;
			state.judge = phase;
			// Land on the pick, so the text below the bars is the one the judge
			// would have the operator read first.
			if (phase.kind === "judged" && phase.verdict.picked !== null) {
				const picked = DRAFT_LABELS.indexOf(phase.verdict.picked);
				if (picked >= 0) {
					state.selected = picked;
					state.scroll = 0;
				}
			}
			tui.requestRender();
		},
		refuse(reason) {
			if (closed) return;
			state.refused = reason;
			tui.requestRender();
		},
		hide(): void {
			if (closed) return;
			closed = true;
			options.onClose();
			handle.hide();
		},
	};
	return session;
}
