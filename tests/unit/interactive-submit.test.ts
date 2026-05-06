import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResourcesContract } from "../../src/domains/resources/index.js";
import { expandInteractiveSubmitText } from "../../src/interactive/index.js";

describe("interactive submit prompt templates", () => {
	it("expands prompt-template slash input before chat submission", () => {
		const resources = {
			expandPromptTemplate: () => ({
				expanded: true,
				text: "expanded prompt",
				args: [],
				template: {
					name: "review",
					description: "Review",
					content: "expanded prompt",
					filePath: "/tmp/review.md",
					sourceInfo: { path: "/tmp/review.md", scope: "user" },
				},
				diagnostics: [],
			}),
		} as Partial<ResourcesContract> as ResourcesContract;

		strictEqual(expandInteractiveSubmitText("/review file", resources, "/repo"), "expanded prompt");
	});
});
