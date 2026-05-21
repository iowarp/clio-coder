import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProvidersContract, ResolvedModelRef } from "../../src/domains/providers/index.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

describe("interactive slash commands", () => {
	it("renders /help through stdout for the interactive surface", () => {
		let stdout = "";
		const ctx = {
			io: {
				stdout: (text: string) => {
					stdout += text;
				},
				stderr: () => {},
			},
		} as Partial<SlashCommandContext> as SlashCommandContext;

		dispatchSlashCommand(parseSlashCommand("/help"), ctx);

		ok(stdout.includes("commands:"), stdout);
		ok(stdout.includes("/help"), stdout);
		ok(stdout.includes("/hotkeys"), stdout);
	});

	it("parses /run tool profiles", () => {
		const command = parseSlashCommand("/run --tool-profile science-local worker run tests");
		strictEqual(command.kind, "run");
		if (command.kind !== "run") throw new Error("expected run command");
		strictEqual(command.options.toolProfile, "science-local");
		strictEqual(command.agentId, "worker");
		strictEqual(command.task, "run tests");

		strictEqual(parseSlashCommand("/run --tool-profile unknown worker task").kind, "run-usage");
	});

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

	it("filters /skills by case-insensitive name or description query", () => {
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
					{
						name: "bench",
						description: "Benchmark kernels",
						content: "Bench",
						filePath: "/tmp/bench/SKILL.md",
						baseDir: "/tmp/bench",
						sourceInfo: { path: "/tmp/bench/SKILL.md", scope: "user" },
						disableModelInvocation: false,
					},
				],
			}),
		} as Partial<SlashCommandContext> as SlashCommandContext;

		dispatchSlashCommand(parseSlashCommand("/skills REVIEW"), ctx);

		ok(stdout.includes("/skill:review"), stdout);
		ok(!stdout.includes("/skill:bench"), stdout);

		stdout = "";
		dispatchSlashCommand(parseSlashCommand("/skills missing"), ctx);
		ok(stdout.includes('no matches for "missing"'), stdout);
	});

	it("parses and applies /model pattern commands", () => {
		const command = parseSlashCommand("/model mini/qwen:high");
		strictEqual(command.kind, "model-set");
		if (command.kind !== "model-set") throw new Error("expected model-set command");
		strictEqual(command.pattern, "mini/qwen:high");

		let stdout = "";
		const appliedRefs: ResolvedModelRef[] = [];
		const providers = {
			list: () => [
				{
					endpoint: { id: "mini", runtime: "stub", defaultModel: "qwen" },
					runtime: { id: "stub" },
					discoveredModels: [],
				},
			],
		} as unknown as ProvidersContract;
		const ctx = {
			io: {
				stdout: (text: string) => {
					stdout += text;
				},
				stderr: () => {},
			},
			providers,
			applyModelRef: (ref: ResolvedModelRef) => appliedRefs.push(ref),
		} as Partial<SlashCommandContext> as SlashCommandContext;

		dispatchSlashCommand(command, ctx);

		const applied = appliedRefs[0];
		ok(applied, "expected /model to apply a resolved ref");
		strictEqual(applied?.endpoint, "mini");
		strictEqual(applied?.model, "qwen");
		strictEqual(applied?.thinkingLevel, "high");
		ok(stdout.includes("[/model] active: mini/qwen thinking=high"), stdout);
	});

	it("opens model selector for /models alias", () => {
		let opened = 0;
		const ctx = {
			openModel: () => {
				opened += 1;
			},
		} as Partial<SlashCommandContext> as SlashCommandContext;

		dispatchSlashCommand(parseSlashCommand("/models"), ctx);

		strictEqual(opened, 1);
	});

	it("reports /model pattern resolution errors", () => {
		let stderr = "";
		const ctx = {
			io: {
				stdout: () => {},
				stderr: (text: string) => {
					stderr += text;
				},
			},
			providers: { list: () => [] } as Partial<ProvidersContract> as ProvidersContract,
			applyModelRef: () => {
				throw new Error("should not apply");
			},
		} as Partial<SlashCommandContext> as SlashCommandContext;

		dispatchSlashCommand(parseSlashCommand("/model missing"), ctx);

		ok(stderr.includes("no targets configured"), stderr);
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
