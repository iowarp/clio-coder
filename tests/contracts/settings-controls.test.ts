import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { saveControl } from "../../src/cli/configure-controls.js";
import { readSettings, updateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { getAtPath, setAtPath } from "../../src/core/session-routing.js";
import { applyControlValue, SETTING_CONTROLS } from "../../src/core/settings-controls.js";
import {
	buildSettingItems,
	buildSettingsSections,
	createSettingsChangePlan,
	SettingsCenter,
} from "../../src/interactive/overlays/settings.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function fixture() {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "first", runtime: "openai-compat", defaultModel: "first-model" },
		{ id: "second", runtime: "openai-compat", defaultModel: "second-model" },
	];
	settings.chat.target = "first";
	settings.chat.model = "custom-model";
	return settings;
}

test("every shared control has a TUI home and accepts its shipped value", () => {
	const rows = buildSettingItems(DEFAULT_SETTINGS);
	for (const control of SETTING_CONTROLS) {
		assert.ok(
			rows.some((row) => row.configPath === control.path),
			control.path,
		);
		assert.notEqual(control.label, control.path, control.path);
		if (control.readOnly) continue;
		const value = getAtPath(DEFAULT_SETTINGS, control.path);
		const text =
			value == null
				? ""
				: control.kind === "list"
					? (value as string[]).join(", ")
					: typeof value === "object"
						? JSON.stringify(value)
						: String(value);
		const settings = structuredClone(DEFAULT_SETTINGS);
		assert.doesNotThrow(() => applyControlValue(settings, control.path, text), control.path);
	}
});

test("invalid typed values, references, and cross-field edits leave the original intact", () => {
	for (const [path, input] of [
		["safety.autonomy", "unknown"],
		["fleet.concurrency", "1.5"],
		["chat.retry.maxRetries", "NaN"],
		["chat.retry.maxRetries", "-1"],
		["chat.prewarm", "yes"],
		["context.workingSet.target", "1"],
		["fleet.nodes", "{}"],
		["interface.keybindings", "{"],
		["chat.target", "typo"],
		["fleet.default.node", "typo"],
		["chat.modelPicker.favorites", "typo/model"],
		["fleet.profiles", '{"reviewer":{"target":"typo"}}'],
		["fleet.agentProfiles", '{"scout":"typo"}'],
		["integrations.library.confirmedRemote", "https://example.com"],
	] as const) {
		const settings = fixture();
		const before = structuredClone(settings);
		assert.throws(() => applyControlValue(settings, path, input), Error, path);
		assert.deepEqual(settings, before, path);
	}
});

test("changing a role connection clears only that role's previous model override", () => {
	const settings = fixture();
	const before = structuredClone(settings);
	applyControlValue(settings, "chat.target", "second");
	assert.equal(settings.chat.target, "second");
	assert.equal(settings.chat.model, null);
	assert.deepEqual(settings.fleet, before.fleet);
	assert.deepEqual(settings.targets, before.targets);
});

test("saved edits preserve unrelated fields, explicit inheritance, and survive a fresh read", async (t) => {
	const env = await isolateClioEnv("clio-settings-controls-");
	t.after(() => env.restore());
	updateSettings(() => fixture());
	saveControl("chat.target", "second");
	saveControl("safety.limits.sessionCostUsd", "7");
	saveControl("chat.modelPicker.favorites", "second/second-model");
	saveControl("context.compaction.model", "summary-model");
	saveControl("context.compaction.model", "");
	const saved = parse(readFileSync(join(env.dir, "config", "settings.yaml"), "utf8"));
	assert.equal(saved.chat.model, null);
	assert.equal(saved.context?.compaction?.model, undefined);
	const effective = readSettings();
	assert.equal(effective.chat.model, "second-model");
	assert.equal(effective.safety.limits.sessionCostUsd, 7);
	assert.deepEqual(effective.chat.modelPicker.favorites, ["second/second-model"]);
	assert.equal(effective.targets.length, 2);
	const content = readFileSync(join(env.dir, "config", "settings.yaml"), "utf8");
	assert.throws(() => saveControl("chat.target", "missing"));
	assert.equal(readFileSync(join(env.dir, "config", "settings.yaml"), "utf8"), content);
});

test("numeric editors accept custom values, retain invalid drafts, and recover without closing settings", () => {
	const settings = fixture();
	const items = buildSettingItems(settings);
	let reviewed: string | undefined;
	const center = new SettingsCenter(items, {
		getBodyHeight: () => 24,
		prepareChange: (_item, value) => {
			reviewed = value;
			return null;
		},
		onApply: () => {},
		onCancel: () => {},
	});
	const rows = buildSettingsSections(items).find((section) => section.id === "chat")?.items ?? [];
	center.setSelection(
		"chat",
		rows.findIndex((row) => row.configPath === "chat.maxOutputTokens"),
	);
	center.handleInput("\r");
	center.handleInput("\x05");
	center.handleInput("\x15");
	center.handleInput("invalid");
	center.handleInput("\r");
	assert.equal(reviewed, undefined);
	assert.equal(center.getSelection().submenuOpen, true);
	assert.match(center.render(120).join("\n"), /finite number/);
	center.handleInput("\x05");
	center.handleInput("\x15");
	center.handleInput("12345");
	center.handleInput("\r");
	assert.equal(reviewed, "12345");
});

test("TUI saves JSON maps with dotted user keys as whole collections", () => {
	const settings = fixture();
	const row = buildSettingItems(settings).find((item) => item.id === "keybindings");
	assert.ok(row);
	const value = { "clio-coder.notifications.dismiss": "alt+n" };
	const plan = createSettingsChangePlan(settings, row, JSON.stringify(value));
	assert.ok(plan);
	assert.deepEqual(
		plan.leaves.map((leaf) => leaf.path),
		["interface.keybindings"],
	);
	const saved = structuredClone(settings);
	for (const leaf of plan.leaves) setAtPath(saved, leaf.path, structuredClone(leaf.after));
	assert.deepEqual(saved.interface.keybindings, value);
	const clear = createSettingsChangePlan(saved, row, "{}");
	assert.ok(clear);
	assert.deepEqual(
		clear.leaves.map((leaf) => leaf.path),
		["interface.keybindings"],
	);
});
