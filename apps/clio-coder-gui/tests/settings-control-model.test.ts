import assert from "node:assert/strict";
import { test } from "node:test";
import {
	emptyMeaning,
	groupControls,
	matchesControl,
	selectOptions,
	sentence,
	TIMING_SENTENCE,
	writtenSentences,
} from "../client/pages/settings-control-model.js";
import type { SettingControl } from "../contracts/settings-controls.js";

const control = (over: Partial<SettingControl> = {}): SettingControl => ({
	path: "chat.thinkingLevel",
	section: "chat",
	group: "Model & responses",
	label: "Thinking level",
	description: "Reasoning budget for the chat loop.",
	valueHelp: {},
	kind: "string",
	optional: false,
	timing: "nextTurn",
	value: "low",
	source: "user",
	access: "writable",
	...over,
});

test("timing uses the engine's three sentences verbatim", () => {
	assert.deepEqual(TIMING_SENTENCE, {
		hotReload: "A running session can apply this immediately.",
		nextTurn: "Used by the next relevant request, dispatch, or explicit open.",
		restartRequired: "Takes effect in the next session.",
	});
});

test("a select never rewrites a saved value it does not recognise, and an optional one leads with automatic", () => {
	assert.equal(selectOptions(control()), null);
	assert.deepEqual(
		selectOptions(control({ kind: "boolean", value: "true" }))?.map((option) => option.label),
		["On", "Off"],
	);
	assert.deepEqual(
		selectOptions(control({ choices: ["low", "high"] }))?.map((option) => option.value),
		["low", "high"],
	);
	assert.deepEqual(selectOptions(control({ path: "chat.target", optional: true, value: "gone", suggestions: ["a"] })), [
		{ value: "", label: "Automatic" },
		{ value: "gone", label: "gone" },
		{ value: "a", label: "a" },
	]);
	// Suggestions on a list stay free text; a list is not one value.
	assert.equal(selectOptions(control({ kind: "list", suggestions: ["a"] })), null);
	assert.equal(emptyMeaning(control({ kind: "list" })), "None");
	assert.equal(emptyMeaning(control()), "Not set");
});

test("search covers path, label, description and group; groups keep registry order", () => {
	assert.equal(matchesControl(control(), " REASONING "), true);
	assert.equal(matchesControl(control(), "model & resp"), true);
	assert.equal(matchesControl(control(), "fleet"), false);
	assert.deepEqual(
		groupControls([
			control({ group: "B" }),
			control({ group: "A", path: "x.y" }),
			control({ group: "B", path: "x.z" }),
		]).map((row) => [row.group, row.controls.length]),
		[
			["B", 2],
			["A", 1],
		],
	);
});

test("a write reports the requested change first and names every side effect", () => {
	const controls = [control({ path: "chat.target", label: "Target" }), control({ path: "chat.model", label: "Model" })];
	assert.deepEqual(
		writtenSentences(
			[
				{ path: "chat.target", value: "other" },
				{ path: "chat.model", value: "" },
			],
			controls,
			"chat.target",
		),
		["Saved Target.", "This also cleared Model."],
	);
	assert.deepEqual(writtenSentences([], controls, "chat.target"), ["Nothing changed; the value was already in effect."]);
	assert.equal(sentence("never send a pre-warm request"), "Never send a pre-warm request.");
	assert.equal(sentence("Done."), "Done.");
});
