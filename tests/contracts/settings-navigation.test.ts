import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	resolveSettingsSection,
	SETTINGS_SECTIONS,
	settingsSectionForPath,
} from "../../src/core/settings-navigation.js";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	buildSettingItems,
	buildSettingsSections,
	SETTINGS_LABELS_BY_ID,
	SETTINGS_SECTION_ROWS,
	SettingsCenter,
} from "../../src/interactive/overlays/settings.js";
import { parseSlashCommand } from "../../src/interactive/slash-commands.js";

function fixture() {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [{ id: "local", runtime: "openai-compat", defaultModel: "coder" }];
	settings.fleet.profiles.reviewer = { target: "local", model: "coder", thinkingLevel: "low" };
	settings.fleet.agentProfiles.reviewer = "reviewer";
	return buildSettingItems(settings);
}

test("every existing settings control has exactly one home and canonical persisted paths determine it", () => {
	const items = fixture();
	const controls = items.filter((item) => item.presentationKind !== "group-header");
	const sections = buildSettingsSections(items);
	deepStrictEqual(
		sections.map((section) => [section.id, section.label]),
		SETTINGS_SECTIONS.map((section) => [section.id, section.label]),
	);
	deepStrictEqual(Object.values(SETTINGS_SECTION_ROWS).flat().sort(), Object.keys(SETTINGS_LABELS_BY_ID).sort());
	for (const row of controls) {
		const homes = sections.filter((section) => section.items.some((item) => item.id === row.id));
		strictEqual(homes.length, 1, row.id);
		strictEqual(homes[0]?.id, settingsSectionForPath(row.configPath), row.id);
		if (row.section === "advanced")
			ok(row.id.startsWith("maintenance."), `${row.id} fell into Advanced without an explicit home`);
	}
	const byId = new Map(items.map((item) => [item.id, item]));
	for (const [id, home] of [
		["budget.concurrency", "fleet"],
		["guardrails.workerToolCallCap", "fleet"],
		["guardrails.internalDispatchTimeoutMs", "fleet"],
		["panes.journal", "fleet"],
		["panes.enabled", "interface"],
		["terminal.smoothStreaming", "interface"],
		["keybindings", "interface"],
		["attribution.gitCommits", "integrations"],
		["skills.trustProjectCompatRoots", "integrations"],
		["workers.onPermission", "safety"],
		["delegation.defaults.toolGovernance", "safety"],
		["watchdog.enabled", "safety"],
		["compaction.model", "context"],
		["background.target", "context"],
		["defaults.maxTokens", "chat"],
		["modelSelector.favorites", "chat"],
	] as const)
		strictEqual(byId.get(id)?.section, home, id);
});

test("slash links use the same canonical areas and preserve previous section names as exact aliases", () => {
	for (const section of SETTINGS_SECTIONS) {
		for (const name of [section.id, ...section.aliases]) {
			strictEqual(resolveSettingsSection(name), section.id, name);
			deepStrictEqual(parseSlashCommand(`/settings ${name}`), { kind: "settings", area: section.id });
		}
	}
	for (const name of ["", "permanent", "models,chat", "diagnostics-extra"])
		strictEqual(resolveSettingsSection(name), undefined);
	deepStrictEqual(parseSlashCommand("/settings chat model-picker"), {
		kind: "settings",
		area: "chat",
		group: "model-picker",
	});
});

test("every area renders within narrow and wide terminals, and headings are skipped during navigation", () => {
	const items = fixture();
	const center = new SettingsCenter(items, {
		getBodyHeight: () => 22,
		prepareChange: () => null,
		onApply: () => {},
		onCancel: () => {},
	});
	for (const section of buildSettingsSections(items)) {
		center.setSelection(section.id, 0);
		const selection = center.getSelection();
		strictEqual(selection.section, section.id);
		ok(section.items.find((item) => item.id === selection.rowId)?.presentationKind !== "group-header");
		for (const width of [32, 40, 72, 112, 160]) {
			const lines = center.render(width);
			strictEqual(lines.length, 22);
			ok(
				lines.every((line) => visibleWidth(line) <= width),
				`${section.id} overflows ${width} columns`,
			);
		}
	}
	center.setSelection("models", 0);
	strictEqual(center.getSelection().section, "chat");
	center.handleInput("\x1b");
	strictEqual(center.getSelection().depth, "sections");
	center.handleInput("/");
	center.handleInput("interface.smoothStreaming");
	center.handleInput("\r");
	strictEqual(center.getSelection().section, "interface");
	center.handleInput("\r");
	strictEqual(center.getSelection().rowId, "terminal.smoothStreaming");
	match(center.render(112).join("\n"), /Smooth streaming/);
});

test("settings groups collect related controls and preserve the target inventory column heading", () => {
	const sections = buildSettingsSections(fixture());
	strictEqual(sections.find((section) => section.id === "targets")?.items[0]?.id, "targets");
	const context = sections.find((section) => section.id === "context");
	ok(context);
	let group = "";
	const memberships = new Map<string, string>();
	for (const item of context.items) {
		if (item.presentationKind === "group-header") group = item.label;
		else memberships.set(item.id, group);
	}
	strictEqual(memberships.get("compaction.auto"), "Compaction");
	strictEqual(memberships.get("compaction.model"), "Compaction");
	strictEqual(memberships.get("background.target"), "Proactive memory");
	strictEqual(memberships.get("memory.intervention.enabled"), "Proactive memory");
});
