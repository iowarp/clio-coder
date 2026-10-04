import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { resolveSettingsArea, SETTINGS_AREAS, settingsPlacementForRow } from "../../src/core/settings-areas.js";
import { resolveSettingsSection, SETTINGS_SECTIONS } from "../../src/core/settings-navigation.js";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	buildSettingItems,
	buildSettingsSections,
	SETTINGS_LABELS_BY_ID,
	SETTINGS_SECTION_ROWS,
	SettingsCenter,
} from "../../src/interactive/overlays/settings.js";
import { parseSlashCommand } from "../../src/session-control/slash-commands.js";

function fixture() {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [{ id: "local", runtime: "openai-compat", defaultModel: "coder" }];
	settings.fleet.profiles.reviewer = { target: "local", model: "coder", thinkingLevel: "low" };
	settings.fleet.agentProfiles.reviewer = "reviewer";
	return buildSettingItems(settings);
}

test("fleet setup actions provide filter metadata without catalog entries", () => {
	const items = buildSettingItems(structuredClone(DEFAULT_SETTINGS), { onFleetSettingsChanged: () => {} });
	for (const id of ["fleet.nodes.add", "fleet.nodes.discover"] as const) {
		const row = items.find((item) => item.id === id);
		ok(row);
		strictEqual(row.configPath, id);
		ok(row.label.length > 0);
		ok(row.description.length > 0);
	}
});

test("every existing settings control has exactly one home and canonical persisted paths determine it", () => {
	const items = fixture();
	const controls = items.filter((item) => item.presentationKind !== "group-header");
	const sections = buildSettingsSections(items);
	deepStrictEqual(
		sections.map((section) => [section.id, section.label]),
		SETTINGS_AREAS.map((area) => [area.id, area.label]),
	);
	deepStrictEqual(Object.values(SETTINGS_SECTION_ROWS).flat().sort(), Object.keys(SETTINGS_LABELS_BY_ID).sort());
	// Recent & Pinned only repeats rows that live elsewhere, so it is never a home.
	const homeSections = sections.filter((section) => section.id !== "recent");
	for (const row of controls) {
		const homes = homeSections.filter((section) => section.items.some((item) => item.id === row.id));
		strictEqual(homes.length, 1, row.id);
		const placement = settingsPlacementForRow(row.id, row.configPath);
		strictEqual(homes[0]?.id, placement.area, row.id);
		notStrictEqual(placement.group, "Other", `${row.id} fell into Advanced without an explicit home`);
	}
	const byId = new Map(items.map((item) => [item.id, item]));
	for (const [id, home] of [
		["budget.concurrency", "fleet"],
		["guardrails.workerToolCallCap", "fleet"],
		["guardrails.internalDispatchTimeoutMs", "advanced"],
		["panes.journal", "fleet"],
		["panes.enabled", "interface"],
		["terminal.smoothStreaming", "chat"],
		["keybindings", "advanced"],
		["attribution.gitCommits", "workspace"],
		["skills.trustProjectCompatRoots", "integrations"],
		["workers.onPermission", "safety"],
		["delegation.defaults.toolGovernance", "safety"],
		["watchdog.enabled", "safety"],
		["compaction.model", "context"],
		["background.target", "context"],
		["defaults.maxTokens", "models"],
		["modelSelector.favorites", "models"],
	] as const)
		strictEqual(byId.get(id)?.section, home, id);
});

test("slash links use the same canonical areas and keep previous section names resolving", () => {
	for (const area of SETTINGS_AREAS) {
		for (const name of [area.id, ...area.aliases]) {
			strictEqual(resolveSettingsArea(name), area.id, name);
			deepStrictEqual(parseSlashCommand(`/settings ${name}`), { kind: "settings", area: area.id });
		}
	}
	for (const name of ["", "permanent", "models,chat", "diagnostics-extra"])
		strictEqual(resolveSettingsArea(name), undefined);
	// configure and the GUI still share the eight-section navigation under its own names.
	for (const section of SETTINGS_SECTIONS) {
		for (const name of [section.id, ...section.aliases]) {
			strictEqual(resolveSettingsSection(name), section.id, name);
			ok(resolveSettingsArea(name) !== undefined, `previous section name '${name}' no longer opens an area`);
		}
	}
	// Model choice moved out of Chat into Models & Inference; only retry stayed in Chat.
	for (const name of ["orchestrator", "models", "model", "thinking"]) strictEqual(resolveSettingsArea(name), "models");
	strictEqual(resolveSettingsArea("retry"), "chat");
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
	center.setSelection("orchestrator", 0);
	strictEqual(center.getSelection().section, "models");
	center.setSelection("retry", 0);
	strictEqual(center.getSelection().section, "chat");
	center.handleInput("\x1b");
	strictEqual(center.getSelection().depth, "sections");
	center.handleInput("/");
	center.handleInput("interface.smoothStreaming");
	center.handleInput("\r");
	strictEqual(center.getSelection().section, "chat");
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
