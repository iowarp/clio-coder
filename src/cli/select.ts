/**
 * A one-of-many picker driven by arrow keys, for the interactive menus in
 * `clio-coder configure`.
 *
 * Every other prompt in this CLI is a readline line-prompt from `./ask.ts`, and
 * that is still the fallback: raw mode needs a terminal on both ends, and a
 * scripted run, a pipe, or a dumb terminal has neither. `canSelect()` answers
 * whether the interactive path is available, and callers keep the numbered
 * prompt for when it is not, so no invocation loses a way to answer.
 *
 * The escape key is the whole point. A readline menu can only be left by typing
 * the token that means "back", which the screen has to teach; Escape is the key
 * a person already presses. It arrives as a plain keypress here because raw mode
 * turns off the terminal's own line discipline, which is also why Ctrl-C has to
 * be handled by hand: with `setRawMode(true)` no SIGINT is raised and an
 * unhandled Ctrl-C would simply do nothing.
 */
import { emitKeypressEvents } from "node:readline";
import chalk from "chalk";

import { column, terminalColumns, truncate } from "./text-layout.js";

export interface SelectChoice<T> {
	value: T;
	label: string;
	/** Dim text after the label, for what the entry covers. */
	hint?: string;
}

export interface SelectOptions<T> {
	/** Line above the list, already styled by the caller. */
	heading?: string;
	choices: ReadonlyArray<SelectChoice<T>>;
	/** Index the cursor opens on, clamped into range. */
	initialIndex?: number;
	/** Prefix on every rendered line, so the picker sits on the presenter's rail. */
	railPrefix?: string;
	/** Word for leaving the menu, shown in the key legend. Omit to hide it. */
	backLabel?: string;
	input?: NodeJS.ReadStream;
	output?: NodeJS.WriteStream;
}

export type SelectResult<T> = { kind: "selected"; value: T } | { kind: "back" } | { kind: "quit" };

/** Whether the arrow-key picker can run: both ends must be a real terminal. */
export function canSelect(
	input: NodeJS.ReadStream = process.stdin,
	output: NodeJS.WriteStream = process.stdout,
): boolean {
	return Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === "function" && process.env.TERM !== "dumb");
}

const CURSOR_HIDE = "\u001B[?25l";
const CURSOR_SHOW = "\u001B[?25h";

export async function promptSelect<T>(options: SelectOptions<T>): Promise<SelectResult<T>> {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const choices = options.choices;
	if (choices.length === 0) return { kind: "back" };

	const rail = options.railPrefix ?? "";
	// The rail prefix carries color, so its printed length is not its string
	// length; the caller's indentation is two spaces plus one glyph either way.
	const railWidth = 3;
	const hasHints = choices.some((choice) => choice.hint !== undefined);
	const labelWidth = Math.min(30, Math.max(...choices.map((choice) => choice.label.length)));

	let index = Math.min(Math.max(options.initialIndex ?? 0, 0), choices.length - 1);
	let drawnLines = 0;

	const render = (): void => {
		// Redraw in place: up over what was drawn, then clear to the end of the
		// screen. A full clear would take the transcript above the menu with it.
		if (drawnLines > 0) output.write(`\u001B[${drawnLines}A\u001B[0J`);
		// Measured every frame, so a window resized mid-menu lays out correctly on
		// the next keypress rather than at the width the menu opened on.
		const room = terminalColumns(output) - railWidth;
		const hintRoom = room - 2 - labelWidth - 2;
		const lines: string[] = [];
		if (options.heading !== undefined) {
			lines.push(`${rail}${options.heading}`, rail.trimEnd());
		}
		choices.forEach((choice, position) => {
			const active = position === index;
			// Widths are computed on the unstyled text and the color applied
			// afterwards. Truncating the styled string counted escape bytes as
			// columns, so the highlighted row, which carries the most escapes, was
			// cut several characters shorter than every other row.
			const aligned = hasHints && hintRoom >= 12;
			const label = aligned ? column(choice.label, labelWidth) : truncate(choice.label, room - 2);
			const hint = aligned && choice.hint !== undefined ? truncate(choice.hint, hintRoom) : "";
			const marker = active ? chalk.cyan("❯") : " ";
			const styledLabel = active ? chalk.cyan.bold(label) : label;
			lines.push(`${rail}${marker} ${styledLabel}${hint.length > 0 ? `  ${chalk.dim(hint)}` : ""}`.trimEnd());
		});
		lines.push(rail.trimEnd());
		// On the top screen escape and q do the same thing, and listing both as
		// "quit" reads as two different exits.
		const legend = ["↑/↓ move", "enter select"];
		if (options.backLabel !== undefined && options.backLabel !== "quit") legend.push(`esc ${options.backLabel}`);
		legend.push(options.backLabel === "quit" ? "esc or q quit" : "q quit");
		lines.push(`${rail}${chalk.dim(legend.join(" · "))}`);
		output.write(`${lines.join("\n")}\n`);
		drawnLines = lines.length;
	};

	const wasRaw = input.isRaw === true;
	emitKeypressEvents(input);
	input.setRawMode(true);
	input.resume();
	output.write(CURSOR_HIDE);
	render();

	try {
		return await new Promise<SelectResult<T>>((resolve) => {
			const finish = (result: SelectResult<T>): void => {
				input.off("keypress", onKeypress);
				input.off("end", onEnd);
				input.off("close", onEnd);
				resolve(result);
			};
			// An input that stops talking is not a selection. Without this the
			// picker sits on a closed stdin forever, which is what a recorded
			// terminal session and a `script` capture both produce at the end of
			// their key file.
			function onEnd(): void {
				finish({ kind: "quit" });
			}
			function onKeypress(_str: string, key: { name?: string; ctrl?: boolean; shift?: boolean }): void {
				if (key.ctrl && (key.name === "c" || key.name === "d")) {
					finish({ kind: "quit" });
					return;
				}
				switch (key.name) {
					case "up":
					case "k":
						index = (index - 1 + choices.length) % choices.length;
						render();
						return;
					case "down":
					case "j":
					case "tab":
						index = (index + 1) % choices.length;
						render();
						return;
					case "home":
						index = 0;
						render();
						return;
					case "end":
						index = choices.length - 1;
						render();
						return;
					case "return":
					case "enter":
					case "space": {
						const choice = choices[index];
						finish(choice === undefined ? { kind: "back" } : { kind: "selected", value: choice.value });
						return;
					}
					case "escape":
					case "left":
					case "backspace":
						finish({ kind: "back" });
						return;
					case "q":
						finish({ kind: "quit" });
						return;
					default: {
						// A digit picks that row directly, so the muscle memory the
						// numbered menu built still works.
						const digit = Number.parseInt(key.name ?? "", 10);
						if (Number.isInteger(digit) && digit >= 1 && digit <= choices.length) {
							index = digit - 1;
							render();
							const choice = choices[index];
							if (choice !== undefined) finish({ kind: "selected", value: choice.value });
						}
					}
				}
			}
			input.on("keypress", onKeypress);
			input.once("end", onEnd);
			input.once("close", onEnd);
		});
	} finally {
		output.write(CURSOR_SHOW);
		if (!wasRaw) input.setRawMode(false);
		input.pause();
	}
}
