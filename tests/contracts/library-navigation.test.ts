import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { createSlashCommandAutocompleteProvider } from "../../src/interactive/slash-autocomplete.js";
import {
	commandReference,
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

it("canonical category commands open the shared Library without submitting a turn", () => {
	const opened: unknown[] = [];
	const ctx = {
		openSkillsHub: (tab: unknown) => opened.push(tab),
		submitChat: () => {
			throw new Error("browser submitted a model turn");
		},
	} as unknown as SlashCommandContext;
	for (const [command, tab] of [
		["library", "plugin"],
		["skills", "skill"],
		["agents", "agent"],
		["prompts", "prompt"],
	]) {
		deepStrictEqual(parseSlashCommand(`/${command}`), { kind: "resources", tab });
		strictEqual(dispatchSlashCommand(parseSlashCommand(`/${command}`), ctx), "accepted");
	}
	deepStrictEqual(
		opened,
		["plugin", "skill", "agent", "prompt"].map((tab) => ({ tab })),
	);
});

it("retired browser spellings refuse before prompt expansion or model submission", () => {
	const notices: string[] = [];
	const ctx = {
		notice: (_level: string, message: string) => notices.push(message),
		render: () => {},
		expandPromptTemplate: () => {
			throw new Error("retired command reached prompt expansion");
		},
		submitChat: () => {
			throw new Error("retired command reached model submission");
		},
	} as unknown as SlashCommandContext;
	for (const input of [
		"/skill",
		"/agents list",
		"/agents connect",
		"/skills install review",
		"/prompts extra",
		"/resources",
		"/resources plugins reload",
		"/plugins",
		"/library extensions",
		"/library extensions reload",
		...["skill", "agent", "prompt", "fleet", "plugin"].flatMap((kind) => [`/library ${kind}`, `/library ${kind}s`]),
	]) {
		strictEqual(parseSlashCommand(input).kind, "usage-error", input);
		strictEqual(dispatchSlashCommand(parseSlashCommand(input), ctx), "rejected", input);
	}
	match(notices[0] ?? "", /\/skills.*\/skill <name>/);
	deepStrictEqual(parseSlashCommand("/skill off"), { kind: "skill-surface-clear" });
	deepStrictEqual(parseSlashCommand("/skill review src"), { kind: "skill-invocation", text: "/skill review src" });
});

it("help and completions expose only the canonical browsing routes", async () => {
	const names = commandReference().map((entry) => entry.name);
	for (const name of ["library", "skills", "agents", "prompts", "extensions"]) strictEqual(names.includes(name), true);
	for (const name of ["plugins", "resources"]) strictEqual(names.includes(name), false);
	const provider = createSlashCommandAutocompleteProvider({ fdPath: null });
	for (const line of ["/agents ", "/library pl", "/library extensions ", "/skills install "]) {
		const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		strictEqual(result, null, line);
	}
});

it("routes typed package operations to their category and preserves an explicit scope", () => {
	for (const tab of ["skill", "agent", "prompt", "fleet", "plugin"]) {
		for (const operation of ["inspect", "install", "remove"]) {
			const request = {
				tab,
				focus: `${tab}:fixture`,
				...(operation === "inspect" ? {} : { intent: operation }),
				scope: "project",
			};
			const command = parseSlashCommand(`/library ${operation} ${tab}:fixture --project`);
			deepStrictEqual(command, { kind: "resources", ...request });
			const opened: unknown[] = [];
			const context = { openSkillsHub: (value: unknown) => opened.push(value) } as unknown as SlashCommandContext;
			strictEqual(dispatchSlashCommand(command, context), "accepted");
			deepStrictEqual(opened, [request]);
		}
	}
});

it("preserves a quoted import source and scope, and refuses malformed or conflicting requests", () => {
	deepStrictEqual(parseSlashCommand('/library import "/tmp/lab plugin" --project'), {
		kind: "resources",
		tab: "plugin",
		importSource: "/tmp/lab plugin",
		scope: "project",
	});
	deepStrictEqual(parseSlashCommand("/library import https://github.com/vendor/recipes/tree/main/plugin --user"), {
		kind: "resources",
		tab: "plugin",
		importSource: "https://github.com/vendor/recipes/tree/main/plugin",
		scope: "user",
	});
	for (const input of [
		"/library install",
		"/library remove",
		"/library inspect",
		"/library import",
		"/library install skill:tdd --unknown",
		"/library inspect skill:tdd extra",
		"/library remove plugin:materio --user --project",
		"/library import /tmp/recipe --user --project",
		"/library reload extra",
	])
		strictEqual(parseSlashCommand(input).kind, "usage-error", input);
});
