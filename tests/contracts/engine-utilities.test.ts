import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	BRANCH_SUMMARY_PREFIX,
	BRANCH_SUMMARY_SUFFIX,
	bashExecutionToText,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
} from "../../src/engine/messages.js";
import { parseCommandArgs, substituteArgs } from "../../src/engine/prompt-templates.js";
import { truncateHead, truncateTail } from "../../src/engine/truncate.js";

test("truncation counts UTF-8 bytes and preserves complete head lines", () => {
	const head = truncateHead("é\n😀\nend", { maxBytes: 7 });
	strictEqual(head.content, "é\n😀");
	strictEqual(head.outputBytes, 7);
	strictEqual(head.truncatedBy, "bytes");
	strictEqual(head.lastLinePartial, false);
	const oversized = truncateHead("😀\nend", { maxBytes: 3 });
	strictEqual(oversized.content, "");
	strictEqual(oversized.firstLineExceedsLimit, true);
	strictEqual(truncateHead("é\n").totalLines, 1);
	strictEqual(truncateHead("").maxBytes, 50 * 1024);
});

test("tail truncation never splits a UTF-8 character and replaces unpaired surrogates", () => {
	const tail = truncateTail("prefix😀界", { maxBytes: 6 });
	strictEqual(tail.content, "界");
	strictEqual(tail.outputBytes, 3);
	strictEqual(tail.lastLinePartial, true);
	strictEqual(truncateTail("prefix😀界", { maxBytes: 7 }).content, "😀界");
	strictEqual(truncateTail("prefix\ud800x", { maxBytes: 4 }).content, "�x");
	strictEqual(truncateTail("😀", { maxBytes: 0 }).content, "");
});

test("summary and bash replay wording remains exact", () => {
	strictEqual(
		`${COMPACTION_SUMMARY_PREFIX}kept${COMPACTION_SUMMARY_SUFFIX}`,
		"The conversation history before this point was compacted into the following summary:\n\n<summary>\nkept\n</summary>",
	);
	strictEqual(
		`${BRANCH_SUMMARY_PREFIX}kept${BRANCH_SUMMARY_SUFFIX}`,
		"The following is a summary of a branch that this conversation came back from:\n\n<summary>\nkept</summary>",
	);
	const message = {
		role: "bashExecution" as const,
		command: "printf result",
		output: "result",
		exitCode: 2,
		cancelled: false,
		truncated: true,
		fullOutputPath: "/saved/output",
		timestamp: 0,
	};
	strictEqual(
		bashExecutionToText(message),
		"Ran `printf result`\n```\nresult\n```\n\nCommand exited with code 2\n\n[Output truncated. Full output: /saved/output]",
	);
	strictEqual(
		bashExecutionToText({ ...message, output: "", cancelled: true, truncated: false }),
		"Ran `printf result`\n(no output)\n\n(command cancelled)",
	);
});

test("prompt arguments retain quoted, positional, slice and raw substitution semantics and Pi 1.0 defaults", () => {
	const raw = "  first\t\"two words\"  'three words' ";
	const args = parseCommandArgs(raw);
	deepStrictEqual(args, ["first", "two words", "three words"]);
	deepStrictEqual(parseCommandArgs('"" one\ntwo'), ["one", "two"]);
	deepStrictEqual(parseCommandArgs('"a\nb" c\nd'), ["a\nb", "c", "d"]);
	strictEqual(
		// biome-ignore lint/suspicious/noTemplateCurlyInString: These are prompt placeholders passed to the substitution API.
		substituteArgs("$1|$2|$4|${@:2:1}|${@:2}|$@|$ARGUMENTS", args),
		"first|two words||two words|two words three words|first two words three words|first two words three words",
	);
	strictEqual(substituteArgs("$1|$ARGUMENTS|$@", args, raw), `first|${raw}|first two words three words`);
	strictEqual(substituteArgs("$ARGUMENTS", args, 'literal $1 $@ "quoted"'), 'literal $1 $@ "quoted"');
	// biome-ignore lint/suspicious/noTemplateCurlyInString: These are prompt placeholders passed to the substitution API.
	strictEqual(substituteArgs("${1:-7}|${@:-all}|${ARGUMENTS:-none}", [], ""), "7|all|none");
	// Clio's default form inserts the raw payload exactly when parsed arguments exist and falls back when only whitespace was typed.
	// biome-ignore lint/suspicious/noTemplateCurlyInString: These are prompt placeholders passed to the substitution API.
	strictEqual(substituteArgs("${ARGUMENTS:-d}", args, raw), raw);
	// biome-ignore lint/suspicious/noTemplateCurlyInString: These are prompt placeholders passed to the substitution API.
	strictEqual(substituteArgs("${ARGUMENTS:-d}", parseCommandArgs(" \t "), " \t "), "d");
	// biome-ignore lint/suspicious/noTemplateCurlyInString: These are prompt placeholders passed to the substitution API.
	strictEqual(substituteArgs("$1|${@:1:1}", ["$@", "b"]), "$@|$@");
});
