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
// The prefix gives the reference a head to cut first, so its one frame draws the fence whole.
const whole = (text: string, width: number, bareCodeFences = false): string[] => {
	const view = panel(bareCodeFences);
	view.applyEvent({ type: "text_delta", delta: text } as never);
	return view.render(width);
};

afterEach(() => setPaletteSkin(undefined));

for (const bareCodeFences of [false, true]) {
	test(`every frame of a streamed open fence matches the fence drawn whole${bareCodeFences ? " (export)" : ""}`, () => {
		const text = `Intro.\n\n${FENCE}\n`;
		for (const width of [24, 80]) {
			const streamed = panel(bareCodeFences);
			for (let at = 0; at < text.length; at += 3) {
				streamed.applyEvent({ type: "text_delta", delta: text.slice(at, at + 3) } as never);
				const end = Math.min(at + 3, text.length);
				deepStrictEqual(streamed.render(width), whole(text.slice(0, end), width, bareCodeFences), `at ${end}`);
			}
		}
	});
}

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
	deepStrictEqual(after, whole(text, 80));
});
