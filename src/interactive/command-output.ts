import { wrapTextWithAnsi } from "../engine/tui.js";
import type { RunIo } from "./slash-commands.js";

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
