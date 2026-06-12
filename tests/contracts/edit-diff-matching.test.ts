import { ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
} from "../../src/tools/edit-diff.js";

describe("contracts/edit-diff matching", () => {
	it("preserves unrelated typographic bytes during a fuzzy matched edit", () => {
		const untouched = 'const note = "Preserve \u201Cremote\u201D \u2014 text\u00A0here";\n\n';
		const content = `${untouched}function label() {\n\treturn \u201Cold\u201D;   \n}\n`;

		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: '\treturn "old";', newText: '\treturn "new";' }],
			"quotes.ts",
		);

		strictEqual(result.baseContent, content);
		strictEqual(result.newContent, `${untouched}function label() {\n\treturn “new”;\n}\n`);
		ok(result.newContent.startsWith(untouched));
	});

	it("keeps original bytes the model did not intend to change (bt-01 mixed quote pair)", () => {
		const content = 'export const banner = "The “alpha” status is pending";\n';

		const result = applyEditsToNormalizedContent(
			content,
			[
				{
					oldText: 'export const banner = "The “alpha" status is pending";',
					newText: 'export const banner = "The “alpha" status is ready";',
				},
			],
			"hostile.ts",
		);

		strictEqual(result.newContent, 'export const banner = "The “alpha” status is ready";\n');
	});

	it("keeps the file's smart quotes when the model sends straight quotes on both sides", () => {
		const content = "const tag = “v1”; // pending\n";

		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: 'const tag = "v1"; // pending', newText: 'const tag = "v1"; // ready' }],
			"symmetric.ts",
		);

		strictEqual(result.newContent, "const tag = “v1”; // ready\n");
	});

	it("keeps the file's unicode dash when the model sends a hyphen on both sides", () => {
		const content = 'const note = "a — b pending";\n';

		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: 'const note = "a - b pending";', newText: 'const note = "a - b ready";' }],
			"dash.ts",
		);

		strictEqual(result.newContent, 'const note = "a — b ready";\n');
	});

	it("applies a genuine quote change where the normalized forms differ", () => {
		const content = "const q =\u00A0“x”;\n";

		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: "const q = “x”;", newText: "const q = 'x';" }],
			"intent.ts",
		);

		strictEqual(result.newContent, "const q =\u00A0'x';\n");
	});

	it("falls back to the model's line when normalization is not one-to-one", () => {
		const content = "const w = ﬁle; // pending\n";

		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: "const w = file; // pending", newText: "const w = file; // ready" }],
			"ligature.ts",
		);

		strictEqual(result.newContent, "const w = file; // ready\n");
	});

	it("keeps original bytes on paired lines when the edit changes the line count", () => {
		const content = ["const a = “x”;", "const b = 1;", "const c = 2;", ""].join("\n");

		const result = applyEditsToNormalizedContent(
			content,
			[
				{
					oldText: ['const a = "x";', "const b = 1;", "const c = 2;"].join("\n"),
					newText: ['const a = "x";', "const c = 2;"].join("\n"),
				},
			],
			"linecount.ts",
		);

		strictEqual(result.newContent, ["const a = “x”;", "const c = 2;", ""].join("\n"));
	});

	it("matches indentation drift and reindents replacement lines", () => {
		const content = ["function demo() {", "    const before = 1;", "", '    const value = "old";', "}", ""].join("\n");

		const result = applyEditsToNormalizedContent(
			content,
			[
				{
					oldText: ["  const before = 1;", "", '  const value = "old";'].join("\n"),
					newText: ["  const before = 2;", "", '  const value = "new";'].join("\n"),
				},
			],
			"indent.ts",
		);

		strictEqual(
			result.newContent,
			["function demo() {", "    const before = 2;", "", '    const value = "new";', "}", ""].join("\n"),
		);
	});

	it("reindents tabs and spaces by prefix replacement", () => {
		const content = ["function demo() {", "\tconst before = 1;", '\tconst value = "old";', "}", ""].join("\n");

		const result = applyEditsToNormalizedContent(
			content,
			[
				{
					oldText: ["  const before = 1;", '  const value = "old";'].join("\n"),
					newText: ["  const before = 1;", '  const value = "new";'].join("\n"),
				},
			],
			"tabs.ts",
		);

		strictEqual(
			result.newContent,
			["function demo() {", "\tconst before = 1;", '\tconst value = "new";', "}", ""].join("\n"),
		);
	});

	it("rejects duplicate indentation relaxed matches", () => {
		const content = ["function a() {", "    return value;", "}", "function b() {", "\treturn value;", "}", ""].join("\n");

		throws(
			() =>
				applyEditsToNormalizedContent(
					content,
					[{ oldText: " \treturn value;", newText: " \treturn otherValue;" }],
					"duplicates.ts",
				),
			/Found 2 occurrences/,
		);
	});

	it("round trips CRLF files after indentation relaxed matching", () => {
		const rawContent = "function demo() {\r\n\treturn old;\r\n}\r\n";
		const lineEnding = detectLineEnding(rawContent);
		const result = applyEditsToNormalizedContent(
			normalizeToLF(rawContent),
			[{ oldText: "  return old;", newText: "  return new;" }],
			"crlf.ts",
		);

		strictEqual(restoreLineEndings(result.newContent, lineEnding), "function demo() {\r\n\treturn new;\r\n}\r\n");
	});

	it("still rejects replacements that make no changes", () => {
		throws(
			() =>
				applyEditsToNormalizedContent(
					"const value = 1;\n",
					[{ oldText: "const value = 1;", newText: "const value = 1;" }],
					"same.ts",
				),
			/No changes made/,
		);
	});

	it("still rejects overlapping edits", () => {
		throws(
			() =>
				applyEditsToNormalizedContent(
					"abcdef\n",
					[
						{ oldText: "abc", newText: "ABC" },
						{ oldText: "bcd", newText: "BCD" },
					],
					"overlap.txt",
				),
			/overlap/,
		);
	});
});
