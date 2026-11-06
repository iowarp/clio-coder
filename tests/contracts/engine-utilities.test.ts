import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
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

test("summaries frame their payload and bash replay retains output, exit, cancellation and recovery metadata", () => {
	for (const [prefix, suffix] of [
		[COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX],
		[BRANCH_SUMMARY_PREFIX, BRANCH_SUMMARY_SUFFIX],
	])
		match(`${prefix}kept${suffix}`, /<summary>\nkept\n?<\/summary>$/u);
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
	const replay = bashExecutionToText(message);
	match(replay, /`printf result`/u);
	match(replay, /```\nresult\n```/u);
	match(replay, /code 2/u);
	match(replay, /truncated/iu);
	match(replay, /\/saved\/output/u);
	const canceled = bashExecutionToText({ ...message, output: "", cancelled: true, truncated: false });
	match(canceled, /`printf result`/u);
	match(canceled, /no output/u);
	match(canceled, /cancelled/u);
	doesNotMatch(canceled, /code 2|\/saved\/output/u);
});

test("prompt arguments retain quoted, positional, slice and raw substitution semantics and Pi 1.0 defaults", () => {
	const raw = "  first\t\"two words\"  'three words' ";
	const args = parseCommandArgs(raw);
	deepStrictEqual(args, ["first", "two words", "three words"]);
	// Pi 1.3.0 (#10867): a quoted empty argument keeps its position, so later arguments do not shift.
	deepStrictEqual(parseCommandArgs('"" one\ntwo'), ["", "one", "two"]);
	deepStrictEqual(parseCommandArgs("a '' c"), ["a", "", "c"]);
	// biome-ignore lint/suspicious/noTemplateCurlyInString: These are prompt placeholders passed to the substitution API.
	strictEqual(substituteArgs("$2|${1:-correctness}", parseCommandArgs('"" src/x.ts')), "src/x.ts|correctness");
	// biome-ignore lint/suspicious/noTemplateCurlyInString: These are prompt placeholders passed to the substitution API.
	strictEqual(substituteArgs("${ARGUMENTS:-d}|$ARGUMENTS", parseCommandArgs('""'), '""'), 'd|""');
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
