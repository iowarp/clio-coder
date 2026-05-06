import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

describe("interactive slash commands", () => {
	it("lists skills from the injected resources hook", () => {
		let stdout = "";
		const ctx = {
			io: {
				stdout: (text: string) => {
					stdout += text;
				},
				stderr: () => {},
			},
			listSkills: () => ({
				diagnostics: [],
				items: [
					{
						name: "review",
						description: "Review files",
						content: "Review",
						filePath: "/tmp/review/SKILL.md",
						baseDir: "/tmp/review",
						sourceInfo: { path: "/tmp/review/SKILL.md", scope: "user" },
						disableModelInvocation: false,
					},
				],
			}),
		} as Partial<SlashCommandContext> as SlashCommandContext;

		dispatchSlashCommand(parseSlashCommand("/skills"), ctx);

		ok(stdout.includes("skills:"), stdout);
		ok(stdout.includes("/skill:review"), stdout);
		ok(stdout.includes("Review files"), stdout);
	});

	it("lists prompt templates from the injected resources hook", () => {
		let stdout = "";
		const ctx = {
			io: {
				stdout: (text: string) => {
					stdout += text;
				},
				stderr: () => {},
			},
			listPrompts: () => ({
				diagnostics: [],
				items: [
					{
						name: "review",
						description: "Review a diff",
						argumentHint: "<path>",
						content: "Review $1",
						filePath: "/tmp/review.md",
						sourceInfo: { path: "/tmp/review.md", scope: "user" },
					},
				],
			}),
		} as Partial<SlashCommandContext> as SlashCommandContext;

		dispatchSlashCommand(parseSlashCommand("/prompts"), ctx);

		ok(stdout.includes("prompt templates:"), stdout);
		ok(stdout.includes("/review <path>"), stdout);
		ok(stdout.includes("Review a diff"), stdout);
	});
});
