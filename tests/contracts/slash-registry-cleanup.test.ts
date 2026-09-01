import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	commandReference,
	dispatchSlashCommand,
	parseSlashCommand,
	SETTINGS_AREA_IDS,
	SLASH_COMMAND_GROUPS,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

function context(events: string[]): SlashCommandContext {
	const partial: Partial<SlashCommandContext> = {
		notice: (level, text) => events.push(`notice:${level}:${text}`),
		render: () => events.push("render"),
		submitChat: (text) => events.push(`chat:${text}`),
		expandPromptTemplate: (text) => {
			events.push(`expand:${text}`);
			return {
				expanded: true,
				text,
				args: [],
				template: {
					name: "test",
					description: "test",
					content: text,
					filePath: "/test.md",
					sourceInfo: { path: "/test.md", scope: "package" },
					trusted: true,
				},
				diagnostics: [],
			};
		},
		openSkillsHub: (tab) => events.push(`resources:${tab ?? "skills"}`),
		openPrompts: () => events.push("resources:prompts"),
		openExtensions: () => events.push("resources:extensions"),
		openAgents: () => events.push("agents:list"),
		openInterop: () => events.push("agents:connect"),
		openFleetRuns: () => events.push("fleet:runs"),
		openThinkingPicker: () => events.push("picker:thinking"),
		openOutputPicker: () => events.push("picker:output"),
		openSettings: (area, group) => events.push(`settings:${area ?? "root"}:${group ?? "root"}`),
	};
	return partial as SlashCommandContext;
}

describe("slice 9 slash registry cleanup", () => {
	it("publishes only the accepted canonical surface in explicit group order", () => {
		assert.deepEqual(SLASH_COMMAND_GROUPS, ["Work", "Inspect", "Configure", "Session"]);
		assert.deepEqual(SETTINGS_AREA_IDS, ["chat", "fleet", "targets", "context", "safety", "interface", "integrations"]);
		assert.deepEqual(
			commandReference().map(({ name }) => name),
			[
				"run",
				"fleet",
				"delegate",
				"council",
				"oracle",
				"btw",
				"share",
				"skill",
				"agents",
				"tasks",
				"context",
				"memory",
				"view",
				"panes",
				"cost",
				"decisions",
				"resources",
				"help",
				"model",
				"thinking",
				"output",
				"settings",
				"new",
				"resume",
				"handoff",
				"fork",
				"tree",
				"export",
				"archive",
				"quit",
			],
		);
	});

	it("routes merged resources and agents connect through their canonical nouns", () => {
		const events: string[] = [];
		const ctx = context(events);
		for (const text of [
			"/resources",
			"/resources skills",
			"/resources prompts",
			"/resources library agent",
			"/resources extensions",
			"/agents",
			"/agents list",
			"/agents connect",
		]) {
			dispatchSlashCommand(parseSlashCommand(text), ctx);
		}
		assert.deepEqual(events, [
			"resources:skills",
			"resources:skills",
			"resources:prompts",
			"resources:agent",
			"resources:extensions",
			"agents:list",
			"agents:list",
			"agents:connect",
		]);
	});

	it("keeps fleet operational and bare quick setters in their own pickers", () => {
		const events: string[] = [];
		const ctx = context(events);
		for (const text of ["/fleet", "/thinking", "/output", "/settings chat model-picker"]) {
			dispatchSlashCommand(parseSlashCommand(text), ctx);
		}
		assert.deepEqual(events, ["fleet:runs", "picker:thinking", "picker:output", "settings:chat:model-picker"]);
	});

	it("separates worker sharing from full archive import and export", () => {
		assert.deepEqual(parseSlashCommand("/share run-42"), { kind: "share", runId: "run-42" });
		assert.deepEqual(parseSlashCommand("/archive export backup.clio"), {
			kind: "archive-export",
			path: "backup.clio",
		});
		assert.deepEqual(parseSlashCommand("/archive import --dry-run --force backup.clio"), {
			kind: "archive-import",
			path: "backup.clio",
			dryRun: true,
			force: true,
		});
		assert.deepEqual(parseSlashCommand("/share import"), {
			kind: "usage-error",
			command: "share",
			reason: "/share import is retired and did not run; use /archive import",
		});
		assert.deepEqual(parseSlashCommand("/share export backup.clio"), {
			kind: "usage-error",
			command: "share",
			reason: "/share export is retired and did not run; use /archive export",
		});
	});

	it("gives retired spellings targeted tombstones before any possible execution", () => {
		const replacements: ReadonlyArray<[string, string]> = [
			["/library", "/resources library"],
			["/prompts", "/resources prompts"],
			["/extensions", "/resources extensions"],
			["/interop", "/agents connect"],
			["/targets", "/settings targets"],
			["/scoped-models", "/settings chat model-picker"],
			["/compact", "/context compact"],
			["/skill:review", "/skill <name>"],
		];
		for (const [text, replacement] of replacements) {
			const events: string[] = [];
			assert.equal(dispatchSlashCommand(parseSlashCommand(text), context(events)), "rejected");
			assert.equal(
				events.some((event) => event.includes(replacement)),
				true,
				text,
			);
			assert.equal(
				events.some((event) => event.startsWith("expand:") || event.startsWith("chat:")),
				false,
				text,
			);
		}
	});
});
