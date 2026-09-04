import { ok, strictEqual } from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
	canSelect,
	type MultiSelectResult,
	promptMultiSelect,
	promptSelect,
	promptText,
	type SelectResult,
	type TextResult,
} from "../../src/cli/select.js";

/**
 * A pair of streams shaped like a terminal, so the picker takes its interactive
 * path without one being attached. `setRawMode` is what raw input needs and what
 * `canSelect` looks for; a PassThrough has neither, so both are supplied here.
 */
function fakeTerminal(
	columns = 100,
	rows = 40,
): {
	input: NodeJS.ReadStream;
	output: NodeJS.WriteStream;
	rendered: () => string;
	rawModeCalls: boolean[];
} {
	const input = new PassThrough() as unknown as NodeJS.ReadStream;
	const output = new PassThrough() as unknown as NodeJS.WriteStream;
	const rawModeCalls: boolean[] = [];
	let rendered = "";

	Object.assign(input, {
		isTTY: true,
		setRawMode: (value: boolean) => {
			rawModeCalls.push(value);
			return input;
		},
	});
	Object.assign(output, { isTTY: true, columns, rows });
	output.on("data", (chunk: Buffer) => {
		rendered += chunk.toString("utf8");
	});

	return { input, output, rendered: () => rendered, rawModeCalls };
}

/** Feed keystrokes to a prompt that is already listening, and await its answer. */
async function feed<R>(terminal: ReturnType<typeof fakeTerminal>, pending: Promise<R>, keys: ReadonlyArray<string>) {
	await new Promise((resolve) => setImmediate(resolve));
	for (const key of keys) {
		terminal.input.push(key);
		await new Promise((resolve) => setImmediate(resolve));
	}
	return pending;
}

/** The last frame a prompt drew, with the cursor and clear escapes removed. */
function visibleLines(terminal: ReturnType<typeof fakeTerminal>): string[] {
	return terminal
		.rendered()
		.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "gu"), "")
		.split("\n")
		.filter((line) => line.startsWith("|  "));
}

const CHOICES = [
	{ value: "targets", label: "Targets & Auth", hint: "providers, endpoints, credentials" },
	{ value: "models", label: "Models & Thinking", hint: "default model, thinking level" },
	{ value: "fleet", label: "Fleet", hint: "concurrency, retries" },
];

/** Feed keystrokes once the picker is listening, and await its answer. */
async function drive(
	terminal: ReturnType<typeof fakeTerminal>,
	keys: ReadonlyArray<string>,
	backLabel = "back",
): Promise<SelectResult<string>> {
	const pending = promptSelect({
		choices: CHOICES,
		railPrefix: "|  ",
		backLabel,
		input: terminal.input,
		output: terminal.output,
	});
	await new Promise((resolve) => setImmediate(resolve));
	for (const key of keys) {
		terminal.input.push(key);
		await new Promise((resolve) => setImmediate(resolve));
	}
	return pending;
}

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;
const ENTER = "\r";
const ESCAPE = ESC;
const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(127);

describe("contracts/select-keypress", () => {
	it("refuses the interactive path unless both ends are a terminal", () => {
		const terminal = fakeTerminal();
		strictEqual(canSelect(terminal.input, terminal.output), true);

		const pipe = new PassThrough() as unknown as NodeJS.ReadStream;
		strictEqual(canSelect(pipe, terminal.output), false, "a piped stdin has no raw mode");
		strictEqual(canSelect(terminal.input, new PassThrough() as unknown as NodeJS.WriteStream), false);
	});

	it("moves with the arrow keys and selects with enter", async () => {
		const terminal = fakeTerminal();
		const result = await drive(terminal, [DOWN, DOWN, UP, ENTER]);
		strictEqual(result.kind, "selected");
		strictEqual(result.kind === "selected" ? result.value : null, "models");
	});

	it("wraps around both ends of the list", async () => {
		const terminal = fakeTerminal();
		const result = await drive(terminal, [UP, ENTER]);
		strictEqual(result.kind === "selected" ? result.value : null, "fleet", "up from the first entry lands on the last");
	});

	it("leaves the screen on escape", async () => {
		const terminal = fakeTerminal();
		strictEqual((await drive(terminal, [ESCAPE])).kind, "back");
	});

	it("quits on q and on ctrl-c, which raw mode does not turn into a signal", async () => {
		strictEqual((await drive(fakeTerminal(), ["q"])).kind, "quit");
		strictEqual((await drive(fakeTerminal(), [CTRL_C])).kind, "quit");
	});

	it("treats a closed input as a quit rather than waiting forever", async () => {
		const terminal = fakeTerminal();
		const pending = promptSelect({
			choices: CHOICES,
			input: terminal.input,
			output: terminal.output,
		});
		await new Promise((resolve) => setImmediate(resolve));
		terminal.input.push(null);
		strictEqual((await pending).kind, "quit");
	});

	it("takes a digit as a direct pick, so the numbered habit still works", async () => {
		const terminal = fakeTerminal();
		const result = await drive(terminal, ["3"]);
		strictEqual(result.kind === "selected" ? result.value : null, "fleet");
	});

	it("restores raw mode and the cursor on every exit", async () => {
		const terminal = fakeTerminal();
		await drive(terminal, [ESCAPE]);
		strictEqual(terminal.rawModeCalls[0], true, "raw mode is entered to read single keys");
		strictEqual(terminal.rawModeCalls.at(-1), false, "and left before returning");
		ok(terminal.rendered().includes(`${ESC}[?25h`), "the cursor is shown again");
	});

	it("fits every row inside a narrow terminal, highlighted rows included", async () => {
		const terminal = fakeTerminal(60);
		await drive(terminal, [ESCAPE]);

		const lines = terminal
			.rendered()
			.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "gu"), "")
			.split("\n")
			.filter((line) => line.startsWith("|  "));
		ok(lines.length >= CHOICES.length, "every choice is drawn");
		for (const line of lines) ok(line.length <= 60, `row exceeded the terminal: ${JSON.stringify(line)}`);

		// The highlighted row carries the most escape bytes. Truncating the styled
		// string measured those as columns and cut it short, so it is the row that
		// has to be checked for the same width as the rest.
		const labelColumns = new Set(lines.filter((line) => line.includes("&")).map((line) => line.indexOf("&")));
		strictEqual(labelColumns.size <= 2, true, "labels stay in one column whether or not a row is highlighted");
	});

	it("scrolls a list longer than the viewport instead of overflowing the terminal", async () => {
		// A model list from a real server runs to dozens of ids. Drawing all of
		// them makes the frame taller than the screen, and the cursor-up that
		// opens the next frame then lands in the middle of the previous one.
		const terminal = fakeTerminal(100, 40);
		const many = Array.from({ length: 20 }, (_value, index) => ({
			value: `model-${index}`,
			label: `model-${index}`,
		}));
		const pending = promptSelect({
			choices: many,
			railPrefix: "|  ",
			maxVisible: 5,
			input: terminal.input,
			output: terminal.output,
		});
		const result = await feed(terminal, pending, [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER]);
		strictEqual(result.kind === "selected" ? result.value : null, "model-6");

		const lines = visibleLines(terminal);
		ok(
			lines.some((line) => line.includes("↓ 15 more")),
			"the first frame says how many rows are below the window",
		);
		ok(
			lines.some((line) => line.includes("↑ 2 more")),
			"the scrolled frame says how many rows are above it",
		);
		const rows = lines.filter((line) => /model-\d+/u.test(line) && !line.includes("more"));
		for (const row of rows) ok(row.length <= 100, `row exceeded the terminal: ${JSON.stringify(row)}`);
	});

	it("erases its frame on exit when the caller owns the transcript", async () => {
		const terminal = fakeTerminal();
		const pending = promptSelect({
			choices: CHOICES,
			railPrefix: "|  ",
			clearOnExit: true,
			input: terminal.input,
			output: terminal.output,
		});
		await feed(terminal, pending, [ENTER]);
		// The last thing written is the erase, not another frame: a wizard redraws
		// its own answer row in place of the menu it just answered.
		ok(terminal.rendered().endsWith(`${ESC}[0J`), `frame not erased:\n${JSON.stringify(terminal.rendered().slice(-40))}`);
	});
});

describe("contracts/select-keypress: text", () => {
	function text(
		terminal: ReturnType<typeof fakeTerminal>,
		options: Partial<Parameters<typeof promptText>[0]> = {},
	): Promise<TextResult> {
		return promptText({
			heading: ["", "Target id"],
			initial: "llamacpp",
			railPrefix: "|  ",
			backLabel: "back",
			input: terminal.input,
			output: terminal.output,
			...options,
		});
	}

	it("returns the pre-filled default when the answer is just enter", async () => {
		const terminal = fakeTerminal();
		const result = await feed(terminal, text(terminal), [ENTER]);
		strictEqual(result.kind, "value");
		strictEqual(result.kind === "value" ? result.value : null, "llamacpp");
		ok(
			visibleLines(terminal).some((line) => line.includes("llamacpp")),
			"the default is shown in the field, not hidden behind a [bracket]",
		);
	});

	it("edits the default rather than making the user retype it", async () => {
		const terminal = fakeTerminal();
		// Eight backspaces clear "llamacpp", then the real id is typed over it.
		const result = await feed(terminal, text(terminal), [
			...Array.from({ length: 8 }, () => BACKSPACE),
			"m",
			"i",
			"n",
			"i",
			ENTER,
		]);
		strictEqual(result.kind === "value" ? result.value : null, "mini");
	});

	it("goes back on escape and quits on ctrl-c, which readline cannot report", async () => {
		const closed = fakeTerminal();
		const pending = text(closed);
		await new Promise((resolve) => setImmediate(resolve));
		closed.input.push(null);
		strictEqual((await pending).kind, "quit", "a closed input is not an answer");
		const back = fakeTerminal();
		strictEqual((await feed(back, text(back), [ESCAPE])).kind, "back");
		const quit = fakeTerminal();
		strictEqual((await feed(quit, text(quit), [CTRL_C])).kind, "quit");
	});

	it("refuses an answer its caller rejects, and says why on the rail", async () => {
		const terminal = fakeTerminal();
		const result = await feed(
			terminal,
			text(terminal, {
				initial: "",
				validate: (value) => (value.length === 0 ? "a target id is required" : null),
			}),
			[ENTER, "m", "i", "n", "i", ENTER],
		);
		strictEqual(result.kind === "value" ? result.value : null, "mini");
		ok(
			visibleLines(terminal).some((line) => line.includes("a target id is required")),
			"the reason belongs on the rail, not on stderr",
		);
	});

	it("masks a credential so it is not left on the screen", async () => {
		const terminal = fakeTerminal();
		const result = await feed(terminal, text(terminal, { initial: "", mask: true }), ["s", "k", "1", ENTER]);
		strictEqual(result.kind === "value" ? result.value : null, "sk1");
		ok(!terminal.rendered().includes("sk1"), "the typed key must never be drawn");
		ok(
			visibleLines(terminal).some((line) => line.includes("•••")),
			"but its length is shown, so the field reads as filled",
		);
	});
});

describe("contracts/select-keypress: multi-select", () => {
	const PEERS = [
		{ value: "codex", label: "Codex", hint: "npx @agentclientprotocol/codex-acp" },
		{ value: "opencode", label: "OpenCode", hint: "opencode acp" },
		{ value: "gemini", label: "Gemini CLI", hint: "gemini --experimental-acp" },
	];

	function peers(terminal: ReturnType<typeof fakeTerminal>): Promise<MultiSelectResult<string>> {
		return promptMultiSelect({
			choices: PEERS,
			railPrefix: "|  ",
			backLabel: "back",
			input: terminal.input,
			output: terminal.output,
		});
	}

	it("ticks with space and confirms once, in place of one y/N question per agent", async () => {
		const terminal = fakeTerminal();
		const result = await feed(terminal, peers(terminal), [" ", DOWN, DOWN, " ", ENTER]);
		strictEqual(result.kind, "selected");
		if (result.kind === "selected") strictEqual(result.values.join(","), "codex,gemini");
	});

	it("confirms nothing when nothing was ticked, which is a real answer", async () => {
		const terminal = fakeTerminal();
		const result = await feed(terminal, peers(terminal), [ENTER]);
		strictEqual(result.kind === "selected" ? result.values.length : -1, 0);
	});

	it("ticks every entry on a, so a long list is not six presses of space", async () => {
		const terminal = fakeTerminal();
		const result = await feed(terminal, peers(terminal), ["a", ENTER]);
		strictEqual(result.kind === "selected" ? result.values.join(",") : null, "codex,opencode,gemini");
	});

	it("leaves the step on escape, so the wizard can go back from it", async () => {
		const terminal = fakeTerminal();
		strictEqual((await feed(terminal, peers(terminal), [ESCAPE])).kind, "back");
	});
});
