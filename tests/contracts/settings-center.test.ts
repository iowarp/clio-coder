import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { Component, OverlayHandle, TUI } from "../../src/engine/tui.js";
import {
	applySettingChange,
	buildSettingItems,
	buildSettingsSections,
	type EditableSettingId,
	openSettingsOverlay,
	SETTINGS_LABELS_BY_ID,
	SETTINGS_SECTION_ROWS,
	SETTINGS_SECTIONS,
	SettingsCenter,
} from "../../src/interactive/overlays/settings.js";

const ESC = String.fromCharCode(27);
const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const FOOTER_NOTE_FOR_TEST = "applies to this session and to new sessions";

function settingsWithTargets(): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.endpoints = [
		{ id: "target-a", runtime: "openai-compat", url: "http://localhost:1111", defaultModel: "model-a" },
		{ id: "target-b", runtime: "openai-compat", url: "http://localhost:2222", defaultModel: "model-b" },
	];
	settings.safetyLevel = "auto-edit";
	settings.orchestrator = { endpoint: "target-a", model: "model-a", thinkingLevel: "off" };
	settings.workers.default = { endpoint: "target-a", model: "model-a", thinkingLevel: "off" };
	settings.scope = ["target-a/model-a", "target-b/model-b"];
	settings.budget.sessionCeilingUsd = 5;
	settings.compaction = { auto: true, threshold: 0.8, excludeLastTurns: 6 };
	settings.retry = { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60000 };
	settings.terminal.showTerminalProgress = false;
	return settings;
}

function stripAnsi(value: string): string {
	return value.replace(SGR_PATTERN, "");
}

function noopSettingsCenter(bodyHeight: number): SettingsCenter {
	return new SettingsCenter(buildSettingItems(settingsWithTargets()), {
		getBodyHeight: () => bodyHeight,
		onChange: () => undefined,
		onCancel: () => undefined,
	});
}

function fakeTui(rows: number, columns: number): { tui: TUI; captured: () => Component | null; renders: () => number } {
	let overlay: Component | null = null;
	let renderCount = 0;
	const handle: OverlayHandle = {
		hide: () => undefined,
		setHidden: () => undefined,
		isHidden: () => false,
		focus: () => undefined,
		unfocus: () => undefined,
		isFocused: () => true,
	};
	const tui = {
		terminal: { rows, columns },
		requestRender: () => {
			renderCount += 1;
		},
		showOverlay: (component: Component) => {
			overlay = component;
			return handle;
		},
	} as unknown as TUI;
	return { tui, captured: () => overlay, renders: () => renderCount };
}

describe("contracts/settings center", () => {
	it("partitions exactly the editable settings into sections and omits deleted rows", () => {
		const items = buildSettingItems(settingsWithTargets());
		const expectedIds = SETTINGS_SECTIONS.flatMap((section) => [...SETTINGS_SECTION_ROWS[section.id]]);
		deepStrictEqual(
			items.map((item) => item.id),
			expectedIds,
		);
		for (const deleted of ["workers.profiles", "endpoints.count", "keybindings"]) {
			ok(!items.some((item) => item.id === deleted), `${deleted} must not render`);
		}

		const sections = buildSettingsSections(items);
		deepStrictEqual(
			sections.map((section) => section.id),
			SETTINGS_SECTIONS.map((section) => section.id),
		);
		for (const section of sections) {
			deepStrictEqual(
				section.items.map((item) => item.id),
				[...SETTINGS_SECTION_ROWS[section.id]],
			);
			for (const item of section.items) {
				ok(item.values || item.submenu, `${item.id} must be editable`);
				strictEqual(item.configPath, item.id);
			}
		}
	});

	it("keeps the human label to setting id mapping explicit", () => {
		const labels = Object.fromEntries(buildSettingItems(settingsWithTargets()).map((item) => [item.id, item.label]));
		deepStrictEqual(labels, SETTINGS_LABELS_BY_ID);
	});

	it("preserves applySettingChange behavior for every editable id", () => {
		const cases: Array<{ id: EditableSettingId; value: string; assert: (settings: ClioSettings) => void }> = [
			{ id: "safetyLevel", value: "full-auto", assert: (settings) => strictEqual(settings.safetyLevel, "full-auto") },
			{
				id: "orchestrator.thinkingLevel",
				value: "high",
				assert: (settings) => strictEqual(settings.orchestrator.thinkingLevel, "high"),
			},
			{
				id: "orchestrator.endpoint",
				value: "target-b",
				assert: (settings) => {
					strictEqual(settings.orchestrator.endpoint, "target-b");
					strictEqual(settings.orchestrator.model, "model-b");
				},
			},
			{
				id: "orchestrator.model",
				value: "model-custom",
				assert: (settings) => strictEqual(settings.orchestrator.model, "model-custom"),
			},
			{
				id: "workers.default.endpoint",
				value: "target-b",
				assert: (settings) => {
					strictEqual(settings.workers.default.endpoint, "target-b");
					strictEqual(settings.workers.default.model, "model-b");
				},
			},
			{
				id: "workers.default.model",
				value: "fleet-custom",
				assert: (settings) => strictEqual(settings.workers.default.model, "fleet-custom"),
			},
			{
				id: "budget.sessionCeilingUsd",
				value: "12.5",
				assert: (settings) => strictEqual(settings.budget.sessionCeilingUsd, 12.5),
			},
			{
				id: "scope",
				value: "target-b/model-b, target-a/model-a",
				assert: (settings) => deepStrictEqual(settings.scope, ["target-b/model-b", "target-a/model-a"]),
			},
			{ id: "compaction.auto", value: "false", assert: (settings) => strictEqual(settings.compaction.auto, false) },
			{
				id: "compaction.excludeLastTurns",
				value: "10",
				assert: (settings) => strictEqual(settings.compaction.excludeLastTurns, 10),
			},
			{
				id: "compaction.threshold",
				value: "0.9",
				assert: (settings) => strictEqual(settings.compaction.threshold, 0.9),
			},
			{ id: "retry.enabled", value: "false", assert: (settings) => strictEqual(settings.retry.enabled, false) },
			{ id: "retry.maxRetries", value: "8", assert: (settings) => strictEqual(settings.retry.maxRetries, 8) },
			{ id: "retry.baseDelayMs", value: "5000", assert: (settings) => strictEqual(settings.retry.baseDelayMs, 5000) },
			{
				id: "retry.maxDelayMs",
				value: "120000",
				assert: (settings) => strictEqual(settings.retry.maxDelayMs, 120000),
			},
			{
				id: "terminal.showTerminalProgress",
				value: "true",
				assert: (settings) => strictEqual(settings.terminal.showTerminalProgress, true),
			},
		];

		for (const testCase of cases) {
			const settings = settingsWithTargets();
			applySettingChange(settings, testCase.id, testCase.value);
			testCase.assert(settings);
		}
	});

	it("renders a two-lane center at 120x30", () => {
		const center = noopSettingsCenter(26);
		const lines = center.render(112);
		const rendered = stripAnsi(lines.join("\n"));
		strictEqual(lines.length, 26);
		ok(rendered.includes("Sections"));
		ok(rendered.includes("Autonomy"));
		ok(rendered.includes("Orchestrator"));
		ok(rendered.includes("Autonomy level"));
		ok(rendered.includes("safetyLevel"));
		ok(rendered.includes("│"), "wide layout should include the lane divider");
		ok(rendered.includes("Model initiative guidance"));
		ok(rendered.includes("cycles: suggest, auto-edit, full-auto"));
		ok(!rendered.includes("workers.profiles"));
		ok(!rendered.includes("endpoints.count"));
		ok(!rendered.includes("keybindings"));
	});

	it("renders a stacked center at 80x20", () => {
		const center = noopSettingsCenter(16);
		const lines = center.render(72);
		const rendered = stripAnsi(lines.join("\n"));
		strictEqual(lines.length, 16);
		ok(rendered.includes("Autonomy"));
		ok(rendered.includes("Orchestrator"));
		ok(rendered.includes("Autonomy level"));
		ok(rendered.includes("orchestrator.thinkingLevel"));
		ok(!rendered.includes("│"), "narrow layout should not include the lane divider");
		ok(rendered.includes(FOOTER_NOTE_FOR_TEST));
	});

	it("refreshRows keeps section and row selection across a live value change", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(24, 100);
		const handle = openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay, "expected settings overlay component");

		overlay.handleInput?.("\t");
		for (let i = 0; i < 5; i += 1) overlay.handleInput?.("j");
		overlay.handleInput?.("\t");
		overlay.handleInput?.("j");

		live.current.retry.maxRetries = 8;
		handle.refreshRows();

		const rendered = stripAnsi(overlay.render(120).join("\n"));
		ok(rendered.includes("▸ Max retries"), rendered);
		ok(rendered.includes("retry.maxRetries"));
		ok(rendered.includes("8"));
		ok(fake.renders() > 0);
	});

	it("emits a success notice naming the setting path and new value on a committed change", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(24, 100);
		const notices: Array<{ level: string; text: string; key?: string | undefined }> = [];
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			notice: (level, text, key) => {
				notices.push({ level, text, key });
			},
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay, "expected settings overlay component");

		// Tab to the sections lane, move to Terminal, Tab back to rows, Space-toggle.
		overlay.handleInput?.("\t");
		for (let i = 0; i < 6; i += 1) overlay.handleInput?.("j");
		overlay.handleInput?.("\t");
		overlay.handleInput?.(" ");

		strictEqual(live.current.terminal.showTerminalProgress, true, "toggle persisted");
		deepStrictEqual(notices, [
			{
				level: "success",
				text: "terminal.showTerminalProgress set to true",
				key: "settings:terminal.showTerminalProgress",
			},
		]);
	});
});
