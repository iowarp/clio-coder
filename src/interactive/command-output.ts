import { wrapTextWithAnsi } from "../engine/tui.js";
import { renderReferenceCard } from "./renderers/reference-card.js";
import type { PromptReferenceCard, RunIo } from "./slash-commands.js";
import { type ClioToken, clioTheme, GLYPH } from "./theme/index.js";

export type NoticeLevel = "info" | "success" | "warn" | "error";

export function appendNotice(level: NoticeLevel, text: string, sink: CommandOutputSink): void {
	const normalized = text.replace(/\r/g, "").replace(/\n+/gu, " ").trimEnd();
	if (normalized.trim().length === 0) return;
	sink.appendReplayBlock((width) => {
		const theme = clioTheme();
		let glyph = "";
		let token: ClioToken = "dim";
		switch (level) {
			case "info":
				glyph = "·";
				token = "dim";
				break;
			case "success":
				glyph = GLYPH.ok;
				token = "success";
				break;
			case "warn":
				glyph = GLYPH.warnInline;
				token = "warning";
				break;
			case "error":
				glyph = GLYPH.error;
				token = "error";
				break;
		}
		const prefix = `${theme.fg(token, glyph)} `;
		return wrapTextWithAnsi(`${prefix}${normalized}`, width);
	});
	sink.requestRender();
}

/**
 * Echo the command line an operator typed, dimmed, above the output it starts.
 *
 * A dispatched run draws its own attributed block, and without this the block
 * appears with nothing above it saying who asked for it or what was asked. The
 * echo is transcript-only: it is a replay block, so it is never persisted as a
 * session entry and never reaches the model, which is the whole point of a
 * `/run` the main agent is not told about.
 */
export function appendOperatorCommand(text: string, sink: CommandOutputSink): void {
	const normalized = text.replace(/\r/g, "").replace(/\n+/gu, " ").trim();
	if (normalized.length === 0) return;
	sink.appendReplayBlock((width) => {
		const theme = clioTheme();
		return wrapTextWithAnsi(theme.fg("dim", `${GLYPH.user} ${normalized}`), width);
	});
	sink.requestRender();
}

/**
 * Render a display-only prompt template for the operator. A replay block like
 * the command echo above: it is never persisted as a session entry and never
 * reaches the model, which is what "display only" promises the author.
 */
export function appendReferenceCard(card: PromptReferenceCard, sink: CommandOutputSink): void {
	sink.appendReplayBlock((width) => renderReferenceCard(card, width));
	sink.requestRender();
}

/**
 * A dim line under an operator turn, in the prose gutter, saying something
 * about the turn that the operator did not type: which template expanded, how
 * long it was. Transcript-only, like the echo above.
 */
export function appendOperatorAside(text: string, sink: CommandOutputSink): void {
	const normalized = text.replace(/\r/g, "").replace(/\n+/gu, " ").trim();
	if (normalized.length === 0) return;
	sink.appendReplayBlock((width) => {
		const theme = clioTheme();
		return wrapTextWithAnsi(theme.fg("dim", normalized), Math.max(1, width - 2)).map((line) => `  ${line}`);
	});
	sink.requestRender();
}

export interface InterviewRecordEntry {
	/** The question's header, or its first line when it has none. */
	label: string;
	answer: string;
}

/**
 * What a round of an interview asked and what the operator answered, kept in
 * the transcript once the overlay has moved on. Without it the round left
 * only a tool row reading `▸ tool action {"action":"ask",…`, and the answers
 * lived on `/decisions` alone.
 */
export function appendInterviewRecord(entries: ReadonlyArray<InterviewRecordEntry>, sink: CommandOutputSink): void {
	const kept = entries.filter((entry) => entry.answer.trim().length > 0);
	if (kept.length === 0) return;
	sink.appendReplayBlock((width) => {
		const theme = clioTheme();
		const lines: string[] = [];
		const inner = Math.max(1, width - 2);
		for (const entry of kept) {
			const label = entry.label.replace(/\s+/gu, " ").trim();
			lines.push(...wrapTextWithAnsi(`${theme.fg("accent", GLYPH.cursor)} ${theme.fg("dim", label)}`, width));
			lines.push(...wrapTextWithAnsi(theme.fg("muted", entry.answer.trim()), inner).map((line) => `  ${line}`));
		}
		return lines;
	});
	sink.requestRender();
}

export type CommandOutputReplayBlock = (width: number) => string[];

export interface CommandOutputSink {
	appendReplayBlock(renderBlock: CommandOutputReplayBlock): void;
	requestRender(): void;
}

export type CommandOutputWrap = (line: string, width: number) => string[];

function appendCommandOutput(text: string, sink: CommandOutputSink, wrap: CommandOutputWrap = wrapTextWithAnsi): void {
	const normalized = text.replace(/\r/g, "").replace(/\n$/u, "");
	if (normalized.length === 0) return;
	sink.appendReplayBlock((width) => {
		const lines: string[] = [];
		for (const rawLine of normalized.split("\n")) {
			lines.push(...wrap(rawLine, width));
		}
		return lines;
	});
	sink.requestRender();
}

export function createCommandOutputRunIo(sink: CommandOutputSink, wrap: CommandOutputWrap = wrapTextWithAnsi): RunIo {
	const write = (text: string): void => appendCommandOutput(text, sink, wrap);
	return {
		stdout: write,
		stderr: write,
	};
}
