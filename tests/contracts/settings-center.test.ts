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
const ENTER = "\r";
const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const SCOPE_NOTE = "this session";

/** Rows the overlay deliberately surfaces read-only; they are managed elsewhere. */
const READ_ONLY_IDS = new Set<EditableSettingId>([
	"safetyNet",
	"modelSelector.favorites",
	"theme",
	"targets",
	"keybindings",
	"delegation.agents",
]);

function settingsWithTargets(): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "target-a", runtime: "openai-compat", url: "http://localhost:1111", defaultModel: "model-a" },
		{ id: "target-b", runtime: "openai-compat", url: "http://localhost:2222", defaultModel: "model-b" },
	];
	settings.autonomy = "auto-edit";
	settings.orchestrator = { target: "target-a", model: "model-a", thinkingLevel: "off" };
	settings.workers.default = { target: "target-a", model: "model-a", thinkingLevel: "off" };
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
		onCommit: () => undefined,
		onCancel: () => undefined,
	});
}

interface Commit {
	id: string;
	value: string;
	scope: "session" | "global";
}

function spyingSettingsCenter(bodyHeight: number): { center: SettingsCenter; commits: Commit[] } {
	const commits: Commit[] = [];
	const center = new SettingsCenter(buildSettingItems(settingsWithTargets()), {
		getBodyHeight: () => bodyHeight,
		onCommit: (id, value, scope) => commits.push({ id, value, scope }),
		onCancel: () => undefined,
		requestRender: () => undefined,
	});
	return { center, commits };
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
	it("partitions every knob into sections and keeps pointer rows read-only", () => {
		const items = buildSettingItems(settingsWithTargets());
		const expectedIds = SETTINGS_SECTIONS.flatMap((section) => [...SETTINGS_SECTION_ROWS[section.id]]);
		deepStrictEqual(
			items.map((item) => item.id),
			expectedIds,
		);

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
				if (READ_ONLY_IDS.has(item.id)) {
					ok(item.readOnly, `${item.id} must be read-only`);
					ok(!item.values && !item.submenu, `${item.id} must not be editable`);
				} else {
					ok(!item.readOnly, `${item.id} must be editable`);
					ok(item.values || item.submenu, `${item.id} must be editable`);
				}
				strictEqual(item.configPath, item.id);
			}
		}
	});

	it("classifies restart-required knobs and treats the rest as live", () => {
		const byId = new Map(buildSettingItems(settingsWithTargets()).map((item) => [item.id, item]));
		strictEqual(byId.get("budget.concurrency")?.scope, "restart");
		strictEqual(byId.get("runtimePlugins")?.scope, "restart");
		strictEqual(byId.get("autonomy")?.scope, "live");
		strictEqual(byId.get("retry.maxRetries")?.scope, "live");
	});

	it("keeps the human label to setting id mapping explicit", () => {
		const labels = Object.fromEntries(buildSettingItems(settingsWithTargets()).map((item) => [item.id, item.label]));
		deepStrictEqual(labels, SETTINGS_LABELS_BY_ID);
	});

	it("preserves applySettingChange behavior for every editable id", () => {
		const cases: Array<{ id: EditableSettingId; value: string; assert: (settings: ClioSettings) => void }> = [
			{ id: "autonomy", value: "full-auto", assert: (s) => strictEqual(s.autonomy, "full-auto") },
			{ id: "workers.onPermission", value: "fail", assert: (s) => strictEqual(s.workers.onPermission, "fail") },
			{
				id: "delegation.defaults.toolGovernance",
				value: "deny-all",
				assert: (s) => strictEqual(s.delegation.defaults.toolGovernance, "deny-all"),
			},
			{
				id: "skills.trustProjectCompatRoots",
				value: "true",
				assert: (s) => strictEqual(s.skills.trustProjectCompatRoots, true),
			},
			{
				id: "orchestrator.thinkingLevel",
				value: "high",
				assert: (s) => strictEqual(s.orchestrator.thinkingLevel, "high"),
			},
			{
				id: "orchestrator.target",
				value: "target-b",
				assert: (s) => {
					strictEqual(s.orchestrator.target, "target-b");
					strictEqual(s.orchestrator.model, "model-b");
				},
			},
			{
				id: "orchestrator.model",
				value: "model-custom",
				assert: (s) => strictEqual(s.orchestrator.model, "model-custom"),
			},
			{
				id: "workers.default.target",
				value: "target-b",
				assert: (s) => {
					strictEqual(s.workers.default.target, "target-b");
					strictEqual(s.workers.default.model, "model-b");
				},
			},
			{
				id: "workers.default.model",
				value: "fleet-custom",
				assert: (s) => strictEqual(s.workers.default.model, "fleet-custom"),
			},
			{
				id: "workers.default.thinkingLevel",
				value: "medium",
				assert: (s) => strictEqual(s.workers.default.thinkingLevel, "medium"),
			},
			{ id: "workers.maxRetries", value: "5", assert: (s) => strictEqual(s.workers.maxRetries, 5) },
			{ id: "modelSelector.recentLimit", value: "20", assert: (s) => strictEqual(s.modelSelector.recentLimit, 20) },
			{ id: "defaults.maxTokens", value: "65536", assert: (s) => strictEqual(s.defaults.maxTokens, 65536) },
			{ id: "defaults.maxTokens", value: "0", assert: (s) => strictEqual(s.defaults.maxTokens, 0) },
			{ id: "budget.concurrency", value: "auto", assert: (s) => strictEqual(s.budget.concurrency, "auto") },
			{ id: "budget.concurrency", value: "4", assert: (s) => strictEqual(s.budget.concurrency, 4) },
			{
				id: "budget.sessionCeilingUsd",
				value: "12.5",
				assert: (s) => strictEqual(s.budget.sessionCeilingUsd, 12.5),
			},
			{
				id: "scope",
				value: "target-b/model-b, target-a/model-a",
				assert: (s) => deepStrictEqual(s.scope, ["target-b/model-b", "target-a/model-a"]),
			},
			{ id: "compaction.auto", value: "false", assert: (s) => strictEqual(s.compaction.auto, false) },
			{
				id: "compaction.excludeLastTurns",
				value: "10",
				assert: (s) => strictEqual(s.compaction.excludeLastTurns, 10),
			},
			{ id: "compaction.threshold", value: "0.9", assert: (s) => strictEqual(s.compaction.threshold, 0.9) },
			{ id: "compaction.model", value: "prov/sum", assert: (s) => strictEqual(s.compaction.model, "prov/sum") },
			{ id: "compaction.model", value: "  ", assert: (s) => strictEqual("model" in s.compaction, false) },
			{
				id: "compaction.systemPrompt",
				value: "~/p.md",
				assert: (s) => strictEqual(s.compaction.systemPrompt, "~/p.md"),
			},
			{ id: "retry.enabled", value: "false", assert: (s) => strictEqual(s.retry.enabled, false) },
			{ id: "retry.maxRetries", value: "8", assert: (s) => strictEqual(s.retry.maxRetries, 8) },
			{ id: "retry.baseDelayMs", value: "5000", assert: (s) => strictEqual(s.retry.baseDelayMs, 5000) },
			{ id: "retry.maxDelayMs", value: "120000", assert: (s) => strictEqual(s.retry.maxDelayMs, 120000) },
			{
				id: "terminal.showTerminalProgress",
				value: "true",
				assert: (s) => strictEqual(s.terminal.showTerminalProgress, true),
			},
			{ id: "identity", value: "atlas", assert: (s) => strictEqual(s.identity, "atlas") },
			{
				id: "runtimePlugins",
				value: "@scope/a, @scope/b",
				assert: (s) => deepStrictEqual(s.runtimePlugins, ["@scope/a", "@scope/b"]),
			},
			{
				id: "delegation.defaults.connectTimeoutMs",
				value: "45000",
				assert: (s) => strictEqual(s.delegation.defaults.connectTimeoutMs, 45000),
			},
			{
				id: "delegation.defaults.turnTimeoutMs",
				value: "600000",
				assert: (s) => strictEqual(s.delegation.defaults.turnTimeoutMs, 600000),
			},
			{
				id: "delegation.defaults.permissionTimeoutMs",
				value: "90000",
				assert: (s) => strictEqual(s.delegation.defaults.permissionTimeoutMs, 90000),
			},
		];

		for (const testCase of cases) {
			const settings = settingsWithTargets();
			applySettingChange(settings, testCase.id, testCase.value);
			testCase.assert(settings);
		}
	});

	it("renders a two-lane center with a breadcrumb footer at 120x30", () => {
		const center = noopSettingsCenter(26);
		const rendered = stripAnsi(center.render(112).join("\n"));
		strictEqual(center.render(112).length, 26);
		ok(rendered.includes("Sections"));
		ok(rendered.includes("Autonomy & Safety"));
		ok(rendered.includes("Models"));
		ok(rendered.includes("Advanced"));
		ok(rendered.includes("Autonomy level"));
		ok(rendered.includes("autonomy"), "config path column shows at full width");
		ok(rendered.includes("│"), "wide layout should include the lane divider");
		ok(rendered.includes("How freely Clio acts"));
		ok(rendered.includes("Autonomy & Safety › Autonomy level"), "footer breadcrumb");
		ok(rendered.includes(SCOPE_NOTE), "footer states the live/global scope");
	});

	it("renders a stacked center at 80x20", () => {
		const center = noopSettingsCenter(16);
		const lines = center.render(72);
		const rendered = stripAnsi(lines.join("\n"));
		strictEqual(lines.length, 16);
		ok(rendered.includes("Autonomy"));
		ok(rendered.includes("Autonomy level"));
		ok(!rendered.includes("│"), "narrow layout should not include the lane divider");
	});

	it("stays legible on an extremely narrow terminal by dropping the path column", () => {
		const center = noopSettingsCenter(20);
		const lines = center.render(40);
		strictEqual(lines.length, 20);
		const rendered = stripAnsi(lines.join("\n"));
		ok(rendered.includes("auto-edit"), "value stays visible when the path column is dropped");
	});

	it("never overflows a very short terminal", () => {
		const center = noopSettingsCenter(6);
		strictEqual(center.render(100).length, 6);
		strictEqual(center.render(40).length, 6);
	});

	it("Space previews a value without committing; Enter commits it", () => {
		const { center, commits } = spyingSettingsCenter(26);
		center.setSelection("safety", 0); // autonomy = auto-edit
		center.handleInput(" "); // preview → full-auto
		strictEqual(commits.length, 0, "preview must not commit");
		const previewed = stripAnsi(center.render(112).join("\n"));
		ok(previewed.includes("full-auto"), "preview value is shown");
		center.handleInput(ENTER); // commit pending → applies to session, opens scope confirm
		deepStrictEqual(commits, [{ id: "autonomy", value: "full-auto", scope: "session" }]);
	});

	it("a live knob applies to the session immediately, then offers a global save", () => {
		const { center, commits } = spyingSettingsCenter(26);
		center.setSelection("safety", 0); // autonomy
		center.handleInput(ENTER); // advance one + commit session + open confirm
		deepStrictEqual(commits, [{ id: "autonomy", value: "full-auto", scope: "session" }]);
		center.handleInput(ENTER); // choose the default option: save globally
		deepStrictEqual(commits, [
			{ id: "autonomy", value: "full-auto", scope: "session" },
			{ id: "autonomy", value: "full-auto", scope: "global" },
		]);
	});

	it("Esc on the confirm dialog keeps a live edit session-only", () => {
		const { center, commits } = spyingSettingsCenter(26);
		center.setSelection("safety", 0);
		center.handleInput(ENTER); // session apply + confirm
		center.handleInput(ESC); // decline global
		deepStrictEqual(commits, [{ id: "autonomy", value: "full-auto", scope: "session" }]);
	});

	it("a restart-required knob is global-only and never applies to the session", () => {
		const { center, commits } = spyingSettingsCenter(26);
		center.setSelection("budget", 2); // budget.concurrency = auto
		center.handleInput(ENTER); // open confirm; no session apply for restart knobs
		strictEqual(commits.length, 0, "restart knobs do not apply live");
		center.handleInput(ENTER); // choose: save globally
		deepStrictEqual(commits, [{ id: "budget.concurrency", value: "1", scope: "global" }]);
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

		// Navigate to Retry → Max retries by driving keys through the frame.
		overlay.handleInput?.("\t"); // sections lane
		for (let i = 0; i < 6; i += 1) overlay.handleInput?.("j"); // safety→…→retry
		overlay.handleInput?.("\t"); // rows lane
		overlay.handleInput?.("j"); // → Max retries

		live.current.retry.maxRetries = 8;
		handle.refreshRows();

		const rendered = stripAnsi(overlay.render(120).join("\n"));
		ok(rendered.includes("▸ Max retries"), rendered);
		ok(rendered.includes("retry.maxRetries"));
		ok(rendered.includes("8"));
		ok(fake.renders() > 0);
	});

	it("routes session vs global commits through commitSetting and emits a scoped notice", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(24, 100);
		const calls: Array<{ id: string; scope: "session" | "global" }> = [];
		const notices: Array<{ level: string; text: string; key?: string | undefined }> = [];
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			commitSetting: (id, next, scope) => {
				calls.push({ id, scope });
				live.current = next;
			},
			notice: (level, text, key) => notices.push({ level, text, key }),
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay, "expected settings overlay component");

		overlay.handleInput?.(ENTER); // autonomy: session apply + confirm
		overlay.handleInput?.(ENTER); // save globally

		deepStrictEqual(calls, [
			{ id: "autonomy", scope: "session" },
			{ id: "autonomy", scope: "global" },
		]);
		strictEqual(notices.length, 2);
		strictEqual(notices[1]?.text, "autonomy set to full-auto (saved globally)");
		strictEqual(notices[1]?.key, "settings:autonomy");
	});

	it("falls back to writeSettings when no scoped commit handler is wired", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(24, 100);
		let writes = 0;
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				writes += 1;
				live.current = next;
			},
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay, "expected settings overlay component");
		overlay.handleInput?.(ENTER); // commit (session → writeSettings fallback)
		overlay.handleInput?.(ENTER); // global → writeSettings
		ok(writes >= 1, "edits persist through writeSettings when commitSetting is absent");
	});
});
