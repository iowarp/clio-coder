import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Markdown } from "../../src/engine/tui.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { codeInk } from "../../src/interactive/renderers/code-ink.js";
import { clioTheme, markdownTheme } from "../../src/interactive/theme/index.js";

const theme = clioTheme();

describe("code ink", () => {
	it("maps a ts fence onto the closed four-token vocabulary and leaves identifiers plain", () => {
		const lines = codeInk("ts", ['const label = "hi"; // note', "let n = 42;"]);
		strictEqual(
			lines[0],
			`${theme.fg("reason", "const")} label = ${theme.fg("success", '"hi"')}; ${theme.fg("dim", "// note")}`,
			"keywords take reason, strings success, comments dim, identifiers stay plain",
		);
		strictEqual(
			lines[1],
			`${theme.fg("reason", "let")} n = ${theme.fg("info", "42")};`,
			"numeric literals take info and punctuation stays plain",
		);
	});

	it("leaves types, function names, and member accesses plain rather than guessing", () => {
		const lines = codeInk("ts", ["const value: MyType = compute(input);", "token.type = promise.catch;"]);
		strictEqual(
			lines[0],
			`${theme.fg("reason", "const")} value: MyType = compute(input);`,
			"type annotations and call targets carry no color",
		);
		strictEqual(lines[1], "token.type = promise.catch;", "keyword-shaped member names stay plain after a dot");
	});

	it("carries a block comment across lines so every spanned line stays dim", () => {
		const lines = codeInk("ts", ["/* one", "two", "three */ const x = 1;"]);
		strictEqual(lines[0], theme.fg("dim", "/* one"));
		strictEqual(lines[1], theme.fg("dim", "two"));
		strictEqual(
			lines[2],
			`${theme.fg("dim", "three */")} ${theme.fg("reason", "const")} x = ${theme.fg("info", "1")};`,
			"the closing line splits into comment tail and freshly lexed code",
		);
	});

	it("carries a template literal across lines as one string", () => {
		const lines = codeInk("ts", ["const s = `first", "second`;"]);
		strictEqual(lines[0], `${theme.fg("reason", "const")} s = ${theme.fg("success", "`first")}`);
		strictEqual(lines[1], `${theme.fg("success", "second`")};`);
	});

	it("colors diff fences by what a line does, not what it lexes as", () => {
		const lines = codeInk("diff", ["--- a/f.ts", "+++ b/f.ts", "@@ -1,2 +1,2 @@", " context", "-old", "+new"]);
		strictEqual(lines[0], "--- a/f.ts", "file headers are neither added nor removed and stay plain");
		strictEqual(lines[1], "+++ b/f.ts", "file headers are neither added nor removed and stay plain");
		strictEqual(lines[2], theme.fg("dim", "@@ -1,2 +1,2 @@"), "hunk headers read dim");
		strictEqual(lines[3], " context", "context lines stay plain");
		strictEqual(lines[4], theme.fg("error", "-old"), "removed lines read error");
		strictEqual(lines[5], theme.fg("success", "+new"), "added lines read success");
	});

	it("dims the leading shell prompt and hash comments in bash fences", () => {
		const lines = codeInk("bash", ["$ npm run ci # gate", 'if [ -f "x" ]; then']);
		strictEqual(
			lines[0],
			`${theme.fg("dim", "$")} npm run ci ${theme.fg("dim", "# gate")}`,
			"the $ prompt and the trailing comment read dim, the command stays plain",
		);
		strictEqual(
			lines[1],
			`${theme.fg("reason", "if")} [ -f ${theme.fg("success", '"x"')} ]; ${theme.fg("reason", "then")}`,
			"bash reserved words take reason and quoted strings success",
		);
	});

	it("treats json keys and values as the strings and literals they are", () => {
		const lines = codeInk("json", ['{ "n": 42, "ok": true }']);
		strictEqual(
			lines[0],
			`{ ${theme.fg("success", '"n"')}: ${theme.fg("info", "42")}, ${theme.fg("success", '"ok"')}: ${theme.fg("reason", "true")} }`,
		);
	});

	it("returns unknown-language and untagged fences untouched", () => {
		const raw = ["const x = 1;", "# not a comment here"];
		deepStrictEqual(codeInk("weird", raw), raw);
		deepStrictEqual(codeInk(undefined, raw), raw);
	});

	it("renders an unknown-language fence byte-identical to the hookless plain rendering", () => {
		const text = ["```weird", "const x = 1;", "```"].join("\n");
		const inked = new Markdown(
			text,
			0,
			0,
			markdownTheme(theme, (code, lang) => codeInk(lang, code.split("\n"))),
		);
		const plain = new Markdown(text, 0, 0, markdownTheme(theme));
		deepStrictEqual(inked.render(80), plain.render(80));
	});

	it("reaches the chat transcript through the markdown highlight hook", () => {
		const panel = createChatPanel();
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "Fix:\n\n```ts\nconst x = 1;\n```" }] },
		} as ChatLoopEvent);
		const rendered = panel.render(80).join("\n");
		ok(rendered.includes(theme.fg("reason", "const")), "a ts fence in a finalized turn carries code ink");
		ok(rendered.includes(theme.fg("info", "1")), "numeric literals in the fence carry info");
	});
});
