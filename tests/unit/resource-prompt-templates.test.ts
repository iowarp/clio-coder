import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	expandPromptTemplateInput,
	type PromptTemplateList,
	parseCommandArgs,
	substituteArgs,
} from "../../src/domains/resources/index.js";

describe("resources prompt templates", () => {
	it("parses quoted command arguments", () => {
		deepStrictEqual(parseCommandArgs(`one "two words" 'three words' "" four`), [
			"one",
			"two words",
			"three words",
			"",
			"four",
		]);
	});

	it("substitutes positional and argv-style placeholders", () => {
		const result = substituteArgs("$1|$2|$@|$ARGUMENTS|$" + "{@:2}|$" + "{@:2:2}|$9", [
			"alpha",
			"beta",
			"gamma",
			"delta",
		]);
		strictEqual(result, "alpha|beta|alpha beta gamma delta|alpha beta gamma delta|beta gamma delta|beta gamma|");
	});

	it("expands a matching slash prompt template once", () => {
		const templates: PromptTemplateList = {
			diagnostics: [],
			items: [
				{
					name: "review",
					description: "Review a diff",
					content: "Review $1 with notes for $" + "{@:2}.",
					filePath: "/tmp/review.md",
					sourceInfo: { path: "/tmp/review.md", scope: "user" },
				},
			],
		};

		const expanded = expandPromptTemplateInput(`/review "src/app.ts" tests and docs`, templates);

		strictEqual(expanded.expanded, true);
		strictEqual(expanded.text, "Review src/app.ts with notes for tests and docs.");
	});

	it("leaves non-matching slash commands unchanged", () => {
		const expanded = expandPromptTemplateInput("/unknown hello", { items: [], diagnostics: [] });
		strictEqual(expanded.expanded, false);
		strictEqual(expanded.text, "/unknown hello");
	});
});
