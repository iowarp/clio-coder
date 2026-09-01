import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "../../src/engine/tui.js";
import {
	type CompletionSource,
	type CompletionSources,
	createSlashCommandAutocompleteProvider,
	type SlashCompletionItem,
} from "../../src/interactive/slash-autocomplete.js";
import { commandReference, SLASH_COMMAND_GROUPS } from "../../src/interactive/slash-commands.js";

async function suggest(provider: AutocompleteProvider, text: string, cursor = text.length, force = false) {
	return provider.getSuggestions([text], 0, cursor, { signal: new AbortController().signal, force });
}

function provider(sources: CompletionSources = {}) {
	return createSlashCommandAutocompleteProvider({ basePath: process.cwd(), fdPath: null, completionSources: sources });
}

describe("contracts/slash-autocomplete", () => {
	it("activates only for a leading line-one slash and uses case-insensitive canonical prefix matching", async () => {
		const autocomplete = provider();
		strictEqual(await suggest(autocomplete, "explain /con"), null);
		strictEqual(
			await autocomplete.getSuggestions(["hello", "/con"], 1, 4, { signal: new AbortController().signal }),
			null,
		);
		deepStrictEqual(
			(await suggest(autocomplete, "  /CON"))?.items.map((item) => item.value),
			["context"],
		);
		deepStrictEqual(
			(await suggest(autocomplete, "/CONTEXT"))?.items.map((item) => item.value),
			["context"],
		);
		strictEqual(await suggest(autocomplete, "/context"), null, "an exact submit-ready command is suppressed");
	});

	it("keeps top-level rows in explicit group/manifest order without filtering re-sorts", async () => {
		const rows = (await suggest(provider(), "/"))?.items as SlashCompletionItem[] | undefined;
		const values = rows?.map((item) => item.value);
		const expected = SLASH_COMMAND_GROUPS.flatMap((group) =>
			commandReference()
				.filter((entry) => entry.group === group)
				.map((entry) => entry.name),
		);
		deepStrictEqual(values, expected);
		for (const retired of ["library", "prompts", "extensions", "interop", "targets", "scoped-models"]) {
			ok(!values?.includes(retired));
		}
		ok(rows?.every((row) => row.effectDescription));
		ok(rows?.find((row) => row.value === "run")?.remainingGrammar?.includes("<agent>"));
	});

	it("replaces the command or argument token under the cursor and preserves suffix text", async () => {
		const autocomplete = provider();
		const commandLine = "/con suffix";
		const commandSuggestions = await suggest(autocomplete, commandLine, 4);
		const command = commandSuggestions?.items.find((item) => item.value === "context");
		ok(command && commandSuggestions);
		deepStrictEqual(autocomplete.applyCompletion([commandLine], 0, 4, command, commandSuggestions.prefix), {
			lines: ["/context suffix"],
			cursorLine: 0,
			cursorCol: 8,
		});

		const argumentLine = "/context re suffix";
		const argumentSuggestions = await suggest(autocomplete, argumentLine, 11);
		const refresh = argumentSuggestions?.items.find((item) => item.value === "refresh");
		ok(refresh && argumentSuggestions);
		deepStrictEqual(autocomplete.applyCompletion([argumentLine], 0, 11, refresh, argumentSuggestions.prefix), {
			lines: ["/context refresh suffix"],
			cursorLine: 0,
			cursorCol: 16,
		});
	});

	it("uses the same token-under-cursor replacement for explicit path completion", async () => {
		const autocomplete = provider();
		const line = "pack-suffix";
		const suggestions = await suggest(autocomplete, line, 4, true);
		const packageJson = suggestions?.items.find((item) => item.value === "package.json");
		ok(packageJson && suggestions);
		deepStrictEqual(autocomplete.applyCompletion([line], 0, 4, packageJson, suggestions.prefix), {
			lines: ["package.json"],
			cursorLine: 0,
			cursorCol: 12,
		});
	});

	it("preserves quotes and advances beyond the closing quote when another slot follows", async () => {
		const autocomplete = provider({
			"settings-areas": async () => [{ id: "chat", value: "chat", label: "Chat", description: "Chat settings" }],
		});
		const line = `/settings 'ch' tail`;
		const suggestions = await suggest(autocomplete, line, 13);
		const chat = suggestions?.items[0];
		ok(chat && suggestions);
		deepStrictEqual(autocomplete.applyCompletion([line], 0, 13, chat, suggestions.prefix), {
			lines: [`/settings 'chat' tail`],
			cursorLine: 0,
			cursorCol: 16,
		});
	});

	it("models bare-valid parents as explicit structured submenus only on request", async () => {
		const autocomplete = provider();
		strictEqual(await suggest(autocomplete, "/context"), null);
		const opened = await suggest(autocomplete, "/context", 8, true);
		deepStrictEqual(
			opened?.items.map((item) => ({ label: item.label, kind: (item as SlashCompletionItem).kind })),
			[{ label: "Open …", kind: "open-submenu" }],
		);
		const submenu = await suggest(autocomplete, "/context ");
		deepStrictEqual(
			submenu?.items.map((item) => ({ value: item.value, kind: (item as SlashCompletionItem).kind })),
			["compact", "recall", "init", "refresh", "reset"].map((value) => ({ value, kind: "submenu" })),
		);
	});

	it("advances flags to values, appends a space for another slot, and suppresses exact automatic rows", async () => {
		const autocomplete = provider();
		const advanced = await suggest(autocomplete, "/run", 4, true);
		ok(advanced?.items[0]);
		deepStrictEqual(autocomplete.applyCompletion(["/run"], 0, 4, advanced.items[0], advanced.prefix).lines, ["/run "]);
		const flagSuggestions = await suggest(autocomplete, "/run --thi");
		const thinking = flagSuggestions?.items.find((item) => item.value === "--thinking");
		ok(thinking && flagSuggestions);
		strictEqual((thinking as SlashCompletionItem).appendSpace, true);
		deepStrictEqual(autocomplete.applyCompletion(["/run --thi"], 0, 10, thinking, flagSuggestions.prefix).lines, [
			"/run --thinking ",
		]);
		deepStrictEqual(
			(await suggest(autocomplete, "/context REF"))?.items.map((item) => item.value),
			["refresh"],
		);
		strictEqual(await suggest(autocomplete, "/context refresh"), null);
	});

	it("filters sensitive values, exposes disabled reasons, and refuses disabled acceptance", async () => {
		const autocomplete = provider({
			targets: async () => [
				{ id: "ok", value: "online", label: "online", description: "healthy" },
				{ id: "off", value: "offline", label: "offline", description: "saved", disabledReason: "target is down" },
				{ id: "secret", value: "token-value", label: "token-value", description: "secret", sensitive: true },
			],
		});
		const suggestions = await suggest(autocomplete, "/run --target o");
		deepStrictEqual(
			suggestions?.items.map((item) => item.value),
			["online", "offline"],
		);
		const disabled = suggestions?.items[1] as SlashCompletionItem;
		strictEqual(disabled.description, "target is down");
		strictEqual(disabled.disabledReason, "target is down");
		deepStrictEqual(autocomplete.applyCompletion(["/run --target o"], 0, 15, disabled, suggestions?.prefix ?? ""), {
			lines: ["/run --target o"],
			cursorLine: 0,
			cursorCol: 15,
		});
	});

	it("generation-checks async providers so stale results cannot overwrite a newer prefix", async () => {
		const pending: Array<{ prefix: string; resolve: (values: Awaited<ReturnType<CompletionSource>>) => void }> = [];
		const targets: CompletionSource = (request) =>
			new Promise((resolve) => pending.push({ prefix: request.prefix, resolve }));
		const autocomplete = provider({ targets });
		const older = suggest(autocomplete, "/run --target a");
		const newer = suggest(autocomplete, "/run --target ab");
		strictEqual(pending.length, 2);
		pending[1]?.resolve([{ id: "about", value: "about", label: "about", description: "new" }]);
		deepStrictEqual(
			(await newer)?.items.map((item) => item.value),
			["about"],
		);
		pending[0]?.resolve([{ id: "alpha", value: "alpha", label: "alpha", description: "old" }]);
		strictEqual(await older, null);
	});
});
