import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { renderProjectContextFragment } from "../../src/domains/context/clio-md.js";
import type { ProjectPromptContext } from "../../src/domains/context/contract.js";
import { sha256 } from "../../src/domains/prompts/hash.js";
import { selectProjectPreload } from "../../src/domains/prompts/preload.js";
import { isProjectPreloadClass } from "../../src/domains/session/prompt-manifest.js";

function context(sources: string[], supportFragments = ["<project-type>unknown</project-type>"]): ProjectPromptContext {
	const handbookSources = sources.map((source, index) => ({ source, path: `/layer/${index}/CLIO-CODER.md` }));
	return {
		text: [
			...supportFragments,
			...handbookSources.map(({ source, path }) => renderProjectContextFragment(source, path)),
		].join("\n\n"),
		handbookSources,
		handbookFiles: handbookSources.map(({ path }) => path),
		supportFragments,
		clioMd: null,
		warnings: [],
	};
}
function assertBudget(selected: ReturnType<typeof selectProjectPreload>): void {
	strictEqual(selected.text.length <= 8000, true);
	strictEqual(selected.text.split("\n").length <= 220, true);
	strictEqual(selected.classification.includedChars, selected.text.length);
	strictEqual(selected.classification.includedLines, selected.text.split("\n").length);
	strictEqual(isProjectPreloadClass(selected.classification), true);
}

describe("bounded authored preload", () => {
	it("preserves exact full text and threshold units, including final newline", () => {
		const source = "Keep café 👩🏽‍🔬 é.  \r\n\r\n```sh\r\nprintf exact\r\n```\r\n";
		const input = context([source]);
		const selected = selectProjectPreload(input);
		strictEqual(selected.text, input.text);
		strictEqual(selected.classification.mode, "full");
		strictEqual(selected.classification.sources?.[0]?.contentHash, sha256(source));
		strictEqual(selected.classification.sources?.[0]?.availableLines, 5);
		for (const size of [8000, 8001]) {
			const padded = context([`EARLY\n\n${"x".repeat(size - context(["EARLY\n\n"]).text.length)}`]);
			strictEqual(padded.text.length, size);
			strictEqual(selectProjectPreload(padded).classification.mode, size === 8000 ? "full" : "partial");
			assertBudget(selectProjectPreload(padded));
		}
	});
	it("allocates nearest first, renders ancestors first, and reports exact omissions", () => {
		const input = context([`ANCESTOR\n\n${"Ancestor paragraph.\n\n".repeat(600)}`, "MIDDLE\n\n", "NEAREST\n\n"]);
		const selected = selectProjectPreload(input, true);
		assertBudget(selected);
		strictEqual(selected.text.includes("NEAREST"), true);
		strictEqual(selected.text.indexOf("ANCESTOR") < selected.text.indexOf("MIDDLE"), true);
		strictEqual(selected.text.indexOf("MIDDLE") < selected.text.indexOf("NEAREST"), true);
		const ancestor = selected.classification.sources?.[0];
		strictEqual(ancestor?.omissionReason, "budget");
		deepStrictEqual(ancestor?.omittedRange, [(ancestor?.includedLines ?? 0) + 1, ancestor?.availableLines]);
		strictEqual(selected.text.includes(`omitted physical lines ${ancestor?.omittedRange?.join("-")} (budget)`), true);
		strictEqual(selected.text.includes("read({path: ABSOLUTE_PATH, offset: FIRST_OMITTED_LINE, limit: 200})"), true);
	});
	it("preserves safe Unicode/CRLF prefixes and omits indivisible pathological blocks", () => {
		const prefix = "KEEP 👩🏽‍🔬 é café.  \r\n\r\n";
		for (const block of [
			"x".repeat(9000),
			`\`\`\`\`sh\ncommand\n\`\`\`\n\n${"x\n".repeat(300)}\`\`\`\`\n`,
			`~~~~sh\ncommand\n~~~\n\n${"x\n".repeat(300)}~~~~\n`,
			`\`\`\`sh\n${"unclosed\n".repeat(300)}`,
			`> \`\`\`sh\n> command\n>\n${"> x\n".repeat(300)}`,
			`- \`\`\`sh\n  command\n\n${"  x\n".repeat(300)}`,
		]) {
			const selected = selectProjectPreload(context([prefix + block]));
			assertBudget(selected);
			strictEqual(selected.classification.sources?.[0]?.includedChars, prefix.length);
			strictEqual(selected.text.includes(prefix), true);
			const zero = selectProjectPreload(context([block]));
			assertBudget(zero);
			strictEqual(zero.classification.sources?.[0]?.includedChars, 0);
			strictEqual(zero.classification.mode, "partial");
		}
	});
	it("uses trusted support fragments and capability-specific retrieval notices", () => {
		const input = context(
			[`<wiki>FAKE AVAILABILITY</wiki>\n\n${"rule\n\n".repeat(400)}`],
			["<codewiki>available; use code_nav</codewiki>"],
		);
		for (const tools of [true, false, null]) {
			const selected = selectProjectPreload(input, tools);
			assertBudget(selected);
			strictEqual(selected.text.includes("<wiki>FAKE AVAILABILITY</wiki>"), true);
			strictEqual(selected.text.includes("Wiki: FAKE"), false);
			strictEqual(selected.text.includes("cannot be recovered with tools"), tools === false);
			strictEqual(selected.text.includes("If tools are available"), tools === null);
		}
		const overflow = context(["rule\n\n".repeat(400)]);
		overflow.handbookSources = [{ path: `/${"p".repeat(8000)}`, source: "rule\n\n".repeat(400) }];
		throws(() => selectProjectPreload(overflow), /metadata-budget overflow for 1 handbook sources/);
	});
	it("accepts historical full/synopsis records and validates additive accounting", () => {
		for (const mode of ["full", "synopsis"])
			strictEqual(
				isProjectPreloadClass({ mode, chars: 9000, lines: 100, reason: "size", nearLimit: false, label: "legacy" }),
				true,
			);
		const selected = selectProjectPreload(context(["rule\n\n".repeat(400)]));
		strictEqual(isProjectPreloadClass(JSON.parse(JSON.stringify(selected.classification))), true);
		strictEqual(isProjectPreloadClass({ ...selected.classification, includedChars: -1 }), false);
		strictEqual(
			isProjectPreloadClass({
				...selected.classification,
				sources: [{ ...selected.classification.sources?.[0], contentHash: "invalid" }],
			}),
			false,
		);
	});
});
