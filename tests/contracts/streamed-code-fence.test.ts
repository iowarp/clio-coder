import { deepStrictEqual, notDeepStrictEqual, ok } from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Lexer } from "marked";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { setPaletteSkin } from "../../src/interactive/theme/tokens.js";

// A streamed answer that is one long open code fence draws each complete line once and only the line still open on
// each delta; every frame must read as the same text rendered whole. Lines here carry lexer state across line ends.
const FENCE = [
	"```ts",
	"/* a block comment",
	"   that spans lines */ const greeting = `hello",
	// A template literal's placeholder, which the lint reads as a mistake inside a plain string.
	`${"$"}{name} and more\`;`,
	"",
	"function add(a: number, b: number): number {",
	"\treturn a + b; // a trailing comment",
	"}",
	`const long = "${"word ".repeat(30)}";`,
	"",
	"",
	"export { add };",
].join("\n");

const panel = (bareCodeFences = false) => {
	const view = createChatPanel({ now: () => 1_000, bareCodeFences });
	view.appendUser("Q");
	view.applyEvent({ type: "agent_start" } as never);
	return view;
};
// The reference is the same text finished, so no streamed path draws both sides of a comparison.
const whole = (text: string, width: number, bareCodeFences = false): string[] => {
	const view = panel(bareCodeFences);
	const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
	view.applyEvent({ type: "message_end", message } as never);
	return view.render(width);
};
// The stream holds its last character back until the next one shows how it joins, so a frame of `text` reads as all
// of it but that character finished.
const frame = (text: string, width: number, bareCodeFences = false): string[] =>
	whole(text.slice(0, -1), width, bareCodeFences);

afterEach(() => setPaletteSkin(undefined));

for (const bareCodeFences of [false, true]) {
	test(`every frame of a streamed open fence matches the fence drawn whole${bareCodeFences ? " (export)" : ""}`, () => {
		const text = `Intro.\n\n${FENCE}\n`;
		for (const width of [24, 80]) {
			const streamed = panel(bareCodeFences);
			for (let at = 0; at < text.length; at += 3) {
				streamed.applyEvent({ type: "text_delta", delta: text.slice(at, at + 3) } as never);
				const end = Math.min(at + 3, text.length);
				deepStrictEqual(streamed.render(width), frame(text.slice(0, end), width, bareCodeFences), `at ${end}`);
			}
		}
	});
}

// Lines a fence holds that look like fence markers: each piece the open fence draws on its own must read them as the
// whole fence does.
const MARKER_LINES = {
	// A template literal ending in a lone backtick line, which Pi trims only as the last line of a code block.
	template: "```js\nconst t = `\n  line one\n`\nconsole.log(t);\nconst u = `\nx\n`\n",
	tildes: "~~~~\na\n~~\n~~~\nb\n",
	// Closing lines that close the fence for Pi: extra marker characters, or a tab indent of three spaces.
	"long closer": "```ts\nconst a = 1;\n```~~\nAfter the fence.\n",
	"mixed closer": "~~~ts\na = 1\n~~~`\nAfter the fence.\n",
	"tab closer": "```ts\na = 1\n\t```\nAfter the fence.\n",
	"crlf closer": "```ts\nconst a = 1;\r\nconst b = 2;\r\n```\r\nAfter the fence.\r\n",
	// A shorter fence line inside the fence ends inline math's own fence state, so `$a+b$` is set as math.
	"nested fence math": "````markdown\n```python\nprint(1)\n$a+b$ here\nmore\n```\n````\nAfter $c$.\n",
};

for (const [name, fence] of Object.entries(MARKER_LINES)) {
	test(`every frame of a streamed fence with ${name} lines matches the text drawn whole`, () => {
		const text = `Intro.\n\n${fence}`;
		for (const bareCodeFences of [false, true]) {
			for (const width of [23, 80]) {
				const streamed = panel(bareCodeFences);
				for (let at = 0; at < text.length; at += 2) {
					streamed.applyEvent({ type: "text_delta", delta: text.slice(at, at + 2) } as never);
					const end = Math.min(at + 2, text.length);
					deepStrictEqual(streamed.render(width), frame(text.slice(0, end), width, bareCodeFences), `at ${end}`);
				}
				const done = panel(bareCodeFences);
				const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
				for (const view of [streamed, done]) view.applyEvent({ type: "message_end", message } as never);
				deepStrictEqual(streamed.render(width), done.render(width), "finished");
			}
		}
	});
}

// A `$$` line whose body does not read as math yet is a paragraph, and the block after it is a block of its own,
// until the closing line makes one math block of them all.
const PENDING_MATH = {
	"a fence": "Intro.\n\n$$\n```x\n$$\n",
	"a heading": "Intro.\n\n$$\n# head\n$$\n",
	"blank lines": "Intro.\n\n$$\n\nfoo\n\n$$\n\nAfter.\n",
	"a heading inside a paragraph": "Para\n$$\nfoo\n# H\n$$\n\nAfter.\n",
};

for (const [name, text] of Object.entries(PENDING_MATH)) {
	test(`every frame of streamed display math opened before ${name} matches the text drawn whole`, () => {
		for (const width of [23, 80]) {
			const streamed = panel();
			for (let at = 0; at < text.length; at += 1) {
				streamed.applyEvent({ type: "text_delta", delta: text.slice(at, at + 1) } as never);
				deepStrictEqual(streamed.render(width), frame(text.slice(0, at + 1), width), `at ${at + 1}`);
			}
			const done = panel();
			const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
			for (const view of [streamed, done]) view.applyEvent({ type: "message_end", message } as never);
			deepStrictEqual(streamed.render(width), done.render(width), "finished");
		}
	});
}

test("every frame of seeded fences of marker, math and wrapped lines matches the text drawn whole", () => {
	// A fixed seed keeps the cases the same on every run; each draws an opening line and up to ten lines from the pool.
	// The generator's low bits cycle with a short period, so a pick scales its high bits to the list.
	let seed = 991;
	const pick = <T>(items: readonly T[]): T => {
		seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
		return items[Math.floor((seed / 0x80000000) * items.length)] as T;
	};
	const widths = [23, 31, 47, 64, 80];
	const steps = [1, 2, 3, 4];
	const openers = ["```ts", "````md", "~~~", "~~~~js", "```", "```js title", "```python", "$$", "\\["];
	const pool = ["`", "``", "~", "~~", "~~~", "```", "````", "```~", "~~~`"];
	pool.push("\t```", "  ```", "    ```", "```py", "```x");
	pool.push("~~~~", "$x$ here", "a $b$ c", "$$", "const t = `", "`;", "x\r", "", "", "word ".repeat(9), "/* c", "*/ d");
	pool.push("\tindented", "- item", "# head");
	for (let n = 0; n < 160; n += 1) {
		const lines = [pick(openers)];
		for (let count = pick([2, 4, 6, 8, 10]); count > 0; count -= 1) lines.push(pick(pool));
		const text = `Intro.\n\n${lines.join("\n")}${pick(["", "\n"])}${pick(["", "", "After $q$ text.\n"])}`;
		// Every export, width and step combination runs four times, each on a different text.
		const bareCodeFences = n % 2 === 1;
		const width = widths[Math.floor(n / 2) % widths.length] as number;
		const step = steps[Math.floor(n / 10) % steps.length] as number;
		const streamed = panel(bareCodeFences);
		for (let at = 0; at < text.length; at += step) {
			streamed.applyEvent({ type: "text_delta", delta: text.slice(at, at + step) } as never);
			const end = Math.min(at + step, text.length);
			const label = `${JSON.stringify(text)} at ${end}, width ${width}`;
			deepStrictEqual(streamed.render(width), frame(text.slice(0, end), width, bareCodeFences), label);
		}
		const done = panel(bareCodeFences);
		const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
		for (const view of [streamed, done]) view.applyEvent({ type: "message_end", message } as never);
		deepStrictEqual(streamed.render(width), done.render(width), `${JSON.stringify(text)} finished`);
	}
});

test("a delta to a long open fence lexes only the line still open", () => {
	const streamed = panel();
	streamed.applyEvent({ type: "text_delta", delta: "Intro.\n\n```ts\n" } as never);
	streamed.render(80);
	for (let line = 0; line < 400; line += 1) {
		streamed.applyEvent({ type: "text_delta", delta: `const value${line} = compute(${line});\n` } as never);
		streamed.render(80);
	}
	const lex = Lexer.prototype.lex;
	let lexed = 0;
	Lexer.prototype.lex = function (this: Lexer, source: string) {
		lexed += source.length;
		return lex.call(this, source);
	};
	try {
		streamed.applyEvent({ type: "text_delta", delta: "const last = 1;" } as never);
		streamed.render(80);
		streamed.applyEvent({ type: "text_delta", delta: "\n" } as never);
		streamed.render(80);
	} finally {
		Lexer.prototype.lex = lex;
	}
	// The fence holds about 12,000 characters; two deltas relex a line or two each, not the fence.
	ok(lexed < 200, `lexed ${lexed} characters`);
});

test("a style change redraws the settled lines of an open fence", () => {
	const text = `Intro.\n\n${FENCE}\n`;
	const streamed = panel();
	for (let at = 0; at < text.length; at += 5) {
		streamed.applyEvent({ type: "text_delta", delta: text.slice(at, at + 5) } as never);
		streamed.render(80);
	}
	const before = streamed.render(80);
	setPaletteSkin({ orangeFocal: { dark: "#ff0000", light: "#ff0000" } });
	const after = streamed.render(80);
	notDeepStrictEqual(after, before);
	deepStrictEqual(after, frame(text, 80));
});
