import assert from "node:assert/strict";
import { test } from "node:test";
import { attributedQuotes, normalize, quoted } from "../quote-check.mjs";

const page = [
	"Type this:",
	"",
	"```text",
	"/rewind",
	"```",
	"",
	"In the recorded session behind this guide, the preview read:",
	"",
	"```text",
	"The workspace already matches this snapshot.",
	"```",
	"",
	"```sh",
	"clio-coder doctor",
	"```",
	"",
	"```text recording",
	"rule: secret_path_bash",
	"```",
];

test("only text fences the page attributes to a recording are quotes", () => {
	assert.deepEqual(attributedQuotes(page), [
		{ line: 10, text: "The workspace already matches this snapshot." },
		{ line: 18, text: "rule: secret_path_bash" },
	]);
});

test("a quote matches across terminal wrapping and panel borders, not across changed words", () => {
	const transcript = normalize("│ The workspace already matches   │\n│ this snapshot. Nothing would   │");
	assert.ok(quoted("The workspace already matches this snapshot.", [transcript]));
	assert.ok(!quoted("The workspace already matches that snapshot.", [transcript]));
});
