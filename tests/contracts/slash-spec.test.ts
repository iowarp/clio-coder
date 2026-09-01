import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildSlashAutocompleteCommands,
	COMPLETION_SLOT_MANIFEST,
	stubCompletionSources,
} from "../../src/interactive/slash-autocomplete.js";
import { commandReference, SETTINGS_AREA_IDS, SLASH_COMMAND_GROUPS } from "../../src/interactive/slash-commands.js";
import {
	COMPLETION_SLOT_NAMES,
	completeArgs,
	completionAcceptance,
	parseArgs,
	replaceCompletionToken,
} from "../../src/interactive/slash-spec.js";

describe("contracts/slash-spec", () => {
	it("derives the autocomplete surface from the slice 9 registry in explicit group and manifest order", () => {
		const expected = SLASH_COMMAND_GROUPS.flatMap((group) =>
			commandReference()
				.filter((entry) => entry.group === group)
				.map((entry) => entry.name),
		);
		deepStrictEqual(
			buildSlashAutocompleteCommands().map((entry) => entry.name),
			expected,
		);
		for (const retired of ["library", "prompts", "extensions", "interop", "targets", "scoped-models"]) {
			ok(!expected.includes(retired), `/${retired} is absent from the post-cleanup surface`);
		}
		for (const current of ["resources", "archive", "fleet", "agents"]) ok(expected.includes(current));
	});

	it("keeps static grammar order and performs case-insensitive prefix discovery", () => {
		const context = commandReference().find((entry) => entry.name === "context");
		ok(context?.args);
		deepStrictEqual(
			completeArgs(context.args, "")?.completions.map((item) => item.token),
			["compact", "recall", "init", "refresh", "reset"],
		);
		deepStrictEqual(
			completeArgs(context.args, "RE")?.completions.map((item) => item.token),
			["recall", "refresh", "reset"],
		);

		const output = {
			positionals: [{ name: "verbosity", required: false, values: ["minimal", "default", "verbose"] }],
		} as const;
		deepStrictEqual(
			completeArgs(output, "")?.completions.map((item) => item.token),
			["minimal", "default", "verbose"],
		);
	});

	it("finds and replaces the token under the cursor while preserving both sides", () => {
		const args = {
			positionals: [
				{ name: "first", required: true },
				{ name: "action", required: true, values: ["recall", "refresh"] },
				{ name: "tail", required: false },
			],
		};
		const text = "alpha re later";
		const result = completeArgs(args, text, 7);
		ok(result);
		deepStrictEqual({ start: result.tokenStart, end: result.tokenEnd }, { start: 6, end: 8 });
		deepStrictEqual(
			result.completions.map((item) => item.token),
			["recall", "refresh"],
		);
		deepStrictEqual(
			replaceCompletionToken({ line: "/context recall old", range: { start: 9, end: 15 }, cursor: 12, value: "refresh" }),
			{ line: "/context refresh old", cursor: 16 },
		);
		deepStrictEqual(
			replaceCompletionToken({
				line: "/context re old",
				range: { start: 9, end: 11 },
				cursor: 11,
				value: "refresh",
				mode: "remainder",
			}),
			{ line: "/context refresh old", cursor: 16 },
		);
	});

	it("returns quote-aware content ranges and preserves closing quotes and suffix text", () => {
		const args = { positionals: [{ name: "area", required: false, values: SETTINGS_AREA_IDS }] };
		const text = `'cha' untouched`;
		const result = completeArgs(args, text, 3);
		ok(result);
		deepStrictEqual(
			{ start: result.tokenStart, end: result.tokenEnd, quote: result.quote },
			{ start: 1, end: 4, quote: "'" },
		);
		const applied = replaceCompletionToken({
			line: text,
			range: { start: result.tokenStart, end: result.tokenEnd },
			cursor: 3,
			value: "chat",
		});
		deepStrictEqual(applied, { line: `'chat' untouched`, cursor: 5 });
		deepStrictEqual(parseArgs(args, `'chat'`), {
			flags: new Map(),
			flagValues: new Map(),
			positionals: ["chat"],
		});
	});

	it("encodes Tab, Right, Enter, disabled-row, and Escape acceptance semantics", () => {
		strictEqual(completionAcceptance({ key: "tab", selectionMoved: false, syntacticallyComplete: false }), "accept");
		strictEqual(
			completionAcceptance({ key: "right", selectionMoved: false, syntacticallyComplete: false }),
			"accept-remainder",
		);
		strictEqual(completionAcceptance({ key: "enter", selectionMoved: true, syntacticallyComplete: true }), "accept");
		strictEqual(completionAcceptance({ key: "enter", selectionMoved: false, syntacticallyComplete: true }), "submit");
		strictEqual(completionAcceptance({ key: "enter", selectionMoved: false, syntacticallyComplete: false }), "none");
		strictEqual(
			completionAcceptance({ key: "tab", selectionMoved: true, syntacticallyComplete: false, disabled: true }),
			"disabled",
		);
		strictEqual(completionAcceptance({ key: "escape", selectionMoved: true, syntacticallyComplete: true }), "close");
	});

	it("declares every named dynamic slot with inert slice 10 sources", async () => {
		const sources = stubCompletionSources();
		deepStrictEqual(Object.keys(sources), [...COMPLETION_SLOT_NAMES]);
		for (const slot of COMPLETION_SLOT_NAMES) {
			deepStrictEqual(
				await sources[slot]({
					slot,
					prefix: "",
					command: "test",
					line: "",
					cursor: 0,
					generation: 1,
					signal: new AbortController().signal,
				}),
				[],
			);
		}
		const attached = new Set(Object.values(COMPLETION_SLOT_MANIFEST));
		for (const required of [
			"agents",
			"agent-profiles",
			"targets",
			"models",
			"tasks",
			"settings-areas",
			"settings-groups",
			"paths",
		] as const) {
			ok(attached.has(required), `${required} is attached to grammar`);
		}
	});
});
