import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ResourcesContract } from "../../src/domains/resources/index.js";
import { expandInteractiveSubmit, expandInteractiveSubmitText } from "../../src/interactive/index.js";

let scratch: string;
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
	"base64",
);

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "clio-interactive-submit-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

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

	it("expands inline @file references after resource expansion", () => {
		writeFileSync(join(scratch, "notes.md"), "notes body\n", "utf8");
		const resources = {
			expandSkillInvocation: (text: string) => ({ expanded: false, text, args: "", diagnostics: [] }),
			expandPromptTemplate: (text: string) => ({ expanded: false, text, args: [], diagnostics: [] }),
		} as Partial<ResourcesContract> as ResourcesContract;

		const expanded = expandInteractiveSubmitText("Read @notes.md", resources, scratch);

		ok(expanded.includes(`<file name="${join(scratch, "notes.md")}">`), expanded);
		ok(expanded.includes("notes body"), expanded);
	});

	it("attaches inline image references for chat submission", () => {
		writeFileSync(join(scratch, "pixel.png"), PNG_1X1);
		const resources = {
			expandSkillInvocation: (text: string) => ({ expanded: false, text, args: "", diagnostics: [] }),
			expandPromptTemplate: (text: string) => ({ expanded: false, text, args: [], diagnostics: [] }),
		} as Partial<ResourcesContract> as ResourcesContract;

		const expanded = expandInteractiveSubmit("Describe @pixel.png", resources, scratch);

		strictEqual(expanded.images.length, 1);
		strictEqual(expanded.images[0]?.mimeType, "image/png");
		strictEqual(expanded.images[0]?.data, PNG_1X1.toString("base64"));
		ok(expanded.text.includes(`<file name="${join(scratch, "pixel.png")}"></file>`), expanded.text);
	});
});
