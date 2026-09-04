import { ok, strictEqual } from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { canSelect, promptSelect, type SelectResult } from "../../src/cli/select.js";

/**
 * A pair of streams shaped like a terminal, so the picker takes its interactive
 * path without one being attached. `setRawMode` is what raw input needs and what
 * `canSelect` looks for; a PassThrough has neither, so both are supplied here.
 */
function fakeTerminal(columns = 100): {
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
	Object.assign(output, { isTTY: true, columns });
	output.on("data", (chunk: Buffer) => {
		rendered += chunk.toString("utf8");
	});

	return { input, output, rendered: () => rendered, rawModeCalls };
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
});
