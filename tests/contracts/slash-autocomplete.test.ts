import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import { createUserTasksStore, type UserTasksStore } from "../../src/domains/user-tasks/store.js";
import {
	createInteractivePresentation,
	type InteractivePresentationDeps,
} from "../../src/interactive/interactive-presentation.js";
import {
	createSlashCommandAutocompleteProvider,
	type SlashAutocompleteOptions,
} from "../../src/interactive/slash-autocomplete.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

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

// Stop presentation construction at its existing autocomplete factory seam;
// the real presentation supplies the catalogs and the real provider consumes them.
function presentationProvider(userTasks?: UserTasksStore) {
	let provider: ReturnType<typeof createSlashCommandAutocompleteProvider> | undefined;
	const captured = new Error("autocomplete captured");
	const noop = () => {};
	throws(
		() =>
			createInteractivePresentation({
				userTasks,
				getTaskBoard: () => ({ tasks: [{ id: "t91", title: "Agent board only", status: "pending" }] }),
				workspaceFacts: {},
				keybindings: { getKeys: () => [] },
				observability: { bindRunReaders: () => noop, snapshot: () => ({}), subscribe: () => noop },
				factories: {
					createBanner: () => ({}),
					createChatPanel: () => ({}),
					createFollowUpQueuePanel: () => ({}),
					createStatusController: () => ({}),
					createDispatchBoardStore: () => ({}),
					createContextActivityStore: () => ({}),
					createNotificationCenter: () => ({}),
					buildFooter: () => ({}),
					createEditor: () => ({}),
					createAutocomplete: (options: SlashAutocompleteOptions) => {
						provider = createSlashCommandAutocompleteProvider({ ...options, fdPath: null });
						throw captured;
					},
				},
			} as unknown as InteractivePresentationDeps),
		(error) => error === captured,
	);
	ok(provider);
	return provider;
}

for (const action of ["hand", "done", "drop"] as const) {
	test(`presentation /tasks ${action} completions select the loaded operator inbox task`, async () => {
		let body: string | undefined;
		const userTasks = createUserTasksStore({
			cwd: "/fixture",
			exists: () => body !== undefined,
			read: () => body ?? "",
			write: (_path, value) => {
				body = value;
			},
		});
		const provider = presentationProvider(userTasks);
		const line = `/tasks ${action} `;
		const suggestions = () => provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		// A populated agent board must not leak into an empty operator inbox.
		deepStrictEqual(await suggestions(), null);
		const first = userTasks.add("Operator first");
		const second = userTasks.add("Operator second");
		const handed = userTasks.add("Already handed");
		userTasks.hand(handed.id);
		const picked = userTasks.add("Already picked");
		userTasks.recordPicked(picked.id, "session-fixture", "t92");
		const done = userTasks.add("Already done");
		userTasks.done(done.id);
		const dropped = userTasks.add("Already dropped");
		userTasks.drop(dropped.id);
		const result = await suggestions();
		ok(result);
		deepStrictEqual(
			result.items.map((item) => item.value),
			action === "hand" ? [first.id, second.id] : [first.id, second.id, handed.id, picked.id],
		);
		for (const item of result.items) {
			const applied = provider.applyCompletion([line], 0, line.length, item, result.prefix);
			const parsed = parseSlashCommand(applied.lines[0] ?? "");
			deepStrictEqual(parsed, { kind: `tasks-${action}`, id: item.value });
			const submitted: string[] = [];
			const errors: string[] = [];
			const ctx = {
				userTasks,
				submitChat: (text: string) => submitted.push(text),
				notice: (level: string, text: string) => {
					if (level === "error") errors.push(text);
				},
				render: () => {},
			} as unknown as SlashCommandContext;
			strictEqual(dispatchSlashCommand(parsed, ctx), "accepted");
			deepStrictEqual(errors, []);
			strictEqual(
				userTasks.get(item.value)?.status,
				action === "hand" ? "handed" : action === "done" ? "done" : "dropped",
			);
			if (action === "hand") {
				ok(submitted[0]?.includes(userTasks.get(item.value)?.title ?? "missing"));
			}
			if (item.value === first.id) strictEqual(userTasks.get(second.id)?.status, "open");
		}
		deepStrictEqual(await suggestions(), null);
	});
}

test("presentation offers no operator task IDs without an inbox owner", async () => {
	const provider = presentationProvider();
	const line = "/tasks done ";
	deepStrictEqual(await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal }), null);
});
