import { deepStrictEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import {
	createSlashCommandAutocompleteProvider,
	type SlashAutocompleteOptions,
} from "../../src/interactive/slash-autocomplete.js";

const legacyOptionRemoved: "listSkills" extends keyof SlashAutocompleteOptions ? false : true = true;

test("dynamic slash slots read current source values and replace the argument", async () => {
	ok(legacyOptionRemoved);
	const catalog = {
		agents: [{ id: "researcher", description: "Inspect sources" }],
		targets: [{ id: "local", description: "Local inference" }],
		skills: [{ id: "review", description: "Review changes" }],
	};
	const provider = createSlashCommandAutocompleteProvider({
		fdPath: null,
		completionSources: Object.fromEntries(
			Object.entries(catalog).map(([slot, rows]) => [
				slot,
				async () => rows.map((row) => ({ ...row, value: row.id, label: row.id })),
			]),
		),
	});
	for (const [line, expected] of [
		["/run re", "researcher"],
		["/run researcher --target lo", "local"],
		["/skill re", "review"],
	] as const) {
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});
		ok(suggestions);
		deepStrictEqual(
			suggestions.items.map((item) => item.value),
			[expected],
		);
		const item = suggestions.items[0];
		ok(item);
		const applied = provider.applyCompletion([line], 0, line.length, item, suggestions.prefix);
		deepStrictEqual(applied.lines, [line.replace(/\S+$/, `${expected} `)]);
	}
	catalog.skills.push({ id: "repair", description: "Repair defects" });
	const line = "/skill rep";
	const refreshed = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	deepStrictEqual(
		refreshed?.items.map((item) => item.value),
		["repair"],
	);
});

test("unprovided dynamic slots have no values", async () => {
	const provider = createSlashCommandAutocompleteProvider({ fdPath: null });
	const line = "/skill missing";
	const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	deepStrictEqual(result, null);
});
