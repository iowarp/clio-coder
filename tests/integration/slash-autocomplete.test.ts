import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	buildSlashAutocompleteCommands,
	createSlashCommandAutocompleteProvider,
} from "../../src/interactive/slash-autocomplete.js";
import { BUILTIN_SLASH_COMMANDS, parseSlashCommand } from "../../src/interactive/slash-commands.js";

function abortSignal(): AbortSignal {
	return new AbortController().signal;
}

describe("interactive/slash-autocomplete", () => {
	it("builds one command entry per canonical slash-command registry entry", () => {
		const commands = buildSlashAutocompleteCommands();
		const names = commands.map((command) => command.name).sort();
		const expected = BUILTIN_SLASH_COMMANDS.map((command) => command.name).sort();
		deepStrictEqual(names, expected);
		const run = commands.find((command) => command.name === "run");
		ok(run?.argumentHint?.includes("<agent> <task>"), JSON.stringify(run));
		strictEqual(
			commands.some((command) => command.name === "models"),
			false,
		);
	});

	it("shows all commands for slash and prefix-filters command names", async () => {
		const provider = createSlashCommandAutocompleteProvider();
		const all = await provider.getSuggestions(["/"], 0, 1, { signal: abortSignal() });
		ok(all);
		const allValues = all.items.map((item) => item.value).sort();
		const expected = BUILTIN_SLASH_COMMANDS.map((command) => command.name).sort();
		deepStrictEqual(allValues, expected);

		const filtered = await provider.getSuggestions(["/m"], 0, 2, { signal: abortSignal() });
		ok(filtered);
		deepStrictEqual(
			filtered.items.map((item) => item.value),
			["model"],
		);
	});

	it("applies Tab-style command completions with a trailing space", () => {
		const provider = createSlashCommandAutocompleteProvider();
		const result = provider.applyCompletion(["/m"], 0, 2, { value: "model", label: "model" }, "/m");
		deepStrictEqual(result.lines, ["/model "]);
		strictEqual(result.cursorCol, "/model ".length);
	});

	it("uses pi-tui file completion for @path triggers", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-autocomplete-"));
		try {
			writeFileSync(join(scratch, "README.md"), "# test\n");
			const provider = createSlashCommandAutocompleteProvider({ basePath: scratch });
			const suggestions = await provider.getSuggestions(["@READ"], 0, 5, { signal: abortSignal(), force: true });
			ok(suggestions, "expected file suggestions");
			ok(
				suggestions.items.some((item) => item.value === "README.md" || item.label === "README.md"),
				JSON.stringify(suggestions.items),
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("parses canonical command names without duplicate aliases", () => {
		deepStrictEqual(parseSlashCommand("/model"), { kind: "model" });
		deepStrictEqual(parseSlashCommand("/models"), { kind: "unknown", text: "/models" });
		deepStrictEqual(parseSlashCommand("/quit"), { kind: "quit" });
		deepStrictEqual(parseSlashCommand("/exit"), { kind: "unknown", text: "/exit" });
		deepStrictEqual(parseSlashCommand("/skills"), { kind: "skills" });
		deepStrictEqual(parseSlashCommand("/prompts"), { kind: "prompts" });
		deepStrictEqual(parseSlashCommand("/receipts"), { kind: "receipts" });
		deepStrictEqual(parseSlashCommand("/receipts verify run-123"), {
			kind: "receipt-verify",
			runId: "run-123",
		});
		deepStrictEqual(parseSlashCommand("/receipt verify run-123"), {
			kind: "unknown",
			text: "/receipt verify run-123",
		});
	});
});
