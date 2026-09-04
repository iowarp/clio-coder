/**
 * The arrow-key prompts for `clio-coder configure`: a one-of-many picker, a
 * many-of-many picker, and a single-line text field.
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
 *
 * The text field exists for the same reason. A wizard whose list steps go back
 * on Escape and whose typed steps do not is worse than one that never offered
 * Escape at all, and readline cannot report the key: it is the start of every
 * arrow sequence, so readline waits half a second and then discards it.
 */
import { emitKeypressEvents } from "node:readline";
import chalk from "chalk";

import { column, terminalColumns, truncate } from "./text-layout.js";

export interface SelectChoice<T> {
	value: T;
	label: string;
	/** Dim text after the label, for what the entry covers. */
	hint?: string;
	/** Ticked when a multi-select opens. Ignored by the one-of-many picker. */
	checked?: boolean;
}

/** Lines above a prompt, already styled by the caller. An empty string is a bare rail. */
export type PromptHeading = string | ReadonlyArray<string>;

export interface SelectOptions<T> {
	heading?: PromptHeading;
	choices: ReadonlyArray<SelectChoice<T>>;
	/** Index the cursor opens on, clamped into range. */
	initialIndex?: number;
	/** Prefix on every rendered line, so the picker sits on the presenter's rail. */
	railPrefix?: string;
	/** Word for leaving the menu, shown in the key legend. Omit to hide it. */
	backLabel?: string;
	/** Rows to show at once. Defaults to what the terminal has room for. */
	maxVisible?: number;
	/**
	 * Erase the menu once it is answered, leaving the caller's transcript to say
	 * what was chosen. A wizard that redraws its own answer rows needs this; a
	 * settings menu that returns to the same screen does not.
	 */
	clearOnExit?: boolean;
	input?: NodeJS.ReadStream;
	output?: NodeJS.WriteStream;
}

export type SelectResult<T> = { kind: "selected"; value: T } | { kind: "back" } | { kind: "quit" };

export interface MultiSelectOptions<T> extends Omit<SelectOptions<T>, "initialIndex"> {
	/** Word for accepting the ticked set, shown in the key legend. */
	confirmLabel?: string;
}

export type MultiSelectResult<T> = { kind: "selected"; values: T[] } | { kind: "back" } | { kind: "quit" };

export interface TextPromptOptions {
	heading?: PromptHeading;
	/** Pre-filled and editable. Pressing enter on it returns it unchanged. */
	initial?: string;
	/** Dim line under the field, for what a good answer looks like. */
	hint?: string;
	/** Show dots instead of the characters, for a credential. */
	mask?: boolean;
	/** Reason to refuse the answer and stay on the field, or null to accept it. */
	validate?: (value: string) => string | null;
	railPrefix?: string;
	backLabel?: string;
	clearOnExit?: boolean;
	input?: NodeJS.ReadStream;
	output?: NodeJS.WriteStream;
}

export type TextResult = { kind: "value"; value: string } | { kind: "back" } | { kind: "quit" };

/** Whether the arrow-key prompts can run: both ends must be a real terminal. */
export function canSelect(
	input: NodeJS.ReadStream = process.stdin,
	output: NodeJS.WriteStream = process.stdout,
): boolean {
	return Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === "function" && process.env.TERM !== "dumb");
}

const ESC = "\u001B";
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "gu");

/** Printed width of a styled string, which is not its length once it carries color. */
function printedWidth(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

interface Keypress {
	name?: string;
	ctrl?: boolean;
	meta?: boolean;
	shift?: boolean;
	sequence?: string;
}

/** Lines above the list that are not choices, so the viewport can be sized to what is left. */
function headingLines(heading: PromptHeading | undefined): string[] {
	if (heading === undefined) return [];
	return typeof heading === "string" ? [heading] : [...heading];
}

/**
 * Hold the terminal in raw mode for one prompt, resolving on whatever the key
 * handler decides.
 *
 * An input that stops talking is not an answer. Without the `end`/`close` arms
 * a prompt sits on a closed stdin forever, which is what a recorded terminal
 * session and a `script` capture both produce at the end of their key file.
 */
async function readKeys<R>(
	input: NodeJS.ReadStream,
	output: NodeJS.WriteStream,
	hideCursor: boolean,
	onStart: () => void,
	onKey: (str: string, key: Keypress, finish: (result: R) => void) => void,
	onEnd: () => R,
): Promise<R> {
	const wasRaw = input.isRaw === true;
	emitKeypressEvents(input);
	input.setRawMode(true);
	input.resume();
	if (hideCursor) output.write(CURSOR_HIDE);
	onStart();
	try {
		return await new Promise<R>((resolve) => {
			const finish = (result: R): void => {
				input.off("keypress", handleKey);
				input.off("end", handleEnd);
				input.off("close", handleEnd);
				resolve(result);
			};
			function handleEnd(): void {
				finish(onEnd());
			}
			function handleKey(str: string, key: Keypress): void {
				onKey(str, key ?? {}, finish);
			}
			input.on("keypress", handleKey);
			input.once("end", handleEnd);
			input.once("close", handleEnd);
		});
	} finally {
		if (hideCursor) output.write(CURSOR_SHOW);
		if (!wasRaw) input.setRawMode(false);
		input.pause();
	}
}

/**
 * Draw one frame in place: up over what was drawn, then clear to the end of the
 * screen. A full clear would take the transcript above the prompt with it.
 */
function makeFrame(output: NodeJS.WriteStream): {
	draw: (lines: ReadonlyArray<string>) => void;
	erase: () => void;
	drawn: () => number;
} {
	let drawn = 0;
	return {
		draw(lines) {
			if (drawn > 0) output.write(`${ESC}[${drawn}A${ESC}[0J`);
			output.write(`${lines.join("\n")}\n`);
			drawn = lines.length;
		},
		erase() {
			if (drawn > 0) output.write(`${ESC}[${drawn}A${ESC}[0J`);
			drawn = 0;
		},
		drawn: () => drawn,
	};
}

interface ChoiceRowSpec<T> {
	choices: ReadonlyArray<SelectChoice<T>>;
	rail: string;
	railWidth: number;
	output: NodeJS.WriteStream;
	/** Printed width of everything drawn before the label, cursor included. */
	markerWidth: number;
	marker: (index: number) => string;
}

/** The choice rows for one frame, windowed to what the terminal can hold. */
function choiceRows<T>(spec: ChoiceRowSpec<T>, index: number, windowStart: number, viewport: number): string[] {
	const { choices, rail, railWidth, output, markerWidth, marker } = spec;
	// Measured every frame, so a window resized mid-menu lays out correctly on
	// the next keypress rather than at the width the menu opened on.
	const room = terminalColumns(output) - railWidth;
	const hasHints = choices.some((choice) => choice.hint !== undefined);
	const labelWidth = Math.min(30, Math.max(...choices.map((choice) => choice.label.length)));
	const hintRoom = room - markerWidth - labelWidth - 2;
	const end = Math.min(choices.length, windowStart + viewport);
	const lines: string[] = [];
	if (windowStart > 0) lines.push(`${rail}${chalk.dim(`  ↑ ${windowStart} more`)}`);
	for (let position = windowStart; position < end; position++) {
		const choice = choices[position];
		if (choice === undefined) continue;
		const active = position === index;
		// Widths are computed on the unstyled text and the color applied
		// afterwards. Truncating the styled string counted escape bytes as
		// columns, so the highlighted row, which carries the most escapes, was
		// cut several characters shorter than every other row.
		const aligned = hasHints && hintRoom >= 12;
		const label = aligned ? column(choice.label, labelWidth) : truncate(choice.label, room - markerWidth);
		const hint = aligned && choice.hint !== undefined ? truncate(choice.hint, hintRoom) : "";
		const styledLabel = active ? chalk.cyan.bold(label) : label;
		lines.push(`${rail}${marker(position)}${styledLabel}${hint.length > 0 ? `  ${chalk.dim(hint)}` : ""}`.trimEnd());
	}
	if (end < choices.length) lines.push(`${rail}${chalk.dim(`  ↓ ${choices.length - end} more`)}`);
	return lines;
}

/**
 * Rows to show at once. The list scrolls rather than overflowing, because a
 * frame taller than the terminal cannot be redrawn in place: the cursor-up that
 * opens the next frame lands in the middle of the previous one.
 */
function viewportFor(output: NodeJS.WriteStream, overhead: number, total: number, requested?: number): number {
	if (requested !== undefined) return Math.max(1, Math.min(total, requested));
	const rows = typeof output.rows === "number" && output.rows > 0 ? output.rows : 24;
	return Math.max(3, Math.min(total, rows - overhead));
}

export async function promptSelect<T>(options: SelectOptions<T>): Promise<SelectResult<T>> {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const choices = options.choices;
	if (choices.length === 0) return { kind: "back" };

	const rail = options.railPrefix ?? "";
	// The rail prefix carries color, so its printed length is not its string
	// length; the caller's indentation is two spaces plus one glyph either way.
	const railWidth = 3;
	const head = headingLines(options.heading);
	const frame = makeFrame(output);

	let index = Math.min(Math.max(options.initialIndex ?? 0, 0), choices.length - 1);
	let windowStart = 0;

	const render = (): void => {
		const viewport = viewportFor(output, head.length + 5, choices.length, options.maxVisible);
		if (index < windowStart) windowStart = index;
		else if (index >= windowStart + viewport) windowStart = index - viewport + 1;
		windowStart = Math.max(0, Math.min(windowStart, choices.length - viewport));
		const lines: string[] = [];
		for (const line of head) lines.push(`${rail}${line}`.trimEnd());
		if (head.length > 0) lines.push(rail.trimEnd());
		lines.push(
			...choiceRows(
				{
					choices,
					rail,
					railWidth,
					output,
					markerWidth: 2,
					marker: (position) => `${position === index ? chalk.cyan("❯") : " "} `,
				},
				index,
				windowStart,
				viewport,
			),
		);
		lines.push(rail.trimEnd());
		// On the top screen escape and q do the same thing, and listing both as
		// "quit" reads as two different exits.
		const legend = ["↑/↓ move", "enter select"];
		if (options.backLabel !== undefined && options.backLabel !== "quit") legend.push(`esc ${options.backLabel}`);
		legend.push(options.backLabel === "quit" ? "esc or q quit" : "q quit");
		lines.push(`${rail}${chalk.dim(legend.join(" · "))}`);
		frame.draw(lines);
	};

	const result = await readKeys<SelectResult<T>>(
		input,
		output,
		true,
		render,
		(_str, key, finish) => {
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
				case "pageup":
					index = Math.max(0, index - 5);
					render();
					return;
				case "pagedown":
					index = Math.min(choices.length - 1, index + 5);
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
		},
		() => ({ kind: "quit" }),
	);
	if (options.clearOnExit) frame.erase();
	return result;
}

/**
 * Tick any number of entries and confirm once.
 *
 * This is what replaces a run of `[y/N]` questions, one per detected thing. The
 * questions were identical apart from a name, and asking them in sequence hid
 * how many there were and gave no way to change the first answer after seeing
 * the last.
 */
export async function promptMultiSelect<T>(options: MultiSelectOptions<T>): Promise<MultiSelectResult<T>> {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const choices = options.choices;
	if (choices.length === 0) return { kind: "selected", values: [] };

	const rail = options.railPrefix ?? "";
	const railWidth = 3;
	const head = headingLines(options.heading);
	const frame = makeFrame(output);
	const checked = choices.map((choice) => choice.checked === true);

	let index = 0;
	let windowStart = 0;

	const render = (): void => {
		const viewport = viewportFor(output, head.length + 5, choices.length, options.maxVisible);
		if (index < windowStart) windowStart = index;
		else if (index >= windowStart + viewport) windowStart = index - viewport + 1;
		windowStart = Math.max(0, Math.min(windowStart, choices.length - viewport));
		const lines: string[] = [];
		for (const line of head) lines.push(`${rail}${line}`.trimEnd());
		if (head.length > 0) lines.push(rail.trimEnd());
		lines.push(
			...choiceRows(
				{
					choices,
					rail,
					railWidth,
					output,
					markerWidth: 4,
					marker: (position) => {
						const cursor = position === index ? chalk.cyan("❯") : " ";
						const box = checked[position] === true ? chalk.green("◉") : chalk.dim("○");
						return `${cursor} ${box} `;
					},
				},
				index,
				windowStart,
				viewport,
			),
		);
		lines.push(rail.trimEnd());
		const legend = ["↑/↓ move", "space toggle", `enter ${options.confirmLabel ?? "confirm"}`];
		if (options.backLabel !== undefined) legend.push(`esc ${options.backLabel}`);
		lines.push(`${rail}${chalk.dim(legend.join(" · "))}`);
		frame.draw(lines);
	};

	const result = await readKeys<MultiSelectResult<T>>(
		input,
		output,
		true,
		render,
		(_str, key, finish) => {
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
				case "space":
					checked[index] = checked[index] !== true;
					render();
					return;
				case "a":
					// One key for "all of them", because the alternative on a list of
					// six is six presses of space with nothing telling you that.
					{
						const turnOn = checked.some((value) => !value);
						checked.fill(turnOn);
					}
					render();
					return;
				case "return":
				case "enter":
					finish({
						kind: "selected",
						values: choices.filter((_choice, position) => checked[position] === true).map((choice) => choice.value),
					});
					return;
				case "escape":
				case "left":
					finish({ kind: "back" });
					return;
				default: {
					const digit = Number.parseInt(key.name ?? "", 10);
					if (Number.isInteger(digit) && digit >= 1 && digit <= choices.length) {
						index = digit - 1;
						checked[index] = checked[index] !== true;
						render();
					}
				}
			}
		},
		() => ({ kind: "quit" }),
	);
	if (options.clearOnExit) frame.erase();
	return result;
}

/** Printable text from one keypress, including a paste that arrives whole. */
function typedText(str: string, key: Keypress): string | null {
	if (key.ctrl === true || key.meta === true) return null;
	if (typeof str !== "string" || str.length === 0) return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to reject them
	if (/[\u0000-\u001F\u007F]/u.test(str)) return null;
	return str;
}

/**
 * One line of text with a default already in the field, Escape to go back.
 *
 * The terminal cursor is left visible and moved onto the field rather than
 * drawn as an inverted cell: under NO_COLOR an inverted cell renders as nothing
 * at all, and a text field with no cursor is a field you cannot tell is
 * focused.
 */
export async function promptText(options: TextPromptOptions): Promise<TextResult> {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const rail = options.railPrefix ?? "";
	const railWidth = printedWidth(rail);
	const head = headingLines(options.heading);
	const frame = makeFrame(output);

	let value = options.initial ?? "";
	let caret = value.length;
	let error: string | null = null;
	/** Lines drawn below the field, so the cursor can be put back on it. */
	let below = 0;
	/** Whether the cursor is currently parked on the field rather than after the frame. */
	let parked = false;

	const render = (): void => {
		if (parked) {
			output.write(`\r${below > 0 ? `${ESC}[${below}B` : ""}`);
			parked = false;
		}
		const room = Math.max(8, terminalColumns(output) - railWidth - 2);
		const shown = options.mask === true ? "•".repeat(value.length) : value;
		const lines: string[] = [];
		for (const line of head) lines.push(`${rail}${line}`.trimEnd());
		if (head.length > 0) lines.push(rail.trimEnd());
		const fieldIndex = lines.length;
		lines.push(`${rail}${chalk.cyan("❯")} ${truncate(shown, room)}`);
		if (error !== null) lines.push(`${rail}${chalk.yellow(truncate(error, room))}`);
		else if (options.hint !== undefined) lines.push(`${rail}${chalk.dim(truncate(options.hint, room))}`);
		lines.push(rail.trimEnd());
		const legend = ["enter accept"];
		if (options.backLabel !== undefined) legend.push(`esc ${options.backLabel}`);
		legend.push("ctrl-c quit");
		lines.push(`${rail}${chalk.dim(legend.join(" · "))}`);
		frame.draw(lines);
		below = lines.length - fieldIndex;
		// Park the terminal's own cursor on the field, at the edit position.
		const columnOffset = railWidth + 2 + Math.min(caret, room);
		output.write(`${ESC}[${below}A\r${columnOffset > 0 ? `${ESC}[${columnOffset}C` : ""}`);
		parked = true;
	};

	const unpark = (): void => {
		if (!parked) return;
		output.write(`\r${below > 0 ? `${ESC}[${below}B` : ""}`);
		parked = false;
	};

	const result = await readKeys<TextResult>(
		input,
		output,
		false,
		render,
		(str, key, finish) => {
			if (key.ctrl === true) {
				switch (key.name) {
					case "c":
					case "d":
						unpark();
						finish({ kind: "quit" });
						return;
					case "a":
						caret = 0;
						render();
						return;
					case "e":
						caret = value.length;
						render();
						return;
					case "u":
						value = value.slice(caret);
						caret = 0;
						render();
						return;
					case "k":
						value = value.slice(0, caret);
						render();
						return;
					case "w": {
						const head_ = value.slice(0, caret).replace(/\S+\s*$/u, "");
						value = head_ + value.slice(caret);
						caret = head_.length;
						render();
						return;
					}
					default:
						return;
				}
			}
			switch (key.name) {
				case "escape":
					unpark();
					finish({ kind: "back" });
					return;
				case "return":
				case "enter": {
					const answer = value.trim();
					const reason = options.validate?.(answer) ?? null;
					if (reason !== null) {
						error = reason;
						render();
						return;
					}
					unpark();
					finish({ kind: "value", value: answer });
					return;
				}
				case "backspace":
					if (caret > 0) {
						value = value.slice(0, caret - 1) + value.slice(caret);
						caret -= 1;
						error = null;
						render();
					}
					return;
				case "delete":
					if (caret < value.length) {
						value = value.slice(0, caret) + value.slice(caret + 1);
						error = null;
						render();
					}
					return;
				case "left":
					caret = Math.max(0, caret - 1);
					render();
					return;
				case "right":
					caret = Math.min(value.length, caret + 1);
					render();
					return;
				case "home":
					caret = 0;
					render();
					return;
				case "end":
					caret = value.length;
					render();
					return;
				default: {
					const typed = typedText(str, key);
					if (typed === null) return;
					value = value.slice(0, caret) + typed + value.slice(caret);
					caret += typed.length;
					error = null;
					render();
				}
			}
		},
		() => {
			unpark();
			return { kind: "quit" };
		},
	);
	if (options.clearOnExit) frame.erase();
	return result;
}
