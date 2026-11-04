import { skinEpoch } from "../theme/tokens.js";

/**
 * `/draft` overlay: the candidates as they denoise.
 *
 * One row per candidate carries its state. Below the rows is the selected
 * candidate's text; the arrows and the number keys move the
 * selection. Enter takes the selected draft into the composer, unsent. Like
 * `/btw`, nothing here reaches the session.
 */

import { redactStreamingUrlCredentials, redactUrlCredentials } from "../../domains/safety/redaction.js";
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
import { DRAFT_LABELS, type DraftLabel, hasDeadDraftToolCallMarkup } from "../../session-control/drafts.js";
import { buildResponsiveHint, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { codeInk } from "../renderers/code-ink.js";
import { clioTheme, GLYPH, markdownTheme, rule } from "../theme/index.js";

export const DRAFT_OVERLAY_TITLE = "Drafts";

export type DraftCandidatePhase =
	| { kind: "streaming"; text: string }
	| { kind: "drafted"; text: string }
	| { kind: "failed"; reason: string };

export interface DraftOverlayState {
	request: string;
	candidates: DraftCandidatePhase[];
	selected: number;
	scroll: number;
	/** The whole round was cancelled or refused before any candidate ran. */
	refused?: string;
}

export interface DraftOverlaySession extends OverlayHandle {
	setCandidate(index: number, phase: DraftCandidatePhase): void;
	refuse(reason: string): void;
}

/** The settled draft Enter would take. */
export interface TakenDraft {
	index: number;
	label: DraftLabel;
	text: string;
}

export interface OpenDraftOverlayOptions {
	request: string;
	count: number;
	columns: number;
	/** Live terminal height, which bounds how much of the selected draft shows. */
	rows: number;
	/** Esc: ask the host to close the overlay, which hides it through its own transition. */
	onEscape: () => void;
	/**
	 * Enter on a settled draft. The host puts its text in the composer and closes
	 * the overlay. Absent, Enter does nothing and the legend does not offer it.
	 */
	onUse?: (taken: TakenDraft) => void;
	/** Hidden by any path: abort whatever is still running. */
	onClose: () => void;
}

const MIN_WIDTH = 50;
const MAX_WIDTH = 110;

function overlayWidth(columns: number): number {
	return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns - 4));
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
	return state.candidates.map((phase, index) => {
		const label = DRAFT_LABELS[index] ?? String(index + 1);
		const cursor = index === state.selected ? theme.fg("selectedOption", GLYPH.cursor) : " ";
		const head = `${cursor} ${index === state.selected ? theme.fg("selectedOption", label) : label}  `;
		let body: string;
		if (phase.kind === "failed") {
			body = theme.fg("error", `${GLYPH.error} ${redactUrlCredentials(phase.reason)}`);
		} else {
			body = theme.fg(phase.kind === "streaming" ? "annotation" : "menuDescription", candidateStatus(phase));
		}
		return truncateToWidth(`${head}${body}`, width);
	});
}

function dimLines(text: string, width: number): string[] {
	const theme = clioTheme();
	const wrapped: string[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) {
			wrapped.push("");
			continue;
		}
		for (const part of wrapTextWithAnsi(theme.fg("annotation", line), width)) wrapped.push(part);
	}
	return wrapped;
}

/**
 * Rendered Markdown per settled candidate and width. Scrolling re-renders the
 * overlay on every key, and parsing and highlighting a long draft each time
 * would make the arrows lag.
 */
const renderedDrafts = new WeakMap<DraftCandidatePhase, { width: number; epoch: number; lines: string[] }>();

function markdownLines(phase: Extract<DraftCandidatePhase, { kind: "drafted" }>, width: number): string[] {
	const cached = renderedDrafts.get(phase);
	if (cached && cached.width === width && cached.epoch === skinEpoch()) return cached.lines;
	const theme = markdownTheme(clioTheme(), (code, lang) => codeInk(lang, code.split("\n")));
	const lines = new Markdown(redactUrlCredentials(phase.text).trim(), 0, 0, theme)
		.render(width)
		.map((line) => line.trimEnd());
	renderedDrafts.set(phase, { width, epoch: skinEpoch(), lines });
	return lines;
}

/** The selected candidate's text, windowed to `maxLines` from `scroll`. */
function selectedText(state: DraftOverlayState, width: number, maxLines: number): string[] {
	const theme = clioTheme();
	const phase = state.candidates[state.selected];
	if (!phase) return [];
	if (phase.kind === "failed") return wrapTextWithAnsi(theme.fg("error", redactUrlCredentials(phase.reason)), width);
	// The trim would hide the whitespace that closes an open URL, so the streaming hold reads the raw text first (#446).
	const text = (phase.kind === "drafted" ? phase.text : redactStreamingUrlCredentials(phase.text)).trim();
	if (text.length === 0) return [theme.fg("annotation", "…")];
	// A streaming candidate is a diffusion frame: noise until it settles, so it
	// reads dim until its round completes. A settled one renders as the
	// transcript would render the same answer.
	const wrapped = phase.kind === "drafted" ? markdownLines(phase, width) : dimLines(text, width);
	const start = Math.min(state.scroll, Math.max(0, wrapped.length - maxLines));
	const window = wrapped.slice(start, start + maxLines);
	const below = wrapped.length - (start + window.length);
	if (below > 0) window.push(theme.fg("annotation", `${GLYPH.down} ${below} more ${below === 1 ? "line" : "lines"}`));
	return window;
}

/** Pure so the layout is testable without a TUI. */
export function formatDraftOverlayBody(state: DraftOverlayState, width: number, maxTextLines: number): string[] {
	const theme = clioTheme();
	const contentWidth = Math.max(1, Math.floor(width));
	const lines: string[] = [];
	for (const line of wrapTextWithAnsi(theme.fg("annotation", `${GLYPH.user} ${state.request}`), contentWidth)) {
		lines.push(line);
	}
	lines.push(rule(theme, contentWidth));
	if (state.refused !== undefined) {
		for (const line of wrapTextWithAnsi(theme.fg("error", redactUrlCredentials(state.refused)), contentWidth))
			lines.push(line);
		return lines;
	}
	lines.push(...candidateRows(state, contentWidth));
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

/**
 * The selected draft when it has settled with text. A streaming or failed
 * candidate is not one the operator can take, and an empty draft is a gap.
 */
export function takenDraft(state: DraftOverlayState): TakenDraft | null {
	const phase = state.candidates[state.selected];
	if (phase?.kind !== "drafted") return null;
	const text = phase.text.trim();
	const label = DRAFT_LABELS[state.selected];
	if (text.length === 0 || label === undefined || hasDeadDraftToolCallMarkup(text)) return null;
	return { index: state.selected, label, text };
}

/** Every candidate has settled one way or the other. */
function allSettled(state: DraftOverlayState): boolean {
	return state.candidates.every((phase) => phase.kind !== "streaming");
}

export function openDraftOverlay(tui: TUI, options: OpenDraftOverlayOptions): DraftOverlaySession {
	const state: DraftOverlayState = {
		request: options.request,
		candidates: Array.from({ length: options.count }, () => ({ kind: "streaming", text: "" }) as DraftCandidatePhase),
		selected: 0,
		scroll: 0,
	};
	// The frame, the request, the rows and two rules take about
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
			if (matchesKey(data, "enter")) {
				const taken = options.onUse ? takenDraft(state) : null;
				if (taken) options.onUse?.(taken);
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
					...(options.onUse && takenDraft(state) ? [{ key: "Enter", verb: "use" }] : []),
				],
				{ key: "Esc", verb: allSettled(state) ? "close" : "cancel" },
			)(innerWidth),
	});

	const session: DraftOverlaySession = {
		...handle,
		setCandidate(index, phase) {
			if (closed || index < 0 || index >= state.candidates.length) return;
			state.candidates[index] = phase;
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
