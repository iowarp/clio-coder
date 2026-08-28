/**
 * Settings Center number editors report a refused value.
 *
 * The 0.3.7 release tester set watchdog.cadenceToolCalls to 0 and got the row
 * list back with nothing changed and no reason. Every row that routes through
 * the shared number editor now keeps the editor open and prints why the value
 * was refused, in the words the config validator would use for the same key,
 * and the apply path enforces exactly the bound the editor checked so a value
 * the editor forwards is never dropped later.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { MAX_TIMER_DELAY_MS } from "../../src/core/timers.js";
import {
	applySettingChange,
	buildSettingItems,
	buildSettingsSections,
	createSettingsChangePlan,
	describeNumberSettingRefusal,
	NUMBER_SETTING_IDS,
	type NumberSettingId,
	SETTINGS_SECTIONS,
	SettingsCenter,
} from "../../src/interactive/overlays/settings.js";

const ESC = String.fromCharCode(27);
const ENTER = "\r";
const BACKSPACE = "\x7f";
const FORWARD_DELETE = `${ESC}[3~`;
const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

interface Commit {
	id: string;
	value: string;
}

/** Every row the number editor serves, with one refused value and the reason it must print. */
const REFUSALS: ReadonlyArray<{ id: NumberSettingId; typed: string; reason: string; accepted: string }> = [
	{
		id: "watchdog.cadenceToolCalls",
		typed: "0",
		reason: "Not applied: expected an integer >= 1, got 0.",
		accepted: "20",
	},
	{
		id: "budget.sessionCeilingUsd",
		typed: "-1",
		reason: "Not applied: expected a number >= 0, got -1.",
		accepted: "12.5",
	},
	{
		id: "delegation.defaults.connectTimeoutMs",
		typed: "0",
		reason: "Not applied: expected an integer >= 1, got 0.",
		accepted: "45000",
	},
	{
		id: "delegation.defaults.turnTimeoutMs",
		typed: "abc",
		reason: 'Not applied: expected an integer, got "abc".',
		accepted: "600000",
	},
	{
		id: "delegation.defaults.permissionTimeoutMs",
		typed: String(MAX_TIMER_DELAY_MS + 1),
		reason: `Not applied: expected an integer <= ${MAX_TIMER_DELAY_MS}, got ${MAX_TIMER_DELAY_MS + 1}.`,
		accepted: "90000",
	},
];

function baseSettings(): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	settings.targets = [
		{ id: "target-a", runtime: "openai-compat", url: "http://localhost:1111", defaultModel: "model-a" },
	];
	settings.orchestrator = { target: "target-a", model: "model-a", thinkingLevel: "off" };
	return settings;
}

function plainText(lines: readonly string[]): string {
	return lines.map((line) => line.replace(SGR_PATTERN, "")).join("\n");
}

/**
 * Replace the editor's text with `typed` and press Enter. The editor opens with
 * the cursor at the start of the current value, so the old text is cleared in
 * both directions.
 */
function submit(center: SettingsCenter, typed: string): void {
	for (let index = 0; index < 32; index += 1) center.handleInput(FORWARD_DELETE);
	for (let index = 0; index < 32; index += 1) center.handleInput(BACKSPACE);
	for (const character of typed) center.handleInput(character);
	center.handleInput(ENTER);
}

function openEditor(settings: ClioSettings, id: NumberSettingId): { center: SettingsCenter; commits: Commit[] } {
	const commits: Commit[] = [];
	const items = buildSettingItems(settings);
	const section = buildSettingsSections(items).find((candidate) => candidate.items.some((item) => item.id === id));
	ok(section, `${id} belongs to a section`);
	const rowIndex = section.items.findIndex((item) => item.id === id);
	const center = new SettingsCenter(items, {
		getBodyHeight: () => 24,
		prepareChange: (item, value) => createSettingsChangePlan(settings, item, value),
		onApply: (plan) => commits.push({ id: plan.rowId, value: plan.selectedValue }),
		onCancel: () => undefined,
		requestRender: () => undefined,
	});
	center.setSelection(section.id, rowIndex);
	center.handleInput(ENTER);
	strictEqual(center.getSelection().depth, "detail", `${id} opens its editor`);
	return { center, commits };
}

describe("contracts/settings-center number editor refusals", () => {
	it("serves exactly the five number rows through the shared editor", () => {
		deepStrictEqual([...NUMBER_SETTING_IDS].sort(), [
			"budget.sessionCeilingUsd",
			"delegation.defaults.connectTimeoutMs",
			"delegation.defaults.permissionTimeoutMs",
			"delegation.defaults.turnTimeoutMs",
			"watchdog.cadenceToolCalls",
		]);
		deepStrictEqual([...REFUSALS.map((entry) => entry.id)].sort(), [...NUMBER_SETTING_IDS].sort());
		const byId = new Map(buildSettingItems(baseSettings()).map((item) => [item.id, item]));
		for (const id of NUMBER_SETTING_IDS) {
			const row = byId.get(id);
			ok(row?.submenu, `${id} opens a submenu`);
			strictEqual(row?.affordance, "free text");
			ok(
				SETTINGS_SECTIONS.some((section) => section.id === buildSettingsSections([row]).at(0)?.id),
				`${id} is reachable from a section`,
			);
		}
	});

	it("keeps the editor open and prints the validator-worded reason for a refused value", () => {
		for (const { id, typed, reason } of REFUSALS) {
			const settings = baseSettings();
			const before = structuredClone(settings);
			const { center, commits } = openEditor(settings, id);

			submit(center, typed);

			strictEqual(center.getSelection().depth, "detail", `${id}: a refused value keeps the editor open`);
			const screen = plainText(center.render(120));
			ok(screen.includes(reason), `${id}: the reason is on screen\n${screen}`);
			deepStrictEqual(commits, [], `${id}: nothing was committed`);
			deepStrictEqual(settings, before, `${id}: settings untouched`);

			center.handleInput(ESC);
			strictEqual(center.getSelection().depth, "rows", `${id}: Esc still leaves the editor`);
			strictEqual(center.getSelection().rowId, id);
		}
	});

	it("clears the reason and moves on to the destination prompt once the value is corrected", () => {
		for (const { id, typed, reason, accepted } of REFUSALS) {
			const settings = baseSettings();
			const { center, commits } = openEditor(settings, id);
			submit(center, typed);
			ok(plainText(center.render(120)).includes(reason), `${id}: refused first`);

			submit(center, accepted);

			const screen = plainText(center.render(120));
			ok(!screen.includes("Not applied:"), `${id}: the reason is gone after a good value\n${screen}`);
			ok(screen.includes("Apply and save globally"), `${id}: the destination prompt opened\n${screen}`);
			center.handleInput(ENTER);
			deepStrictEqual(commits, [{ id, value: accepted }], `${id}: the corrected value was committed`);
		}
	});

	it("names the bound for a blank submission where blank does not clear the key", () => {
		strictEqual(describeNumberSettingRefusal("watchdog.cadenceToolCalls", "   "), null, "blank clears the cadence");
		strictEqual(
			describeNumberSettingRefusal("delegation.defaults.turnTimeoutMs", ""),
			"Not applied: expected an integer, got an empty string.",
		);
		strictEqual(
			describeNumberSettingRefusal("budget.sessionCeilingUsd", ""),
			"Not applied: expected a number, got an empty string.",
		);
		strictEqual(
			describeNumberSettingRefusal("watchdog.cadenceToolCalls", "1.5"),
			"Not applied: expected an integer, got 1.5.",
		);
		strictEqual(describeNumberSettingRefusal("budget.sessionCeilingUsd", "0"), null);
		strictEqual(describeNumberSettingRefusal("budget.sessionCeilingUsd", "12.5"), null);
	});

	it("applies exactly what the editor accepts and refuses exactly what it refuses", () => {
		for (const { id, typed, accepted } of REFUSALS) {
			const settings = baseSettings();
			const before = structuredClone(settings);
			ok(describeNumberSettingRefusal(id, typed), `${id}: ${typed} is refused with a reason`);
			applySettingChange(settings, id, typed);
			deepStrictEqual(settings, before, `${id}: a refused value is not stored`);

			strictEqual(describeNumberSettingRefusal(id, accepted), null, `${id}: ${accepted} is accepted`);
			applySettingChange(settings, id, accepted);
			ok(createSettingsChangePlan(before, { id, label: id, currentValue: "", scope: "live" }, accepted));
		}

		const cleared = baseSettings();
		cleared.watchdog.cadenceToolCalls = 5;
		applySettingChange(cleared, "watchdog.cadenceToolCalls", "");
		strictEqual("cadenceToolCalls" in cleared.watchdog, false, "blank clears the cadence through the apply path");

		const whole = baseSettings();
		applySettingChange(whole, "watchdog.cadenceToolCalls", "7");
		strictEqual(whole.watchdog.cadenceToolCalls, 7);
	});
});
