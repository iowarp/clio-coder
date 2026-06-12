import { wrapTextWithAnsi } from "../engine/tui.js";
import type { RunIo } from "./slash-commands.js";
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
				glyph = GLYPH.noticeInfo;
				token = "dim";
				break;
			case "success":
				glyph = GLYPH.noticeSuccess;
				token = "success";
				break;
			case "warn":
				glyph = GLYPH.noticeWarn;
				token = "warning";
				break;
			case "error":
				glyph = GLYPH.noticeError;
				token = "error";
				break;
		}
		const prefix = `${theme.fg(token, glyph)} `;
		return wrapTextWithAnsi(`${prefix}${normalized}`, width);
	});
	sink.requestRender();
}

export type CommandOutputReplayBlock = (width: number) => string[];

export interface CommandOutputSink {
	appendReplayBlock(renderBlock: CommandOutputReplayBlock): void;
	requestRender(): void;
}

export type CommandOutputWrap = (line: string, width: number) => string[];

export function appendCommandOutput(
	text: string,
	sink: CommandOutputSink,
	wrap: CommandOutputWrap = wrapTextWithAnsi,
): void {
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
