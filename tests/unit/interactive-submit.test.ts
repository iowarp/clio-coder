import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResourcesContract } from "../../src/domains/resources/index.js";
import { expandInteractiveSubmitText } from "../../src/interactive/index.js";

describe("interactive submit prompt templates", () => {
	it("expands prompt-template slash input before chat submission", () => {
		const resources = {
			expandSkillInvocation: (text: string) => ({ expanded: false, text, args: "", diagnostics: [] }),
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

	it("expands explicit skill invocation input before prompt templates", () => {
		const resources = {
			expandSkillInvocation: () => ({
				expanded: true,
				text: "expanded skill",
				args: "file",
				skill: {
					name: "review",
					description: "Review",
					content: "expanded skill",
					filePath: "/tmp/review/SKILL.md",
					baseDir: "/tmp/review",
					sourceInfo: { path: "/tmp/review/SKILL.md", scope: "user" },
					disableModelInvocation: false,
				},
				diagnostics: [],
			}),
			expandPromptTemplate: (text: string) => ({ expanded: false, text, args: [], diagnostics: [] }),
		} as Partial<ResourcesContract> as ResourcesContract;

		strictEqual(expandInteractiveSubmitText("/skill:review file", resources, "/repo"), "expanded skill");
	});
});
